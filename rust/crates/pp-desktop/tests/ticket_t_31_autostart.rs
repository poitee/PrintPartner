//! T-31 (GRE-369): the per-user LaunchAgent is created and removed
//! idempotently, starts the app with an argument array, and disabling removes
//! only this app's agent. Runs on any OS against a temporary home directory;
//! the real login/reboot check needs a Mac.

use pp_desktop::autostart::{Change, LABEL, LaunchAgent, MINIMIZED_ARG};
use std::fs;
use std::path::Path;

const EXECUTABLE: &str = "/Applications/Print Partner & Co.app/Contents/MacOS/pp-desktop";

fn agents(home: &Path) -> std::path::PathBuf {
    home.join("Library/LaunchAgents")
}

#[test]
fn ticket_t_31_label_is_the_bundle_identifier() {
    let config: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(config["identifier"], LABEL);
}

#[test]
fn ticket_t_31_enable_is_idempotent_and_uses_an_argument_array() {
    let home = tempfile::tempdir().unwrap();
    let agent = LaunchAgent::new(home.path(), Path::new(EXECUTABLE)).unwrap();
    assert_eq!(
        agent.path(),
        agents(home.path()).join(format!("{LABEL}.plist"))
    );
    assert!(!agent.is_enabled());

    assert_eq!(agent.enable().unwrap(), Change::Created);
    let first = fs::read(agent.path()).unwrap();
    assert!(agent.is_enabled());
    assert_eq!(agent.enable().unwrap(), Change::Unchanged);
    assert_eq!(fs::read(agent.path()).unwrap(), first);

    let text = String::from_utf8(first).unwrap();
    // One <string> per argument, escaped, with no shell wrapper.
    let arguments = text
        .split("<key>ProgramArguments</key>")
        .nth(1)
        .unwrap()
        .split("</array>")
        .next()
        .unwrap();
    let strings: Vec<&str> = arguments
        .split("<string>")
        .skip(1)
        .map(|part| part.split("</string>").next().unwrap())
        .collect();
    assert_eq!(
        strings,
        [
            "/Applications/Print Partner &amp; Co.app/Contents/MacOS/pp-desktop",
            MINIMIZED_ARG,
        ]
    );
    assert!(!text.contains("/bin/sh"));
    assert!(text.contains(&format!("<key>Label</key>\n\t<string>{LABEL}</string>")));
    assert!(text.contains("<key>RunAtLoad</key>\n\t<true/>"));
    // No temp file is left behind.
    let names: Vec<_> = fs::read_dir(agents(home.path()))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, [format!("{LABEL}.plist")]);
}

#[test]
fn ticket_t_31_enable_rewrites_a_stale_agent_for_a_moved_app() {
    let home = tempfile::tempdir().unwrap();
    let old = LaunchAgent::new(home.path(), Path::new("/Volumes/Old/pp-desktop")).unwrap();
    assert_eq!(old.enable().unwrap(), Change::Created);
    let current = LaunchAgent::new(home.path(), Path::new(EXECUTABLE)).unwrap();
    assert!(!current.is_enabled());
    assert_eq!(current.enable().unwrap(), Change::Updated);
    assert!(current.is_enabled());
    assert!(
        !fs::read_to_string(current.path())
            .unwrap()
            .contains("/Volumes/Old")
    );
}

#[test]
fn ticket_t_31_disable_removes_only_this_apps_agent() {
    let home = tempfile::tempdir().unwrap();
    let agent = LaunchAgent::new(home.path(), Path::new(EXECUTABLE)).unwrap();
    assert_eq!(agent.disable().unwrap(), Change::Absent);

    agent.enable().unwrap();
    let other = agents(home.path()).join("com.example.other.plist");
    fs::write(
        &other,
        "<plist><dict><key>Label</key><string>com.example.other</string></dict></plist>",
    )
    .unwrap();

    assert_eq!(agent.disable().unwrap(), Change::Removed);
    assert!(!agent.path().exists());
    assert!(other.exists(), "another app's agent must stay");
    assert_eq!(agent.disable().unwrap(), Change::Absent);
}

#[test]
fn ticket_t_31_disable_keeps_a_file_that_is_not_ours() {
    let home = tempfile::tempdir().unwrap();
    let agent = LaunchAgent::new(home.path(), Path::new(EXECUTABLE)).unwrap();
    fs::create_dir_all(agents(home.path())).unwrap();
    fs::write(
        agent.path(),
        "<plist><dict><key>Label</key><string>com.example.squatter</string></dict></plist>",
    )
    .unwrap();
    assert!(agent.disable().is_err());
    assert!(agent.path().exists());
}

#[cfg(unix)]
#[test]
fn ticket_t_31_refuses_a_symlinked_agent_path() {
    let home = tempfile::tempdir().unwrap();
    let agent = LaunchAgent::new(home.path(), Path::new(EXECUTABLE)).unwrap();
    fs::create_dir_all(agents(home.path())).unwrap();
    let target = home.path().join("elsewhere.plist");
    fs::write(&target, agent.plist()).unwrap();
    std::os::unix::fs::symlink(&target, agent.path()).unwrap();
    assert!(agent.enable().is_err());
    assert!(agent.disable().is_err());
    assert!(target.exists());
}

#[test]
fn ticket_t_31_requires_absolute_paths() {
    assert!(LaunchAgent::new(Path::new("relative-home"), Path::new(EXECUTABLE)).is_err());
    assert!(LaunchAgent::new(Path::new("/Users/me"), Path::new("pp-desktop")).is_err());
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| arg.to_string()).collect()
}

#[test]
fn ticket_t_31_release_launch_accepts_minimized_and_starts_hidden() {
    use pp_desktop::LaunchArgs;
    // The exact arguments the LaunchAgent passes after the binary.
    let agent = LaunchAgent::new(Path::new("/Users/me"), Path::new(EXECUTABLE)).unwrap();
    assert!(
        agent
            .plist()
            .contains(&format!("<string>{MINIMIZED_ARG}</string>"))
    );

    let release = LaunchArgs::parse(args(&[MINIMIZED_ARG]), false).unwrap();
    assert!(release.minimized);
    assert!(!release.window_visible());

    let plain = LaunchArgs::parse(args(&[]), false).unwrap();
    assert!(plain.window_visible());
    assert_eq!(plain, LaunchArgs::default());
}

#[test]
fn ticket_t_31_release_launch_still_refuses_other_arguments() {
    use pp_desktop::LaunchArgs;
    for refused in [
        &["--unknown"][..],
        &["--data", "/tmp/x"],
        &["--dev-stage", "/tmp/x"],
        &["--test-exit-seconds", "3"],
        &["--test-recovery-logs"],
        &[MINIMIZED_ARG, "--unknown"],
    ] {
        assert!(
            LaunchArgs::parse(args(refused), false).is_err(),
            "{refused:?}"
        );
    }
    let debug = LaunchArgs::parse(
        args(&[
            MINIMIZED_ARG,
            "--data",
            "/tmp/data",
            "--test-exit-seconds",
            "3",
        ]),
        true,
    )
    .unwrap();
    assert!(debug.minimized && !debug.window_visible());
    assert_eq!(debug.data.as_deref(), Some(Path::new("/tmp/data")));
    assert_eq!(debug.test_exit, Some(3));
}
