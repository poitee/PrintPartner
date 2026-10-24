use std::path::Path;

use super::scratch::Scratch;

fn assert_empty(root: &Path) {
    let leftovers: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert!(
        leftovers.is_empty(),
        "test run leaked scratch: {leftovers:?}"
    );
}

/// Re-runs this test binary under a fresh `TMPDIR` and fails if any test left
/// files behind. `arguments` must include `--skip <this_test_name>` so the
/// check does not recurse into itself.
pub fn assert_test_run_clean(arguments: &[&str]) {
    let scratch = Scratch::new("pp-scratch-check-");
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(arguments)
        .arg("--nocapture")
        .env("TMPDIR", scratch.as_ref())
        .env("TMP", scratch.as_ref())
        .env("TEMP", scratch.as_ref())
        .env("CARGO_TARGET_TMPDIR", scratch.as_ref())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "scratch test subprocess failed\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(
        !String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("test result: ok. 0 passed;")),
        "scratch test subprocess ran no tests",
    );
    assert_empty(scratch.as_ref());
}

#[test]
fn scratch_check_rejects_leftovers() {
    let scratch = tempfile::tempdir().unwrap();
    std::fs::write(scratch.path().join("leaked-file"), b"leak").unwrap();
    let failure = std::panic::catch_unwind(|| assert_empty(scratch.path()));
    let message = failure.unwrap_err().downcast::<String>().unwrap();
    assert!(message.contains("test run leaked scratch:"));
    assert!(message.contains("leaked-file"));
}
