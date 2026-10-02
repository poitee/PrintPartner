use anyhow::{Context, Result, bail, ensure};
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
    data_dir: PathBuf,
    runtime_dir: PathBuf,
    lease: String,
    release_allowed: bool,
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
        let marker_path = data_dir.join(".desktop-owner.json");
        if marker_path.exists() {
            bail!("A prior writer marker remains; verify no prior writer is alive before recovery");
        }
        let lease = hex::encode(rand::random::<[u8; 32]>());
        let runtime_dir = std::env::temp_dir().join(format!(
            "pp-{}-{}",
            std::process::id(),
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir(&runtime_dir)?;
        std::fs::set_permissions(&runtime_dir, std::fs::Permissions::from_mode(0o700))?;
        let marker = serde_json::json!({"pid":std::process::id(),"lease_hash":hex::encode(Sha256::digest(lease.as_bytes())),"runtime_dir":runtime_dir});
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
        let marker_removed = runtime_removed && std::fs::remove_file(&marker).is_ok();
        if !runtime_removed || !marker_removed {
            let retained = Self {
                lock: self.lock.take(),
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
