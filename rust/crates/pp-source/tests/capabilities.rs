use pp_source::{
    ArtifactBudget, FileKind, LocalFiles, Publication, SelectedFile, Selection, SnapshotRequest,
    SourcePath, TenantRepos,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-source-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("repos")).unwrap();
        fs::create_dir(path.join("input")).unwrap();
        fs::write(path.join("input/part.stl"), b"solid bytes").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn repos(&self) -> TenantRepos {
        TenantRepos::open("tenant-fixture".into(), &self.0.join("repos")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn request() -> SnapshotRequest {
    SnapshotRequest {
        upstream_revision_key: "caller-uuid".into(),
        files: vec![SelectedFile {
            path: SourcePath::try_from("part.stl".to_owned()).unwrap(),
            kind: FileKind::Stl,
            size_hint_bytes: Some(999),
        }],
        selection: Selection {
            max_stl_files: 500,
            max_documentation_bytes: 1000,
            omitted_files: vec![],
        },
    }
}
fn budget() -> ArtifactBudget {
    ArtifactBudget::new(1024 * 1024, 1024 * 1024).unwrap()
}

#[test]
fn source_handle_survives_repos_path_replacement_without_following_it() {
    let fixture = Fixture::new();
    let mut source = fixture.repos().source(42).unwrap();
    fs::rename(fixture.0.join("repos"), fixture.0.join("original")).unwrap();
    fs::create_dir(fixture.0.join("repos")).unwrap();
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    let receipt = source.materialize(request(), &input, budget()).unwrap();
    assert_eq!(receipt.publication, Publication::Created);
    assert!(
        fixture
            .0
            .join("original/42/revisions/caller-uuid/part.stl")
            .is_file()
    );
    assert!(
        fs::read_dir(fixture.0.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn input_handle_survives_input_path_replacement() {
    let fixture = Fixture::new();
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    fs::rename(fixture.0.join("input"), fixture.0.join("old-input")).unwrap();
    fs::create_dir(fixture.0.join("input")).unwrap();
    fs::write(fixture.0.join("input/part.stl"), b"replacement bytes").unwrap();
    fixture
        .repos()
        .source(42)
        .unwrap()
        .materialize(request(), &input, budget())
        .unwrap();
    assert_eq!(
        fs::read(fixture.0.join("repos/42/revisions/caller-uuid/part.stl")).unwrap(),
        b"solid bytes"
    );
}

#[test]
fn zero_source_and_unsafe_revision_do_not_publish() {
    let fixture = Fixture::new();
    assert!(fixture.repos().source(0).is_err());
    assert!(fixture.repos().source(9_007_199_254_740_992).is_err());
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    let mut invalid = request();
    invalid.upstream_revision_key = "../other".into();
    assert!(
        fixture
            .repos()
            .source(42)
            .unwrap()
            .materialize(invalid, &input, budget())
            .is_err()
    );
    assert!(
        fs::read_dir(fixture.0.join("repos/42/revisions"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn changed_policy_and_bytes_reuse_original_publication() {
    let fixture = Fixture::new();
    let mut source = fixture.repos().source(42).unwrap();
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    let first = source.materialize(request(), &input, budget()).unwrap();
    fs::write(fixture.0.join("input/part.stl"), b"changed").unwrap();
    let mut next = request();
    next.selection.max_stl_files = 0;
    let second = source
        .materialize(next, &input, ArtifactBudget::new(0, 0).unwrap())
        .unwrap();
    assert_eq!(second.publication, Publication::Reused);
    assert_eq!(second.manifest_digest, first.manifest_digest);
    assert_eq!(second.selection, first.selection);
}

#[test]
fn conflicting_directory_case_is_rejected_before_copying() {
    let fixture = Fixture::new();
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    let mut selected = request();
    selected.files = ["Part.stl", "part.stl/child.stl"]
        .into_iter()
        .map(|path| SelectedFile {
            path: SourcePath::try_from(path.to_owned()).unwrap(),
            kind: FileKind::Stl,
            size_hint_bytes: None,
        })
        .collect();
    let error = fixture
        .repos()
        .source(42)
        .unwrap()
        .materialize(selected, &input, budget())
        .unwrap_err();
    assert_eq!(error.category(), "duplicate-path");
    assert!(
        fs::read_dir(fixture.0.join("repos/42/revisions"))
            .unwrap()
            .next()
            .is_none()
    );
}
