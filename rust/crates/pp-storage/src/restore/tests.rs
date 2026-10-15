use super::*;
use flate2::{Compression, write::GzEncoder};
use rusqlite::Connection;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, symlink},
    path::PathBuf,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-offline-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn owner(&self) -> StorageLease {
        StorageLease::acquire(&self.0.join("data")).unwrap()
    }
    fn archive(&self, version: u8, scope: &str, extra: &[(&str, &[u8])]) -> PathBuf {
        let db = self.0.join("fixture.db");
        let _ = fs::remove_file(&db);
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE restored(value TEXT); INSERT INTO restored VALUES ('backup row');",
        )
        .unwrap();
        drop(conn);
        let roots = if scope == "full" {
            serde_json::json!([
                "repos",
                "sources",
                "exports",
                "thumbs",
                "covers",
                "assistant-domain",
                "manifests",
                "custom_filaments.json",
                "kit-catalog.json",
                "kit-catalog.yaml",
                "path-hints.yaml"
            ])
        } else {
            serde_json::json!([])
        };
        let metadata = serde_json::json!({"version":version.to_string(),"formatVersion":version,"createdAt":"2026-10-15T00:00:00Z","appVersion":"3.3.0","scope":{"kind":scope,"includedRoots": roots}}).to_string();
        let path = self.0.join("backup.tar.gz");
        let mut archive = tar::Builder::new(GzEncoder::new(
            fs::File::create(&path).unwrap(),
            Compression::default(),
        ));
        append(&mut archive, "backup-metadata.json", metadata.as_bytes());
        append(&mut archive, "print-partner.db", &fs::read(db).unwrap());
        for (name, bytes) in extra {
            append(&mut archive, name, bytes);
        }
        archive.into_inner().unwrap().finish().unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn append<W: std::io::Write>(archive: &mut tar::Builder<W>, name: &str, bytes: &[u8]) {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive.append_data(&mut header, name, bytes).unwrap();
}
fn row(owner: &StorageLease) -> String {
    Connection::open(owner.data_dir().join("print-partner.db"))
        .unwrap()
        .query_row("SELECT value FROM restored", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn ticket_t_2_offline_restore_sqlite_scope_and_stale_wal() {
    for (version, scope) in [(1, "legacy"), (2, "database-only"), (2, "full")] {
        let f = Fixture::new();
        let owner = f.owner();
        let data = owner.data_dir();
        fs::create_dir(data.join("repos")).unwrap();
        fs::write(data.join("repos/old"), b"old root").unwrap();
        fs::write(data.join("print-partner.db"), b"old database").unwrap();
        fs::write(data.join("print-partner.db-wal"), b"stale WAL").unwrap();
        fs::write(data.join("print-partner.db-shm"), b"stale SHM").unwrap();
        fs::write(data.join("custom_filaments.json"), b"old config").unwrap();
        let archive = f.archive(version, scope, &[]);
        let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
        assert_eq!(
            fs::read(data.join("print-partner.db")).unwrap(),
            b"old database"
        );
        prepared
            .activate_with(&owner, || {
                assert!(
                    StorageLease::acquire(data).is_err(),
                    "writer acquired during activation"
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(row(&owner), "backup row");
        assert!(!data.join("print-partner.db-wal").exists());
        assert!(!data.join("print-partner.db-shm").exists());
        if scope == "full" {
            assert!(!data.join("repos").exists());
            assert!(!data.join("custom_filaments.json").exists());
        } else {
            assert_eq!(fs::read(data.join("repos/old")).unwrap(), b"old root");
            assert_eq!(
                fs::read(data.join("custom_filaments.json")).unwrap(),
                b"old config"
            );
        }
    }
}

#[test]
fn ticket_t_2_offline_restore_rejects_unexpected_duplicate_scope_and_unsafe_live_paths() {
    let f = Fixture::new();
    let owner = f.owner();
    fs::write(owner.data_dir().join("print-partner.db"), b"unchanged").unwrap();
    for (scope, extra) in [
        ("full", vec![(".desktop.lock", &b"overwrite"[..])]),
        ("full", vec![("print-partner.db", &b"duplicate"[..])]),
        ("database-only", vec![("repos/evil", &b"scope"[..])]),
        ("full", vec![("repos\\escape", &b"path"[..])]),
    ] {
        let archive = f.archive(2, scope, &extra);
        assert!(PreparedRestore::prepare(&owner, &archive).is_err());
        assert_eq!(
            fs::read(owner.data_dir().join("print-partner.db")).unwrap(),
            b"unchanged"
        );
    }
    symlink(&f.0, owner.data_dir().join("repos")).unwrap();
    let archive = f.archive(2, "full", &[("repos/new", b"new")]);
    assert!(PreparedRestore::prepare(&owner, &archive).is_err());
    assert_eq!(
        fs::read(owner.data_dir().join("print-partner.db")).unwrap(),
        b"unchanged"
    );
}

#[test]
fn ticket_t_2_offline_restore_faults_roll_back_and_interruption_recovers() {
    for interrupt in [false, true] {
        for stop_at in 1..=30 {
            let f = Fixture::new();
            let owner = f.owner();
            let data = owner.data_dir();
            fs::write(data.join("print-partner.db"), b"original db").unwrap();
            fs::create_dir(data.join("repos")).unwrap();
            fs::write(data.join("repos/old"), b"original root").unwrap();
            let archive = f.archive(
                2,
                "full",
                &[("repos/new", b"restored root"), ("thumbs/new", b"new root")],
            );
            let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
            let mut calls = 0;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                prepared.activate_with(&owner, || {
                    calls += 1;
                    if calls == stop_at {
                        if interrupt {
                            panic!("simulated interruption");
                        }
                        anyhow::bail!("simulated rename failure");
                    }
                    Ok(())
                })
            }));
            assert!(calls >= stop_at);
            if interrupt {
                assert!(result.is_err());
            } else {
                assert!(result.unwrap().is_err());
            }
            recover_pending(&owner).unwrap();
            recover_pending(&owner).unwrap();
            assert_eq!(
                fs::read(data.join("print-partner.db")).unwrap(),
                b"original db"
            );
            assert_eq!(fs::read(data.join("repos/old")).unwrap(), b"original root");
            assert!(!data.join("repos/new").exists());
            assert!(!data.join("thumbs").exists());
        }
    }
}

#[test]
fn ticket_t_2_offline_restore_applies_staged_wal_rows() {
    let f = Fixture::new();
    let owner = f.owner();
    let db = f.0.join("wal.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE restored(value TEXT); INSERT INTO restored VALUES ('WAL row');").unwrap();
    let path = f.0.join("wal.tar.gz");
    let mut tar = tar::Builder::new(GzEncoder::new(
        fs::File::create(&path).unwrap(),
        Compression::default(),
    ));
    append(&mut tar, "backup-metadata.json", br#"{"version":"2","formatVersion":2,"createdAt":"2026-10-15T00:00:00Z","appVersion":"3.3.0","scope":{"kind":"database-only","includedRoots":[]}}"#);
    append(&mut tar, "print-partner.db", &fs::read(&db).unwrap());
    append(
        &mut tar,
        "print-partner.db-wal",
        &fs::read(f.0.join("wal.db-wal")).unwrap(),
    );
    tar.into_inner().unwrap().finish().unwrap();
    PreparedRestore::prepare(&owner, &path)
        .unwrap()
        .activate(&owner)
        .unwrap();
    assert_eq!(row(&owner), "WAL row");
    assert!(!owner.data_dir().join("print-partner.db-wal").exists());
    drop(conn);
}

#[test]
fn ticket_t_2_offline_restore_pax_paths_and_links_are_validated() {
    for (name, kind) in [
        ("repos/../escape", tar::EntryType::Regular),
        ("repos/link", tar::EntryType::Symlink),
        ("repos/hardlink", tar::EntryType::Link),
        ("repos/fifo", tar::EntryType::Fifo),
    ] {
        let f = Fixture::new();
        let owner = f.owner();
        fs::write(owner.data_dir().join("print-partner.db"), b"unchanged").unwrap();
        let path = f.0.join("unsafe.tar.gz");
        let mut tar = tar::Builder::new(GzEncoder::new(
            fs::File::create(&path).unwrap(),
            Compression::default(),
        ));
        tar.append_pax_extensions([("path", name.as_bytes())])
            .unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(0);
        header.set_mode(0o600);
        if kind.is_symlink() || kind.is_hard_link() {
            header.set_link_name("/tmp/external").unwrap();
        }
        header.set_cksum();
        tar.append_data(&mut header, "repos/entry", &[][..])
            .unwrap();
        tar.into_inner().unwrap().finish().unwrap();
        assert!(PreparedRestore::prepare(&owner, &path).is_err());
        assert_eq!(
            fs::read(owner.data_dir().join("print-partner.db")).unwrap(),
            b"unchanged"
        );
    }
    let f = Fixture::new();
    let owner = f.owner();
    let path = f.archive(2, "full", &[]);
    let contents = fs::read(&path).unwrap();
    let mut tar = tar::Builder::new(GzEncoder::new(
        fs::File::create(f.0.join("pax.tar.gz")).unwrap(),
        Compression::default(),
    ));
    let mut original = tar::Archive::new(flate2::read::GzDecoder::new(&contents[..]));
    for entry in original.entries().unwrap() {
        let mut entry = entry.unwrap();
        tar.append(&entry.header().clone(), &mut entry).unwrap();
    }
    let name = format!("repos/{}", "x".repeat(150));
    tar.append_pax_extensions([("path", name.as_bytes())])
        .unwrap();
    append(&mut tar, "truncated-name", b"long path contents");
    tar.into_inner().unwrap().finish().unwrap();
    PreparedRestore::prepare(&owner, &f.0.join("pax.tar.gz"))
        .unwrap()
        .activate(&owner)
        .unwrap();
    assert_eq!(
        fs::read(owner.data_dir().join(name)).unwrap(),
        b"long path contents"
    );
    assert_eq!(row(&owner), "backup row");
}

#[test]
fn ticket_t_2_offline_restore_recovery_rejects_escaping_journal() {
    let f = Fixture::new();
    let owner = f.owner();
    let outside = f.0.join("outside");
    fs::write(&outside, b"preserve").unwrap();
    for journal in [
        serde_json::json!({"version":1,"stage":"../outside","entries":[]}),
        serde_json::json!({"version":1,"stage":format!(".offline-restore-{}", "a".repeat(32)),"entries":[{"name":"../outside","previous":false,"replacement":true}]}),
    ] {
        fs::write(owner.data_dir().join(JOURNAL), journal.to_string()).unwrap();
        assert!(recover_pending(&owner).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"preserve");
        assert!(owner.data_dir().join(JOURNAL).exists());
    }
}

#[test]
fn ticket_t_2_offline_restore_keeps_files_when_rollback_is_incomplete() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let owner = f.owner();
    fs::write(owner.data_dir().join(DATABASE), b"original database").unwrap();
    let archive = f.archive(2, "database-only", &[]);
    let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
    let old = prepared.stage.join("old");
    let error = prepared
        .activate_with(&owner, || {
            fs::set_permissions(&old, fs::Permissions::from_mode(0o000))?;
            anyhow::bail!("activation failure with unreadable rollback files")
        })
        .unwrap_err();
    assert!(error.to_string().contains("Recovery required"), "{error:#}");
    assert!(pending(&owner).unwrap());
    assert!(StorageLease::acquire(owner.data_dir()).is_err());
    fs::set_permissions(old, fs::Permissions::from_mode(0o700)).unwrap();
    recover_pending(&owner).unwrap();
    assert_eq!(
        fs::read(owner.data_dir().join(DATABASE)).unwrap(),
        b"original database"
    );
    assert!(!pending(&owner).unwrap());
}

#[test]
fn ticket_t_2_offline_restore_journal_write_failure_leaves_store_retryable() {
    const CHILD: &str = "PP_RESTORE_JOURNAL_WRITE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "restore::tests::ticket_t_2_offline_restore_journal_write_failure_leaves_store_retryable", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let f = Fixture::new();
    let owner = f.owner();
    fs::write(owner.data_dir().join(DATABASE), b"original database").unwrap();
    let archive = f.archive(2, "database-only", &[]);
    let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
    let mut original = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    unsafe {
        assert_eq!(libc::getrlimit(libc::RLIMIT_FSIZE, &mut original), 0);
        libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
        let limit = libc::rlimit {
            rlim_cur: 1,
            rlim_max: original.rlim_max,
        };
        assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
    }
    let result = prepared.activate(&owner);
    unsafe {
        assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &original), 0);
    }
    assert!(result.is_err());
    assert!(
        !pending(&owner).unwrap(),
        "partial journal blocks every writer"
    );
    assert_eq!(
        fs::read(owner.data_dir().join(DATABASE)).unwrap(),
        b"original database"
    );
    recover_pending(&owner).unwrap();
    PreparedRestore::prepare(&owner, &archive)
        .unwrap()
        .activate(&owner)
        .unwrap();
    assert_eq!(row(&owner), "backup row");
}

#[test]
fn ticket_t_2_offline_restore_reclaims_abandoned_private_stages_only() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let owner = f.owner();
    let data = owner.data_dir();
    let abandoned = data.join(format!(".offline-restore-{}", "a".repeat(32)));
    private_dir(&abandoned).unwrap();
    fs::write(abandoned.join("journal.tmp"), b"{partial").unwrap();
    let target = f.0.join("outside");
    private_dir(&target).unwrap();
    fs::write(target.join("sentinel"), b"preserved").unwrap();
    symlink(&target, abandoned.join("nested-link")).unwrap();
    for name in [
        ".offline-restore-short",
        ".offline-restore-gggggggggggggggggggggggggggggggg",
        ".offline-restore-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extra",
    ] {
        private_dir(&data.join(name)).unwrap();
    }
    recover_pending(&owner).unwrap();
    assert!(
        !abandoned.exists(),
        "abandoned extraction was not reclaimed"
    );
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"preserved");
    assert!(data.join(".offline-restore-short").is_dir());
    assert!(
        data.join(".offline-restore-gggggggggggggggggggggggggggggggg")
            .is_dir()
    );
    assert!(
        data.join(".offline-restore-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extra")
            .is_dir()
    );
    let unsafe_path = data.join(format!(".offline-restore-{}", "b".repeat(32)));
    symlink(&target, &unsafe_path).unwrap();
    assert!(recover_pending(&owner).is_err());
    assert!(
        fs::symlink_metadata(&unsafe_path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_file(&unsafe_path).unwrap();
    private_dir(&unsafe_path).unwrap();
    fs::set_permissions(&unsafe_path, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(recover_pending(&owner).is_err());
    assert!(unsafe_path.is_dir());
    assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"preserved");
}

#[test]
fn ticket_t_2_offline_restore_recovery_preserves_active_preparation() {
    let f = Fixture::new();
    let owner = f.owner();
    let archive = f.archive(2, "database-only", &[]);
    let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
    recover_pending(&owner).unwrap();
    assert!(prepared.stage.join("new").join(DATABASE).is_file());
    prepared.activate(&owner).unwrap();
    assert_eq!(row(&owner), "backup row");
}

#[test]
fn ticket_t_2_offline_restore_full_root_with_nested_link_installs_and_rolls_back() {
    for rollback in [false, true] {
        let f = Fixture::new();
        let owner = f.owner();
        let data = owner.data_dir();
        let target = f.0.join("external");
        private_dir(&target).unwrap();
        fs::write(target.join("sentinel"), b"external original").unwrap();
        private_dir(&data.join("repos")).unwrap();
        fs::write(data.join("repos/old"), b"old repo").unwrap();
        symlink(&target, data.join("repos/link")).unwrap();
        fs::write(data.join(DATABASE), b"original database").unwrap();
        let archive = f.archive(2, "full", &[("repos/new", b"new repo")]);
        let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
        let stage = prepared.stage.clone();
        let result = prepared.activate_with(&owner, || {
            if rollback && stage.join("old/repos").exists() {
                anyhow::bail!("rollback after opaque root rename");
            }
            Ok(())
        });
        if rollback {
            assert!(result.is_err());
            assert_eq!(fs::read(data.join("repos/old")).unwrap(), b"old repo");
            assert!(
                fs::symlink_metadata(data.join("repos/link"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(fs::read(data.join(DATABASE)).unwrap(), b"original database");
        } else {
            result.unwrap();
            assert_eq!(fs::read(data.join("repos/new")).unwrap(), b"new repo");
            assert!(!data.join("repos/link").exists());
            assert_eq!(row(&owner), "backup row");
        }
        assert_eq!(
            fs::read(target.join("sentinel")).unwrap(),
            b"external original"
        );
        assert!(!pending(&owner).unwrap());
    }
}

#[test]
fn ticket_t_2_offline_restore_committed_cleanup_failure_requires_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let owner = f.owner();
    fs::write(owner.data_dir().join(DATABASE), b"original database").unwrap();
    let archive = f.archive(2, "database-only", &[]);
    let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
    let old = prepared.stage.join("old");
    let mut renames = 0;
    let error = prepared
        .activate_with(&owner, || {
            renames += 1;
            if renames == 8 {
                fs::set_permissions(&old, fs::Permissions::from_mode(0o000))?;
            }
            Ok(())
        })
        .unwrap_err();
    assert!(error.is::<RecoveryRequired>(), "{error:#}");
    assert_eq!(row(&owner), "backup row");
    assert!(pending(&owner).unwrap());
    assert!(StorageLease::acquire(owner.data_dir()).is_err());
    fs::set_permissions(old, fs::Permissions::from_mode(0o700)).unwrap();
    recover_pending(&owner).unwrap();
    assert_eq!(row(&owner), "backup row");
    assert!(!pending(&owner).unwrap());
}

#[test]
fn ticket_t_2_offline_restore_recovers_interrupted_journal_publication() {
    let f = Fixture::new();
    let owner = f.owner();
    let data = owner.data_dir();
    fs::write(data.join(DATABASE), b"original database").unwrap();
    let stage = data.join(format!(".offline-restore-{}", "c".repeat(32)));
    private_dir(&stage).unwrap();
    private_dir(&stage.join("new")).unwrap();
    private_dir(&stage.join("old")).unwrap();
    let journal = Journal {
        version: 1,
        stage: stage.file_name().unwrap().to_str().unwrap().to_owned(),
        entries: vec![Replacement {
            name: DATABASE.to_owned(),
            previous: true,
            replacement: true,
        }],
    };
    let mut file = private_file(&stage.join("journal.tmp")).unwrap();
    file.write_all(&serde_json::to_vec(&journal).unwrap())
        .unwrap();
    file.sync_all().unwrap();
    fs::hard_link(stage.join("journal.tmp"), data.join(JOURNAL)).unwrap();
    sync(data).unwrap();
    recover_pending(&owner).unwrap();
    assert_eq!(fs::read(data.join(DATABASE)).unwrap(), b"original database");
    assert!(!stage.exists());
    assert!(!pending(&owner).unwrap());
}

#[test]
fn ticket_t_2_offline_restore_publication_never_overwrites_pending_journal() {
    let f = Fixture::new();
    let owner = f.owner();
    let archive = f.archive(2, "database-only", &[]);
    let prepared = PreparedRestore::prepare(&owner, &archive).unwrap();
    fs::write(owner.data_dir().join(JOURNAL), b"existing pending journal").unwrap();
    assert!(prepared.activate(&owner).is_err());
    assert_eq!(
        fs::read(owner.data_dir().join(JOURNAL)).unwrap(),
        b"existing pending journal"
    );
}
