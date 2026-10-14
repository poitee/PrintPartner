use pp_storage::{Limits, WriterOwner, lease::StorageLease};
use std::os::unix::fs::DirBuilderExt;
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
};

#[path = "common/process.rs"]
mod child_process;

struct Copy(PathBuf);

impl Copy {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "pp-t12-directory-{}",
            hex::encode(rand::random::<[u8; 16]>())
        )))
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        if self.0.exists() {
            mode(&self.0, 0o700);
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}

fn mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn ticket_t_12_foreign_owned_directory_is_refused() {
    let root = Path::new("/");
    if std::fs::metadata(root).unwrap().uid() == unsafe { libc::geteuid() } {
        return;
    }
    let error = pp_storage::lease::prepare_directory(root).unwrap_err();
    assert_eq!(error.to_string(), "Unsafe data directory permissions");
}

#[test]
fn ticket_t_12_new_store_is_private() {
    let status = child_process::command(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ticket_t_12_private_store_subprocess",
            "--nocapture",
        ])
        .env("PP_T12_PRIVATE_STORE_PROBE", "1")
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn ticket_t_12_private_store_subprocess() {
    if std::env::var_os("PP_T12_PRIVATE_STORE_PROBE").is_none() {
        return;
    }
    unsafe { libc::umask(0) };
    let copy = Copy::new();
    let nested = copy.0.join("portable/data");
    let owner = StorageLease::acquire(&nested).unwrap();
    for path in [&copy.0, &copy.0.join("portable"), &nested] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert!(owner.release().lock_released);
}

#[test]
fn ticket_t_12_permission_repair_reopens_the_copied_database() {
    let source = Copy::new();
    let (owner, _) = WriterOwner::open(&source.0, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    let copy = Copy::new();
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&copy.0)
        .unwrap();
    let database = copy.0.join("print-partner.db");
    std::fs::copy(source.0.join("print-partner.db"), &database).unwrap();
    let before = std::fs::read(&database).unwrap();
    mode(&copy.0, 0o775);
    let error = WriterOwner::open(&copy.0, Limits::default()).err().unwrap();
    assert_eq!(error.to_string(), "Unsafe data directory permissions");
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert!(!copy.0.join(".desktop.lock").exists());
    mode(&copy.0, 0o700);
    let (owner, _) = WriterOwner::open(&copy.0, Limits::default()).unwrap();
    owner.shutdown().unwrap();
}

#[test]
fn ticket_t_12_unsafe_permissions_refuse_before_lock_or_database_changes() {
    for permissions in [0o777, 0o775, 0o707, 0o555, 0o600, 0o300] {
        let copy = Copy::new();
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&copy.0)
            .unwrap();
        let database = copy.0.join("print-partner.db");
        let config = copy.0.join("desktop.toml");
        std::fs::write(&database, b"copied database, never open this").unwrap();
        std::fs::write(&config, b"port = 43123\n").unwrap();
        mode(&copy.0, permissions);

        let error = StorageLease::acquire(&copy.0)
            .err()
            .expect("unsafe store refused");
        assert!(
            error
                .to_string()
                .contains("Unsafe data directory permissions"),
            "{error:#}"
        );
        let error = WriterOwner::open(&copy.0, Limits::default())
            .err()
            .expect("writer refused before preflight");
        assert!(
            error
                .to_string()
                .contains("Unsafe data directory permissions"),
            "{error:#}"
        );

        mode(&copy.0, 0o700);
        assert_eq!(
            std::fs::read(&database).unwrap(),
            b"copied database, never open this"
        );
        assert_eq!(std::fs::read(&config).unwrap(), b"port = 43123\n");
        let mut entries = std::fs::read_dir(&copy.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(entries, ["desktop.toml", "print-partner.db"]);
        let owner = StorageLease::acquire(&copy.0).expect("same copy admitted after repair");
        assert!(owner.release().lock_released);
    }
}

#[test]
fn ticket_t_12_legacy_permissions_and_data_alias_are_preserved() {
    let copy = Copy::new();
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&copy.0)
        .unwrap();
    let data = copy.0.join("data");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&data)
        .unwrap();
    let alias = copy.0.join("alias");
    symlink(&data, &alias).unwrap();
    for permissions in [0o700, 0o750, 0o755] {
        mode(&data, permissions);
        let owner = StorageLease::acquire(&alias).unwrap();
        assert_eq!(owner.data_dir(), data.canonicalize().unwrap());
        assert_eq!(
            std::fs::metadata(&data).unwrap().permissions().mode() & 0o777,
            permissions
        );
        assert!(StorageLease::acquire(&data).is_err());
        assert!(owner.release().lock_released);
    }
}
