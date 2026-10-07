use pp_storage::{Limits, WriterOwner, profiles::ProfileLibraryRequest};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

const NODE_FIXTURE: &str = include_str!("fixtures/profile-library-node.json");
const PRIVATE_PATH: &str = "/owned/private/dummy-secret-path";
const PRIVATE_CONFIG: &str = "{\"dummySecret\":\"never-public\"}";

fn directory(label: &str) -> PathBuf {
    let mut random = [0; 12];
    getrandom::fill(&mut random).unwrap();
    std::env::temp_dir().join(format!(
        "pp-profile-library-{label}-{}",
        hex::encode(random)
    ))
}

fn fixture_owner(directory: &Path, limits: Limits) -> WriterOwner {
    let owner = WriterOwner::open_at(directory, limits, "2026-10-05T16:00:00.000Z")
        .unwrap()
        .0;
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    connection
        .execute_batch(
            "DELETE FROM printer_profiles;
             DELETE FROM process_profiles;
             DELETE FROM filament_profiles;",
        )
        .unwrap();
    for row in [
        (
            101,
            "default",
            "Same",
            "orca",
            Some("1.9"),
            Some("2026-10-05T17:00:01.000Z"),
            "2026-10-05T16:00:01.000Z",
        ),
        (
            105,
            "default",
            "10",
            "bambu",
            None,
            Some("2026-10-05T17:00:05.000Z"),
            "2026-10-05T16:00:05.000Z",
        ),
        (
            999,
            "foreign",
            "Foreign secret",
            "orca",
            Some("hidden"),
            Some("2026-10-05T17:00:09.000Z"),
            "2026-10-05T16:00:09.000Z",
        ),
    ] {
        connection.execute(
            "INSERT INTO printer_profiles(id,tenant_id,name,slicer_format,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![row.0,row.1,row.2,row.3,PRIVATE_PATH,PRIVATE_CONFIG,row.4,row.5,row.6],
        ).unwrap();
    }
    for row in [
        (
            202,
            "default",
            "Same",
            "prusa",
            None::<&str>,
            None::<&str>,
            "2026-10-05T16:00:02.000Z",
        ),
        (
            204,
            "default",
            "a",
            "orca",
            None::<&str>,
            None::<&str>,
            "2026-10-05T16:00:04.000Z",
        ),
    ] {
        connection.execute(
            "INSERT INTO process_profiles(id,tenant_id,name,slicer_format,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![row.0,row.1,row.2,row.3,PRIVATE_PATH,PRIVATE_CONFIG,row.4,row.5,row.6],
        ).unwrap();
    }
    for row in [
        (
            303,
            "default",
            "Á",
            "PLA",
            Some("2.0"),
            Some("2026-10-05T17:00:03.000Z"),
            "2026-10-05T16:00:03.000Z",
        ),
        (
            306,
            "default",
            "2",
            "PETG",
            Some("2.1"),
            None,
            "2026-10-05T16:00:06.000Z",
        ),
    ] {
        connection.execute(
            "INSERT INTO filament_profiles(id,tenant_id,name,material_type,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![row.0,row.1,row.2,row.3,PRIVATE_PATH,PRIVATE_CONFIG,row.4,row.5,row.6],
        ).unwrap();
    }
    owner
}

#[test]
fn authenticated_storage_read_matches_node_projection_and_excludes_private_values() {
    let directory = directory("projection");
    let owner = fixture_owner(&directory, Limits::default());
    let result = owner
        .local_profile_library()
        .read(
            ProfileLibraryRequest,
            &AtomicBool::new(false),
            Duration::from_secs(1),
        )
        .unwrap();
    let actual = serde_json::to_value(result).unwrap();
    let expected: Value = serde_json::from_str(NODE_FIXTURE).unwrap();
    assert_eq!(actual, expected);
    let text = serde_json::to_string(&actual).unwrap();
    assert!(!text.contains("Foreign secret"));
    assert!(!text.contains(PRIVATE_PATH));
    assert!(!text.contains(PRIVATE_CONFIG));
    assert_eq!(actual["profiles"][4]["kind"], json!("printer"));
    assert_eq!(actual["profiles"][5]["kind"], json!("process"));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reader_admission_observes_busy_cancel_release_and_stop() {
    let directory = directory("admission");
    let owner = fixture_owner(
        &directory,
        Limits {
            queued_writes: 1,
            readers: 1,
        },
    );
    let client = owner.local_profile_library();
    let held = owner.client().reader(Duration::from_secs(1)).unwrap();
    let busy = client
        .read(
            ProfileLibraryRequest,
            &AtomicBool::new(false),
            Duration::from_millis(1),
        )
        .unwrap_err();
    assert_eq!(
        busy.downcast_ref::<pp_storage::profiles::ProfileLibraryFailure>(),
        Some(&pp_storage::profiles::ProfileLibraryFailure::ReaderBusy)
    );
    let cancelled = client
        .read(
            ProfileLibraryRequest,
            &AtomicBool::new(true),
            Duration::from_secs(1),
        )
        .unwrap_err();
    assert_eq!(
        cancelled.downcast_ref::<pp_storage::profiles::ProfileLibraryFailure>(),
        Some(&pp_storage::profiles::ProfileLibraryFailure::Cancelled)
    );
    drop(held);
    assert!(
        !client
            .read(
                ProfileLibraryRequest,
                &AtomicBool::new(false),
                Duration::from_secs(1),
            )
            .unwrap()
            .profiles()
            .is_empty()
    );
    owner.shutdown().unwrap();
    let stopped = client
        .read(
            ProfileLibraryRequest,
            &AtomicBool::new(false),
            Duration::from_secs(1),
        )
        .unwrap_err();
    assert_eq!(
        stopped.downcast_ref::<pp_storage::profiles::ProfileLibraryFailure>(),
        Some(&pp_storage::profiles::ProfileLibraryFailure::Stopped)
    );
    std::fs::remove_dir_all(directory).unwrap();
}
