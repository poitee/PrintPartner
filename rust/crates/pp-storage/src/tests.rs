use super::*;
use std::sync::mpsc;
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
    for version in [30, 38] {
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

fn remove_schema37(connection: &Connection) {
    connection
        .execute_batch(
            "DROP TRIGGER trg_plan_apply_admissions_immutable_delete;
             DROP TRIGGER trg_plan_apply_admissions_immutable_update;
             DROP TABLE plan_apply_admissions;",
        )
        .unwrap();
}

#[test]
fn schema37_migrates_supported_versions_and_rolls_back_as_one_unit() {
    for version in 31..=36 {
        let path = directory("schema37-version");
        let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
        owner.shutdown().unwrap();
        let connection = Connection::open(path.join("print-partner.db")).unwrap();
        remove_schema37(&connection);
        if version < 36 {
            connection
                .execute_batch(
                    "DROP TABLE source_import_quota; DROP TABLE source_import_operations;",
                )
                .unwrap();
        }
        if version < 35 {
            connection
                .execute_batch("DROP TABLE durable_job_reconciliations; DROP TABLE durable_job_history; DROP TABLE durable_job_keys; DROP TABLE durable_jobs;")
                .unwrap();
        }
        connection
            .execute(
                "UPDATE app_settings SET value=? WHERE tenant_id='default' AND key='schema_version'",
                [version.to_string()],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(connection);
        let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
        assert_eq!(ready.previous_version, version);
        assert_eq!(ready.version, 37);
        let backup = ready.backup.unwrap();
        assert!(backup.ends_with(if version < 36 {
            "pre-schema36.db"
        } else {
            "pre-schema37.db"
        }));
        owner.shutdown().unwrap();
    }

    let path = directory("schema37-rollback");
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    let connection = Connection::open(path.join("print-partner.db")).unwrap();
    remove_schema37(&connection);
    connection
        .execute_batch(
            "UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version';
             CREATE TRIGGER reject_schema37 BEFORE UPDATE ON app_settings
             WHEN NEW.key='schema_version' AND NEW.value='37'
             BEGIN SELECT RAISE(ABORT,'fixture schema37 constraint'); END;",
        )
        .unwrap();
    drop(connection);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
    let connection = Connection::open(path.join("print-partner.db")).unwrap();
    let child_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='plan_apply_admissions')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!child_exists);
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "36"
    );
    connection
        .execute_batch("DROP TRIGGER reject_schema37")
        .unwrap();
    drop(connection);
    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert_eq!(ready.version, 37);
    owner.shutdown().unwrap();
}

#[test]
fn schema37_preflight_rejects_unexpected_missing_changed_and_orphan_objects() {
    let make = || {
        let path = directory("schema37-audit");
        let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
        owner.shutdown().unwrap();
        path
    };
    let assert_unchanged = |path: &Path| {
        let database = path.join("print-partner.db");
        let before = std::fs::read(&database).unwrap();
        assert!(WriterOwner::open(path, Limits::default()).is_err());
        assert_eq!(std::fs::read(database).unwrap(), before);
        assert!(!path.join(".desktop-owner.json").exists());
    };

    let unexpected = make();
    Connection::open(unexpected.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version'",
            [],
        )
        .unwrap();
    assert_unchanged(&unexpected);

    let missing = make();
    Connection::open(missing.join("print-partner.db"))
        .unwrap()
        .execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_update")
        .unwrap();
    assert_unchanged(&missing);

    let changed = make();
    Connection::open(changed.join("print-partner.db"))
        .unwrap()
        .execute_batch("ALTER TABLE plan_apply_admissions ADD COLUMN unintended TEXT")
        .unwrap();
    assert_unchanged(&changed);

    let orphan = make();
    let connection = Connection::open(orphan.join("print-partner.db")).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; INSERT INTO plan_apply_admissions VALUES(999,'plan-apply-request-v1','x','y',0,NULL,0);")
        .unwrap();
    drop(connection);
    assert_unchanged(&orphan);
}

#[test]
fn schema37_backup_captures_schema36_wal_and_reopen_keeps_original_backup() {
    let path = directory("schema37-wal-backup");
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    let database = path.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    remove_schema37(&connection);
    connection
        .execute_batch("UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    connection
        .execute("INSERT INTO app_settings(tenant_id,key,value) VALUES('default','schema37-wal','retained')", [])
        .unwrap();
    assert!(database.with_file_name("print-partner.db-wal").exists());
    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 36);
    let backup = ready.backup.unwrap();
    let backup_connection =
        Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        backup_connection
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema37-wal'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "retained"
    );
    drop(backup_connection);
    drop(connection);
    owner.shutdown().unwrap();
    let before = std::fs::read(&backup).unwrap();
    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert!(ready.backup.is_none());
    assert_eq!(std::fs::read(backup).unwrap(), before);
    owner.shutdown().unwrap();
}

#[test]
fn malformed_schema_version_rejects_before_owner_or_source_mutation() {
    let path = directory("schema-version-text");
    let database = path.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch("CREATE TABLE app_settings(tenant_id TEXT,key TEXT,value TEXT); INSERT INTO app_settings VALUES('default','schema_version','37x');")
        .unwrap();
    drop(connection);
    std::fs::write(path.join("retained-user-file"), b"retained").unwrap();
    let before = std::fs::read(&database).unwrap();
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
    assert_eq!(std::fs::read(database).unwrap(), before);
    assert_eq!(
        std::fs::read(path.join("retained-user-file")).unwrap(),
        b"retained"
    );
    assert!(!path.join(".desktop-owner.json").exists());
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
    for version in [30, 38] {
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
fn reopen_preserves_the_pre_upgrade_backup() {
    let path = directory("upgrade-backup");
    let database = path.join("print-partner.db");
    std::fs::write(
        &database,
        include_bytes!("../tests/fixtures/accepted-plan-node.db"),
    )
    .unwrap();
    let older_backup = path.join("backups/pre-schema34.db");
    std::fs::create_dir_all(older_backup.parent().unwrap()).unwrap();
    std::fs::write(&older_backup, b"retained older recovery copy").unwrap();
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
    assert_ne!(backup, older_backup);
    assert_eq!(
        std::fs::read(older_backup).unwrap(),
        b"retained older recovery copy"
    );
}

#[test]
fn schema37_backup_preserves_pre36_and_existing_pre37_copies() {
    for existing in [false, true] {
        let path = directory("schema37-backup-coexistence");
        let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
        owner.shutdown().unwrap();
        let connection = Connection::open(path.join("print-partner.db")).unwrap();
        remove_schema37(&connection);
        connection.execute_batch("UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        drop(connection);
        let backups = path.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        let previous = backups.join("pre-schema36.db");
        std::fs::write(&previous, b"retained schema36 recovery copy").unwrap();
        let selected = backups.join("pre-schema37.db");
        if existing {
            std::fs::write(&selected, b"retained schema37 recovery copy").unwrap();
        }
        let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
        assert_eq!(ready.previous_version, 36);
        assert_eq!(ready.version, 37);
        assert_eq!(ready.backup.as_ref(), Some(&selected));
        owner.shutdown().unwrap();
        assert_eq!(
            std::fs::read(&previous).unwrap(),
            b"retained schema36 recovery copy"
        );
        if existing {
            assert_eq!(
                std::fs::read(&selected).unwrap(),
                b"retained schema37 recovery copy"
            );
        } else {
            let backup =
                Connection::open_with_flags(&selected, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            assert_eq!(backup.query_row("SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'", [], |row| row.get::<_, String>(0)).unwrap(), "36");
        }
        let before = std::fs::read(&selected).unwrap();
        let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
        assert!(ready.backup.is_none());
        owner.shutdown().unwrap();
        assert_eq!(std::fs::read(selected).unwrap(), before);
    }
}
