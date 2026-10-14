mod guard;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
pub(crate) use guard::ensure_stale_owner;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

pub struct LeaseRelease {
    pub marker_removed: bool,
    pub runtime_removed: bool,
    pub lock_released: bool,
    pub ownership_retained: bool,
}

pub struct StorageLease {
    lock: Option<File>,
    lease_guard: Option<guard::StorageLease>,
    data_dir: PathBuf,
    runtime_dir: PathBuf,
    lease: String,
    release_allowed: bool,
}

/// Create private Unix store directories and admit existing owner-controlled stores.
/// Existing modes and data-directory aliases are preserved. This does not validate
/// ancestor permissions or ACLs, or protect against hostile path replacement.
pub fn prepare_directory(path: &Path) -> Result<PathBuf> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let metadata = std::fs::metadata(path)?;
    ensure!(metadata.is_dir(), "Data directory is not a directory");
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o300 == 0o300
            && metadata.mode() & 0o022 == 0,
        "Unsafe data directory permissions"
    );
    Ok(path.canonicalize()?)
}

#[cfg(test)]
thread_local! {
    static FAIL_MARKER_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn write_marker(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_MARKER_WRITE.with(std::cell::Cell::take) {
        file.write_all(&bytes[..bytes.len() / 2])?;
        return Err(std::io::Error::from_raw_os_error(libc::ENOSPC));
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// Record the supervised child in the owner marker before setup opens storage.
pub fn record_child(directory: &Path, pid: u32) -> Result<()> {
    guard::record_child(directory, pid)
}

#[cfg(test)]
pub(crate) fn current_process_identity() -> String {
    guard::process_identity(std::process::id()).expect("own process identity")
}

/// A prior marker is retirable only when its owner and any recorded child are dead.
fn prior_writer_is_stale(marker: &serde_json::Value, pid: u32) -> bool {
    guard::owner_is_stale(pid, marker["process_identity"].as_str())
        && (marker["kind"] == "standalone"
            // Version 1 guarantees recording the child before setup opens storage.
            || (marker["storage_protocol_version"].as_u64() == Some(1)
                && marker.get("child_pid").is_none()
                && marker.get("child_process_identity").is_none())
            || guard::child_is_stale(marker))
}

/// Inspect marker liveness without changing storage before schema validation.
/// Acquisition checks the marker again while holding both ownership guards.
pub(crate) fn prior_owner_blocks_unowned(marker_path: &Path) -> bool {
    let bytes = match std::fs::read(marker_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    let Ok(marker) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return true;
    };
    let Some(pid) = marker["pid"]
        .as_u64()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
    else {
        return true;
    };
    !prior_writer_is_stale(&marker, pid as u32)
}

impl StorageLease {
    pub fn acquire(path: &Path) -> Result<Self> {
        let data_dir = prepare_directory(path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(data_dir.join(".desktop.lock"))?;
        lock.try_lock_exclusive()
            .context("Data directory already owned")?;
        let lease_guard = guard::StorageLease::acquire(&data_dir)?;
        let marker_path = data_dir.join(".desktop-owner.json");
        if marker_path.exists() {
            let marker: serde_json::Value = serde_json::from_slice(&std::fs::read(&marker_path)?)?;
            // The OS lock serializes inspection and replacement with every cooperating writer.
            // A free lock alone is insufficient for older standalone writers using only markers.
            ensure_stale_owner(&marker)?;
            std::fs::rename(
                &marker_path,
                data_dir.join(".desktop-lease/previous-marker.json"),
            )?;
        }
        let lease = hex::encode(rand::random::<[u8; 32]>());
        let runtime_dir = std::env::temp_dir().join(format!(
            "pp-{}-{}",
            std::process::id(),
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir(&runtime_dir)?;
        std::fs::set_permissions(&runtime_dir, std::fs::Permissions::from_mode(0o700))?;
        let marker = serde_json::json!({"storage_protocol_version":1,"pid":std::process::id(),"process_identity":lease_guard.identity,"lease_hash":hex::encode(Sha256::digest(lease.as_bytes())),"runtime_dir":runtime_dir});
        let result = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&marker_path)
            .and_then(|mut file| {
                write_marker(&mut file, marker.to_string().as_bytes()).inspect_err(|_| {
                    // A torn marker cannot be parsed, so it would refuse every later
                    // admission. We created it and still hold the lock, so remove it.
                    let _ = std::fs::remove_file(&marker_path);
                })
            });
        if let Err(error) = result {
            let _ = std::fs::remove_dir(&runtime_dir);
            return Err(error.into());
        }
        Ok(Self {
            lock: Some(lock),
            lease_guard: Some(lease_guard),
            data_dir,
            runtime_dir,
            lease,
            release_allowed: true,
        })
    }
    pub fn record_child(directory: &Path, pid: u32) -> Result<()> {
        guard::record_child(directory, pid)
    }
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
    pub fn secret(&self) -> &str {
        &self.lease
    }
    pub fn clone_file(&self) -> Result<File> {
        Ok(self.lock.as_ref().expect("active lease").try_clone()?)
    }
    pub fn retain_on_drop(&mut self) {
        self.release_allowed = false;
    }
    pub fn allow_drop_cleanup(&mut self) {
        self.release_allowed = true;
    }
    pub fn release(mut self) -> LeaseRelease {
        self.release_allowed = false;
        self.finish_release()
    }
    pub fn retain_until_process_exit(mut self) {
        self.release_allowed = false;
        let directory = self.data_dir.clone();
        failed_releases()
            .lock()
            .expect("failed release registry poisoned")
            .insert(
                directory,
                RetainedLease {
                    lease: self,
                    retry_allowed: false,
                },
            );
    }
    pub fn retry_failed_release(directory: &Path) -> Result<LeaseRelease> {
        Self::retry_failed_release_if_present(directory)?
            .context("No retained failed release for this directory")
    }
    /// Retry a failed release before restarting, only if closure was proved.
    /// Missing registry entries leave active leases and other processes untouched.
    pub fn retry_failed_release_if_present(directory: &Path) -> Result<Option<LeaseRelease>> {
        let directory = directory.canonicalize()?;
        let mut retained = failed_releases()
            .lock()
            .expect("failed release registry poisoned");
        let Some(entry) = retained.get(&directory) else {
            return Ok(None);
        };
        ensure!(
            entry.retry_allowed,
            "Closure was not proved; ownership retained until process exit"
        );
        let mut lease = retained
            .remove(&directory)
            .expect("retained lease exists")
            .lease;
        drop(retained);
        Ok(Some(lease.finish_release()))
    }
    fn finish_release(&mut self) -> LeaseRelease {
        let runtime_removed =
            !self.runtime_dir.exists() || std::fs::remove_dir(&self.runtime_dir).is_ok();
        let marker = self.data_dir.join(".desktop-owner.json");
        let marker_removed = runtime_removed
            && match std::fs::remove_file(&marker) {
                Ok(()) => true,
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            };
        // Keep the shared lease until marker cleanup is proved. Standalone Node
        // writers use this lease without checking the Rust OS lock.
        let guard_released = marker_removed
            && self
                .lease_guard
                .as_mut()
                .is_none_or(|guard| guard.release().is_ok());
        if !runtime_removed || !marker_removed || !guard_released {
            let retained = Self {
                lock: self.lock.take(),
                lease_guard: self.lease_guard.take(),
                data_dir: self.data_dir.clone(),
                runtime_dir: self.runtime_dir.clone(),
                lease: self.lease.clone(),
                release_allowed: false,
            };
            failed_releases()
                .lock()
                .expect("failed release registry poisoned")
                .insert(
                    self.data_dir.clone(),
                    RetainedLease {
                        lease: retained,
                        retry_allowed: true,
                    },
                );
            return LeaseRelease {
                marker_removed,
                runtime_removed,
                lock_released: false,
                ownership_retained: true,
            };
        }
        drop(self.lock.take());
        LeaseRelease {
            marker_removed,
            runtime_removed,
            lock_released: true,
            ownership_retained: false,
        }
    }
}

struct RetainedLease {
    lease: StorageLease,
    retry_allowed: bool,
}

fn failed_releases() -> &'static Mutex<BTreeMap<PathBuf, RetainedLease>> {
    static LEASES: OnceLock<Mutex<BTreeMap<PathBuf, RetainedLease>>> = OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

impl Drop for StorageLease {
    fn drop(&mut self) {
        if self.release_allowed {
            self.release_allowed = false;
            self.finish_release();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pp-release-order-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)
            .unwrap();
        path
    }

    fn assert_released(released: LeaseRelease, path: &Path) {
        assert!(released.marker_removed && released.runtime_removed && released.lock_released);
        assert!(!released.ownership_retained);
        assert!(!path.join(".desktop-owner.json").exists());
        assert!(!path.join(".desktop-lease").exists());
        let lock = File::open(path.join(".desktop.lock")).unwrap();
        lock.try_lock_exclusive().unwrap();
        FileExt::unlock(&lock).unwrap();
        drop(guard::StorageLease::acquire(path).unwrap());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn missing_marker_release_and_retry_complete() {
        for retry in [false, true] {
            let path = directory();
            let owner = StorageLease::acquire(&path).unwrap();
            std::fs::remove_file(path.join(".desktop-owner.json")).unwrap();
            let released = if retry {
                let blocker = owner.runtime_dir().join("block-release");
                std::fs::write(&blocker, b"retain").unwrap();
                let failed = owner.release();
                assert!(failed.ownership_retained && !failed.lock_released);
                assert!(guard::StorageLease::acquire(&path).is_err());
                std::fs::remove_file(blocker).unwrap();
                StorageLease::retry_failed_release(&path).unwrap()
            } else {
                owner.release()
            };
            assert_released(released, &path);
        }
    }

    #[test]
    fn marker_cleanup_failure_retains_atomic_lease() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        let marker = path.join(".desktop-owner.json");
        std::fs::remove_file(&marker).unwrap();
        std::fs::create_dir(&marker).unwrap();
        let released = owner.release();
        assert!(released.runtime_removed && !released.marker_removed);
        assert!(released.ownership_retained && !released.lock_released);
        assert!(path.join(".desktop-lease/owner.json").is_file());
        assert!(guard::StorageLease::acquire(&path).is_err());
        let again = StorageLease::retry_failed_release(&path).unwrap();
        assert!(again.ownership_retained && !again.marker_removed && !again.lock_released);
        assert!(guard::StorageLease::acquire(&path).is_err());
        std::fs::remove_dir(&marker).unwrap();
        assert_released(StorageLease::retry_failed_release(&path).unwrap(), &path);
    }

    #[test]
    fn ticket_t_7_writer_disk_full_marker_leaves_the_copy_admittable() {
        let path = directory();
        FAIL_MARKER_WRITE.with(|fail| fail.set(true));
        let refused = StorageLease::acquire(&path)
            .err()
            .expect("ENOSPC refuses admission");
        assert_eq!(
            refused
                .downcast_ref::<std::io::Error>()
                .and_then(std::io::Error::raw_os_error),
            Some(libc::ENOSPC),
            "{refused:#}"
        );
        assert!(
            !path.join(".desktop-owner.json").exists(),
            "torn marker left behind"
        );
        assert!(!path.join(".desktop-lease").exists());
        let lock = File::open(path.join(".desktop.lock")).unwrap();
        lock.try_lock_exclusive().unwrap();
        FileExt::unlock(&lock).unwrap();

        let owner = StorageLease::acquire(&path).unwrap();
        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(".desktop-owner.json")).unwrap())
                .unwrap();
        assert_eq!(marker["pid"], std::process::id());
        assert_released(owner.release(), &path);
    }

    #[test]
    fn stale_takeover_preserves_retired_previous_marker() {
        let path = directory();
        let mut prior_process = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = prior_process.id();
        prior_process.wait().unwrap();
        let instance = "ab".repeat(16);
        let prior = serde_json::json!({
            "pid": pid, "process_identity": "prior", "instance": instance,
            "storage_protocol_version": 1
        });
        let lease = path.join(".desktop-lease");
        std::fs::create_dir(&lease).unwrap();
        std::fs::write(lease.join("owner.json"), prior.to_string()).unwrap();
        std::fs::write(lease.join("previous-marker.json"), b"older crash").unwrap();
        std::fs::write(path.join(".desktop-owner.json"), prior.to_string()).unwrap();

        let owner = StorageLease::acquire(&path).unwrap();
        assert_eq!(
            std::fs::read(lease.join("previous-marker.json")).unwrap(),
            prior.to_string().as_bytes()
        );
        assert_eq!(
            std::fs::read(path.join(format!(
                ".desktop-lease-retired-{instance}/previous-marker.json"
            )))
            .unwrap(),
            b"older crash"
        );
        assert!(StorageLease::acquire(&path).is_err());
        assert_released(owner.release(), &path);
    }
}
