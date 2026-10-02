use pp_source::{
    ArtifactBudget, LocalFiles, Selection, SnapshotRequest, SourcePath, TenantRepos,
    media::{MediaError, MediaLimits, discover_import_rules},
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
use zip::{ZipWriter, write::SimpleFileOptions};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".media-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(root.join("repos")).unwrap();
        fs::create_dir(root.join("input")).unwrap();
        Self(root)
    }
    fn model(&self, triangles: usize) {
        let mut zip = ZipWriter::new(File::create(self.0.join("input/model.3mf")).unwrap());
        zip.start_file("3D/main.model", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"<model><object name='part'><mesh><vertex x='0' y='0' z='0'/><vertex x='1' y='0' z='0'/><vertex x='0' y='1' z='0'/>").unwrap();
        for _ in 0..triangles {
            zip.write_all(b"<triangle v1='0' v2='1' v3='2'/>").unwrap();
        }
        zip.write_all(b"</mesh></object></model>").unwrap();
        zip.finish().unwrap();
    }
    fn local(&self) -> LocalFiles {
        LocalFiles::open(&self.0.join("input")).unwrap()
    }
    fn tenant(&self) -> TenantRepos {
        TenantRepos::open("tenant".into(), &self.0.join("repos")).unwrap()
    }
    fn candidate(&self) -> PathBuf {
        self.0
            .join("repos/42/revisions/.pp-source-media/.candidate")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn path(value: &str) -> SourcePath {
    SourcePath::try_from(value.to_owned()).unwrap()
}
#[test]
fn conversion_owns_candidate_and_published_original_and_derived_bytes_survive_reuse() {
    let f = Fixture::new();
    f.model(1);
    let original = fs::read(f.0.join("input/model.3mf")).unwrap();
    let tenant = f.tenant();
    let mut source = tenant.source(42).unwrap();
    let prepared = source
        .prepare_media(
            &f.local(),
            &[path("model.3mf")],
            &[],
            MediaLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(prepared.receipt().conversions[0].result.object_count, 1);
    let mut second = tenant.source(42).unwrap();
    assert!(matches!(
        second.prepare_media(
            &f.local(),
            &[path("model.3mf")],
            &[],
            MediaLimits::default(),
            &AtomicBool::new(false)
        ),
        Err(MediaError::Busy)
    ));
    assert!(f.candidate().join("_3mf/model/part.stl").is_file());
    let request = SnapshotRequest {
        upstream_revision_key: "revision".into(),
        files: prepared.receipt().selected_files.clone(),
        selection: Selection {
            max_stl_files: 500,
            max_documentation_bytes: 10000,
            omitted_files: vec![],
        },
    };
    let snapshot = source
        .materialize(
            request.clone(),
            prepared.files(),
            ArtifactBudget::new(100000, 10000).unwrap(),
        )
        .unwrap();
    let derived = fs::read(
        f.0.join("repos")
            .join(&snapshot.snapshot_locator)
            .join("_3mf/model/part.stl"),
    )
    .unwrap();
    prepared.discard().unwrap();
    assert!(!f.candidate().exists());
    f.model(2);
    let prepared = source
        .prepare_media(
            &f.local(),
            &[path("model.3mf")],
            &[],
            MediaLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let reused = source
        .materialize(
            request,
            prepared.files(),
            ArtifactBudget::new(100000, 10000).unwrap(),
        )
        .unwrap();
    assert_eq!(reused.manifest_digest, snapshot.manifest_digest);
    assert_eq!(reused.publication, pp_source::Publication::Reused);
    assert_eq!(
        fs::read(
            f.0.join("repos")
                .join(&snapshot.snapshot_locator)
                .join("model.3mf")
        )
        .unwrap(),
        original
    );
    assert_eq!(
        fs::read(
            f.0.join("repos")
                .join(&snapshot.snapshot_locator)
                .join("_3mf/model/part.stl")
        )
        .unwrap(),
        derived
    );
    drop(prepared);
    assert!(!f.candidate().exists());
}
#[test]
fn failure_after_writing_a_facet_cleans_all_private_files_and_retry_succeeds() {
    let f = Fixture::new();
    f.model(2);
    let mut source = f.tenant().source(42).unwrap();
    let result = source.prepare_media(
        &f.local(),
        &[path("model.3mf")],
        &[],
        MediaLimits {
            max_output_bytes: 170,
            ..MediaLimits::default()
        },
        &AtomicBool::new(false),
    );
    assert!(matches!(
        result,
        Err(MediaError::Invalid(
            "3MF derived STL output exceeds the size limit"
        ))
    ));
    assert!(!f.candidate().exists());
    assert!(f.0.join("input/model.3mf").exists());
    source
        .prepare_media(
            &f.local(),
            &[path("model.3mf")],
            &[],
            MediaLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
        .discard()
        .unwrap();
}
#[test]
fn cancelled_live_conversion_cleans_derived_files_and_retries() {
    let f = Fixture::new();
    f.model(20000);
    let mut source = f.tenant().source(42).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let signal = cancelled.clone();
    let output = f.candidate().join("_3mf/model/part.stl");
    let watcher = thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(20) {
            if fs::metadata(&output).is_ok_and(|m| m.len() > 100) {
                signal.store(true, Ordering::Relaxed);
                return true;
            }
            thread::sleep(Duration::from_millis(1));
        }
        false
    });
    let result = source.prepare_media(
        &f.local(),
        &[path("model.3mf")],
        &[],
        MediaLimits::default(),
        &cancelled,
    );
    assert!(watcher.join().unwrap());
    assert!(matches!(
        result,
        Err(MediaError::Archive(
            pp_source::archive::ArchiveError::Cancelled
        ))
    ));
    assert!(!f.candidate().exists());
    cancelled.store(false, Ordering::Relaxed);
    source
        .prepare_media(
            &f.local(),
            &[path("model.3mf")],
            &[],
            MediaLimits::default(),
            &cancelled,
        )
        .unwrap()
        .discard()
        .unwrap();
}
#[test]
fn original_capability_survives_path_replacement_and_output_symlinks_are_confined() {
    let f = Fixture::new();
    f.model(1);
    let local = f.local();
    fs::rename(f.0.join("input"), f.0.join("moved")).unwrap();
    std::os::unix::fs::symlink(f.0.join("repos"), f.0.join("input")).unwrap();
    let mut source = f.tenant().source(42).unwrap();
    let prepared = source
        .prepare_media(
            &local,
            &[path("model.3mf")],
            &[],
            MediaLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(prepared.receipt().conversions[0].result.object_count, 1);
    prepared.discard().unwrap();
    fs::remove_dir(f.0.join("repos/42/revisions/.pp-source-media")).unwrap();
    std::os::unix::fs::symlink(
        f.0.join("moved"),
        f.0.join("repos/42/revisions/.pp-source-media"),
    )
    .unwrap();
    assert!(
        source
            .prepare_media(
                &local,
                &[path("model.3mf")],
                &[],
                MediaLimits::default(),
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert!(f.0.join("moved/model.3mf").is_file());
}
#[test]
fn discovery_keeps_empty_directories_and_uses_filesystem_name_order_with_printables_after_directories()
 {
    let f = Fixture::new();
    fs::create_dir(f.0.join("input/wrapper")).unwrap();
    assert_eq!(discover_import_rules(&f.local()).unwrap(), vec!["wrapper/"]);
    fs::create_dir(f.0.join("input/𐀀")).unwrap();
    fs::create_dir(f.0.join("input/\u{e000}")).unwrap();
    fs::write(f.0.join("input/a.STL"), b"stl").unwrap();
    fs::write(f.0.join("input/B.3MF"), b"opaque").unwrap();
    fs::write(f.0.join("input/ignored.zip"), b"zip").unwrap();
    assert_eq!(
        discover_import_rules(&f.local()).unwrap(),
        vec!["wrapper/", "\u{e000}/", "𐀀/", "B.3MF", "a.STL"]
    );
}
#[test]
fn original_derived_collisions_refuse_without_overwrite() {
    let f = Fixture::new();
    f.model(1);
    fs::create_dir_all(f.0.join("input/_3mf/model")).unwrap();
    fs::write(f.0.join("input/_3mf/model/part.stl"), b"immutable original").unwrap();
    let mut source = f.tenant().source(42).unwrap();
    assert!(
        source
            .prepare_media(
                &f.local(),
                &[path("model.3mf"), path("_3mf/model/part.stl")],
                &[],
                MediaLimits::default(),
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert_eq!(
        fs::read(f.0.join("input/_3mf/model/part.stl")).unwrap(),
        b"immutable original"
    );
    assert!(!f.candidate().exists());
}
