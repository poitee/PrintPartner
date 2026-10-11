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
    let source_lock = File::open(fixture.0.join("repos/42/revisions")).unwrap();
    source_lock.try_lock_exclusive().unwrap();
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

fn local_request(key: &str) -> SnapshotRequest {
    SnapshotRequest {
        upstream_revision_key: key.into(),
        files: vec![SelectedFile {
            path: SourcePath::try_from("part.stl".to_owned()).unwrap(),
            kind: FileKind::Stl,
            size_hint_bytes: None,
        }],
        selection: Selection {
            max_stl_files: 500,
            max_documentation_bytes: 1024,
            omitted_files: vec![],
        },
    }
}

#[test]
fn peer_materialize_waits_until_live_archive_readiness_is_discarded() {
    let fixture = Fixture::new();
    fixture.zip(1);
    fs::write(fixture.0.join("input/part.stl"), b"peer bytes").unwrap();
    let mut owner = fixture.tenant().source(42).unwrap();
    let extracted = owner
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let revisions = fixture.0.join("repos/42/revisions");
    let finished = Arc::new(AtomicBool::new(false));
    let peer = {
        let mut peer = fixture.tenant().source(42).unwrap();
        let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
        let finished = finished.clone();
        thread::spawn(move || {
            let result = peer.materialize(
                local_request("peer"),
                &input,
                ArtifactBudget::new(1_000_000, 1_000_000).unwrap(),
            );
            finished.store(true, Ordering::Release);
            result
        })
    };
    // The peer's candidate must not stack on top of the live archive stage.
    thread::sleep(Duration::from_millis(500));
    assert!(!finished.load(Ordering::Acquire));
    assert!(!revisions.join(".pp-source-candidate").exists());
    assert!(!revisions.join("peer").exists());
    // The owning handle materializes under the lock it already holds.
    let owned = owner
        .materialize(
            local_request("owned"),
            extracted.files(),
            ArtifactBudget::new(1_000_000, 1_000_000).unwrap(),
        )
        .unwrap();
    assert_eq!(owned.files[0].size_bytes, 65536);
    assert!(!finished.load(Ordering::Acquire));
    extracted.discard().unwrap();
    let peer = peer.join().unwrap().unwrap();
    assert!(!fixture.candidate().exists());
    assert_eq!(
        fs::read(revisions.join("peer/part.stl")).unwrap(),
        b"peer bytes"
    );
    assert_eq!(peer.files[0].size_bytes, 10);
}

#[test]
fn extraction_is_busy_while_a_peer_holds_the_source_revisions_lock() {
    use fs2::FileExt;

    let fixture = Fixture::new();
    fixture.zip(1);
    let mut source = fixture.tenant().source(42).unwrap();
    // A peer process mid-materialize holds this lock on its own descriptor.
    let peer = File::open(fixture.0.join("repos/42/revisions")).unwrap();
    peer.lock_exclusive().unwrap();
    assert!(matches!(
        source.extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false)
        ),
        Err(ArchiveError::Busy)
    ));
    assert!(!fixture.candidate().exists());
    FileExt::unlock(&peer).unwrap();
    let extracted = source
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(peer.try_lock_exclusive().is_err());
    drop(extracted);
    assert!(!fixture.candidate().exists());
    peer.try_lock_exclusive().unwrap();
}

fn deflated_zip(fixture: &Fixture, data: &[u8]) {
    let mut zip = ZipWriter::new(File::create(fixture.0.join("input/upload.zip")).unwrap());
    zip.start_file(
        "part.stl",
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )
    .unwrap();
    zip.write_all(data).unwrap();
    zip.finish().unwrap();
}
fn extract(fixture: &Fixture) -> Result<(), ArchiveError> {
    fixture
        .tenant()
        .source(42)
        .unwrap()
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )?
        .discard()
}

#[test]
fn high_compression_ratio_entry_is_rejected_before_inflating() {
    use pp_source::archive::MAX_COMPRESSION_RATIO;

    let fixture = Fixture::new();
    // 8 MiB of zeros deflates to roughly 1000:1, far above the 100:1 cap.
    deflated_zip(&fixture, &vec![0; 8 * 1024 * 1024]);
    let compressed = fs::metadata(fixture.0.join("input/upload.zip"))
        .unwrap()
        .len();
    assert!(8 * 1024 * 1024 > compressed * MAX_COMPRESSION_RATIO);
    assert!(matches!(
        extract(&fixture),
        Err(ArchiveError::CompressionRatio)
    ));
    assert_eq!(
        ArchiveError::CompressionRatio.to_string(),
        "compression-ratio"
    );
    assert!(!fixture.candidate().exists());
    assert!(
        !fixture
            .0
            .join("repos/42/revisions/archive-revision")
            .exists()
    );
}

#[test]
fn understated_sizes_cannot_smuggle_a_high_ratio_entry_past_the_cap() {
    use pp_source::archive::COMPRESSION_RATIO_FLOOR_BYTES;

    let fixture = Fixture::new();
    deflated_zip(&fixture, &vec![0; 8 * 1024 * 1024]);
    // Advertise exactly the floor so the central-directory check passes and
    // only the streaming byte cap can stop the real 8 MiB payload.
    let path = fixture.0.join("input/upload.zip");
    let mut data = fs::read(&path).unwrap();
    let central = data.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    let floor = (COMPRESSION_RATIO_FLOOR_BYTES as u32).to_le_bytes();
    data[22..26].copy_from_slice(&floor);
    data[central + 24..central + 28].copy_from_slice(&floor);
    fs::write(&path, data).unwrap();
    assert!(matches!(
        extract(&fixture),
        Err(ArchiveError::CompressionRatio)
    ));
    assert!(!fixture.candidate().exists());
}

#[test]
fn ratio_cap_exempts_small_entries_and_accepts_ordinary_compression() {
    let fixture = Fixture::new();
    // Below the 1 MiB floor even an extreme ratio is accepted.
    deflated_zip(&fixture, &vec![0; 512 * 1024]);
    extract(&fixture).unwrap();
    // Above the floor, ordinary low-entropy data (~2:1) is accepted.
    let mut state = 0x2545_f491_u32;
    let data: Vec<u8> = (0..4 * 1024 * 1024)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 28) as u8
        })
        .collect();
    deflated_zip(&fixture, &data);
    extract(&fixture).unwrap();
    assert!(!fixture.candidate().exists());
}

/// Writes a valid ZIP of empty stored files whose central directory is
/// exactly `central_bytes` long, padding it with per-entry comments.
fn zip_with_central_directory(fixture: &Fixture, central_bytes: usize) {
    const NAME: usize = 9;
    let mut comments = vec![];
    let mut remaining = central_bytes;
    while remaining > 0 {
        let entry = remaining.min(46 + NAME + 65_535);
        assert!(entry >= 46 + NAME);
        comments.push(entry - 46 - NAME);
        remaining -= entry;
    }
    let mut local = vec![];
    let mut central = vec![];
    for (index, comment) in comments.iter().enumerate() {
        let name = format!("f{index:04}.stl");
        assert_eq!(name.len(), NAME);
        let offset = local.len() as u32;
        local.extend_from_slice(b"PK\x03\x04");
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(&[0; 20]);
        local.extend_from_slice(&(NAME as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name.as_bytes());
        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&[0; 20]);
        central.extend_from_slice(&(NAME as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&(*comment as u16).to_le_bytes());
        central.extend_from_slice(&[0; 8]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
        central.extend(std::iter::repeat_n(b'c', *comment));
    }
    assert_eq!(central.len(), central_bytes);
    let count = (comments.len() as u16).to_le_bytes();
    let mut data = local;
    let central_offset = (data.len() as u32).to_le_bytes();
    data.extend_from_slice(&central);
    data.extend_from_slice(b"PK\x05\x06");
    data.extend_from_slice(&[0; 4]);
    data.extend_from_slice(&count);
    data.extend_from_slice(&count);
    data.extend_from_slice(&(central_bytes as u32).to_le_bytes());
    data.extend_from_slice(&central_offset);
    data.extend_from_slice(&0u16.to_le_bytes());
    fs::write(fixture.0.join("input/upload.zip"), data).unwrap();
}

#[test]
fn central_directory_metadata_is_bounded_at_eight_mebibytes() {
    use pp_source::archive::MAX_METADATA_BYTES;

    let fixture = Fixture::new();
    zip_with_central_directory(&fixture, MAX_METADATA_BYTES as usize);
    extract(&fixture).unwrap();
    zip_with_central_directory(&fixture, MAX_METADATA_BYTES as usize + 1);
    assert!(matches!(extract(&fixture), Err(ArchiveError::Limit)));
    assert!(!fixture.candidate().exists());
}

#[test]
fn zip64_extra_sizes_cannot_override_the_checked_central_sizes() {
    let fixture = Fixture::new();
    // Take a real ~1000:1 deflate stream for 8 MiB of zeros.
    deflated_zip(&fixture, &vec![0; 8 * 1024 * 1024]);
    let original = fs::read(fixture.0.join("input/upload.zip")).unwrap();
    let u16_at = |at: usize| u16::from_le_bytes([original[at], original[at + 1]]) as usize;
    let central = original
        .windows(4)
        .position(|w| w == b"PK\x01\x02")
        .unwrap();
    let crc = &original[central + 16..central + 20];
    let start = 30 + u16_at(26) + u16_at(28);
    let compressed = &original[start
        ..start
            + u32::from_le_bytes(original[central + 20..central + 24].try_into().unwrap())
                as usize];
    // Ordinary sizes claim a harmless 10:1 entry padded to 100,000 bytes,
    // while a ZIP64 extra field carries the real 8 MiB / ~8 KiB sizes.
    let (claimed_compressed, claimed_inflated) = (100_000u32, 1024 * 1024u32);
    let name = b"part.stl";
    let mut data = vec![];
    data.extend_from_slice(b"PK\x03\x04");
    data.extend_from_slice(&20u16.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&8u16.to_le_bytes());
    data.extend_from_slice(&[0; 4]);
    data.extend_from_slice(crc);
    data.extend_from_slice(&claimed_compressed.to_le_bytes());
    data.extend_from_slice(&claimed_inflated.to_le_bytes());
    data.extend_from_slice(&(name.len() as u16).to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(name);
    data.extend_from_slice(compressed);
    data.resize(30 + name.len() + claimed_compressed as usize, 0);
    let central_offset = data.len() as u32;
    data.extend_from_slice(b"PK\x01\x02");
    data.extend_from_slice(&45u16.to_le_bytes());
    data.extend_from_slice(&45u16.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&8u16.to_le_bytes());
    data.extend_from_slice(&[0; 4]);
    data.extend_from_slice(crc);
    data.extend_from_slice(&claimed_compressed.to_le_bytes());
    data.extend_from_slice(&claimed_inflated.to_le_bytes());
    data.extend_from_slice(&(name.len() as u16).to_le_bytes());
    data.extend_from_slice(&28u16.to_le_bytes());
    data.extend_from_slice(&[0; 10]);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(name);
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&24u16.to_le_bytes());
    data.extend_from_slice(&(8u64 * 1024 * 1024).to_le_bytes());
    data.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    let central_size = data.len() as u32 - central_offset;
    data.extend_from_slice(b"PK\x05\x06");
    data.extend_from_slice(&[0; 4]);
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&central_size.to_le_bytes());
    data.extend_from_slice(&central_offset.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    fs::write(fixture.0.join("input/upload.zip"), data).unwrap();
    let error = extract(&fixture).unwrap_err();
    assert!(matches!(error, ArchiveError::InvalidArchive), "{error:?}");
    assert!(!fixture.candidate().exists());
}

fn find_validated_eocd_offset(data: &[u8]) -> usize {
    let tail_size = data.len().min(65_557);
    let tail_start = data.len() - tail_size;
    let tail = &data[tail_start..];
    for i in (0..tail_size.saturating_sub(21)).rev() {
        if tail[i..i + 4] != *b"PK\x05\x06" {
            continue;
        }
        let comment_len = u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize;
        if i + 22 + comment_len != tail_size {
            continue;
        }
        let footer = &tail[i..];
        let central_size = u32::from_le_bytes(footer[12..16].try_into().unwrap()) as u64;
        let central_offset = u32::from_le_bytes(footer[16..20].try_into().unwrap()) as u64;
        let eocd_offset = tail_start + i;
        if central_offset + central_size == eocd_offset as u64 {
            return eocd_offset;
        }
    }
    panic!("validated EOCD");
}

fn set_archive_comment(data: &mut Vec<u8>, comment: &[u8]) {
    let o = find_validated_eocd_offset(data);
    data.truncate(o + 22);
    data.extend_from_slice(comment);
    data[o + 20..o + 22].copy_from_slice(&(comment.len() as u16).to_le_bytes());
}

fn fake_eocd_comment(decoy_offset: u32, decoy_size: u32, entries: u16) -> Vec<u8> {
    let mut comment = vec![b' '; 4096];
    let mut fake = Vec::from(*b"PK\x05\x06");
    fake.extend_from_slice(&0u16.to_le_bytes());
    fake.extend_from_slice(&0u16.to_le_bytes());
    fake.extend_from_slice(&entries.to_le_bytes());
    fake.extend_from_slice(&entries.to_le_bytes());
    fake.extend_from_slice(&decoy_size.to_le_bytes());
    fake.extend_from_slice(&decoy_offset.to_le_bytes());
    fake.extend_from_slice(&0u16.to_le_bytes());
    assert_eq!(fake.len(), 22);
    comment.extend(fake);
    comment
}

#[test]
fn archive_comment_cannot_embed_a_second_end_record() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let path = fixture.0.join("input/upload.zip");
    let mut data = fs::read(&path).unwrap();
    // A decoy central directory large enough that the ZIP crate would over-allocate
    // if it indexed the fake EOCD placed at the end of the archive comment.
    let o = find_validated_eocd_offset(&data);
    set_archive_comment(
        &mut data,
        &fake_eocd_comment(o as u32, 56 * 1024 * 1024, 10_000),
    );
    fs::write(&path, data).unwrap();
    assert!(matches!(
        extract(&fixture),
        Err(ArchiveError::InvalidArchive)
    ));
    assert!(!fixture.candidate().exists());
}

#[test]
fn ordinary_archive_comment_is_accepted() {
    let fixture = Fixture::new();
    fixture.zip(1);
    let path = fixture.0.join("input/upload.zip");
    let mut data = fs::read(&path).unwrap();
    set_archive_comment(&mut data, b"fixture note");
    fs::write(&path, data).unwrap();
    extract(&fixture).unwrap();
    assert!(!fixture.candidate().exists());
}

#[test]
fn discarding_readiness_keeps_the_lock_for_a_running_owner_materialization() {
    use fs2::FileExt;

    let fixture = Fixture::new();
    fixture.zip(1);
    // Large enough that copying and syncing outlasts the discard below.
    let mut big = File::create(fixture.0.join("input/part.stl")).unwrap();
    for _ in 0..256 {
        big.write_all(&[3; 1024 * 1024]).unwrap();
    }
    drop(big);
    let mut owner = fixture.tenant().source(42).unwrap();
    let extracted = owner
        .extract_zip(
            fixture.input(),
            ArchiveLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let revisions = fixture.0.join("repos/42/revisions");
    let finished = Arc::new(AtomicBool::new(false));
    let worker = {
        let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
        let finished = finished.clone();
        thread::spawn(move || {
            let result = owner.materialize(
                local_request("owner-local"),
                &input,
                ArtifactBudget::new(1 << 30, 1 << 30).unwrap(),
            );
            finished.store(true, Ordering::Release);
            result
        })
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !revisions.join(".pp-source-candidate").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_micros(200));
    }
    extracted.discard().unwrap();
    let peer = File::open(&revisions).unwrap();
    let acquired = peer.try_lock_exclusive().is_ok();
    let running = !finished.load(Ordering::Acquire);
    assert!(running, "materialization finished before the check");
    assert!(!acquired, "a peer took the lock during the owner's copy");
    let snapshot = worker.join().unwrap().unwrap();
    assert_eq!(snapshot.files[0].size_bytes, 256 * 1024 * 1024);
    peer.try_lock_exclusive().unwrap();
}
