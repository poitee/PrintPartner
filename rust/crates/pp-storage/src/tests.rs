use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::mpsc;

fn exited_true_pid() -> u32 {
    let mut prior = Command::new("/usr/bin/true").spawn().unwrap();
    let pid = prior.id();
    prior.wait().unwrap();
    pid
}

fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-storage-{name}-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}
fn fixture(name: &str) -> (PathBuf, WriterOwner, SettingsClient) {
    let path = directory(name);
    let (owner, _) = WriterOwner::open_at(
        &path,
        Limits {
            queued_writes: 1,
            readers: 1,
        },
        "2026-10-02T00:00:00.000Z",
    )
    .unwrap();
    let client = owner.client();
    (path, owner, client)
}
fn set(client: &SettingsClient, key: &str, value: &str) -> Result<WriteReply> {
    client.submit(
        SettingCommand::Set(Setting {
            tenant: "test".into(),
            key: key.into(),
            value: value.into(),
        }),
        &AtomicBool::new(false),
        Duration::ZERO,
    )
}
#[test]
fn settings_are_atomic_and_tenant_scoped() {
    let (path, owner, client) = fixture("settings");
    set(&client, "empty", "").unwrap().recv().unwrap().unwrap();
    let read = client.reader(Duration::ZERO).unwrap();
    assert_eq!(
        read.snapshot("test", "empty").unwrap(),
        SettingSnapshot::Stored { value: "".into() }
    );
    assert_eq!(
        read.snapshot("other", "empty").unwrap(),
        SettingSnapshot::Missing
    );
    assert_eq!(
        read.get_setting("test", "empty", Some("fallback")).unwrap(),
        Some("fallback".into())
    );
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute_batch("CREATE TRIGGER reject_setting BEFORE INSERT ON app_settings WHEN NEW.key='reject' BEGIN INSERT INTO app_settings VALUES('test','partial','must rollback'); SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(
        set(&client, "reject", "no")
            .unwrap()
            .recv()
            .unwrap()
            .is_err()
    );
    assert_eq!(
        read.snapshot("test", "partial").unwrap(),
        SettingSnapshot::Missing
    );
    drop(raw);
    drop(read);
    owner.shutdown().unwrap();
}
#[test]
fn queue_cancellation_reply_loss_and_shutdown_drain() {
    let (path, owner, client) = fixture("queue");
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute_batch("CREATE TRIGGER count_admitted AFTER INSERT ON app_settings WHEN NEW.key='admitted' BEGIN INSERT INTO app_settings VALUES('test','execution-count','1') ON CONFLICT(tenant_id,key) DO UPDATE SET value=CAST(value AS INTEGER)+1; END; BEGIN IMMEDIATE;").unwrap();
    let first = set(&client, "blocking", "yes").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !client.shared.queue.lock().unwrap().pending.is_empty() {
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    drop(set(&client, "admitted", "once").unwrap());
    assert!(
        set(&client, "overflow", "no")
            .unwrap_err()
            .to_string()
            .contains("full")
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let waiting_client = client.clone();
    let waiting_cancel = cancel.clone();
    let waiting = thread::spawn(move || {
        waiting_client
            .submit(
                SettingCommand::Set(Setting {
                    tenant: "test".into(),
                    key: "cancelled".into(),
                    value: "no".into(),
                }),
                &waiting_cancel,
                Duration::from_secs(5),
            )
            .unwrap_err()
            .to_string()
    });
    cancel.store(true, Ordering::Release);
    assert!(waiting.join().unwrap().contains("Cancelled"));
    let read = client.reader(Duration::ZERO).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let close = thread::spawn(move || {
        let result = owner.shutdown();
        done_tx.send(result).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !client.shared.queue.lock().unwrap().closed {
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    assert!(
        set(&client, "after-stop", "no")
            .unwrap_err()
            .to_string()
            .contains("stopped")
    );
    assert!(done_rx.try_recv().is_err());
    assert!(path.join(".desktop-owner.json").exists());
    raw.execute_batch("COMMIT").unwrap();
    first.recv().unwrap().unwrap();
    drop(raw);
    drop(read);
    done_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    close.join().unwrap();
    let check = Connection::open(path.join("print-partner.db")).unwrap();
    assert_eq!(
        snapshot(&check, "test", "execution-count").unwrap(),
        SettingSnapshot::Stored { value: "1".into() }
    );
    for key in ["overflow", "cancelled", "after-stop"] {
        assert_eq!(
            snapshot(&check, "test", key).unwrap(),
            SettingSnapshot::Missing
        );
    }
    assert!(!path.join(".desktop-owner.json").exists());
}
#[test]
fn reader_pool_resets_pragmas_rejects_writes_and_is_bounded() {
    let (_, owner, client) = fixture("readers");
    let read = client.reader(Duration::ZERO).unwrap();
    assert!(
        client
            .reader(Duration::ZERO)
            .err()
            .unwrap()
            .to_string()
            .contains("full")
    );
    let conn = read.connection.as_ref().unwrap();
    conn.execute_batch("PRAGMA query_only=OFF; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=0;")
        .unwrap();
    assert!(
        conn.execute("INSERT INTO app_settings VALUES('test','escape','no')", [])
            .is_err()
    );
    drop(read);
    let read = client.reader(Duration::ZERO).unwrap();
    for (name, value) in [
        ("query_only", 1),
        ("foreign_keys", 1),
        ("busy_timeout", 5000),
        ("synchronous", 2),
    ] {
        assert_eq!(
            read.connection
                .as_ref()
                .unwrap()
                .pragma_query_value(None, name, |r| r.get::<_, i64>(0))
                .unwrap(),
            value
        );
    }
    set(&client, "while-reader-held", "yes")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    drop(read);
    owner.shutdown().unwrap();
    assert!(
        client
            .reader(Duration::ZERO)
            .err()
            .unwrap()
            .to_string()
            .contains("stopped")
    );
}
#[test]
fn ahead_and_old_versions_reject_before_side_effects() {
    for version in [30, 35] {
        let path = directory("version");
        let database = path.join("print-partner.db");
        let conn = Connection::open(&database).unwrap();
        conn.execute_batch("CREATE TABLE app_settings(tenant_id TEXT,key TEXT,value TEXT);")
            .unwrap();
        conn.execute(
            "INSERT INTO app_settings VALUES('default','schema_version',?1)",
            [version.to_string()],
        )
        .unwrap();
        drop(conn);
        let before = std::fs::read(&database).unwrap();
        assert!(
            WriterOwner::open_at(&path, Limits::default(), "2026-10-02T00:00:00.000Z").is_err()
        );
        assert_eq!(std::fs::read(&database).unwrap(), before);
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    }
}

#[test]
fn reopen_preserves_the_pre_upgrade_backup() {
    let path = directory("upgrade-backup");
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    owner.shutdown().unwrap();

    let database = path.join("print-partner.db");
    let raw = Connection::open(&database).unwrap();
    raw.execute(
        "UPDATE app_settings SET value='33' WHERE tenant_id='default' AND key='schema_version'",
        [],
    )
    .unwrap();
    drop(raw);

    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    let backup = ready.backup.unwrap();
    owner.shutdown().unwrap();
    let version = |path: &Path| {
        Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
    };
    assert_eq!(version(&backup), "33");

    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert!(ready.backup.is_none());
    owner.shutdown().unwrap();
    assert_eq!(version(&backup), "33");
}
#[test]
fn backup_includes_uncheckpointed_wal() {
    let (path, owner, client) = fixture("backup");
    set(&client, "wal-only", "committed")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(path.join("print-partner.db-wal").metadata().unwrap().len() > 32);
    let target = path.with_extension("backup.db");
    owner.backup(&target).unwrap();
    let snapshot_db =
        Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        snapshot(&snapshot_db, "test", "wal-only").unwrap(),
        SettingSnapshot::Stored {
            value: "committed".into()
        }
    );
    drop(snapshot_db);
    owner.shutdown().unwrap();
}

#[test]
fn backup_cannot_replace_the_open_database() {
    let (path, owner, client) = fixture("backup-destination");
    set(&client, "retained", "yes")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(
        owner
            .backup(&path.join("print-partner.db"))
            .unwrap_err()
            .to_string()
            .contains("managed storage")
    );
    set(&client, "after-rejection", "works")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let reader = client.reader(Duration::ZERO).unwrap();
    assert_eq!(
        reader.snapshot("test", "retained").unwrap(),
        SettingSnapshot::Stored {
            value: "yes".into()
        }
    );
    assert_eq!(
        reader.snapshot("test", "after-rejection").unwrap(),
        SettingSnapshot::Stored {
            value: "works".into()
        }
    );
    drop(reader);
    owner.shutdown().unwrap();
}

#[test]
fn backup_rejects_managed_trees_aliases_and_existing_files() {
    use fs2::FileExt;
    use std::os::unix::fs::{MetadataExt, symlink};
    let (path, owner, client) = fixture("backup-authority");
    set(&client, "before", "committed")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let marker_path = path.join(".desktop-owner.json");
    let marker = std::fs::read(&marker_path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&marker).unwrap();
    let runtime = PathBuf::from(value["runtime_dir"].as_str().unwrap());
    let lock = path.join(".desktop.lock");
    let inode = std::fs::metadata(&lock).unwrap().ino();
    let mut denied = [
        "print-partner.db",
        "print-partner.db-wal",
        "print-partner.db-shm",
        "print-partner.db-journal",
        ".desktop.lock",
        ".desktop-owner.json",
        "new-file",
    ]
    .map(|name| path.join(name))
    .to_vec();
    denied.push(runtime.join("new-file"));
    let aliases = directory("aliases");
    symlink(&path, aliases.join("data")).unwrap();
    symlink(&runtime, aliases.join("runtime")).unwrap();
    symlink(path.join("print-partner.db-wal"), aliases.join("wal-alias")).unwrap();
    denied.extend([
        aliases.join("data/.desktop.lock"),
        aliases.join("runtime/new-file"),
        aliases.join("wal-alias"),
        path.join("repos/../.desktop.lock"),
    ]);
    let existing = aliases.join("existing");
    std::fs::write(&existing, b"preserve").unwrap();
    denied.push(existing.clone());
    for target in denied {
        assert!(owner.backup(&target).is_err(), "{}", target.display());
        assert_eq!(std::fs::read(&marker_path).unwrap(), marker);
        assert_eq!(std::fs::metadata(&lock).unwrap().ino(), inode);
        let probe = std::fs::File::open(&lock).unwrap();
        assert!(probe.try_lock_exclusive().is_err());
    }
    assert_eq!(std::fs::read(existing).unwrap(), b"preserve");
    set(&client, "after", "committed")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let exported = aliases.join("offline.db");
    owner.backup(&exported).unwrap();
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let reader = owner.client().reader(Duration::ZERO).unwrap();
    let backup = Connection::open(&exported).unwrap();
    for key in ["before", "after"] {
        let expected = SettingSnapshot::Stored {
            value: "committed".into(),
        };
        assert_eq!(reader.snapshot("test", key).unwrap(), expected);
        assert_eq!(snapshot(&backup, "test", key).unwrap(), expected);
    }
    drop(reader);
    owner.shutdown().unwrap();
}

#[test]
fn backup_survives_missing_runtime_without_relaxing_destination_checks() {
    use std::os::unix::fs::symlink;
    let (path, owner, client) = fixture("backup-missing-runtime");
    let external = directory("backup-missing-runtime-external");
    owner.backup(&external.join("before.db")).unwrap();
    set(&client, "wal-only", "committed")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(path.join("print-partner.db-wal").metadata().unwrap().len() > 32);
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.join(".desktop-owner.json")).unwrap()).unwrap();
    let runtime = PathBuf::from(marker["runtime_dir"].as_str().unwrap());
    assert_eq!(std::fs::read_dir(&runtime).unwrap().count(), 0);
    std::fs::remove_dir(&runtime).unwrap();
    let existing = external.join("existing.db");
    std::fs::write(&existing, b"preserve").unwrap();
    symlink(&existing, external.join("existing-link.db")).unwrap();
    symlink(external.join("absent.db"), external.join("dangling.db")).unwrap();
    symlink(&path, external.join("data-alias")).unwrap();
    for destination in [
        path.join("backup.db"),
        runtime.join("backup.db"),
        external.join("data-alias/backup.db"),
        existing.clone(),
        external.join("existing-link.db"),
        external.join("dangling.db"),
    ] {
        assert!(owner.backup(&destination).is_err());
    }
    assert_eq!(std::fs::read(existing).unwrap(), b"preserve");
    let target = external.join("after.db");
    let result = owner.backup(&target);
    assert!(!runtime.exists());
    owner.shutdown().unwrap();
    result.unwrap();
    let backup = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        snapshot(&backup, "test", "wal-only").unwrap(),
        SettingSnapshot::Stored {
            value: "committed".into()
        }
    );
    assert_eq!(
        backup
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(backup);
    std::fs::remove_dir_all(external).unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn shutdown_with_held_reader_fails_bounded_and_retains_ownership() {
    let (path, owner, client) = fixture("held-reader");
    let marker = std::fs::read(path.join(".desktop-owner.json")).unwrap();
    let read = client.reader(Duration::ZERO).unwrap();
    let started = Instant::now();
    let error = owner.shutdown().unwrap_err().to_string();
    assert!(error.contains("Reader checkouts still active after 5s: 1"));
    assert!(started.elapsed() < READER_DRAIN + Duration::from_secs(5));
    assert!(
        set(&client, "after-stop", "no")
            .unwrap_err()
            .to_string()
            .contains("stopped")
    );
    assert_eq!(
        read.snapshot("test", "after-stop").unwrap(),
        SettingSnapshot::Missing
    );
    drop(read);
    assert_eq!(
        std::fs::read(path.join(".desktop-owner.json")).unwrap(),
        marker
    );
    assert!(lease::StorageLease::acquire(&path).is_err());
    assert!(lease::StorageLease::retry_failed_release(&path).is_err());
}

#[test]
fn failed_cleanup_retains_marker_and_lock_until_explicit_retry() {
    use fs2::FileExt;
    let (path, owner, _) = fixture("retained-release");
    let marker = std::fs::read(path.join(".desktop-owner.json")).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&marker).unwrap();
    let runtime = PathBuf::from(value["runtime_dir"].as_str().unwrap());
    let blocker = runtime.join("block-release");
    std::fs::write(&blocker, b"retain").unwrap();
    assert!(owner.shutdown().is_err());
    assert_eq!(
        std::fs::read(path.join(".desktop-owner.json")).unwrap(),
        marker
    );
    assert!(lease::StorageLease::acquire(&path).is_err());
    assert!(
        std::fs::File::open(path.join(".desktop.lock"))
            .unwrap()
            .try_lock_exclusive()
            .is_err()
    );
    let again = lease::StorageLease::retry_failed_release(&path).unwrap();
    assert!(again.ownership_retained && !again.marker_removed && !again.lock_released);
    std::fs::remove_file(blocker).unwrap();
    let released = lease::StorageLease::retry_failed_release(&path).unwrap();
    assert!(
        released.marker_removed
            && released.runtime_removed
            && released.lock_released
            && !released.ownership_retained
    );
    let next = lease::StorageLease::acquire(&path).unwrap().release();
    assert!(next.lock_released);
}

#[test]
fn wal_only_unsupported_versions_preserve_every_input_file() {
    use sha2::{Digest, Sha256};
    let tree = |path: &Path| {
        let mut entries: Vec<_> = std::fs::read_dir(path)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name(),
                    Sha256::digest(std::fs::read(entry.path()).unwrap()).to_vec(),
                )
            })
            .collect();
        entries.sort();
        entries
    };
    for stale_marker in [false, true] {
        for version in [30, 35] {
            for with_shm in [false, true] {
                let source = directory("wal-source");
                let raw = Connection::open(source.join("print-partner.db")).unwrap();
                raw.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE app_settings(tenant_id TEXT,key TEXT,value TEXT); INSERT INTO app_settings VALUES('default','schema_version','34'); PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
                raw.execute("UPDATE app_settings SET value=?1", [version.to_string()])
                    .unwrap();
                let target = directory("wal-rejection");
                for suffix in if with_shm {
                    vec!["", "-wal", "-shm"]
                } else {
                    vec!["", "-wal"]
                } {
                    std::fs::copy(
                        source.join(format!("print-partner.db{suffix}")),
                        target.join(format!("print-partner.db{suffix}")),
                    )
                    .unwrap();
                }
                std::fs::write(target.join("retain-user-file"), b"untouched").unwrap();
                if stale_marker {
                    let pid = exited_true_pid();
                    std::fs::write(
                        target.join(".desktop-owner.json"),
                        serde_json::json!({"storage_protocol_version": 1, "pid": pid}).to_string(),
                    )
                    .unwrap();
                }
                let before = tree(&target);
                let error = WriterOwner::open(&target, Limits::default())
                    .err()
                    .unwrap()
                    .to_string();
                assert!(error.contains(&format!("version {version}")), "{error}");
                assert_eq!(tree(&target), before);
            }
        }
    }
}

#[test]
fn unproved_closure_cannot_be_released_by_cleanup_retry() {
    use fs2::FileExt;
    let path = directory("unproved-closure");
    let owner = lease::StorageLease::acquire(&path).unwrap();
    let marker = std::fs::read(path.join(".desktop-owner.json")).unwrap();
    owner.retain_until_process_exit();
    let error = lease::StorageLease::retry_failed_release(&path)
        .err()
        .unwrap();
    assert!(error.to_string().contains("Closure was not proved"));
    assert_eq!(
        std::fs::read(path.join(".desktop-owner.json")).unwrap(),
        marker
    );
    assert!(
        std::fs::File::open(path.join(".desktop.lock"))
            .unwrap()
            .try_lock_exclusive()
            .is_err()
    );
    assert!(lease::StorageLease::acquire(&path).is_err());
}

#[test]
fn public_open_recovers_dead_writer_marker_and_atomic_lease() {
    let (path, owner, client) = fixture("crash-reopen");
    set(&client, "survives", "crash")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
    owner.shutdown().unwrap();
    let pid = exited_true_pid();
    let marker = serde_json::json!({"storage_protocol_version": 1, "pid": pid, "process_identity": "prior-process", "instance": "ab".repeat(16)});
    std::fs::write(path.join(".desktop-owner.json"), marker.to_string()).unwrap();
    std::fs::create_dir(path.join(".desktop-lease")).unwrap();
    std::fs::write(path.join(".desktop-lease/owner.json"), marker.to_string()).unwrap();
    let (reopened, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let client = reopened.client();
    let reader = client.reader(Duration::ZERO).unwrap();
    assert_eq!(
        reader.snapshot("test", "survives").unwrap(),
        SettingSnapshot::Stored {
            value: "crash".into()
        }
    );
    drop(reader);
    reopened.shutdown().unwrap();
    assert!(!path.join(".desktop-owner.json").exists());
    assert!(!path.join(".desktop-lease").exists());
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn unowned_preflight_rejects_live_and_invalid_markers_without_changes() {
    let mut prior = Command::new("/usr/bin/true").spawn().unwrap();
    let pid = prior.id();
    prior.wait().unwrap();
    let child = lease::current_process_identity();
    for contents in [
        serde_json::json!({"pid": std::process::id()}).to_string(),
        serde_json::json!({"pid": 0}).to_string(),
        "not json".into(),
        // A dead legacy Rust owner may have left an unrecorded child holding storage.
        serde_json::json!({"pid": pid, "process_identity": "prior"}).to_string(),
        // A dead owner whose recorded child is still alive keeps storage blocked.
        serde_json::json!({"storage_protocol_version": 1, "pid": pid, "process_identity": "prior", "child_pid": std::process::id(), "child_process_identity": child}).to_string(),
    ] {
        let path = directory("blocked-marker");
        std::fs::write(path.join(".desktop-owner.json"), &contents).unwrap();
        assert!(WriterOwner::open(&path, Limits::default()).is_err());
        assert_eq!(
            std::fs::read_to_string(path.join(".desktop-owner.json")).unwrap(),
            contents
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
        std::fs::remove_dir_all(path).unwrap();
    }
    let path = directory("unreadable-marker");
    std::fs::create_dir(path.join(".desktop-owner.json")).unwrap();
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
    assert!(path.join(".desktop-owner.json").is_dir());
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    std::fs::remove_dir_all(path).unwrap();
}

const SCHEMA_PARITY_NODE_VERSION: &str = "v22.23.3";
const SCHEMA_PARITY_NODE_ABI: &str = "127";

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaParityNodeIdentity {
    exec_path: PathBuf,
    version: String,
    abi: String,
}

fn require_schema_parity_runtime(identity: &SchemaParityNodeIdentity) -> anyhow::Result<()> {
    anyhow::ensure!(
        identity.version == SCHEMA_PARITY_NODE_VERSION && identity.abi == SCHEMA_PARITY_NODE_ABI,
        "schema fixtures require Node {SCHEMA_PARITY_NODE_VERSION} ABI {SCHEMA_PARITY_NODE_ABI}, found {} ABI {}",
        identity.version,
        identity.abi
    );
    Ok(())
}

fn schema_parity_node_identity(node: &Path) -> anyhow::Result<SchemaParityNodeIdentity> {
    let output = Command::new(node)
        .args([
            "--eval",
            "process.stdout.write(JSON.stringify({execPath:process.execPath,version:process.version,abi:process.versions.modules}))",
        ])
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "Node identity probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let identity: SchemaParityNodeIdentity = serde_json::from_slice(&output.stdout)?;
    anyhow::ensure!(
        std::fs::canonicalize(&identity.exec_path)? == std::fs::canonicalize(node)?,
        "fixture node must be its actual executable, not a dispatcher script"
    );
    require_schema_parity_runtime(&identity)?;
    Ok(identity)
}

#[test]
fn ticket_t_7_migrations_requires_pinned_runtime_identity() {
    let identity = schema_parity_node_identity(&schema_parity_node()).unwrap();
    assert_eq!(identity.version, "v22.23.3");
    assert_eq!(identity.abi, "127");
    let mut wrong_version = identity.clone();
    wrong_version.version = "v24.21.0".into();
    assert!(require_schema_parity_runtime(&wrong_version).is_err());
    let mut wrong_abi = identity;
    wrong_abi.abi = "137".into();
    assert!(require_schema_parity_runtime(&wrong_abi).is_err());
}

#[test]
fn ticket_t_7_migrations_refuses_dispatcher_script() {
    use std::os::unix::fs::PermissionsExt;

    let root = directory("schema-node-dispatcher");
    let wrapper = root.join("node-wrapper");
    let node = schema_parity_node();
    let escaped = node.to_str().unwrap().replace('\'', "'\\''");
    std::fs::write(&wrapper, format!("#!/bin/sh\nexec '{escaped}' \"$@\"\n")).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let error = match schema_parity_node_identity(&wrapper) {
        Ok(_) => panic!("accepted a Node dispatcher"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("not a dispatcher script"), "{error}");
    std::fs::remove_dir_all(root).unwrap();
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SchemaGraph {
    version: String,
    objects: BTreeMap<(String, String), (String, Option<String>)>,
    columns: BTreeMap<String, Vec<String>>,
    foreign_keys: BTreeMap<String, Vec<String>>,
    rows: BTreeMap<String, Vec<String>>,
}

fn schema_parity_node() -> PathBuf {
    if let Ok(path) = std::env::var("PP_SCHEMA_PARITY_NODE") {
        return PathBuf::from(path);
    }
    let pinned = PathBuf::from(
        "/var/lib/agent-fleet-runtime-owner/runtime-root/releases/node-project-22.23.3-bb2b080fb03ea1f2/bin/node",
    );
    if pinned.is_file() {
        return pinned;
    }
    for dir in std::env::var("PATH").unwrap_or_default().split(':') {
        let candidate = PathBuf::from(dir).join("node");
        if candidate.is_file() {
            return candidate;
        }
    }
    panic!("node binary for schema fixtures was not found");
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn value_token(value: rusqlite::types::Value) -> String {
    match value {
        rusqlite::types::Value::Null => "<null>".to_owned(),
        rusqlite::types::Value::Integer(value) => value.to_string(),
        rusqlite::types::Value::Real(value) => value.to_string(),
        rusqlite::types::Value::Text(value) => value,
        rusqlite::types::Value::Blob(value) => hex::encode(value),
    }
}

fn tree_hashes(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if !dir.exists() {
            continue;
        }
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap())
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let digest = hex::encode(Sha256::digest(std::fs::read(&path).unwrap()));
            (relative, digest)
        })
        .collect()
}

fn copy_db_files(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    if !from.is_dir() {
        return;
    }
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let label = name.to_string_lossy();
        if label.starts_with("print-partner.db") && entry.path().is_file() {
            std::fs::copy(entry.path(), to.join(name)).unwrap();
        }
    }
}

fn read_schema_graph(db: &Path) -> SchemaGraph {
    let conn = Connection::open(db).unwrap();
    let version: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut objects = BTreeMap::new();
    let mut statement = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
    let listed = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .unwrap();
    for row in listed {
        let (kind, name, table, sql) = row.unwrap();
        assert!(
            objects.insert((kind, name), (table, sql)).is_none(),
            "duplicate sqlite_master name"
        );
    }
    drop(statement);
    let tables: Vec<String> = objects
        .iter()
        .filter(|((kind, _), _)| kind == "table")
        .map(|((_, name), _)| name.clone())
        .collect();
    let mut columns = BTreeMap::new();
    let mut foreign_keys = BTreeMap::new();
    let mut rows = BTreeMap::new();
    for table in tables {
        let ident = quote_ident(&table);
        let mut info = conn
            .prepare(&format!("PRAGMA table_info({ident})"))
            .unwrap();
        let mut names = Vec::new();
        let defs = info
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let line = format!(
                    "{}\u{1f}{name}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
                    value_token(row.get(0)?),
                    value_token(row.get(2)?),
                    value_token(row.get(3)?),
                    value_token(row.get(4)?),
                    value_token(row.get(5)?),
                );
                Ok((name, line))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect::<Vec<_>>();
        drop(info);
        let defs: Vec<String> = defs
            .into_iter()
            .map(|(name, line)| {
                names.push(name);
                line
            })
            .collect();
        let mut listed = conn
            .prepare(&format!("PRAGMA foreign_key_list({ident})"))
            .unwrap();
        let keys = listed
            .query_map([], |row| {
                let mut parts = Vec::new();
                for index in 0..8 {
                    parts.push(value_token(row.get(index)?));
                }
                Ok(parts.join("\u{1f}"))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect::<Vec<_>>();
        drop(listed);
        let projected = names
            .iter()
            .map(|name| format!("quote({})", quote_ident(name)))
            .collect::<Vec<_>>()
            .join(", ");
        let mut data = conn
            .prepare(&format!(
                "SELECT {projected} FROM {ident} ORDER BY {projected}"
            ))
            .unwrap();
        let stored = data
            .query_map([], |row| {
                let mut cells = Vec::new();
                for index in 0..names.len() {
                    cells.push(row.get::<_, String>(index)?);
                }
                Ok(cells.join("\u{1e}"))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect::<Vec<_>>();
        columns.insert(table.clone(), defs);
        foreign_keys.insert(table.clone(), keys);
        rows.insert(table, stored);
    }
    SchemaGraph {
        version,
        objects,
        columns,
        foreign_keys,
        rows,
    }
}

fn map_diff(
    label: &str,
    left_map: &BTreeMap<String, Vec<String>>,
    right_map: &BTreeMap<String, Vec<String>>,
) -> Vec<String> {
    let mut tables: Vec<_> = left_map.keys().chain(right_map.keys()).collect();
    tables.sort();
    tables.dedup();
    tables
        .into_iter()
        .filter(|table| left_map.get(*table) != right_map.get(*table))
        .map(|table| format!("{label} {table}"))
        .collect()
}

fn graph_diff(left: &SchemaGraph, right: &SchemaGraph) -> Vec<String> {
    let mut diffs = Vec::new();
    if left.version != right.version {
        diffs.push(format!("version {} != {}", left.version, right.version));
    }
    if left.objects != right.objects {
        let mut keys: Vec<_> = left.objects.keys().chain(right.objects.keys()).collect();
        keys.sort();
        keys.dedup();
        for key in keys {
            if left.objects.get(key) != right.objects.get(key) {
                diffs.push(format!("object {} {}", key.0, key.1));
            }
        }
    }
    diffs.extend(map_diff("columns", &left.columns, &right.columns));
    diffs.extend(map_diff(
        "foreign_keys",
        &left.foreign_keys,
        &right.foreign_keys,
    ));
    diffs.extend(map_diff("rows", &left.rows, &right.rows));
    diffs.sort();
    diffs.dedup();
    diffs
}

fn rewrite_sql(graph: &mut SchemaGraph, needle: &str, replacement: &str) -> String {
    for ((kind, name), (_, sql)) in &mut graph.objects {
        let Some(sql) = sql.as_mut() else {
            continue;
        };
        let Some(index) = sql.find(needle) else {
            continue;
        };
        sql.replace_range(index..index + needle.len(), replacement);
        return format!("{kind} {name}");
    }
    panic!("fixture SQL has no {needle}");
}

fn drift_controls(source: &SchemaGraph) -> Vec<(&'static str, SchemaGraph)> {
    let mut check = source.clone();
    rewrite_sql(&mut check, "CHECK", "CHECK /*drift*/");
    let mut default = source.clone();
    rewrite_sql(&mut default, "DEFAULT", "DEFAULT /*drift*/");
    let mut foreign_key = source.clone();
    rewrite_sql(&mut foreign_key, "REFERENCES", "REFERENCES /*drift*/");
    let keys = foreign_key
        .foreign_keys
        .values_mut()
        .find(|keys| !keys.is_empty())
        .unwrap();
    keys[0].push_str("|drift");
    let mut index = source.clone();
    let index_key = index
        .objects
        .iter()
        .find(|((kind, _), (_, sql))| kind == "index" && sql.is_some())
        .map(|(key, _)| key.clone())
        .unwrap();
    index.objects.remove(&index_key);
    let mut trigger = source.clone();
    let trigger_sql = trigger
        .objects
        .iter_mut()
        .find(|((kind, _), _)| kind == "trigger")
        .map(|(_, (_, sql))| sql.as_mut().unwrap())
        .unwrap();
    trigger_sql.push_str(" /*drift*/");
    let mut tenant = source.clone();
    let row = tenant
        .rows
        .get_mut("app_settings")
        .unwrap()
        .iter_mut()
        .find(|row| row.contains("'tenant-a'"))
        .unwrap();
    *row = row.replacen("'tenant-a'", "'tenant-drift'", 1);
    let mut order = source.clone();
    let swapped = order.objects.iter_mut().find_map(|((kind, _), (_, sql))| {
        if kind != "table" {
            return None;
        }
        let sql = sql.as_mut()?;
        let left = "\n    id INTEGER";
        let right = "\n    tenant_id TEXT";
        if sql.contains(left) && sql.contains(right) {
            *sql = sql
                .replacen(left, "\n    \u{0}", 1)
                .replacen(right, left, 1)
                .replacen("\n    \u{0}", right, 1);
            Some(())
        } else {
            None
        }
    });
    assert!(swapped.is_some(), "no observed column pair to swap");
    vec![
        ("check", check),
        ("default", default),
        ("foreign-key", foreign_key),
        ("index", index),
        ("trigger", trigger),
        ("tenant", tenant),
        ("column-order", order),
    ]
}

fn open_parity(dir: &Path, clock: &str) -> (WriterOwner, SchemaReady) {
    WriterOwner::open_at(
        dir,
        Limits {
            queued_writes: 2,
            readers: 2,
        },
        clock,
    )
    .unwrap()
}

fn apply_parity_settings(owner: &WriterOwner) {
    let client = owner.client();
    let cancelled = AtomicBool::new(false);
    let wait = Duration::from_secs(5);
    for (tenant, key, value) in [
        ("tenant-a", "discord_notify_on_update", "1"),
        ("tenant-b", "discord_notify_on_update", "0"),
        ("tenant-a", "discord_notify_on_sync", ""),
    ] {
        client
            .submit(
                SettingCommand::Set(Setting {
                    tenant: tenant.into(),
                    key: key.into(),
                    value: value.into(),
                }),
                &cancelled,
                wait,
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
    }
    let read = client.reader(Duration::ZERO).unwrap();
    assert_eq!(
        read.snapshot("tenant-a", "discord_notify_on_sync").unwrap(),
        SettingSnapshot::Stored {
            value: String::new()
        }
    );
    drop(read);
    for (expected, value, outcome) in [
        (
            SettingSnapshot::Stored {
                value: String::new(),
            },
            "1",
            true,
        ),
        (SettingSnapshot::Missing, "wrong", false),
    ] {
        let applied = client
            .submit(
                SettingCommand::CompareAndSet {
                    setting: Setting {
                        tenant: "tenant-a".into(),
                        key: "discord_notify_on_sync".into(),
                        value: value.into(),
                    },
                    expected,
                },
                &cancelled,
                wait,
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        assert_eq!(applied, outcome);
    }
}

fn schema_version_at(path: &Path) -> String {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[derive(Debug, PartialEq, Eq)]
enum FixtureRefusal {
    HistoricalClaim,
    RejectedKind,
    ShapeMismatch,
}

struct GeneratedFixture {
    name: String,
    initial: u64,
    shape_group: String,
    transformations: Vec<String>,
    source: PathBuf,
    expected_dir: PathBuf,
}

fn steps_are(steps: &[String], expected: &[&str]) -> bool {
    steps.len() == expected.len()
        && steps
            .iter()
            .zip(expected)
            .all(|(step, expected)| step == expected)
}

fn listed_shape(group: &str, initial: u64, steps: &[String]) -> bool {
    match group {
        "empty-directory" => {
            initial == 0 && steps_are(steps, &["node-connect-from-empty-directory"])
        }
        "generated-v34-minus-board-and-legacy-column" => {
            initial == 31
                && steps_are(
                    steps,
                    &[
                        "node-connect-current-schema",
                        "insert-tenant-claimed-project",
                        "drop-board-posts-and-board-comments",
                        "drop-projects-legacy-manifest-cutover",
                        "stamp-schema-version",
                    ],
                )
        }
        "generated-v34-minus-board-tables" => {
            (initial == 32 || initial == 33)
                && steps_are(
                    steps,
                    &[
                        "node-connect-current-schema",
                        "insert-tenant-claimed-project",
                        "drop-board-posts-and-board-comments",
                        "stamp-schema-version",
                    ],
                )
        }
        "generated-v34-current" => {
            initial == 34
                && steps_are(
                    steps,
                    &[
                        "node-connect-current-schema",
                        "insert-tenant-claimed-project",
                        "stamp-schema-version",
                    ],
                )
        }
        "generated-v34-current-autosave" => {
            initial == 34
                && steps_are(
                    steps,
                    &[
                        "node-connect-current-schema",
                        "replace-rows-from-autosave-golden",
                        "stamp-schema-version",
                    ],
                )
        }
        _ => false,
    }
}

fn accept_generated_fixture(case: &serde_json::Value) -> Result<GeneratedFixture, FixtureRefusal> {
    let kind = case["kind"].as_str().unwrap_or("");
    let historical = case["historicalSnapshot"].as_bool();
    if kind == "historical-snapshot" || historical == Some(true) {
        return Err(FixtureRefusal::HistoricalClaim);
    }
    if kind != "generated-current-node" || historical != Some(false) {
        return Err(FixtureRefusal::RejectedKind);
    }
    if case["sourceSchemaVersion"].as_u64() != Some(34) {
        return Err(FixtureRefusal::RejectedKind);
    }
    let name = case["name"]
        .as_str()
        .ok_or(FixtureRefusal::RejectedKind)?
        .to_owned();
    let initial = case["startingVersionStamp"]
        .as_u64()
        .ok_or(FixtureRefusal::RejectedKind)?;
    if case["version"].as_u64() != Some(initial) {
        return Err(FixtureRefusal::RejectedKind);
    }
    let shape_group = case["shapeGroup"]
        .as_str()
        .ok_or(FixtureRefusal::RejectedKind)?
        .to_owned();
    let transformations = case["transformations"]
        .as_array()
        .ok_or(FixtureRefusal::RejectedKind)?
        .iter()
        .map(|step| {
            step.as_str()
                .ok_or(FixtureRefusal::RejectedKind)
                .map(str::to_owned)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !listed_shape(&shape_group, initial, &transformations) {
        return Err(FixtureRefusal::ShapeMismatch);
    }
    Ok(GeneratedFixture {
        name,
        initial,
        shape_group,
        transformations,
        source: PathBuf::from(case["rust"].as_str().ok_or(FixtureRefusal::RejectedKind)?),
        expected_dir: PathBuf::from(
            case["expected"]
                .as_str()
                .ok_or(FixtureRefusal::RejectedKind)?,
        ),
    })
}

fn file_list(value: &serde_json::Value) -> Vec<(String, String)> {
    let mut files = value
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["path"].as_str().unwrap().to_owned(),
                row["sha256"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn cache_material(meta: &serde_json::Value, generator_sha: &str) -> String {
    let mut lines = vec![
        generator_sha.to_owned(),
        meta["node"].as_str().unwrap().to_owned(),
        meta["abi"].as_str().unwrap().to_owned(),
        meta["sourceSchemaVersion"].as_u64().unwrap().to_string(),
        meta["nodeSha256"].as_str().unwrap().to_owned(),
        meta["clock"].as_str().unwrap().to_owned(),
    ];
    for case in meta["inputs"].as_array().unwrap() {
        let steps = case["transformations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(",");
        lines.push(format!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            case["name"].as_str().unwrap(),
            case["kind"].as_str().unwrap(),
            case["historicalSnapshot"].as_bool().unwrap(),
            case["shapeGroup"].as_str().unwrap(),
            case["startingVersionStamp"].as_u64().unwrap(),
            steps,
        ));
    }
    format!("{}\n", lines.join("\n"))
}

fn table_present(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .unwrap()
        == 1
}

fn column_present(conn: &Connection, table: &str, column: &str) -> bool {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({})", quote_ident(table)))
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(|name| name.unwrap())
        .any(|name| name == column)
}

fn require_observed_shape(fixture: &GeneratedFixture) {
    if fixture.shape_group == "empty-directory" {
        assert!(
            tree_hashes(&fixture.source).is_empty(),
            "{} input was not an empty directory",
            fixture.name
        );
        return;
    }
    let scratch = directory(&format!("generated-shape-{}", fixture.name));
    let database = scratch.join("print-partner.db");
    std::fs::copy(fixture.source.join("print-partner.db"), &database).unwrap();
    let conn = Connection::open(&database).unwrap();
    let board_posts = table_present(&conn, "board_posts");
    let board_comments = table_present(&conn, "board_comments");
    let legacy = column_present(&conn, "projects", "legacy_manifest_cutover");
    let stamp: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stamp, fixture.initial.to_string(), "{}", fixture.name);
    let marks = (board_posts, board_comments, legacy);
    let expected = match fixture.shape_group.as_str() {
        "generated-v34-minus-board-and-legacy-column" => (false, false, false),
        "generated-v34-minus-board-tables" => (false, false, true),
        "generated-v34-current" | "generated-v34-current-autosave" => (true, true, true),
        other => panic!("{} has unexpected shape group {other}", fixture.name),
    };
    assert_eq!(
        marks, expected,
        "{} shape {} did not match the input database",
        fixture.name, fixture.shape_group
    );
}

fn sequence_identities(graph: &SchemaGraph) -> Vec<String> {
    graph
        .rows
        .get("sqlite_sequence")
        .map(|rows| {
            rows.iter()
                .map(|row| row.split('\u{1e}').next().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

// Generated Node schema 34 fixtures with recorded manual edits.
// Passing this test does not prove a copied historical database or schema 32 to 33 migration order.
#[test]
fn ticket_t_7_migrations() {
    let node = schema_parity_node();
    let identity = schema_parity_node_identity(&node).unwrap();
    let bytes = std::fs::read(&node).unwrap();
    let node_hash = hex::encode(Sha256::digest(&bytes));
    let root = directory("schema-parity-fixtures");
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../web");
    let output = std::process::Command::new(&node)
        .current_dir(&web)
        .args([
            "--conditions=development",
            "--import",
            "tsx",
            "scripts/storage-fixtures/prepare.mts",
        ])
        .arg(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "node fixture prepare failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("fixtures.json")).unwrap()).unwrap();
    let clock = meta["clock"].as_str().unwrap().to_owned();
    let node_version = meta["node"].as_str().unwrap();
    let abi = meta["abi"].as_str().unwrap();
    assert_eq!(node_version, identity.version);
    assert_eq!(abi, identity.abi);
    assert_eq!(meta["nodeSha256"].as_str().unwrap(), node_hash);
    assert_eq!(
        meta["contract"].as_str().unwrap(),
        "generated-fixture-compatibility"
    );
    assert!(!meta["historicalSnapshot"].as_bool().unwrap());
    assert_eq!(meta["sourceSchemaVersion"].as_u64().unwrap(), 34);
    let generator = web.join("scripts/storage-fixtures/prepare.mts");
    let generator_sha = hex::encode(Sha256::digest(std::fs::read(&generator).unwrap()));
    assert_eq!(meta["generatorSha256"].as_str().unwrap(), generator_sha);
    let cache_key = hex::encode(Sha256::digest(
        cache_material(&meta, &generator_sha).as_bytes(),
    ));
    assert_eq!(meta["cacheKey"].as_str().unwrap(), cache_key);
    let mut forged = meta["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "schema-31")
        .unwrap()
        .clone();
    forged["kind"] = serde_json::json!("historical-snapshot");
    assert!(matches!(
        accept_generated_fixture(&forged),
        Err(FixtureRefusal::HistoricalClaim)
    ));
    let mut names = Vec::new();
    let mut fresh_graph = None;
    let mut opened = Vec::new();
    for case in meta["inputs"].as_array().unwrap() {
        let fixture = accept_generated_fixture(case).unwrap_or_else(|reason| {
            panic!(
                "{} generated fixture was refused: {reason:?}",
                case["name"].as_str().unwrap_or("unnamed")
            )
        });
        let name = fixture.name.clone();
        names.push(name.clone());
        let initial = fixture.initial;
        let source = fixture.source.clone();
        let expected = fixture.expected_dir.join("print-partner.db");
        let before_source = tree_hashes(&source);
        assert_eq!(
            before_source,
            file_list(&case["rustFiles"]),
            "{name} rust input hash"
        );
        assert_eq!(
            tree_hashes(&fixture.expected_dir),
            file_list(&case["expectedFiles"]),
            "{name} expected hash"
        );
        require_observed_shape(&fixture);
        assert_eq!(
            tree_hashes(&source),
            before_source,
            "{name} shape read changed the input"
        );
        opened.push((
            name.clone(),
            initial,
            fixture.shape_group.clone(),
            fixture.transformations.clone(),
            file_list(&case["expectedFiles"]),
        ));
        let work = directory(&format!("schema-parity-{name}"));
        copy_db_files(&source, &work);
        let before_work = tree_hashes(&work);
        if initial == 0 {
            assert!(before_work.is_empty(), "{name} input was not empty");
        } else {
            assert!(
                before_work
                    .iter()
                    .any(|(file, _)| file == "print-partner.db"),
                "{name} had no copied database"
            );
        }
        let (owner, ready) = open_parity(&work, &clock);
        assert_eq!(ready.version, 34, "{name}");
        assert_eq!(ready.previous_version, initial, "{name}");
        let backup = ready.backup.clone();
        if (1..34).contains(&initial) {
            assert_eq!(
                schema_version_at(backup.as_ref().unwrap()),
                initial.to_string(),
                "{name}"
            );
        } else {
            assert!(backup.is_none(), "{name}");
        }
        apply_parity_settings(&owner);
        owner.shutdown().unwrap();
        assert_eq!(tree_hashes(&source), before_source, "{name} source changed");
        let observed = read_schema_graph(&work.join("print-partner.db"));
        let node_graph = read_schema_graph(&expected);
        let diff = graph_diff(&node_graph, &observed);
        assert!(diff.is_empty(), "{name} node {node_version}: {diff:#?}");
        let backup_bytes = backup.as_ref().map(|path| std::fs::read(path).unwrap());
        let (reopened, again) = open_parity(&work, &clock);
        assert_eq!(again.version, 34);
        assert_eq!(again.previous_version, 34);
        assert!(again.backup.is_none());
        reopened.shutdown().unwrap();
        if let Some(bytes) = backup_bytes {
            assert_eq!(std::fs::read(backup.unwrap()).unwrap(), bytes);
        }
        let reopened_graph = read_schema_graph(&work.join("print-partner.db"));
        let mut reopened_diff = graph_diff(&node_graph, &reopened_graph);
        // Seed replay uses INSERT OR IGNORE. SQLite can advance sqlite_sequence.seq
        // while the named rows stay in place. Any other row payload still fails the diff.
        if sequence_identities(&node_graph) == sequence_identities(&reopened_graph) {
            reopened_diff.retain(|line| line != "rows sqlite_sequence");
        }
        assert!(
            reopened_diff.is_empty(),
            "{name} reopen: {reopened_diff:#?}"
        );
        if name == "fresh" {
            fresh_graph = Some(node_graph);
        }
    }
    assert_eq!(
        names,
        [
            "fresh",
            "schema-31",
            "schema-32",
            "schema-33",
            "schema-34",
            "immutable-corpus"
        ]
    );
    let find = |label: &str| {
        opened
            .iter()
            .find(|(name, ..)| name == label)
            .unwrap_or_else(|| panic!("missing {label}"))
    };
    let schema_32 = find("schema-32");
    let schema_33 = find("schema-33");
    assert_eq!(schema_32.1, 32);
    assert_eq!(schema_33.1, 33);
    assert_eq!(schema_32.2, "generated-v34-minus-board-tables");
    assert_eq!(schema_33.2, schema_32.2);
    assert_eq!(schema_33.3, schema_32.3);
    assert_eq!(
        schema_32.4, schema_33.4,
        "schema-32 and schema-33 share one generated shape, so their schema 34 endpoint trees match"
    );
    assert_eq!(
        meta["sameGeneratedShape"]["shapeGroup"].as_str().unwrap(),
        "generated-v34-minus-board-tables"
    );
    assert!(
        meta["sameGeneratedShape"]["expectedTreesEqual"]
            .as_bool()
            .unwrap()
    );
    let fresh = fresh_graph.unwrap();
    for (label, drifted) in drift_controls(&fresh) {
        let diff = graph_diff(&fresh, &drifted);
        assert!(!diff.is_empty(), "{label} drift was accepted: {diff:#?}");
    }
}

fn refused_wal_input(version: &str) -> PathBuf {
    let source = directory("refuse-source");
    let raw = Connection::open(source.join("print-partner.db")).unwrap();
    raw.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE app_settings(tenant_id TEXT, key TEXT, value TEXT); INSERT INTO app_settings VALUES('default','schema_version','34'); PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    raw.execute("UPDATE app_settings SET value=?1", [version])
        .unwrap();
    let target = directory("refuse-target");
    for suffix in ["", "-wal", "-shm"] {
        let from = source.join(format!("print-partner.db{suffix}"));
        if from.is_file() {
            std::fs::copy(&from, target.join(from.file_name().unwrap())).unwrap();
        }
    }
    drop(raw);
    std::fs::write(target.join("retain-user-file"), b"untouched").unwrap();
    assert!(target.join("print-partner.db-wal").is_file());
    assert!(target.join("print-partner.db-shm").is_file());
    target
}

fn assert_refused(path: &Path, message: &str) {
    let before = tree_hashes(path);
    assert!(
        before.iter().any(|(file, _)| file == "print-partner.db")
            && before.iter().any(|(file, _)| file == "retain-user-file")
    );
    let error = WriterOwner::open(path, Limits::default())
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains(message), "{error}");
    assert_eq!(tree_hashes(path), before);
}

#[test]
fn ticket_t_7_migrations_preserves_refused_inputs() {
    assert_refused(
        &refused_wal_input("30"),
        "Cannot upgrade database schema version 30",
    );
    assert_refused(&refused_wal_input("35"), "newer than supported version 34");
    assert_refused(&refused_wal_input("abc"), "Invalid database schema version");
    let corrupt = directory("refuse-corrupt");
    std::fs::write(corrupt.join("print-partner.db"), b"not a sqlite database").unwrap();
    std::fs::write(corrupt.join("print-partner.db-wal"), b"wal-bytes").unwrap();
    std::fs::write(corrupt.join("print-partner.db-shm"), b"shm-bytes").unwrap();
    std::fs::write(corrupt.join("retain-user-file"), b"untouched").unwrap();
    let before = tree_hashes(&corrupt);
    let error = WriterOwner::open(&corrupt, Limits::default())
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains("integrity")
            || error.contains("not a database")
            || error.contains("file is not a database"),
        "{error}"
    );
    assert_eq!(tree_hashes(&corrupt), before);
}

#[test]
fn ticket_t_7_writer_reads_wal_full_and_rejects_reader_writes() {
    let (path, owner, client) = fixture("t7-pragma");
    set(&client, "durable", "kept")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(path.join("print-partner.db-wal").metadata().unwrap().len() > 32);
    let read = client.reader(Duration::ZERO).unwrap();
    let conn = read.connection.as_ref().unwrap();
    assert_eq!(
        conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(pragma_value(conn, "foreign_keys"), 1);
    assert_eq!(pragma_value(conn, "busy_timeout"), 5000);
    assert_eq!(pragma_value(conn, "synchronous"), 2);
    assert_eq!(pragma_value(conn, "query_only"), 1);
    conn.execute_batch("PRAGMA query_only=OFF; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=0;")
        .unwrap();
    let write_error = conn
        .execute("INSERT INTO app_settings VALUES('test','escape','no')", [])
        .unwrap_err()
        .to_string();
    assert!(
        write_error.to_lowercase().contains("readonly"),
        "{write_error}"
    );
    drop(read);
    let read = client.reader(Duration::ZERO).unwrap();
    let conn = read.connection.as_ref().unwrap();
    assert_eq!(
        conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(pragma_value(conn, "foreign_keys"), 1);
    assert_eq!(pragma_value(conn, "busy_timeout"), 5000);
    assert_eq!(pragma_value(conn, "synchronous"), 2);
    assert_eq!(pragma_value(conn, "query_only"), 1);
    assert_eq!(
        read.snapshot("test", "durable").unwrap(),
        SettingSnapshot::Stored {
            value: "kept".into()
        }
    );
    assert_eq!(
        read.snapshot("test", "escape").unwrap(),
        SettingSnapshot::Missing
    );
    drop(read);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let read = owner.client().reader(Duration::ZERO).unwrap();
    assert_eq!(
        read.snapshot("test", "durable").unwrap(),
        SettingSnapshot::Stored {
            value: "kept".into()
        }
    );
    drop(read);
    owner.shutdown().unwrap();
}

fn pragma_value(connection: &Connection, name: &str) -> i64 {
    connection
        .pragma_query_value(None, name, |row| row.get(0))
        .unwrap()
}

#[test]
fn ticket_t_7_writer_rolls_back_and_refuses_a_second_runtime() {
    let (path, owner, client) = fixture("t7-rollback");
    let second = match WriterOwner::open(&path, Limits::default()) {
        Ok(_) => panic!("second runtime opened the same directory"),
        Err(error) => error.to_string(),
    };
    assert!(second.contains("Data directory already owned"), "{second}");
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute_batch("CREATE TRIGGER reject_partial BEFORE INSERT ON app_settings WHEN NEW.key='reject' BEGIN INSERT INTO app_settings VALUES('test','partial','leaked'); SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    let rejected = set(&client, "reject", "no")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap_err()
        .to_string();
    assert!(rejected.contains("injected failure"), "{rejected}");
    set(&client, "stable", "v1")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let mismatched = client
        .submit(
            SettingCommand::CompareAndSet {
                setting: Setting {
                    tenant: "test".into(),
                    key: "stable".into(),
                    value: "v2".into(),
                },
                expected: SettingSnapshot::Missing,
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(!mismatched.recv().unwrap().unwrap());
    let matched = client
        .submit(
            SettingCommand::CompareAndSet {
                setting: Setting {
                    tenant: "test".into(),
                    key: "stable".into(),
                    value: "v2".into(),
                },
                expected: SettingSnapshot::Stored { value: "v1".into() },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matched.recv().unwrap().unwrap());
    drop(raw);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let read = owner.client().reader(Duration::ZERO).unwrap();
    assert_eq!(
        read.snapshot("test", "partial").unwrap(),
        SettingSnapshot::Missing
    );
    assert_eq!(
        read.snapshot("test", "reject").unwrap(),
        SettingSnapshot::Missing
    );
    assert_eq!(
        read.snapshot("test", "stable").unwrap(),
        SettingSnapshot::Stored { value: "v2".into() }
    );
    drop(read);
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_7_writer_bounds_queue_contention_and_cancellation() {
    let (path, owner, client) = fixture("t7-queue");
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute_batch("BEGIN IMMEDIATE;").unwrap();
    let blocking = set(&client, "blocking", "yes").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !client.shared.queue.lock().unwrap().pending.is_empty() {
        assert!(Instant::now() < deadline, "writer never reached the lock");
        thread::yield_now();
    }
    let hidden = client.reader(Duration::ZERO).unwrap();
    assert_eq!(
        hidden.snapshot("test", "blocking").unwrap(),
        SettingSnapshot::Missing
    );
    drop(hidden);
    let admitted = set(&client, "admitted", "once").unwrap();
    let overflow = set(&client, "overflow", "no").unwrap_err().to_string();
    assert!(overflow.contains("Writer queue full"), "{overflow}");
    let cancel = Arc::new(AtomicBool::new(false));
    let waiting_client = client.clone();
    let waiting_cancel = cancel.clone();
    let waiting = thread::spawn(move || {
        waiting_client
            .submit(
                SettingCommand::Set(Setting {
                    tenant: "test".into(),
                    key: "cancelled".into(),
                    value: "no".into(),
                }),
                &waiting_cancel,
                Duration::from_secs(5),
            )
            .unwrap_err()
            .to_string()
    });
    cancel.store(true, Ordering::Release);
    let cancelled = waiting.join().unwrap();
    assert!(
        cancelled.contains("Cancelled before admission"),
        "{cancelled}"
    );
    raw.execute_batch("COMMIT").unwrap();
    assert!(blocking.recv().unwrap().unwrap());
    assert!(admitted.recv().unwrap().unwrap());
    drop(raw);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let read = owner.client().reader(Duration::ZERO).unwrap();
    assert_eq!(
        read.snapshot("test", "blocking").unwrap(),
        SettingSnapshot::Stored {
            value: "yes".into()
        }
    );
    assert_eq!(
        read.snapshot("test", "admitted").unwrap(),
        SettingSnapshot::Stored {
            value: "once".into()
        }
    );
    for key in ["overflow", "cancelled"] {
        assert_eq!(
            read.snapshot("test", key).unwrap(),
            SettingSnapshot::Missing
        );
    }
    drop(read);
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_7_writer_denies_managed_alias_backups_and_reopens() {
    use fs2::FileExt;
    use std::os::unix::fs::{MetadataExt, symlink};
    let (path, owner, client) = fixture("t7-backup");
    set(&client, "kept-a", "committed")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    set(&client, "kept-b", "committed")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(path.join("print-partner.db-wal").metadata().unwrap().len() > 32);
    let lock = path.join(".desktop.lock");
    let inode = std::fs::metadata(&lock).unwrap().ino();
    let marker = std::fs::read(path.join(".desktop-owner.json")).unwrap();
    let aliases = directory("t7-aliases");
    symlink(path.join("print-partner.db-wal"), aliases.join("wal-alias")).unwrap();
    symlink(&path, aliases.join("data")).unwrap();
    for target in [
        path.join("print-partner.db"),
        path.join("print-partner.db-wal"),
        path.join(".desktop.lock"),
        path.join(".desktop-owner.json"),
        aliases.join("wal-alias"),
        aliases.join("data/print-partner.db"),
    ] {
        let error = owner.backup(&target).unwrap_err().to_string();
        assert!(
            error.contains("managed storage") || error.contains("must be a new file"),
            "{target:?} {error}"
        );
        assert_eq!(std::fs::metadata(&lock).unwrap().ino(), inode);
        assert_eq!(
            std::fs::read(path.join(".desktop-owner.json")).unwrap(),
            marker
        );
        assert!(
            std::fs::File::open(&lock)
                .unwrap()
                .try_lock_exclusive()
                .is_err()
        );
    }
    let exported = aliases.join("offline.db");
    owner.backup(&exported).unwrap();
    owner.shutdown().unwrap();
    let backup = Connection::open_with_flags(&exported, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let read = owner.client().reader(Duration::ZERO).unwrap();
    for key in ["kept-a", "kept-b"] {
        let expected = SettingSnapshot::Stored {
            value: "committed".into(),
        };
        assert_eq!(read.snapshot("test", key).unwrap(), expected);
        assert_eq!(snapshot(&backup, "test", key).unwrap(), expected);
    }
    drop(read);
    drop(backup);
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_7_writer_retains_ownership_when_cleanup_fails() {
    use fs2::FileExt;
    let (path, owner, client) = fixture("t7-cleanup");
    set(&client, "kept", "yes")
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let marker = std::fs::read(path.join(".desktop-owner.json")).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&marker).unwrap();
    let runtime = PathBuf::from(value["runtime_dir"].as_str().unwrap());
    std::fs::write(runtime.join("block-release"), b"retain").unwrap();
    let error = owner.shutdown().unwrap_err().to_string();
    assert!(
        error.contains(
            "Storage cleanup failed; ownership retained until explicit retry or process exit"
        ),
        "{error}"
    );
    assert_eq!(
        std::fs::read(path.join(".desktop-owner.json")).unwrap(),
        marker
    );
    let blocked = match WriterOwner::open(&path, Limits::default()) {
        Ok(_) => panic!("cleanup failure released ownership"),
        Err(error) => error.to_string(),
    };
    assert!(
        blocked.contains("already owned") || blocked.contains("may still be alive"),
        "{blocked}"
    );
    assert!(
        std::fs::File::open(path.join(".desktop.lock"))
            .unwrap()
            .try_lock_exclusive()
            .is_err()
    );
    let retained = lease::StorageLease::retry_failed_release(&path).unwrap();
    assert!(retained.ownership_retained);
    assert!(!retained.marker_removed);
    assert!(!retained.lock_released);
    std::fs::remove_file(runtime.join("block-release")).unwrap();
    let released = lease::StorageLease::retry_failed_release(&path).unwrap();
    assert!(released.marker_removed);
    assert!(released.runtime_removed);
    assert!(released.lock_released);
    assert!(!released.ownership_retained);
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let read = owner.client().reader(Duration::ZERO).unwrap();
    assert_eq!(
        read.snapshot("test", "kept").unwrap(),
        SettingSnapshot::Stored {
            value: "yes".into()
        }
    );
    drop(read);
    owner.shutdown().unwrap();
}
