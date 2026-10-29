#![cfg(unix)]
//! T-8-archive (GRE-403): coherent app backup archives in Node's format 2.

use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use pp_storage::{
    Limits, Setting, SettingCommand, SettingSnapshot, WriterOwner,
    archive::{self, MetadataScope, Request, Scope},
};
use rusqlite::{Connection, ErrorCode};
use std::{
    io::Read,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    thread,
    time::{Duration, Instant},
};
use tar::{EntryType, Header};

#[path = "common/process.rs"]
mod child_process;
#[path = "common/scratch.rs"]
mod scratch;
use scratch::Scratch;

fn set(owner: &WriterOwner, key: &str, value: &str) {
    owner
        .client()
        .submit(
            SettingCommand::Set(Setting {
                tenant: "test".into(),
                key: key.into(),
                value: value.into(),
            }),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
}

fn open(data: &Path) -> WriterOwner {
    WriterOwner::open(data, Limits::default()).unwrap().0
}

/// Every archive path with its entry type, in archive order.
fn listing(path: &Path) -> Vec<(String, EntryType)> {
    let mut reader = tar::Archive::new(GzDecoder::new(std::fs::File::open(path).unwrap()));
    reader
        .entries()
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let name = String::from_utf8(entry.path_bytes().into_owned()).unwrap();
            (
                name.trim_end_matches('/').to_owned(),
                entry.header().entry_type(),
            )
        })
        .collect()
}

fn read_entry(path: &Path, name: &str) -> Vec<u8> {
    let mut reader = tar::Archive::new(GzDecoder::new(std::fs::File::open(path).unwrap()));
    for entry in reader.entries().unwrap() {
        let mut entry = entry.unwrap();
        if entry.path_bytes().as_ref() == name.as_bytes() {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            return bytes;
        }
    }
    panic!("{name} missing from archive");
}

fn stored(database: &Path, key: &str) -> Option<String> {
    let connection = Connection::open(database).unwrap();
    connection
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='test' AND key=?",
            [key],
            |row| row.get(0),
        )
        .ok()
}

fn residue(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

#[test]
fn ticket_t_8_archive_snapshots_database_and_roots_in_node_format() {
    let data = Scratch::new("pp-t8-archive-data");
    let out = Scratch::new("pp-t8-archive-out");
    let owner = open(&data);
    set(&owner, "before", "committed");
    std::fs::create_dir_all(data.join("repos/source-a/rev-1")).unwrap();
    std::fs::write(data.join("repos/source-a/rev-1/part.stl"), b"solid part").unwrap();
    std::fs::create_dir_all(data.join("manifests")).unwrap();
    std::fs::write(data.join("manifests/plan.yaml"), b"plates: []").unwrap();
    std::fs::write(data.join("custom_filaments.json"), b"[]").unwrap();
    std::fs::write(out.join("outside.txt"), b"outside secret").unwrap();
    symlink(out.join("outside.txt"), data.join("repos/source-a/escape")).unwrap();
    std::fs::write(data.join("not-a-root.txt"), b"never archived").unwrap();

    let target = out.join("app.tar.gz");
    let metadata = owner
        .create_archive(&target, Request::new("3.9.0", Scope::Full))
        .unwrap();
    assert_eq!(metadata.scope, MetadataScope::Full);
    assert_eq!(
        archive::validate(&target, archive::Limits::default()).unwrap(),
        metadata
    );

    let entries = listing(&target);
    let names: Vec<_> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "print-partner.db",
            "backup-metadata.json",
            "repos",
            "repos/source-a",
            "repos/source-a/rev-1",
            "repos/source-a/rev-1/part.stl",
            "sources",
            "exports",
            "thumbs",
            "covers",
            "manifests",
            "manifests/plan.yaml",
            "custom_filaments.json",
        ]
    );
    assert!(
        entries
            .iter()
            .all(|(_, kind)| matches!(kind, EntryType::Regular | EntryType::Directory))
    );
    assert_eq!(
        read_entry(&target, "repos/source-a/rev-1/part.stl"),
        b"solid part"
    );

    let json: serde_json::Value =
        serde_json::from_slice(&read_entry(&target, "backup-metadata.json")).unwrap();
    assert_eq!(json["version"], "2");
    assert_eq!(json["formatVersion"], 2);
    assert_eq!(json["appVersion"], "3.9.0");
    assert_eq!(json["scope"]["kind"], "full");
    assert_eq!(
        json["scope"]["includedRoots"],
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
    );

    let restored = out.join("restored.db");
    std::fs::write(&restored, read_entry(&target, "print-partner.db")).unwrap();
    assert_eq!(stored(&restored, "before").as_deref(), Some("committed"));
    // The work directory and temporary archive are gone.
    let mut left = residue(&out);
    left.sort();
    assert_eq!(left, ["app.tar.gz", "outside.txt", "restored.db"]);

    // The writer keeps serving after the archive.
    set(&owner, "after", "works");
    assert_eq!(
        owner
            .client()
            .reader(Duration::ZERO)
            .unwrap()
            .snapshot("test", "after")
            .unwrap(),
        SettingSnapshot::Stored {
            value: "works".into()
        }
    );
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_8_archive_database_only_scope_omits_roots() {
    let data = Scratch::new("pp-t8-archive-data");
    let out = Scratch::new("pp-t8-archive-out");
    let owner = open(&data);
    std::fs::create_dir_all(data.join("repos")).unwrap();
    std::fs::write(data.join("repos/file"), b"x").unwrap();
    let target = out.join("db-only.tar.gz");
    owner
        .create_archive(&target, Request::new("3.9.0", Scope::DatabaseOnly))
        .unwrap();
    let names: Vec<_> = listing(&target).into_iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["print-partner.db", "backup-metadata.json"]);
    assert!(data.join("repos/file").exists());
    assert_eq!(
        archive::validate(&target, archive::Limits::default())
            .unwrap()
            .scope,
        MetadataScope::DatabaseOnly
    );
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_8_archive_freezes_other_sqlite_writers_until_done() {
    let data = Scratch::new("pp-t8-archive-data");
    let out = Scratch::new("pp-t8-archive-out");
    let owner = open(&data);
    // An incompressible root keeps the archive busy long enough to observe.
    std::fs::create_dir_all(data.join("sources")).unwrap();
    let noise: Vec<u8> = (0..8 * 1024 * 1024).map(|_| rand_byte()).collect();
    std::fs::write(data.join("sources/large.bin"), noise).unwrap();

    // A second process's writer that holds the lock first delays the archive,
    // and its commit is in the snapshot.
    let external = Connection::open(data.join("print-partner.db")).unwrap();
    external.execute_batch("BEGIN IMMEDIATE").unwrap();
    external
        .execute(
            "INSERT INTO app_settings(tenant_id,key,value) VALUES('test','external','first')",
            [],
        )
        .unwrap();
    let target = out.join("frozen.tar.gz");
    let archive_thread = thread::scope(|scope| {
        let handle =
            scope.spawn(|| owner.create_archive(&target, Request::new("3.9.0", Scope::Full)));
        thread::sleep(Duration::from_millis(200));
        assert!(
            !target.exists(),
            "archive ran while another writer held the lock"
        );
        external.execute_batch("COMMIT").unwrap();

        // While the archive is in progress, no other writer can begin.
        let deadline = Instant::now() + Duration::from_secs(20);
        while !residue(&out).iter().any(|name| name.contains(".work-")) {
            assert!(
                Instant::now() < deadline,
                "archive work directory never appeared"
            );
            thread::sleep(Duration::from_millis(1));
        }
        external.busy_timeout(Duration::ZERO).unwrap();
        let blocked = external.execute_batch("BEGIN IMMEDIATE").unwrap_err();
        assert_eq!(blocked.sqlite_error_code(), Some(ErrorCode::DatabaseBusy));
        handle.join().unwrap()
    });
    archive_thread.unwrap();
    external.busy_timeout(Duration::from_secs(5)).unwrap();
    external.execute_batch("BEGIN IMMEDIATE; COMMIT").unwrap();

    let restored = out.join("restored.db");
    std::fs::write(&restored, read_entry(&target, "print-partner.db")).unwrap();
    assert_eq!(stored(&restored, "external").as_deref(), Some("first"));
    drop(external);
    owner.shutdown().unwrap();
}

fn rand_byte() -> u8 {
    use std::cell::Cell;
    thread_local!(static STATE: Cell<u64> = const { Cell::new(0x9e37_79b9_7f4a_7c15) });
    STATE.with(|state| {
        let mut x = state.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        state.set(x);
        (x >> 32) as u8
    })
}

#[test]
fn ticket_t_8_archive_refuses_unsafe_roots_space_and_destinations() {
    let data = Scratch::new("pp-t8-archive-data");
    let out = Scratch::new("pp-t8-archive-out");
    let owner = open(&data);
    let refuse = |target: &Path, request: Request| {
        owner
            .create_archive(target, request)
            .unwrap_err()
            .to_string()
    };

    std::fs::create_dir_all(out.join("elsewhere")).unwrap();
    std::fs::remove_dir(data.join("repos")).unwrap();
    symlink(out.join("elsewhere"), data.join("repos")).unwrap();
    assert!(
        refuse(&out.join("a.tar.gz"), Request::new("3.9.0", Scope::Full))
            .contains("Backup root cannot be a symbolic link: repos")
    );
    std::fs::remove_file(data.join("repos")).unwrap();

    std::fs::remove_dir(data.join("sources")).unwrap();
    std::fs::write(data.join("sources"), b"a file where a directory belongs").unwrap();
    assert!(
        refuse(&out.join("a.tar.gz"), Request::new("3.9.0", Scope::Full))
            .contains("Backup root has the wrong file type: sources")
    );
    std::fs::remove_file(data.join("sources")).unwrap();

    let mut no_space = Request::new("3.9.0", Scope::Full);
    no_space.reserve_bytes = u64::MAX / 2;
    assert!(refuse(&out.join("a.tar.gz"), no_space).contains("Insufficient disk space for backup"));

    let mut tiny = Request::new("3.9.0", Scope::Full);
    tiny.limits.max_total_bytes = 1024;
    assert!(refuse(&out.join("a.tar.gz"), tiny).contains("decompressed byte limit exceeded"));

    assert!(
        refuse(
            &data.join("inside.tar.gz"),
            Request::new("3.9.0", Scope::Full)
        )
        .contains("inside managed storage")
    );
    std::fs::write(out.join("existing.tar.gz"), b"keep me").unwrap();
    assert!(
        refuse(
            &out.join("existing.tar.gz"),
            Request::new("3.9.0", Scope::Full)
        )
        .contains("must be a new file")
    );
    assert_eq!(
        std::fs::read(out.join("existing.tar.gz")).unwrap(),
        b"keep me"
    );
    let mut left = residue(&out);
    left.sort();
    assert_eq!(left, ["elsewhere", "existing.tar.gz"]);
    owner.shutdown().unwrap();
}

struct Crafted {
    builder: tar::Builder<GzEncoder<Vec<u8>>>,
}

impl Crafted {
    fn new() -> Self {
        Self {
            builder: tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default())),
        }
    }

    /// Writes `name` into the raw header so hostile paths survive.
    fn raw(mut self, name: &[u8], kind: EntryType, data: &[u8]) -> Self {
        let mut header = Header::new_old();
        header.as_old_mut().name[..name.len()].copy_from_slice(name);
        header.set_entry_type(kind);
        header.set_mode(0o644);
        header.set_size(if kind == EntryType::Regular {
            data.len() as u64
        } else {
            0
        });
        if kind == EntryType::Symlink || kind == EntryType::Link {
            header.set_link_name("/etc/passwd").unwrap();
        }
        header.set_cksum();
        let data = if kind == EntryType::Regular {
            data
        } else {
            &[]
        };
        self.builder.append(&header, data).unwrap();
        self
    }

    fn file(self, name: &str, data: &[u8]) -> Self {
        self.raw(name.as_bytes(), EntryType::Regular, data)
    }

    fn dir(self, name: &str) -> Self {
        self.raw(name.as_bytes(), EntryType::Directory, &[])
    }

    fn base(self, metadata: &serde_json::Value, database: &[u8]) -> Self {
        self.file("backup-metadata.json", metadata.to_string().as_bytes())
            .file("print-partner.db", database)
    }

    fn write(self, path: &Path) -> PathBuf {
        let bytes = self.builder.into_inner().unwrap().finish().unwrap();
        std::fs::write(path, bytes).unwrap();
        path.to_owned()
    }
}

fn sqlite_bytes(directory: &Path, wal: bool) -> (Vec<u8>, Vec<u8>) {
    let path = directory.join(format!("seed-{wal}.db"));
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    connection
        .execute_batch("CREATE TABLE app_settings(tenant_id,key,value); INSERT INTO app_settings VALUES('test','legacy','v1');")
        .unwrap();
    let main = std::fs::read(&path).unwrap();
    let wal_bytes = std::fs::read(directory.join(format!("seed-{wal}.db-wal"))).unwrap();
    std::mem::forget(connection);
    (main, wal_bytes)
}

fn v2(kind: &str, roots: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "version": "2",
        "createdAt": "2026-10-29T12:00:00.000Z",
        "appVersion": "3.8.0",
        "formatVersion": 2,
        "scope": { "kind": kind, "includedRoots": roots },
    })
}

#[test]
fn ticket_t_8_archive_accepts_node_format_one_with_wal_and_pre_update_archives() {
    let dir = Scratch::new("pp-t8-archive-node");
    let (main, wal) = sqlite_bytes(&dir, true);
    let legacy = serde_json::json!({
        "version": "1",
        "createdAt": "2026-01-02T03:04:05.678Z",
        "appVersion": "3.3.0",
        "formatVersion": 1,
    });
    let path = Crafted::new()
        .base(&legacy, &main)
        .file("print-partner.db-wal", &wal)
        .dir("repos/")
        .file("repos/a.stl", b"x")
        .write(&dir.join("legacy.tar.gz"));
    let metadata = archive::validate(&path, archive::Limits::default()).unwrap();
    assert_eq!(metadata.scope, MetadataScope::Legacy);
    assert_eq!(metadata.app_version, "3.3.0");

    // Node's pre-update backup is database-only format 2.
    let path = Crafted::new()
        .base(&v2("database-only", &[]), &main)
        .file("print-partner.db-wal", &wal)
        .write(&dir.join("print-partner-pre-update-to-3.9.0-schema-34-to-41.tar.gz"));
    assert_eq!(
        archive::validate(&path, archive::Limits::default())
            .unwrap()
            .scope,
        MetadataScope::DatabaseOnly
    );
}

#[test]
fn ticket_t_8_archive_validation_rejects_traversal_links_and_bad_metadata() {
    let dir = Scratch::new("pp-t8-archive-hostile");
    let (main, _) = sqlite_bytes(&dir, true);
    let full_roots = [
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
        "path-hints.yaml",
    ];
    let full = v2("full", &full_roots);
    let check = |name: &str, crafted: Crafted, expected: &str| {
        let path = crafted.write(&dir.join(format!("{name}.tar.gz")));
        let error = format!(
            "{:#}",
            archive::validate(&path, archive::Limits::default()).unwrap_err()
        );
        assert!(error.contains(expected), "{name}: {error}");
    };
    check(
        "parent",
        Crafted::new()
            .base(&full, &main)
            .file("repos/../../etc/x", b"x"),
        "Unsafe backup entry path",
    );
    check(
        "absolute",
        Crafted::new().base(&full, &main).file("/etc/passwd", b"x"),
        "Unsafe backup entry path",
    );
    check(
        "drive",
        Crafted::new().base(&full, &main).file("C:repos", b"x"),
        "Unsafe backup entry path",
    );
    check(
        "backslash",
        Crafted::new().base(&full, &main).file("repos\\x", b"x"),
        "Unsafe backup entry path",
    );
    check(
        "dot",
        Crafted::new().base(&full, &main).file("repos/./x", b"x"),
        "Unsafe backup entry path",
    );
    check(
        "empty-part",
        Crafted::new().base(&full, &main).file("repos//x", b"x"),
        "Unsafe backup entry path",
    );
    check(
        "symlink",
        Crafted::new()
            .base(&full, &main)
            .dir("repos/")
            .raw(b"repos/link", EntryType::Symlink, &[]),
        "Unsupported backup entry type",
    );
    check(
        "hardlink",
        Crafted::new()
            .base(&full, &main)
            .dir("repos/")
            .raw(b"repos/link", EntryType::Link, &[]),
        "Unsupported backup entry type",
    );
    check(
        "core-symlink",
        Crafted::new()
            .file("backup-metadata.json", full.to_string().as_bytes())
            .raw(b"print-partner.db", EntryType::Symlink, &[]),
        "must be a regular file",
    );
    check(
        "file-root-dir",
        Crafted::new()
            .base(&full, &main)
            .dir("custom_filaments.json/"),
        "must be a regular file",
    );
    check(
        "dir-root-file",
        Crafted::new().base(&full, &main).file("repos", b"x"),
        "Backup directory root has invalid type",
    );
    check(
        "unexpected",
        Crafted::new()
            .base(&full, &main)
            .file("secrets/token", b"x"),
        "Unexpected backup entry",
    );
    check(
        "duplicate",
        Crafted::new()
            .base(&full, &main)
            .file("print-partner.db", &main),
        "Duplicate backup entry",
    );
    check(
        "out-of-scope",
        Crafted::new()
            .base(&v2("database-only", &[]), &main)
            .dir("repos/"),
        "outside the declared scope",
    );
    check(
        "no-metadata",
        Crafted::new().file("print-partner.db", &main),
        "missing backup-metadata.json",
    );
    check(
        "no-database",
        Crafted::new().file("backup-metadata.json", full.to_string().as_bytes()),
        "missing print-partner.db",
    );
    let mut newer = full.clone();
    newer["formatVersion"] = 3.into();
    newer["version"] = "3".into();
    check(
        "newer",
        Crafted::new().base(&newer, &main),
        "newer than supported 2",
    );
    let mut mismatched = full.clone();
    mismatched["version"] = "1".into();
    check(
        "mismatch",
        Crafted::new().base(&mismatched, &main),
        "version fields do not match",
    );
    check(
        "partial-full",
        Crafted::new().base(&v2("full", &["repos"]), &main),
        "scope roots do not match its kind",
    );
    check(
        "bad-sqlite",
        Crafted::new().base(&full, b"not a database at all"),
        "invalid SQLite database",
    );
    let mut corrupt = main.clone();
    corrupt[100..].iter_mut().for_each(|byte| *byte = 0xff);
    check(
        "corrupt-sqlite",
        Crafted::new().base(&full, &corrupt),
        "integrity_check failed",
    );

    let limited = |name: &str, limits: archive::Limits, expected: &str| {
        let path = Crafted::new()
            .base(&full, &main)
            .dir("repos/")
            .file("repos/a", &[0u8; 4096])
            .write(&dir.join(format!("{name}.tar.gz")));
        let error = archive::validate(&path, limits).unwrap_err().to_string();
        assert!(error.contains(expected), "{name}: {error}");
    };
    let defaults = archive::Limits::default();
    limited(
        "entries",
        archive::Limits {
            max_entries: 3,
            ..defaults
        },
        "entry limit exceeded",
    );
    limited(
        "entry-bytes",
        archive::Limits {
            max_entry_bytes: 4095,
            ..defaults
        },
        "exceeds decompressed size limit",
    );
    limited(
        "total",
        archive::Limits {
            max_total_bytes: 4096,
            ..defaults
        },
        "decompressed byte limit exceeded",
    );
    limited(
        "ratio",
        archive::Limits {
            max_decompression_ratio: 1,
            ..defaults
        },
        "decompression ratio",
    );
    // A hostile archive never writes outside the private validation copy.
    assert!(!dir.join("etc").exists() && !Path::new("/etc/x").exists());
}

#[test]
fn ticket_t_8_archive_node_validates_rust_archives() {
    let data = Scratch::new("pp-t8-archive-data");
    let out = Scratch::new("pp-t8-archive-out");
    let owner = open(&data);
    set(&owner, "node", "reads this");
    std::fs::write(data.join("repos/part.stl"), b"solid part").unwrap();
    owner
        .create_archive(&out.join("full.tar.gz"), Request::new("3.9.0", Scope::Full))
        .unwrap();
    owner
        .create_archive(
            &out.join("db-only.tar.gz"),
            Request::new("3.9.0", Scope::DatabaseOnly),
        )
        .unwrap();
    owner.shutdown().unwrap();

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let service = root.join("web/apps/server/src/services/backup-restore.ts");
    let script = out.join("validate.mts");
    std::fs::write(
        &script,
        format!(
            "import {{ validateBackup }} from {service:?};\n\
             for (const path of process.argv.slice(2)) {{\n\
               const metadata = await validateBackup(path);\n\
               console.log(metadata.scope.kind, metadata.scope.includedRoots.length);\n\
             }}\n",
            service = service.to_str().unwrap()
        ),
    )
    .unwrap();
    let node = std::env::var_os("PP_SCHEMA_PARITY_NODE").unwrap_or_else(|| "node".into());
    let output = child_process::command(&node)
        .current_dir(&root)
        .arg("--conditions=development")
        .arg("--import")
        .arg(root.join("web/node_modules/tsx/dist/loader.mjs"))
        .arg(&script)
        .arg(out.join("full.tar.gz"))
        .arg(out.join("db-only.tar.gz"))
        .output()
        .expect("run Node validateBackup");
    assert!(
        output.status.success(),
        "Node rejected a Rust archive.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "full 11\ndatabase-only 0\n"
    );
}
