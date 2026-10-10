mod guard;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
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

/// Record the supervised child in the owner marker before setup opens storage.
pub fn record_child(directory: &Path, pid: u32) -> Result<()> {
    guard::record_child(directory, pid)
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
        std::fs::create_dir_all(path)?;
        let data_dir = path.canonicalize()?;
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
            let pid = marker["pid"]
                .as_u64()
                .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
                .context("Invalid prior writer PID")? as u32;
            // The OS lock serializes inspection and replacement with every cooperating writer.
            // A free lock alone is insufficient for older standalone writers using only markers.
            ensure!(
                prior_writer_is_stale(&marker, pid),
                "A prior writer may still be alive"
            );
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
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&marker_path)?;
            file.write_all(marker.to_string().as_bytes())?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_dir(&runtime_dir);
            return Err(error);
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
        let directory = directory.canonicalize()?;
        let mut retained = failed_releases()
            .lock()
            .expect("failed release registry poisoned");
        let entry = retained
            .get(&directory)
            .context("No retained failed release for this directory")?;
        ensure!(
            entry.retry_allowed,
            "Closure was not proved; ownership retained until process exit"
        );
        let mut lease = retained
            .remove(&directory)
            .expect("retained lease exists")
            .lease;
        drop(retained);
        Ok(lease.finish_release())
    }
    fn finish_release(&mut self) -> LeaseRelease {
        let runtime_removed =
            !self.runtime_dir.exists() || std::fs::remove_dir(&self.runtime_dir).is_ok();
        let marker = self.data_dir.join(".desktop-owner.json");
        let guard_released = runtime_removed
            && self
                .lease_guard
                .as_mut()
                .is_none_or(|guard| guard.release().is_ok());
        let marker_removed = guard_released && std::fs::remove_file(&marker).is_ok();
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
