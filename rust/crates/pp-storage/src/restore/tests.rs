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
