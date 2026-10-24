use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// Resolve a workspace binary for integration tests.
///
/// `env!("CARGO_BIN_EXE_…")` is baked in at compile time on the archive host;
/// partitioned nextest runs remap the workspace and inject runtime paths instead.
pub fn bin_exe(name: &str) -> PathBuf {
    for key in [
        format!("NEXTEST_BIN_EXE_{name}"),
        format!("CARGO_BIN_EXE_{name}"),
    ] {
        if let Ok(path) = std::env::var(&key) {
            let path = PathBuf::from(path);
            assert!(path.is_file(), "{key}={path:?} is not an executable file");
            return path;
        }
    }
    panic!(
        "binary `{name}` not found in environment (expected NEXTEST_BIN_EXE_{name} or CARGO_BIN_EXE_{name})"
    );
}

pub fn command(program: impl AsRef<OsStr>) -> Command {
    // Many #[path] copies only call command(); keep bin_exe live without #[allow].
    let _: fn(&str) -> PathBuf = bin_exe;
    Command::new(program)
}
