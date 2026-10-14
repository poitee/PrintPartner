use super::*;
use std::{os::unix::fs::symlink, path::Path};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("pp-t12-{}", hex::encode(rand::random::<[u8; 8]>())));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn config(&self) -> PathBuf {
        self.0.join("desktop.toml")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn ticket_t_12_linked_config_is_refused_without_replacement() {
    for present in [false, true] {
        let fixture = Fixture::new();
        let target = fixture.0.join("external.toml");
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
        assert!(!fixture.0.join(".desktop-owner.json").exists());
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
    let fixture = Fixture::new();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let listener = bind_origin(&owner).await.unwrap();
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
    let listener = bind_origin(&owner).await.unwrap();
    assert_eq!(listener.local_addr().unwrap(), address);
    assert_eq!(std::fs::read(fixture.config()).unwrap(), bytes);
}

#[tokio::test]
async fn ticket_t_12_corrupt_config_and_port_conflicts_preserve_data() {
    let fixture = Fixture::new();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let conflict = format!("port = {}\n", occupied.local_addr().unwrap().port());
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    for bytes in [
        b"".as_slice(),
        b"port = 0\n",
        b"port = 65536\n",
        b"port = 1\nport = 2\n",
        b"port = \xff\n",
        conflict.as_bytes(),
    ] {
        std::fs::write(fixture.config(), bytes).unwrap();
        assert!(bind_origin(&owner).await.is_err());
        assert_eq!(std::fs::read(fixture.config()).unwrap(), bytes);
    }
    drop(owner);
    assert!(!fixture.0.join(".desktop-owner.json").exists());
}

#[tokio::test]
async fn ticket_t_12_unreadable_config_is_refused_without_replacement() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    std::fs::write(fixture.config(), "port = 12345\n").unwrap();
    std::fs::set_permissions(fixture.config(), std::fs::Permissions::from_mode(0o000)).unwrap();
    let owner = StorageLease::acquire(&fixture.0).unwrap();
    let result = bind_origin(&owner).await;
    std::fs::set_permissions(fixture.config(), std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(result.is_err(), "unreadable config accepted");
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
                .ends_with(".toml.new")
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
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "origin_tests::ticket_t_12_fifo_config_does_not_block_startup",
            "--nocapture",
        ])
        .env("PP_T12_FIFO_CHILD", &fixture.0)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "FIFO child failed");
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("FIFO config blocked startup");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
