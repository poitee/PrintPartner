use pp_storage::{Limits, WriterOwner, lease::StorageLease};
use std::path::PathBuf;

#[path = "common/process.rs"]
mod child_process;

// Forked test children can briefly inherit another test's flock before exec.
static ADMISSION_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-t7-marker-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn refuses(&self) {
        for _ in 0..2 {
            let error = match StorageLease::acquire(&self.0) {
                Ok(owner) => {
                    owner.release();
                    panic!("ambiguous lease was admitted")
                }
                Err(error) => error,
            };
            assert_eq!(error.to_string(), "storage_lease_marker_invalid");
            let error = match WriterOwner::open(&self.0, Limits::default()) {
                Ok((owner, _)) => {
                    owner.shutdown().unwrap();
                    panic!("writer admitted an ambiguous lease")
                }
                Err(error) => error,
            };
            assert_eq!(error.to_string(), "storage_lease_marker_invalid");
            assert!(!self.0.join("print-partner.db").exists());
            assert!(!self.0.join(".desktop-owner.json").exists());
            assert!(std::fs::read_dir(&self.0).unwrap().all(|entry| {
                let name = entry.unwrap().file_name();
                name == ".desktop-lease" || name == ".desktop.lock"
            }));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn ticket_t_7_writer_marker_missing_lease_record_fails_closed() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for nonempty in [false, true] {
        let fixture = Fixture::new();
        let lease = fixture.0.join(".desktop-lease");
        std::fs::create_dir(&lease).unwrap();
        if nonempty {
            std::fs::write(lease.join("previous-marker.json"), b"retained evidence").unwrap();
        }
        fixture.refuses();
        assert!(lease.is_dir());
        assert!(!lease.join("owner.json").exists());
        assert_eq!(
            std::fs::read_dir(&lease).unwrap().count(),
            usize::from(nonempty)
        );
        if nonempty {
            assert_eq!(
                std::fs::read(lease.join("previous-marker.json")).unwrap(),
                b"retained evidence"
            );
        }
    }
}

#[test]
fn ticket_t_7_writer_marker_torn_lease_record_fails_closed() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for bytes in [b"".as_slice(), b"{\"pid\":", b"{}", b"null"] {
        let fixture = Fixture::new();
        let lease = fixture.0.join(".desktop-lease");
        std::fs::create_dir(&lease).unwrap();
        std::fs::write(lease.join("owner.json"), bytes).unwrap();
        fixture.refuses();
        assert_eq!(std::fs::read(lease.join("owner.json")).unwrap(), bytes);
    }
}

#[test]
fn ticket_t_7_writer_marker_incomplete_identity_cannot_prove_staleness() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    for pid in [std::process::id(), dead_pid] {
        for identity in ["", " \t\n"] {
            let fixture = Fixture::new();
            let lease = fixture.0.join(".desktop-lease");
            std::fs::create_dir(&lease).unwrap();
            let bytes = serde_json::to_vec(&serde_json::json!({
                "pid": pid, "process_identity": identity, "instance": "ab".repeat(16)
            }))
            .unwrap();
            std::fs::write(lease.join("owner.json"), &bytes).unwrap();
            fixture.refuses();
            assert_eq!(std::fs::read(lease.join("owner.json")).unwrap(), bytes);
        }
    }
}

#[test]
fn ticket_t_7_writer_marker_complete_stale_lease_recovers() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new();
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    let lease = fixture.0.join(".desktop-lease");
    std::fs::create_dir(&lease).unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({
        "pid": pid, "process_identity": "prior-process", "instance": "ab".repeat(16)
    }))
    .unwrap();
    std::fs::write(lease.join("owner.json"), &bytes).unwrap();
    let (owner, _) = WriterOwner::open(&fixture.0, Limits::default()).unwrap();
    assert!(fixture.0.join("print-partner.db").is_file());
    assert_eq!(
        std::fs::read(fixture.0.join(format!(
            ".desktop-lease-retired-{}/owner.json",
            "ab".repeat(16)
        )))
        .unwrap(),
        bytes
    );
    owner.shutdown().unwrap();
    assert!(!lease.exists());
}

fn refuses_desktop_marker(fixture: &Fixture) {
    use std::os::unix::fs::MetadataExt;
    let marker = fixture.0.join(".desktop-owner.json");
    let before = std::fs::symlink_metadata(&marker).unwrap();
    let bytes = before.is_file().then(|| std::fs::read(&marker).unwrap());
    let target = before
        .file_type()
        .is_symlink()
        .then(|| std::fs::read_link(&marker).unwrap());
    let lease = fixture.0.join(".desktop-lease");
    let lease_before = std::fs::symlink_metadata(&lease)
        .ok()
        .map(|m| (m.dev(), m.ino()));
    let mut errors = Vec::new();
    for _ in 0..2 {
        for writer in [false, true] {
            let error = if writer {
                WriterOwner::open(&fixture.0, Limits::default()).err()
            } else {
                StorageLease::acquire(&fixture.0).err()
            }
            .expect("invalid desktop marker must refuse admission");
            if before.is_dir() || before.file_type().is_symlink() {
                assert_eq!(
                    error
                        .downcast_ref::<std::io::Error>()
                        .and_then(std::io::Error::raw_os_error),
                    Some(if before.is_dir() {
                        libc::EISDIR
                    } else {
                        libc::ENOENT
                    })
                );
            }
            errors.push(error);
            assert_eq!(
                std::fs::symlink_metadata(&lease)
                    .ok()
                    .map(|m| (m.dev(), m.ino())),
                lease_before
            );
            let after = std::fs::symlink_metadata(&marker).unwrap();
            assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
            if let Some(bytes) = &bytes {
                assert_eq!(&std::fs::read(&marker).unwrap(), bytes);
            }
            if let Some(target) = &target {
                assert_eq!(&std::fs::read_link(&marker).unwrap(), target);
            }
            assert!(!fixture.0.join("print-partner.db").exists());
            assert!(std::fs::read_dir(&fixture.0).unwrap().all(|entry| {
                let name = entry.unwrap().file_name();
                name == ".desktop-owner.json" || name == ".desktop.lock" || name == ".desktop-lease"
            }));
        }
    }
    for error in errors {
        assert_eq!(
            error.to_string(),
            "storage_lease_marker_invalid",
            "{error:#}"
        );
    }
}

#[test]
fn ticket_t_7_writer_desktop_marker_malformed_json_is_preserved() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for bytes in [b"".as_slice(), b"{\"pid\":", b"{}", b"null", b"[]"] {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join(".desktop-owner.json"), bytes).unwrap();
        refuses_desktop_marker(&fixture);
    }
}

#[test]
fn ticket_t_7_writer_desktop_marker_invalid_pid_or_type_is_preserved() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for pid in [
        serde_json::json!(0),
        serde_json::json!(-1),
        serde_json::json!(2147483648u64),
        serde_json::json!("123"),
        serde_json::json!(1.5),
        serde_json::json!(null),
    ] {
        let fixture = Fixture::new();
        std::fs::write(
            fixture.0.join(".desktop-owner.json"),
            serde_json::json!({"pid":pid}).to_string(),
        )
        .unwrap();
        refuses_desktop_marker(&fixture);
    }
}

#[test]
fn ticket_t_7_writer_desktop_marker_directory_is_preserved() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new();
    let marker = fixture.0.join(".desktop-owner.json");
    std::fs::create_dir(&marker).unwrap();
    std::fs::write(marker.join("evidence"), b"private evidence").unwrap();
    refuses_desktop_marker(&fixture);
    assert_eq!(
        std::fs::read(marker.join("evidence")).unwrap(),
        b"private evidence"
    );
}

#[test]
fn ticket_t_7_writer_desktop_marker_dangling_symlink_is_preserved() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new();
    std::os::unix::fs::symlink(
        "missing-private-marker",
        fixture.0.join(".desktop-owner.json"),
    )
    .unwrap();
    refuses_desktop_marker(&fixture);
    assert!(!fixture.0.join("missing-private-marker").exists());
}

#[test]
fn ticket_t_7_writer_desktop_marker_live_or_unknown_child_keeps_ownership_diagnostic() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    use std::os::unix::fs::MetadataExt;
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    for pid in [std::process::id(), dead_pid] {
        let fixture = Fixture::new();
        let marker = fixture.0.join(".desktop-owner.json");
        let bytes = serde_json::json!({"pid": pid}).to_string();
        std::fs::write(&marker, &bytes).unwrap();
        let inode = std::fs::metadata(&marker).unwrap().ino();
        for _ in 0..2 {
            let error = StorageLease::acquire(&fixture.0).err().unwrap();
            assert_eq!(error.to_string(), "A prior writer may still be alive");
            let error = WriterOwner::open(&fixture.0, Limits::default())
                .err()
                .unwrap();
            assert_eq!(error.to_string(), "Data directory already owned");
            assert_eq!(std::fs::read(&marker).unwrap(), bytes.as_bytes());
            assert_eq!(std::fs::metadata(&marker).unwrap().ino(), inode);
            assert!(!fixture.0.join("print-partner.db").exists());
            assert!(!fixture.0.join(".desktop-lease").exists());
        }
    }
}

#[test]
fn ticket_t_7_writer_desktop_marker_legacy_standalone_recovers() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    for writer in [false, true] {
        let fixture = Fixture::new();
        std::fs::write(
            fixture.0.join(".desktop-owner.json"),
            serde_json::json!({"pid": dead_pid, "kind": "standalone"}).to_string(),
        )
        .unwrap();
        if writer {
            let (owner, _) = WriterOwner::open(&fixture.0, Limits::default()).unwrap();
            assert!(fixture.0.join("print-partner.db").is_file());
            owner.shutdown().unwrap();
        } else {
            let released = StorageLease::acquire(&fixture.0).unwrap().release();
            assert!(
                released.marker_removed && released.lock_released && !released.ownership_retained
            );
        }
    }
}

#[test]
fn ticket_t_7_writer_desktop_marker_invalid_preserves_existing_stale_lease() {
    let _admission = ADMISSION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    use std::os::unix::fs::MetadataExt;
    let fixture = Fixture::new();
    let mut child = child_process::command("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    let lease = fixture.0.join(".desktop-lease");
    std::fs::create_dir(&lease).unwrap();
    let path = lease.join("owner.json");
    let bytes =
        serde_json::json!({"pid":pid, "process_identity":"prior", "instance":"ab".repeat(16)})
            .to_string();
    std::fs::write(&path, &bytes).unwrap();
    let inode = std::fs::metadata(&path).unwrap().ino();
    std::fs::write(lease.join("previous-marker.json"), b"retained evidence").unwrap();
    std::fs::write(fixture.0.join(".desktop-owner.json"), b"{").unwrap();
    refuses_desktop_marker(&fixture);
    assert_eq!(std::fs::read(&path).unwrap(), bytes.as_bytes());
    assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
    assert_eq!(
        std::fs::read(lease.join("previous-marker.json")).unwrap(),
        b"retained evidence"
    );
}
