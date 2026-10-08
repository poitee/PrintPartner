use pp_source::{
    ArtifactBudget, FileKind, LocalFiles, SelectedFile, Selection, SnapshotRequest, SourcePath,
    TenantRepos,
    archive::{ArchiveError, ArchiveLimits, ZipInput},
};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".archive-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(root.join("repos")).unwrap();
        fs::create_dir(root.join("input")).unwrap();
        Self(root)
    }
    fn zip(&self, size: usize) {
        let mut zip = ZipWriter::new(File::create(self.0.join("input/upload.zip")).unwrap());
        zip.start_file(
            "part.stl",
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .unwrap();
        for _ in 0..size {
            zip.write_all(&[7; 64 * 1024]).unwrap();
        }
        zip.finish().unwrap();
    }
    fn input(&self) -> ZipInput {
        ZipInput::open(
            &LocalFiles::open(&self.0.join("input")).unwrap(),
            &SourcePath::try_from("upload.zip".to_owned()).unwrap(),
        )
        .unwrap()
    }
    fn tenant(&self) -> TenantRepos {
        TenantRepos::open("fixture-tenant".into(), &self.0.join("repos")).unwrap()
    }
    fn candidate(&self) -> PathBuf {
        self.0
            .join("repos/42/revisions/.pp-source-archives/.candidate")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn cli_invalid_revision_cleans_extraction_and_preserves_published_snapshot() {
    use fs2::FileExt;
    use std::process::{Command, Stdio};

    let fixture = Fixture::new();
    let mut zip = ZipWriter::new(File::create(fixture.0.join("input/upload.zip")).unwrap());
    zip.start_file(
        "part.stl",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    zip.write_all(b"solid tiny\nendsolid tiny\n").unwrap();
    zip.finish().unwrap();
    let run = |revision_key: &str| {
        let command = serde_json::json!({
            "tenantId": "fixture-tenant",
            "sourceId": 42,
            "reposDir": fixture.0.join("repos"),
            "inputDir": fixture.0.join("input"),
            "zipPath": "upload.zip",
            "revisionKey": revision_key,
        });
        let mut child = Command::new(env!("CARGO_BIN_EXE_pp-source-archive"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&command).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        println!(
            "{}",
            serde_json::json!({
                "case": "cli_invalid_revision_cleanup",
                "binary": env!("CARGO_BIN_EXE_pp-source-archive"),
                "pid": pid,
                "command": command,
                "revisionKey": revision_key,
                "exitCode": output.status.code(),
                "stdout": &output.stdout,
                "stderr": &output.stderr,
            })
        );
        output
    };
    let accepted = run("accepted");
    assert!(accepted.status.success(), "{accepted:?}");
    let published = fixture.0.join("repos/42/revisions/accepted");
    let published_files = ["part.stl", pp_source::MANIFEST];
    let retained = published_files.map(|name| fs::read(published.join(name)).unwrap());
    assert_eq!(retained[0].as_slice(), b"solid tiny\nendsolid tiny\n");
    let revision_names = || {
        let mut names: Vec<_> = fs::read_dir(published.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let revisions = revision_names();
    let input = fs::read(fixture.0.join("input/upload.zip")).unwrap();
    let rejected = run("");
    assert_eq!(rejected.status.code(), Some(1), "{rejected:?}");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&rejected.stdout).unwrap(),
        serde_json::json!({"error": "invalid-identity"})
    );
    assert!(!fixture.candidate().exists());
    let archive_parent = File::open(fixture.candidate().parent().unwrap()).unwrap();
    archive_parent.try_lock_exclusive().unwrap();
    assert_eq!(
        published_files.map(|name| fs::read(published.join(name)).unwrap()),
        retained
    );
    assert_eq!(
        fs::read_dir(&published).unwrap().count(),
        published_files.len()
    );
    assert_eq!(revision_names(), revisions);
    assert_eq!(fs::read(fixture.0.join("input/upload.zip")).unwrap(), input);
}

#[test]
fn owned_extraction_feeds_snapshot_and_cleanup_preserves_published_bytes() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let mut source = fixture.tenant().source(42).unwrap();
    let extracted = source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let receipt = extracted.receipt();
    assert_eq!(receipt.inflated_bytes, 65536);
    assert!(fixture.candidate().join("files/part.stl").is_file());
    let snapshot = source
        .materialize(
            SnapshotRequest {
                upstream_revision_key: "uuid-owned-by-caller".into(),
                files: receipt
                    .files
                    .iter()
                    .map(|f| SelectedFile {
                        path: f.path.clone(),
                        kind: FileKind::Stl,
                        size_hint_bytes: Some(f.size_bytes),
                    })
                    .collect(),
                selection: Selection {
                    max_stl_files: 500,
                    max_documentation_bytes: 1024,
                    omitted_files: vec![],
                },
            },
            extracted.files(),
            ArtifactBudget::new(1_000_000, 1_000_000).unwrap(),
        )
        .unwrap();
    extracted.discard().unwrap();
    assert!(!fixture.candidate().exists());
    assert_eq!(
        fs::read(
            fixture
                .0
                .join("repos")
                .join(snapshot.snapshot_locator)
                .join("part.stl")
        )
        .unwrap(),
        vec![7; 65536]
    );
}

#[test]
fn input_file_and_source_roots_remain_pinned_after_path_replacement() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let input = fixture.input();
    let mut source = fixture.tenant().source(42).unwrap();
    fs::rename(
        fixture.0.join("input/upload.zip"),
        fixture.0.join("input/original.zip"),
    )
    .unwrap();
    fs::write(fixture.0.join("input/upload.zip"), b"not a zip").unwrap();
    fs::rename(fixture.0.join("repos"), fixture.0.join("original-repos")).unwrap();
    fs::create_dir(fixture.0.join("repos")).unwrap();
    let extracted = source
        .extract_zip(input, ArchiveLimits::default(), &AtomicBool::new(false))
        .unwrap();
    assert_eq!(extracted.receipt().inflated_bytes, 65536);
    assert!(
        fs::read_dir(fixture.0.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
    extracted.discard().unwrap();
    assert!(
        !fixture
            .0
            .join("original-repos/42/revisions/.pp-source-archives/.candidate")
            .exists()
    );
}

#[test]
fn symlinked_archive_parent_cannot_redirect_output() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let mut source = fixture.tenant().source(42).unwrap();
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel"), b"keep").unwrap();
    std::os::unix::fs::symlink(
        &outside,
        fixture.0.join("repos/42/revisions/.pp-source-archives"),
    )
    .unwrap();
    assert!(
        source
            .extract_zip(
                fixture.input(),
                ArchiveLimits::default(),
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"keep");
}

#[test]
fn abandoned_candidate_symlink_is_unlinked_without_following_it() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let mut source = fixture.tenant().source(42).unwrap();
    fs::create_dir(fixture.candidate().parent().unwrap()).unwrap();
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel"), b"keep").unwrap();
    std::os::unix::fs::symlink(&outside, fixture.candidate()).unwrap();
    source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
        .discard()
        .unwrap();
    assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"keep");
    assert!(!fixture.candidate().exists());
}

#[test]
fn cancellation_during_input_copy_cleans_private_stage() {
    let fixture = Fixture::new();
    fixture.zip(512);
    let mut source = fixture.tenant().source(42).unwrap();
    let input = fixture.input();
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let path = fixture.candidate().join("archive.zip");
    let watcher = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
                signal.store(true, Ordering::Relaxed);
                return true;
            }
            thread::sleep(Duration::from_micros(100));
        }
        signal.store(true, Ordering::Relaxed);
        false
    });
    let result = source.extract_zip(input, ArchiveLimits::default(), &cancel);
    assert!(watcher.join().unwrap());
    assert!(matches!(result, Err(ArchiveError::Cancelled)));
    assert!(!fixture.candidate().exists());
    assert!(!fixture.0.join("repos/42/revisions/accepted").exists());
}

#[test]
fn dropping_unused_readiness_cleans_and_releases_the_stage() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let mut source = fixture.tenant().source(42).unwrap();
    let extracted = source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    drop(extracted);
    assert!(!fixture.candidate().exists());
    source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
        .discard()
        .unwrap();
}

#[test]
fn input_symlink_is_rejected_before_extraction() {
    let fixture = Fixture::new();
    fixture.zip(1);
    std::os::unix::fs::symlink(
        fixture.0.join("input/upload.zip"),
        fixture.0.join("input/alias.zip"),
    )
    .unwrap();
    let files = LocalFiles::open(&fixture.0.join("input")).unwrap();
    assert!(
        ZipInput::open(
            &files,
            &SourcePath::try_from("alias.zip".to_owned()).unwrap()
        )
        .is_err()
    );
}

#[test]
fn live_readiness_rejects_another_extraction_without_consuming_its_stage() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let mut source = fixture.tenant().source(42).unwrap();
    let first = source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(matches!(
        source.extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false)
        ),
        Err(ArchiveError::Busy)
    ));
    assert!(fixture.candidate().join("files/part.stl").is_file());
    first.discard().unwrap();
    source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
        .discard()
        .unwrap();
}

#[test]
fn archive_and_snapshot_reject_the_same_unicode_tree_collisions() {
    for names in [
        ["Straße.stl", "STRASSE.stl"],
        ["Σ.stl", "ς.stl"],
        ["σ.stl", "ς.stl"],
        ["ﬃ.stl", "FFI.stl"],
        ["Straße/a.stl", "STRASSE/b.stl"],
        ["parts/Σ/a.stl", "parts/ς/b.stl"],
        ["Straße", "STRASSE/part.stl"],
    ] {
        let fixture = Fixture::new();
        let mut zip = ZipWriter::new(File::create(fixture.0.join("input/upload.zip")).unwrap());
        for name in names {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();
        let mut source = fixture.tenant().source(42).unwrap();
        assert!(
            matches!(
                source.extract_zip(
                    fixture.input(),
                    ArchiveLimits::default(),
                    &AtomicBool::new(false)
                ),
                Err(ArchiveError::DuplicateEntry)
            ),
            "{names:?}"
        );
        assert!(!fixture.candidate().exists());
        let request = SnapshotRequest {
            upstream_revision_key: "unicode-conflict".into(),
            files: names
                .into_iter()
                .map(|name| SelectedFile {
                    path: SourcePath::try_from(name.to_owned()).unwrap(),
                    kind: FileKind::Stl,
                    size_hint_bytes: Some(1),
                })
                .collect(),
            selection: Selection {
                max_stl_files: 100,
                max_documentation_bytes: 100,
                omitted_files: vec![],
            },
        };
        assert!(
            matches!(
                source.materialize(
                    request,
                    &LocalFiles::open(&fixture.0.join("input")).unwrap(),
                    ArtifactBudget::new(10000, 10000).unwrap()
                ),
                Err(pp_source::Error::DuplicatePath)
            ),
            "{names:?}"
        );
        assert!(
            !fixture
                .0
                .join("repos/42/revisions/unicode-conflict")
                .exists()
        );
    }
}

#[test]
fn decomposed_archive_names_reject_without_normalizing_published_paths() {
    let fixture = Fixture::new();
    let mut zip = ZipWriter::new(File::create(fixture.0.join("input/upload.zip")).unwrap());
    for name in ["café.stl", "cafe\u{301}.stl"] {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(b"x").unwrap();
    }
    zip.finish().unwrap();
    let mut source = fixture.tenant().source(42).unwrap();
    assert!(matches!(
        source.extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false)
        ),
        Err(ArchiveError::UnsafeEntry)
    ));
    assert!(!fixture.candidate().exists());
}
