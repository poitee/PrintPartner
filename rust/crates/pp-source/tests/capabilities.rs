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
fn searchable_ancestor_without_read_access_allows_publication_and_reuse() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    struct RestorePermissions<'a>(&'a std::path::Path, fs::Permissions);
    impl Drop for RestorePermissions<'_> {
        fn drop(&mut self) {
            fs::set_permissions(self.0, self.1.clone()).unwrap();
        }
    }
    let _restore = RestorePermissions(&fixture.0, fs::metadata(&fixture.0).unwrap().permissions());
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o111)).unwrap();
    // Root and processes with DAC overrides cannot exercise this restriction.
    if fs::read_dir(&fixture.0).is_ok() {
        eprintln!("Skipping permission restriction with privileged filesystem access");
        return;
    }
    assert_eq!(
        fs::read_dir(&fixture.0).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    let mut source = fixture.repos().source(42).unwrap();
    assert_eq!(
        source
            .materialize(request(), &input, budget())
            .unwrap()
            .publication,
        Publication::Created
    );
    assert_eq!(
        source
            .materialize(request(), &input, budget())
            .unwrap()
            .publication,
        Publication::Reused
    );
    assert_eq!(
        fs::read(fixture.0.join("repos/42/revisions/caller-uuid/part.stl")).unwrap(),
        b"solid bytes"
    );
}

#[test]
fn root_walk_rejects_symlink_ancestors_and_selected_roots() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let alias = fixture.0.with_extension("alias");
    symlink(&fixture.0, &alias).unwrap();
    let repos = TenantRepos::open("tenant-fixture".into(), &alias.join("repos"));
    let input = LocalFiles::open(&alias.join("input"));
    fs::remove_file(&alias).unwrap();
    assert!(repos.is_err());
    assert!(input.is_err());

    symlink(fixture.0.join("repos"), fixture.0.join("repos-alias")).unwrap();
    symlink(fixture.0.join("input"), fixture.0.join("input-alias")).unwrap();
    assert!(TenantRepos::open("tenant-fixture".into(), &fixture.0.join("repos-alias")).is_err());
    assert!(LocalFiles::open(&fixture.0.join("input-alias")).is_err());
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

#[test]
fn max_flat_snapshot_publishes_and_retries_cleanly() {
    let fixture = Fixture::new();
    let input_dir = fixture.0.join("input");
    let mut files = Vec::new();
    for i in 0..pp_source::MAX_ENTRIES {
        let name = format!("f{i:05}.stl");
        fs::write(input_dir.join(&name), b"x").unwrap();
        files.push(SelectedFile {
            path: SourcePath::try_from(name).unwrap(),
            kind: FileKind::Stl,
            size_hint_bytes: Some(1),
        });
    }
    let mut req = request();
    req.files = files;
    req.selection.max_stl_files = pp_source::MAX_ENTRIES as u64;
    let budget = ArtifactBudget::new(16 * 1024 * 1024, 16 * 1024 * 1024).unwrap();
    let input = LocalFiles::open(&input_dir).unwrap();
    let mut source = fixture.repos().source(42).unwrap();
    let first = source.materialize(req.clone(), &input, budget).unwrap();
    assert_eq!(first.publication, Publication::Created);
    assert!(
        !fixture
            .0
            .join("repos/42/revisions/.pp-source-candidate")
            .exists()
    );
    let second = source.materialize(req, &input, budget).unwrap();
    assert_eq!(second.publication, Publication::Reused);
}

#[test]
fn cli_retry_reuses_revision_after_inputs_are_deleted() {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let fixture = Fixture::new();
    let command = serde_json::json!({
        "tenantId": "tenant-fixture", "sourceId": 42,
        "reposDir": fixture.0.join("repos"), "inputDir": fixture.0.join("input"),
        "reservedStoredBytes": 1024 * 1024, "snapshot": request(),
    });
    let invoke = || {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pp-source"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(command.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let first = invoke();
    assert_eq!(first["publication"], "created");
    fs::remove_dir_all(fixture.0.join("input")).unwrap();
    let reused = invoke();
    assert_eq!(reused["publication"], "reused");
    for key in [
        "manifestDigest",
        "files",
        "selection",
        "storedBytes",
        "snapshotLocator",
    ] {
        assert_eq!(reused[key], first[key]);
    }
}

#[test]
fn shared_directory_case_publishes_with_one_spelling_and_reuses() {
    let fixture = Fixture::new();
    let paths = ["Parts/Nested/a.stl", "parts/nested/b.stl"];
    for (path, bytes) in paths
        .iter()
        .zip([b"first".as_slice(), b"second".as_slice()])
    {
        let full = fixture.0.join("input").join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, bytes).unwrap();
    }
    let mut selected = request();
    selected.files = paths
        .into_iter()
        .rev()
        .map(|path| SelectedFile {
            path: SourcePath::try_from(path.to_owned()).unwrap(),
            kind: FileKind::Stl,
            size_hint_bytes: None,
        })
        .collect();
    let input = LocalFiles::open(&fixture.0.join("input")).unwrap();
    let mut source = fixture.repos().source(42).unwrap();
    let first = source
        .materialize(selected.clone(), &input, budget())
        .unwrap();
    assert_eq!(first.publication, Publication::Created);
    assert_eq!(
        first
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["Parts/Nested/a.stl", "Parts/Nested/b.stl"]
    );
    let published = fixture.0.join("repos/42/revisions/caller-uuid");
    assert_eq!(
        fs::read(published.join("Parts/Nested/a.stl")).unwrap(),
        b"first"
    );
    assert_eq!(
        fs::read(published.join("Parts/Nested/b.stl")).unwrap(),
        b"second"
    );
    assert_eq!(fs::read_dir(published.join("Parts")).unwrap().count(), 1);
    let second = source.materialize(selected, &input, budget()).unwrap();
    assert_eq!(second.publication, Publication::Reused);
    assert_eq!(second.manifest_digest, first.manifest_digest);
    assert_eq!(second.files, first.files);
}
