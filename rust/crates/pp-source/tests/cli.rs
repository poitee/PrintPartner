use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-source-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("repos")).unwrap();
        fs::create_dir(path.join("input")).unwrap();
        fs::write(path.join("input/part.stl"), b"solid bytes").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn command(&self) -> Value {
        json!({
            "tenantId": "tenant-fixture",
            "sourceId": 42,
            "reposDir": self.0.join("repos"),
            "inputDir": self.0.join("input"),
            "reservedStoredBytes": 1024 * 1024,
            "snapshot": {
                "upstreamRevisionKey": "caller-uuid",
                "files": [{"path": "part.stl", "kind": "stl", "sizeHintBytes": 999}],
                "selection": {
                    "maxStlFiles": 500,
                    "maxDocumentationBytes": 1000,
                    "omittedFiles": []
                }
            }
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// The binary's arguments are fields of its single JSON command on stdin.
fn invoke(fixture: &Fixture, command: &Value) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_pp-source"))
        .current_dir(&fixture.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(command.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn assert_error(output: Output, category: &str) {
    assert!(!output.status.success(), "{output:?}");
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response.as_object().unwrap().len(), 1, "{response}");
    let error = response["error"].as_str().unwrap();
    // The application owns the category; any suffix is diagnostic text.
    assert_eq!(
        error
            .split_once(": ")
            .map_or(error, |(category, _)| category),
        category
    );
    assert!(output.stderr.is_empty(), "{output:?}");
}

#[test]
fn unknown_argument_exits_nonzero_with_invalid_json_category() {
    let fixture = Fixture::new();
    let mut command = fixture.command();
    command["unknownArgument"] = json!(true);
    assert_error(invoke(&fixture, &command), "invalid-json");
    assert!(
        fs::read_dir(fixture.0.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn missing_value_exits_nonzero_with_invalid_json_category() {
    let fixture = Fixture::new();
    let mut command = fixture.command();
    command.as_object_mut().unwrap().remove("inputDir");
    assert_error(invoke(&fixture, &command), "invalid-json");
    assert!(
        fs::read_dir(fixture.0.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn bad_path_exits_nonzero_with_unsafe_path_category() {
    let fixture = Fixture::new();
    let mut command = fixture.command();
    command["reposDir"] = json!("relative/repos");
    assert_error(invoke(&fixture, &command), "unsafe-path");
    assert!(!fixture.0.join("relative").exists());
    assert!(
        fs::read_dir(fixture.0.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn success_emits_json_matching_committed_example() {
    let fixture = Fixture::new();
    let output = invoke(&fixture, &fixture.command());
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected: Value = serde_json::from_str(include_str!("examples/created.json")).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(
        fs::read(fixture.0.join("repos/42/revisions/caller-uuid/part.stl")).unwrap(),
        b"solid bytes"
    );
}

#[test]
fn cli_invalid_revision_cleans_extraction_and_preserves_published_snapshot() {
    use fs2::FileExt;

    let fixture = Fixture::new();
    let mut zip =
        zip::ZipWriter::new(fs::File::create(fixture.0.join("input/upload.zip")).unwrap());
    zip.start_file(
        "part.stl",
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
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
    assert!(
        !fixture
            .0
            .join("repos/42/revisions/.pp-source-archives/.candidate")
            .exists()
    );
    let source_lock = fs::File::open(fixture.0.join("repos/42/revisions")).unwrap();
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
