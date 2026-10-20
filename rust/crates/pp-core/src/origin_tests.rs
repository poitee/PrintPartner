#![cfg(test)]

use std::os::unix::{ffi::OsStrExt, fs::DirBuilderExt};

use super::*;
use crate::origin::persist_initial_origin;
use std::net::Ipv4Addr;
use std::{os::unix::fs::symlink, path::Path};
use tokio::net::TcpListener;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("pp-t12-{}", hex::encode(rand::random::<[u8; 8]>())));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)
            .unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        for entry in std::fs::read_dir(&self.0).unwrap() {
            let existing = entry.unwrap().file_name();
            let existing = existing.to_str().unwrap();
            assert!(
                existing == name || existing.to_lowercase() != name.to_lowercase(),
                "case-folding fixture collision: {existing:?} and {name:?}"
            );
        }
        self.0.join(name)
    }

    fn config(&self) -> PathBuf {
        self.path("desktop.toml")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
#[should_panic(expected = "case-folding fixture collision")]
fn fixture_rejects_historical_case_fold_collision() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.path("desktop.toml-0123456789abcdef.new"),
        b"stale publication",
    )
    .unwrap();
    fixture.path("desktop.toml-0123456789abcdeF.new");
}

#[test]
fn fixture_allows_exact_reuse_and_distinct_mixed_case_names() {
    let fixture = Fixture::new();
    let stale = fixture.path("desktop.toml-0123456789abcdef.new");
    std::fs::write(&stale, b"stale publication").unwrap();
    assert_eq!(fixture.path("desktop.toml-0123456789abcdef.new"), stale);
    let preserved = fixture.path("desktop.toml-1123456789abcdeF.new");
    std::fs::write(&preserved, b"preserved bytes").unwrap();
    assert_eq!(std::fs::read(stale).unwrap(), b"stale publication");
    assert_eq!(std::fs::read(preserved).unwrap(), b"preserved bytes");
}

#[tokio::test]
async fn ticket_t_12_linked_config_is_refused_without_replacement() {
    for present in [false, true] {
        let fixture = Fixture::new();
        let target = fixture.path("external.toml");
        if present {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            std::fs::write(
                &target,
                format!("port = {}\n", listener.local_addr().unwrap().port()),
            )
            .unwrap();
        }
        symlink(&target, fixture.config()).unwrap();
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        assert!(bind_origin(&owner).await.is_err(), "linked config accepted");
        assert_eq!(std::fs::read_link(fixture.config()).unwrap(), target);
        assert_eq!(target.exists(), present);
        drop(owner);
        assert!(!fixture.path(".desktop-owner.json").exists());
    }
}

#[tokio::test]
async fn ticket_t_12_oversized_config_is_refused_and_preserved() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bytes = format!(
        "port = {}\n{}",
        listener.local_addr().unwrap().port(),
        " ".repeat(4096)
    );
    drop(listener);
    std::fs::write(fixture.config(), &bytes).unwrap();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    assert!(
        bind_origin(&owner).await.is_err(),
        "oversized config accepted"
    );
    assert_eq!(std::fs::read_to_string(fixture.config()).unwrap(), bytes);
}

#[tokio::test]
async fn ticket_t_12_missing_config_persists_private_port_and_reuses_it() {
    use std::os::unix::fs::PermissionsExt;
    if std::env::var_os("PP_T12_ORIGIN_CHILD").is_none() {
        run_child(
            "origin_tests::ticket_t_12_missing_config_persists_private_port_and_reuses_it",
            "PP_T12_ORIGIN_CHILD",
            std::ffi::OsStr::new("1"),
        );
        return;
    }
    let fixture = Fixture::new();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let (listener, change) = bind_origin(&owner).await.unwrap();
    assert_eq!(change, None);
    let address = listener.local_addr().unwrap();
    assert_eq!(address.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert_ne!(address.port(), 0);
    let bytes = std::fs::read(fixture.config()).unwrap();
    assert_eq!(bytes, format!("port = {}\n", address.port()).as_bytes());
    assert_eq!(
        std::fs::metadata(fixture.config())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    drop(listener);
    let (listener, change) = bind_origin(&owner).await.unwrap();
    assert_eq!(change, None);
    assert_eq!(listener.local_addr().unwrap(), address);
    assert_eq!(std::fs::read(fixture.config()).unwrap(), bytes);
}

#[tokio::test]
async fn ticket_t_12_corrupt_config_preserves_data() {
    let fixture = Fixture::new();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    for bytes in [
        b"".as_slice(),
        b"port = 0\n",
        b"port = 65536\n",
        b"port = 1\nport = 2\n",
        b"port = \xff\n",
    ] {
        std::fs::write(fixture.config(), bytes).unwrap();
        assert!(bind_origin(&owner).await.is_err());
        assert_eq!(std::fs::read(fixture.config()).unwrap(), bytes);
    }
    drop(owner);
    assert!(!fixture.path(".desktop-owner.json").exists());
}

#[tokio::test]
async fn ticket_t_12_unreadable_config_is_refused_without_replacement() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    std::fs::write(fixture.config(), "port = 12345\n").unwrap();
    std::fs::set_permissions(fixture.config(), std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::File::open(fixture.config());
    if readable.is_ok() {
        std::fs::set_permissions(fixture.config(), std::fs::Permissions::from_mode(0o600)).unwrap();
        eprintln!("permission-denial case skipped: this process can read mode 000 files");
        return;
    }
    assert_eq!(
        readable.unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let result = bind_origin(&owner).await;
    std::fs::set_permissions(fixture.config(), std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        result
            .unwrap_err()
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(std::fs::read(fixture.config()).unwrap(), b"port = 12345\n");
}

#[tokio::test]
async fn ticket_t_12_directory_config_is_refused_without_replacement() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.config()).unwrap();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    assert!(bind_origin(&owner).await.is_err());
    assert!(fixture.config().is_dir());
}

#[test]
fn ticket_t_12_initial_publish_preserves_a_config_that_appeared_after_read() {
    for linked in [false, true] {
        let fixture = Fixture::new();
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        if linked {
            symlink("missing.toml", fixture.config()).unwrap();
        } else {
            std::fs::write(fixture.config(), "port = 12345\n").unwrap();
        }
        assert!(persist_initial_origin(&owner, 54321).is_err());
        if linked {
            assert_eq!(
                std::fs::read_link(fixture.config()).unwrap(),
                PathBuf::from("missing.toml")
            );
        } else {
            assert_eq!(std::fs::read(fixture.config()).unwrap(), b"port = 12345\n");
        }
        assert!(std::fs::read_dir(&fixture.0).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".new")
        }));
    }
}

#[test]
fn ticket_t_12_fifo_config_does_not_block_startup() {
    if let Some(path) = std::env::var_os("PP_T12_FIFO_CHILD") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let owner = StorageLease::acquire(Path::new(&path)).unwrap();
        assert!(runtime.block_on(bind_origin(&owner)).is_err());
        return;
    }
    let fixture = Fixture::new();
    let path = std::ffi::CString::new(fixture.config().as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    run_child(
        "origin_tests::ticket_t_12_fifo_config_does_not_block_startup",
        "PP_T12_FIFO_CHILD",
        fixture.0.as_os_str(),
    );
}

fn run_child(test: &str, environment: &str, value: &std::ffi::OsStr) {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(environment, value)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{test} child failed");
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("{test} child exceeded its startup deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn occupied_origin_recovers_with_disclosure_and_preserves_portable_data() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let old_port = occupied.local_addr().unwrap().port();
    let old_bytes = format!("port = {old_port}\n");
    std::fs::write(fixture.config(), &old_bytes).unwrap();
    let alias = fixture.path("hard-link.toml");
    std::fs::hard_link(fixture.config(), &alias).unwrap();
    std::fs::write(fixture.path("print-partner.db"), b"opaque database").unwrap();
    std::fs::write(fixture.path("browser-preferences.json"), b"opaque sidecar").unwrap();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let (listener, change) = bind_origin(&owner).await.unwrap();
    let address = listener.local_addr().unwrap();
    assert_ne!(address.port(), old_port);
    assert_eq!(address.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert_eq!(
        change,
        Some(OriginChange::PersistedPortInUse {
            previous_port: std::num::NonZeroU16::new(old_port).unwrap(),
            new_port: std::num::NonZeroU16::new(address.port()).unwrap(),
        })
    );
    assert_eq!(
        change.unwrap().to_string(),
        format!(
            "The saved desktop port {old_port} was in use. This launch uses port {}.",
            address.port()
        )
    );
    assert_eq!(
        std::fs::read(fixture.config()).unwrap(),
        format!("port = {}\n", address.port()).as_bytes()
    );
    assert_eq!(std::fs::read(alias).unwrap(), old_bytes.as_bytes());
    assert_eq!(
        std::fs::metadata(fixture.config())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(TcpListener::bind(address).await.is_err());
    drop(listener);
    drop(owner);
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let (listener, change) = bind_origin(&owner).await.unwrap();
    assert_eq!(listener.local_addr().unwrap(), address);
    assert_eq!(change, None);
    assert_eq!(
        std::fs::read(fixture.path("print-partner.db")).unwrap(),
        b"opaque database"
    );
    assert_eq!(
        std::fs::read(fixture.path("browser-preferences.json")).unwrap(),
        b"opaque sidecar"
    );
    assert_no_temporary(&fixture);
}

fn assert_no_temporary(fixture: &Fixture) {
    assert!(std::fs::read_dir(&fixture.0).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".new")
    }));
}

#[test]
fn replacement_failure_boundaries_preserve_old_or_complete_new_bytes() {
    use crate::state_file::{self, Boundary};
    for failure in [
        Boundary::Write,
        Boundary::FileSync,
        Boundary::Rename,
        Boundary::DirectorySync,
    ] {
        let fixture = Fixture::new();
        std::fs::write(fixture.config(), b"port = 12345\n").unwrap();
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        let previous = state_file::read(&owner, "desktop.toml").unwrap().unwrap();
        let result = state_file::publish_with(
            &owner,
            "desktop.toml",
            b"port = 54321\n",
            Some(&previous),
            |boundary| {
                if boundary == failure {
                    anyhow::bail!("injected publication failure");
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(fixture.config()).unwrap(),
            if failure == Boundary::DirectorySync {
                b"port = 54321\n"
            } else {
                b"port = 12345\n"
            }
        );
        assert_no_temporary(&fixture);
    }
}

#[test]
fn replacement_recheck_refuses_changed_content_identity_and_links() {
    use crate::state_file::{self, Boundary};
    for race in ["content", "identity", "link", "missing"] {
        let fixture = Fixture::new();
        std::fs::write(fixture.config(), b"port = 12345\n").unwrap();
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        let previous = state_file::read(&owner, "desktop.toml").unwrap().unwrap();
        let result = state_file::publish_with(
            &owner,
            "desktop.toml",
            b"port = 54321\n",
            Some(&previous),
            |boundary| {
                if boundary == Boundary::Recheck {
                    if race == "content" {
                        std::fs::write(fixture.config(), b"port = 23456\n")?;
                    } else {
                        std::fs::rename(fixture.config(), fixture.path("old"))?;
                        match race {
                            "identity" => std::fs::write(fixture.config(), b"port = 12345\n")?,
                            "link" => symlink("old", fixture.config())?,
                            "missing" => {}
                            _ => unreachable!(),
                        }
                    }
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        if race == "content" {
            assert_eq!(std::fs::read(fixture.config()).unwrap(), b"port = 23456\n");
        } else {
            assert_eq!(
                std::fs::read(fixture.path("old")).unwrap(),
                b"port = 12345\n"
            );
        }
        if race == "link" {
            assert_eq!(
                std::fs::read_link(fixture.config()).unwrap(),
                PathBuf::from("old")
            );
        }
        assert_no_temporary(&fixture);
    }
}

#[tokio::test]
async fn ticket_t_12_origin_crash_relaunch_reuses_complete_published_config() {
    use crate::state_file::{self, Boundary};

    struct PublicationCase {
        boundary: Boundary,
        expected_new: bool,
    }
    let cases = [
        PublicationCase {
            boundary: Boundary::Write,
            expected_new: false,
        },
        PublicationCase {
            boundary: Boundary::FileSync,
            expected_new: false,
        },
        PublicationCase {
            boundary: Boundary::Rename,
            expected_new: false,
        },
        PublicationCase {
            boundary: Boundary::DirectorySync,
            expected_new: true,
        },
    ];
    if let Some(path) = std::env::var_os("PP_T12_ORIGIN_CRASH_STORE") {
        let path = Path::new(&path);
        let case: usize = std::env::var("PP_T12_ORIGIN_CRASH_CASE")
            .unwrap()
            .parse()
            .unwrap();
        let bytes = std::env::var("PP_T12_ORIGIN_CRASH_NEW").unwrap();
        let owner = StorageLease::acquire(path).unwrap();
        std::fs::write(
            path.join("crash-runtime"),
            owner.runtime_dir().as_os_str().as_encoded_bytes(),
        )
        .unwrap();
        let previous = state_file::read(&owner, "desktop.toml").unwrap().unwrap();
        state_file::publish_with(
            &owner,
            "desktop.toml",
            bytes.as_bytes(),
            Some(&previous),
            |boundary| {
                if boundary == cases[case].boundary {
                    kill_self();
                }
                Ok(())
            },
        )
        .unwrap();
        panic!("publication did not reach the crash checkpoint");
    }
    for (index, case) in cases.iter().enumerate() {
        let fixture = Fixture::new();
        let old = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let new = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old_bytes = format!("port = {}\n", old.local_addr().unwrap().port());
        let new_bytes = format!("port = {}\n", new.local_addr().unwrap().port());
        std::fs::write(fixture.config(), &old_bytes).unwrap();
        let portable = [
            ("print-partner.db", b"copied database".as_slice()),
            (
                "browser-preferences.json",
                b"copied portable preferences".as_slice(),
            ),
        ];
        for (name, bytes) in portable {
            std::fs::write(fixture.path(name), bytes).unwrap();
        }
        run_crash_child(
            "origin_tests::ticket_t_12_origin_crash_relaunch_reuses_complete_published_config",
            &fixture,
            index,
            &new_bytes,
        );
        let expected = if case.expected_new {
            new_bytes
        } else {
            old_bytes
        };
        let expected = expected.as_bytes();
        assert_eq!(std::fs::read(fixture.config()).unwrap(), expected);
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        let (reserved, _other) = if case.expected_new {
            (new, old)
        } else {
            (old, new)
        };
        let address = reserved.local_addr().unwrap();
        let mut reserved = Some(reserved);
        let (listener, change) = crate::origin::bind_origin_using(
            &owner,
            |_| Ok(()),
            |requested| {
                assert_eq!(std::net::SocketAddr::V4(requested), address);
                std::future::ready(Ok(reserved.take().unwrap()))
            },
        )
        .await
        .unwrap();
        assert_eq!(listener.local_addr().unwrap(), address);
        assert_eq!(change, None);
        assert!(TcpListener::bind(address).await.is_err());
        assert_eq!(std::fs::read(fixture.config()).unwrap(), expected);
        for (name, bytes) in portable {
            assert_eq!(std::fs::read(fixture.path(name)).unwrap(), bytes);
        }
    }
}

/// SIGKILLs this process without running any more of its code. `kill` may
/// return before delivery (seen on macOS), and unwinding would drop the lease
/// and clean up state a real crash leaves behind.
fn kill_self() -> ! {
    assert_eq!(unsafe { libc::kill(libc::getpid(), libc::SIGKILL) }, 0);
    loop {
        std::thread::park();
    }
}

/// Re-runs `test` in a child that SIGKILLs itself at publication checkpoint
/// `case`, then removes the runtime directory the killed lease left behind.
fn run_crash_child(test: &str, fixture: &Fixture, case: usize, new_bytes: &str) {
    use std::os::unix::process::ExitStatusExt;

    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("PP_T12_ORIGIN_CRASH_STORE", &fixture.0)
        .env("PP_T12_ORIGIN_CRASH_CASE", case.to_string())
        .env("PP_T12_ORIGIN_CRASH_NEW", new_bytes)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break (status, false);
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            break (child.wait().unwrap(), true);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A child that failed before taking the lease leaves no runtime record;
    // let the status assertions below report that failure instead.
    if let Ok(runtime) = std::fs::read(fixture.path("crash-runtime")) {
        std::fs::remove_dir(std::ffi::OsStr::from_bytes(&runtime)).unwrap();
    }
    assert!(!timed_out, "publication child exceeded its crash deadline");
    assert_eq!(status.signal(), Some(libc::SIGKILL));
}

#[tokio::test]
async fn ticket_t_12_first_origin_crash_relaunch_publishes_one_complete_config() {
    use crate::state_file::{self, Boundary};

    // First publication has no previous file, so it links instead of
    // renaming and never reaches Recheck or Rename.
    let cases = [
        (Boundary::HardLink, true),
        (Boundary::Write, false),
        (Boundary::FileSync, false),
        (Boundary::DirectorySync, true),
    ];
    if let Some(path) = std::env::var_os("PP_T12_ORIGIN_CRASH_STORE") {
        let path = Path::new(&path);
        let case: usize = std::env::var("PP_T12_ORIGIN_CRASH_CASE")
            .unwrap()
            .parse()
            .unwrap();
        let bytes = std::env::var("PP_T12_ORIGIN_CRASH_NEW").unwrap();
        let owner = StorageLease::acquire(path).unwrap();
        std::fs::write(
            path.join("crash-runtime"),
            owner.runtime_dir().as_os_str().as_encoded_bytes(),
        )
        .unwrap();
        assert!(state_file::read(&owner, "desktop.toml").unwrap().is_none());
        state_file::publish_with(&owner, "desktop.toml", bytes.as_bytes(), None, |boundary| {
            if boundary == cases[case].0 {
                kill_self();
            }
            Ok(())
        })
        .unwrap();
        panic!("publication did not reach the crash checkpoint");
    }
    for (index, &(checkpoint, published)) in cases.iter().enumerate() {
        let fixture = Fixture::new();
        let crashed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let crashed_address = crashed.local_addr().unwrap();
        let crashed_bytes = format!("port = {}\n", crashed_address.port());
        let portable = [
            ("print-partner.db", b"copied database".as_slice()),
            (
                "browser-preferences.json",
                b"copied portable preferences".as_slice(),
            ),
        ];
        for (name, bytes) in portable {
            std::fs::write(fixture.path(name), bytes).unwrap();
        }
        run_crash_child(
            "origin_tests::ticket_t_12_first_origin_crash_relaunch_publishes_one_complete_config",
            &fixture,
            index,
            &crashed_bytes,
        );
        if checkpoint == Boundary::HardLink {
            use std::os::unix::fs::MetadataExt;
            let temporary = std::fs::read_dir(&fixture.0)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.extension().is_some_and(|extension| extension == "new"))
                .unwrap();
            let config = std::fs::metadata(fixture.config()).unwrap();
            let temporary_metadata = std::fs::symlink_metadata(&temporary).unwrap();
            assert!(temporary_metadata.is_file());
            assert_eq!(temporary_metadata.dev(), config.dev());
            assert_eq!(temporary_metadata.ino(), config.ino());
            assert_eq!(std::fs::read(temporary).unwrap(), crashed_bytes.as_bytes());
        }
        if published {
            assert_eq!(
                std::fs::read(fixture.config()).unwrap(),
                crashed_bytes.as_bytes()
            );
        } else {
            assert!(
                !fixture.config().exists(),
                "unlinked publication became visible"
            );
        }
        // Hold the crashed port when nothing was published so relaunch must
        // choose and publish a fresh one.
        let _held = (!published).then_some(crashed);
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        let (listener, change) = bind_origin(&owner).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert_eq!(change, None);
        assert_eq!(address == crashed_address, published);
        assert_no_temporary(&fixture);
        let expected = format!("port = {}\n", address.port());
        assert_eq!(
            std::fs::read(fixture.config()).unwrap(),
            expected.as_bytes()
        );
        drop(listener);
        let (listener, change) = bind_origin(&owner).await.unwrap();
        assert_eq!(listener.local_addr().unwrap(), address);
        assert_eq!(change, None);
        assert_eq!(
            std::fs::read(fixture.config()).unwrap(),
            expected.as_bytes()
        );
        for (name, bytes) in portable {
            assert_eq!(std::fs::read(fixture.path(name)).unwrap(), bytes);
        }
    }
}

#[tokio::test]
async fn failed_recovery_closes_selected_listener_before_returning() {
    use crate::state_file::Boundary;
    let fixture = Fixture::new();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(
        fixture.config(),
        format!("port = {}\n", occupied.local_addr().unwrap().port()),
    )
    .unwrap();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let mut selected = None;
    let result = crate::origin::bind_origin_with(&owner, |boundary| {
        if boundary == Boundary::DirectorySync {
            let bytes = std::fs::read_to_string(fixture.config())?;
            let port: u16 = bytes.trim().strip_prefix("port = ").unwrap().parse()?;
            let address = std::net::SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
            assert!(std::net::TcpListener::bind(address).is_err());
            selected = Some(address);
            anyhow::bail!("injected directory sync failure");
        }
        Ok(())
    })
    .await;
    assert!(result.is_err());
    let listener = TcpListener::bind(selected.unwrap()).await.unwrap();
    assert_eq!(
        listener.local_addr().unwrap().port(),
        selected.unwrap().port()
    );
    assert_no_temporary(&fixture);
}

#[tokio::test]
async fn other_bind_errors_never_retry_or_replace_valid_config() {
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::AddrNotAvailable,
    ] {
        let fixture = Fixture::new();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let bytes = format!("port = {port}\n");
        std::fs::write(fixture.config(), &bytes).unwrap();
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        let mut calls = 0;
        let result = crate::origin::bind_origin_using(
            &owner,
            |_| Ok(()),
            |address| {
                calls += 1;
                assert_eq!(address.port(), port);
                std::future::ready(Err(std::io::Error::from(kind)))
            },
        )
        .await;
        assert_eq!(calls, 1);
        assert_eq!(
            result
                .unwrap_err()
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .kind(),
            kind
        );
        assert_eq!(std::fs::read(fixture.config()).unwrap(), bytes.as_bytes());
        assert_no_temporary(&fixture);
    }
}

#[tokio::test]
async fn ticket_t_12_origin_cleanup_removes_only_owned_regular_temporary_files() {
    for config in ["missing", "valid", "corrupt"] {
        let fixture = Fixture::new();
        let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = reserved.local_addr().unwrap();
        let bytes = if config == "corrupt" {
            b"invalid config\n".to_vec()
        } else {
            format!("  port = {}\n\n", address.port()).into_bytes()
        };
        if config != "missing" {
            std::fs::write(fixture.config(), &bytes).unwrap();
        }
        let stale = fixture.path("desktop.toml-0123456789abcdef.new");
        std::fs::write(&stale, b"stale publication").unwrap();
        let preserved = [
            "desktop.toml-0123456789abcde.new",
            "desktop.toml-0123456789abcdef0.new",
            "desktop.toml-1123456789abcdeF.new",
            "desktop.toml-0123456789abcdeg.new",
            "desktop.toml-0123456789abcdef.new.bak",
            "other.toml-0123456789abcdef.new",
            "print-partner.db",
            "browser-preferences.json",
        ];
        for name in preserved {
            std::fs::write(fixture.path(name), b"preserved bytes").unwrap();
        }
        let directory = fixture.path("desktop.toml-1111111111111111.new");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("child"), b"directory contents").unwrap();
        let linked = fixture.path("desktop.toml-2222222222222222.new");
        symlink("print-partner.db", &linked).unwrap();
        let dangling = fixture.path("desktop.toml-3333333333333333.new");
        symlink("absent", &dangling).unwrap();
        let fifo = fixture.path("desktop.toml-4444444444444444.new");
        let fifo_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        let owner = StorageLease::acquire(&fixture.0).unwrap();
        drop(reserved);
        let result = bind_origin(&owner).await;
        if config == "corrupt" {
            assert!(result.is_err());
        } else {
            let (listener, change) = result.unwrap();
            assert_eq!(change, None);
            if config == "valid" {
                assert_eq!(listener.local_addr().unwrap(), address);
            } else {
                assert_eq!(
                    std::fs::read(fixture.config()).unwrap(),
                    format!("port = {}\n", listener.local_addr().unwrap().port()).as_bytes()
                );
            }
        }
        assert!(!stale.exists());
        if config != "missing" {
            assert_eq!(std::fs::read(fixture.config()).unwrap(), bytes);
        }
        for name in preserved {
            assert_eq!(
                std::fs::read(fixture.path(name)).unwrap(),
                b"preserved bytes"
            );
        }
        assert_eq!(
            std::fs::read(directory.join("child")).unwrap(),
            b"directory contents"
        );
        assert_eq!(
            std::fs::read_link(linked).unwrap(),
            Path::new("print-partner.db")
        );
        assert_eq!(std::fs::read_link(dangling).unwrap(), Path::new("absent"));
        use std::os::unix::fs::FileTypeExt;
        assert!(
            std::fs::symlink_metadata(fifo)
                .unwrap()
                .file_type()
                .is_fifo()
        );
    }
}
