mod directory;
mod guard;
use anyhow::{Context, Result, ensure};
use directory::Directory;
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::{File, OpenOptions},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

pub struct LeaseRelease {
    pub marker_removed: bool,
    pub runtime_removed: bool,
    pub lock_released: bool,
    pub ownership_retained: bool,
}

pub struct StorageLease {
    advisory_lock: Option<File>,
    lock: Option<File>,
    lease_guard: Option<guard::StorageLease>,
    admitted: Arc<AdmittedDirectory>,
    runtime_dir: PathBuf,
    lease: String,
    release_allowed: bool,
    child_marker: Arc<Mutex<Option<OwnedChildMarker>>>,
}

struct OwnedChildMarker {
    admitted: Arc<AdmittedDirectory>,
    lease_hash: String,
}

/// Create private Unix store directories and admit existing owner-controlled stores.
/// Existing modes and data-directory aliases are preserved. Existing lock entries
/// must be owner-controlled regular files with one link. Ancestors must be root or
/// effective-user owned and deny group/other write unless sticky. These are path
/// snapshots, not confinement. A held descriptor checks leaf identity through
/// canonicalization. Lease acquisition retains it through marker mutation and
/// ownership cleanup. SQLite initialization and ACL policy remain separate concerns.
pub fn prepare_directory(path: &Path) -> Result<PathBuf> {
    Ok(admit_directory(path)?.path)
}

pub(crate) struct AdmittedDirectory {
    path: PathBuf,
    directory: Directory,
}

pub(crate) struct LockedDirectory {
    admitted: AdmittedDirectory,
    lock: File,
}

impl LockedDirectory {
    pub(crate) fn preflight(&self) -> Result<()> {
        self.admitted.preflight()
    }
}

enum DirectoryCreation {
    Allowed,
    Forbidden,
}

pub(crate) fn admit_directory(path: &Path) -> Result<AdmittedDirectory> {
    admit_directory_with(path, DirectoryCreation::Allowed)
}

fn admit_directory_with(path: &Path, creation: DirectoryCreation) -> Result<AdmittedDirectory> {
    ensure!(!path.as_os_str().is_empty(), "Data directory path is empty");
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    validate_input_ancestors(&path)?;
    if matches!(creation, DirectoryCreation::Allowed) {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)?;
    }
    let opened = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::EACCES | libc::EPERM) => {
                anyhow::Error::new(error).context("Unsafe data directory permissions")
            }
            Some(libc::ENOTDIR) => {
                anyhow::Error::new(error).context("Data directory is not a directory")
            }
            _ => error.into(),
        })?;
    let metadata = opened.metadata()?;
    ensure!(metadata.is_dir(), "Data directory is not a directory");
    validate_directory_permissions(&metadata)?;
    #[cfg(test)]
    tests::replace_directory_before_canonicalization(&path)?;
    let directory = path.canonicalize()?;
    let admitted = AdmittedDirectory {
        path: directory,
        directory: Directory(opened),
    };
    admitted.validate_identity()?;
    let directory = &admitted.path;
    validate_resolved_ancestors(directory, false)?;
    for name in [".desktop.lock", "printpartner.lock"] {
        match std::fs::symlink_metadata(directory.join(name)) {
            Ok(metadata) => validate_lock_metadata(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    #[cfg(test)]
    tests::replace_directory_before_writer_preflight(directory)?;
    Ok(admitted)
}

fn validate_directory_permissions(metadata: &std::fs::Metadata) -> Result<()> {
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o700 == 0o700
            && metadata.mode() & 0o022 == 0,
        "Unsafe data directory permissions"
    );
    Ok(())
}

impl AdmittedDirectory {
    pub(crate) fn lock(self) -> Result<LockedDirectory> {
        self.validate_identity()?;
        validate_resolved_ancestors(&self.path, false)?;
        let path = self.path.join("printpartner.lock");
        let lock = self.open_lock(c"printpartner.lock")?;
        self.validate_identity()?;
        validate_open_lock_identity(&lock, &path)?;
        match fs4::FileExt::try_lock(&lock) {
            Ok(()) => {}
            Err(fs4::TryLockError::WouldBlock) => anyhow::bail!(
                "Data directory already owned; stop the other Print Partner process before starting another instance"
            ),
            Err(fs4::TryLockError::Error(error)) => {
                return Err(error).context("Could not lock printpartner.lock");
            }
        }
        self.validate_identity()?;
        validate_open_lock_identity(&lock, &path)?;
        Ok(LockedDirectory {
            admitted: self,
            lock,
        })
    }

    pub(crate) fn preflight(&self) -> Result<()> {
        self.preflight_schema(false).map(|_| ())
    }

    fn preflight_schema(&self, owned: bool) -> Result<u64> {
        self.validate_identity()?;
        crate::schema::preflight(
            #[cfg(test)]
            &self.path.join("print-partner.db"),
            owned,
            |name| self.open_preflight_file(name),
            || self.validate_identity(),
        )
    }

    fn validate_identity(&self) -> Result<()> {
        let opened = self.directory.metadata()?;
        let named = std::fs::symlink_metadata(&self.path).context("Data directory was replaced")?;
        ensure!(
            named.is_dir() && opened.dev() == named.dev() && opened.ino() == named.ino(),
            "Data directory was replaced"
        );
        validate_directory_permissions(&opened)?;
        validate_directory_permissions(&named)
    }

    fn open_preflight_file(&self, name: &str) -> std::io::Result<File> {
        #[cfg(test)]
        if name == ".desktop-owner.json" && REMOVE_MARKER_BEFORE_READ.take() {
            let result = unsafe {
                libc::unlinkat(
                    self.directory.as_raw_fd(),
                    c".desktop-owner.json".as_ptr(),
                    0,
                )
            };
            if result < 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        let name = CString::new(name)?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_NOCTTY,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::from_raw_os_error(if metadata.is_dir() {
                libc::EISDIR
            } else {
                libc::EINVAL
            }));
        }
        Ok(file)
    }

    fn open_lock(&self, name: &CStr) -> Result<File> {
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn validate_input_ancestors(path: &Path) -> Result<()> {
    for prefix in path.ancestors() {
        match std::fs::symlink_metadata(prefix) {
            Ok(_) => {
                // Resolve every existing prefix before mkdir, including aliases whose
                // target has unsafe parents hidden by the input spelling.
                validate_resolved_ancestors(&prefix.canonicalize()?, prefix != path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn validate_resolved_ancestors(path: &Path, include_self: bool) -> Result<()> {
    let euid = unsafe { libc::geteuid() };
    for ancestor in path.ancestors().skip(usize::from(!include_self)) {
        let metadata = std::fs::metadata(ancestor)?;
        ensure!(
            metadata.is_dir()
                && (metadata.uid() == 0 || metadata.uid() == euid)
                && (metadata.mode() & 0o022 == 0 || metadata.mode() & 0o1000 != 0),
            "Unsafe data directory ancestor"
        );
    }
    Ok(())
}

fn validate_lock_metadata(metadata: &std::fs::Metadata) -> Result<()> {
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o022 == 0,
        "Unsafe data directory lock"
    );
    Ok(())
}

fn validate_lock_identity(file: &File, path: &Path) -> Result<()> {
    #[cfg(test)]
    if REPLACE_LOCK_BEFORE_VALIDATION.with(|remaining| {
        let count = remaining.get();
        remaining.set(count.saturating_sub(1));
        count == 1
    }) {
        std::fs::rename(path, path.with_extension("retired"))?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
    }
    validate_open_lock_identity(file, path)
}

fn validate_open_lock_identity(file: &File, path: &Path) -> Result<()> {
    let opened = file.metadata()?;
    let named = std::fs::symlink_metadata(path)?;
    validate_lock_metadata(&opened)?;
    validate_lock_metadata(&named)?;
    ensure!(
        opened.dev() == named.dev() && opened.ino() == named.ino(),
        "Data directory lock was replaced"
    );
    Ok(())
}

#[cfg(test)]
thread_local! {
    static KEEP_MARKER_INSPECTION_SWAP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static MARKER_INSPECTION_SWAP: std::cell::Cell<Option<(u8, bool)>> = const { std::cell::Cell::new(None) };
    static FAIL_LOCK_UNLOCK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_MARKER_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static REMOVE_MARKER_BEFORE_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static REPLACE_LOCK_BEFORE_VALIDATION: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    static REPLACE_DIRECTORY_BEFORE_WRITER_PREFLIGHT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    static REPLACE_DIRECTORY_DURING_LOCK: std::cell::Cell<(u8, u8)> = const { std::cell::Cell::new((0, 0)) };
    static REPLACE_DIRECTORY_BEFORE_CANONICALIZATION: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

fn unlock_os_lock(file: &File) -> std::io::Result<()> {
    #[cfg(test)]
    if FAIL_LOCK_UNLOCK.with(std::cell::Cell::take) {
        return Err(std::io::Error::from_raw_os_error(libc::EIO));
    }
    FileExt::unlock(file)
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
    let admitted = admit_directory_with(directory, DirectoryCreation::Forbidden)?;
    guard::record_child(&admitted, pid, None)?;
    admitted.validate_identity()
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

fn read_prior_owner(
    open_file: impl Fn(&str) -> std::io::Result<File>,
) -> Result<Option<(serde_json::Value, u32)>> {
    let mut file = match open_file(".desktop-owner.json") {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("storage_lease_marker_invalid"),
    };
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes).context("storage_lease_marker_invalid")?;
    parse_prior_owner(&bytes).map(Some)
}

fn parse_prior_owner(bytes: &[u8]) -> Result<(serde_json::Value, u32)> {
    let marker: serde_json::Value =
        serde_json::from_slice(bytes).context("storage_lease_marker_invalid")?;
    let pid = marker["pid"]
        .as_u64()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
        .context("storage_lease_marker_invalid")? as u32;
    Ok((marker, pid))
}

/// Inspect marker liveness without changing storage before schema validation.
/// Acquisition checks the marker again while holding both ownership guards.
pub(crate) fn prior_owner_blocks_unowned(
    open_file: impl Fn(&str) -> std::io::Result<File>,
) -> Result<bool> {
    Ok(read_prior_owner(open_file)?
        .is_some_and(|(marker, pid)| !prior_writer_is_stale(&marker, pid)))
}

impl StorageLease {
    pub fn acquire(path: &Path) -> Result<Self> {
        Self::acquire_admitted(admit_directory(path)?)
    }

    pub(crate) fn acquire_admitted(admitted: AdmittedDirectory) -> Result<Self> {
        Self::acquire_locked(admitted.lock()?)
    }

    pub(crate) fn acquire_locked(locked: LockedDirectory) -> Result<Self> {
        let LockedDirectory {
            admitted,
            lock: advisory_lock,
        } = locked;
        let data_dir = &admitted.path;
        #[cfg(test)]
        tests::replace_directory_during_lock(data_dir, 1)?;
        admitted.validate_identity()?;
        validate_resolved_ancestors(data_dir, false)?;
        let lock_path = data_dir.join(".desktop.lock");
        #[cfg(test)]
        tests::replace_directory_during_lock(data_dir, 4)?;
        let lock = admitted.open_lock(c".desktop.lock")?;
        #[cfg(test)]
        tests::replace_directory_during_lock(data_dir, 2)?;
        admitted.validate_identity()?;
        validate_lock_identity(&lock, &lock_path)?;
        lock.try_lock_exclusive()
            .context("Data directory already owned")?;
        #[cfg(test)]
        tests::replace_directory_during_lock(data_dir, 3)?;
        admitted.validate_identity()?;
        validate_lock_identity(&lock, &lock_path)?;
        admitted.validate_identity()?;
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 1, false)?;
        let prior = read_prior_owner(|name| admitted.open_preflight_file(name));
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 1, true)?;
        prior?;
        admitted.validate_identity()?;
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 3, false)?;
        let lease_guard = guard::StorageLease::acquire(&admitted.directory);
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 3, true)?;
        let lease_guard = lease_guard?;
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 2, false)?;
        let prior = read_prior_owner(|name| admitted.open_preflight_file(name));
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 2, true)?;
        let prior = prior?;
        admitted.validate_identity()?;
        if let Some((marker, pid)) = prior {
            // The OS lock serializes inspection and replacement with every cooperating writer.
            // A free lock alone is insufficient for older standalone writers using only markers.
            ensure!(
                prior_writer_is_stale(&marker, pid),
                "A prior writer may still be alive"
            );
            #[cfg(test)]
            tests::marker_inspection_swap(data_dir, 4, false)?;
            let retired = admitted.directory.rename(
                ".desktop-owner.json",
                &lease_guard.lease_directory,
                "previous-marker.json",
            );
            #[cfg(test)]
            tests::marker_inspection_swap(data_dir, 4, true)?;
            retired?;
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
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 5, false)?;
        let result = admitted
            .directory
            .create_file(".desktop-owner.json")
            .and_then(|mut file| {
                write_marker(&mut file, marker.to_string().as_bytes()).inspect_err(|_| {
                    // A torn marker cannot be parsed, so it would refuse every later
                    // admission. We created it and still hold the lock, so remove it.
                    let _ = admitted.directory.remove_file(".desktop-owner.json");
                })
            });
        #[cfg(test)]
        tests::marker_inspection_swap(data_dir, 5, true)?;
        let result = result.map_err(anyhow::Error::from).and_then(|()| {
            admitted.validate_identity().inspect_err(|_| {
                let _ = admitted.directory.remove_file(".desktop-owner.json");
            })
        });
        if let Err(error) = result {
            let _ = std::fs::remove_dir(&runtime_dir);
            return Err(error);
        }
        let admitted = Arc::new(admitted);
        let child_marker = Arc::new(Mutex::new(Some(OwnedChildMarker {
            admitted: admitted.clone(),
            lease_hash: hex::encode(Sha256::digest(lease.as_bytes())),
        })));
        Ok(Self {
            advisory_lock: Some(advisory_lock),
            lock: Some(lock),
            lease_guard: Some(lease_guard),
            admitted,
            child_marker,
            runtime_dir,
            lease,
            release_allowed: true,
        })
    }
    pub(crate) fn preflight(&self) -> Result<u64> {
        self.admitted.preflight_schema(true)
    }
    /// Capture child recording for this lease. Release revokes all captured callbacks.
    pub fn child_recorder(&self) -> impl Fn(&Path, u32) -> Result<()> + Send + Sync + 'static {
        let child_marker = self.child_marker.clone();
        move |_, pid| {
            let owner = child_marker
                .lock()
                .map_err(|_| anyhow::anyhow!("Child marker state poisoned"))?;
            let owner = owner.as_ref().context("Desktop ownership was released")?;
            owner.admitted.validate_identity()?;
            guard::record_child(&owner.admitted, pid, Some(&owner.lease_hash))?;
            owner.admitted.validate_identity()
        }
    }
    pub fn data_dir(&self) -> &Path {
        &self.admitted.path
    }
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
    pub fn secret(&self) -> &str {
        &self.lease
    }
    pub fn clone_file(&self) -> Result<File> {
        Ok(self
            .advisory_lock
            .as_ref()
            .expect("active lease")
            .try_clone()?)
    }
    pub fn retain_on_drop(&mut self) {
        self.release_allowed = false;
    }
    pub fn allow_drop_cleanup(&mut self) {
        self.release_allowed = true;
    }
    /// A failed step reports `ownership_retained` and keeps this lease's lock and
    /// guard for `retry_failed_release`. That flag does not prove the OS lock was
    /// reacquired. Release renames whatever directory is bound at the shared
    /// `.desktop-lease` name. While no entry is bound there, as after external
    /// removal or relocation, release and every retry fail and retain ownership
    /// until this process exits. Renaming this lease's own directory back to that
    /// name lets a retry release normally.
    ///
    /// Unresolved defect (GRE-401), not part of this contract: if another
    /// directory, such as a successor lease, is bound at that name, a retry
    /// reports success. It moves that directory to this lease's private release
    /// name and removes `owner.json` from this lease's own directory, wherever
    /// that directory was relocated.
    pub fn release(mut self) -> LeaseRelease {
        self.release_allowed = false;
        #[cfg(test)]
        tests::marker_inspection_swap(&self.admitted.path, 6, false).unwrap();
        let released = self.finish_release();
        #[cfg(test)]
        tests::marker_inspection_swap(&self.admitted.path, 6, true).unwrap();
        released
    }
    pub fn retain_until_process_exit(mut self) {
        self.release_allowed = false;
        let directory = self.admitted.path.clone();
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
        self.child_marker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let runtime_removed =
            !self.runtime_dir.exists() || std::fs::remove_dir(&self.runtime_dir).is_ok();
        let marker_removed = runtime_removed
            && self
                .admitted
                .directory
                .remove_file(".desktop-owner.json")
                .is_ok();
        // The shared lease excludes Node writers until OS unlock succeeds.
        let os_unlocked = marker_removed
            && self
                .lock
                .as_ref()
                .is_none_or(|lock| unlock_os_lock(lock).is_ok());
        let guard_detached = os_unlocked
            && self
                .lease_guard
                .as_mut()
                .is_none_or(|guard| guard.detach().is_ok());
        let advisory_unlocked = guard_detached
            && self
                .advisory_lock
                .as_ref()
                .is_none_or(|lock| fs4::FileExt::unlock(lock).is_ok());
        if !advisory_unlocked {
            if os_unlocked && let Some(lock) = &self.lock {
                // Failed detachment leaves the shared admission guard in place.
                // Re-lock when possible, without blocking on another admission.
                let _ = FileExt::try_lock_exclusive(lock);
            }
            let retained = Self {
                advisory_lock: self.advisory_lock.take(),
                lock: self.lock.take(),
                lease_guard: self.lease_guard.take(),
                admitted: self.admitted.clone(),
                runtime_dir: self.runtime_dir.clone(),
                lease: self.lease.clone(),
                release_allowed: false,
                child_marker: self.child_marker.clone(),
            };
            failed_releases()
                .lock()
                .expect("failed release registry poisoned")
                .insert(
                    self.admitted.path.clone(),
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
        drop(self.lease_guard.take());
        drop(self.lock.take());
        drop(self.advisory_lock.take());
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

    pub(super) fn marker_inspection_swap(path: &Path, checkpoint: u8, restore: bool) -> Result<()> {
        if MARKER_INSPECTION_SWAP.get() != Some((checkpoint, restore)) {
            return Ok(());
        }
        let retired = path.with_extension("retired");
        let replacement = path.with_extension("replacement");
        if restore && KEEP_MARKER_INSPECTION_SWAP.take() {
            MARKER_INSPECTION_SWAP.set(None);
        } else if restore {
            std::fs::rename(path, &replacement)?;
            std::fs::rename(&retired, path)?;
            MARKER_INSPECTION_SWAP.set(None);
        } else {
            std::fs::rename(path, &retired)?;
            std::fs::rename(&replacement, path)?;
            MARKER_INSPECTION_SWAP.set(Some((checkpoint, true)));
        }
        Ok(())
    }

    #[test]
    fn ticket_t_12_child_recording_does_not_create_a_missing_store() {
        let root = directory();
        let missing = root.join("missing/nested");
        assert!(record_child(&missing, std::process::id()).is_err());
        assert!(!root.join("missing").exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ticket_t_12_child_recorder_uses_retained_owner_through_alias() {
        let path = directory();
        let alias = path.with_extension("alias");
        let owner = StorageLease::acquire(&path).unwrap();
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let before: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(".desktop-owner.json")).unwrap())
                .unwrap();
        owner.child_recorder()(&alias, std::process::id()).unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(".desktop-owner.json")).unwrap())
                .unwrap();
        assert_eq!(after["lease_hash"], before["lease_hash"]);
        assert_eq!(after["child_pid"], std::process::id());
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 4);
        assert!(owner.release().lock_released);
        std::fs::remove_file(alias).unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn ticket_t_12_child_recorder_is_revoked_before_reacquisition() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        let record = owner.child_recorder();
        record(&path, std::process::id()).unwrap();
        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(".desktop-owner.json")).unwrap())
                .unwrap();
        assert_eq!(marker["child_pid"], std::process::id());
        assert!(
            !marker["child_process_identity"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert!(owner.release().lock_released);
        let next = StorageLease::acquire(&path).unwrap();
        let before = std::fs::read(path.join(".desktop-owner.json")).unwrap();
        assert_eq!(
            record(&path, std::process::id()).unwrap_err().to_string(),
            "Desktop ownership was released"
        );
        assert_eq!(
            std::fs::read(path.join(".desktop-owner.json")).unwrap(),
            before
        );
        next.child_recorder()(&path, std::process::id()).unwrap();
        assert!(next.release().lock_released);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn ticket_t_12_child_recorder_refuses_another_lease_marker() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        let mut marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(".desktop-owner.json")).unwrap())
                .unwrap();
        marker["lease_hash"] = "another-lease".into();
        let before = serde_json::to_vec(&marker).unwrap();
        std::fs::write(path.join(".desktop-owner.json"), &before).unwrap();
        assert_eq!(
            owner.child_recorder()(&path, std::process::id())
                .unwrap_err()
                .to_string(),
            "Desktop owner marker belongs to another lease"
        );
        assert_eq!(
            std::fs::read(path.join(".desktop-owner.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 4);
        assert!(owner.release().lock_released);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn ticket_t_12_child_recorder_refuses_a_linked_marker() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        let marker = path.join(".desktop-owner.json");
        let before = std::fs::read(&marker).unwrap();
        std::fs::rename(&marker, path.join("private-marker")).unwrap();
        std::os::unix::fs::symlink("private-marker", &marker).unwrap();
        assert!(owner.child_recorder()(&path, std::process::id()).is_err());
        assert_eq!(
            std::fs::read_link(&marker).unwrap(),
            Path::new("private-marker")
        );
        assert_eq!(std::fs::read(path.join("private-marker")).unwrap(), before);
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 5);
        assert!(owner.release().lock_released);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn ticket_t_12_child_marker_contains_transient_directory_swaps() {
        assert_child_marker_contains_swaps(false);
    }

    #[test]
    fn ticket_t_12_child_marker_contains_persistent_directory_swaps() {
        assert_child_marker_contains_swaps(true);
    }

    fn assert_child_marker_contains_swaps(persistent: bool) {
        for checkpoint in 7..=11 {
            let path = directory();
            let replacement = path.with_extension("replacement");
            let retired = path.with_extension("retired");
            let owner = StorageLease::acquire(&path).unwrap();
            let record = owner.child_recorder();
            let original = std::fs::read(path.join(".desktop-owner.json")).unwrap();
            let mut other: serde_json::Value = serde_json::from_slice(&original).unwrap();
            other["lease_hash"] = "replacement-owner".into();
            let other = serde_json::to_vec(&other).unwrap();
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&replacement)
                .unwrap();
            std::fs::write(replacement.join(".desktop-owner.json"), &other).unwrap();
            MARKER_INSPECTION_SWAP.set(Some((checkpoint, false)));
            KEEP_MARKER_INSPECTION_SWAP.set(persistent);
            FAIL_MARKER_WRITE.set(checkpoint == 11);
            let result = record(&path, std::process::id());
            FAIL_MARKER_WRITE.set(false);
            assert_eq!(
                MARKER_INSPECTION_SWAP.take(),
                None,
                "checkpoint {checkpoint}"
            );
            assert!(!KEEP_MARKER_INSPECTION_SWAP.take());
            let untouched = if persistent { &path } else { &replacement };
            let admitted = if persistent { &retired } else { &path };
            assert_eq!(
                std::fs::read(untouched.join(".desktop-owner.json")).unwrap(),
                other,
                "checkpoint {checkpoint} redirected a child marker update"
            );
            assert_eq!(
                std::fs::read_dir(untouched).unwrap().count(),
                1,
                "checkpoint {checkpoint} left a temporary file in the replacement"
            );
            if persistent || checkpoint == 11 {
                assert!(
                    result.is_err(),
                    "checkpoint {checkpoint} accepted a persistent swap or failed write"
                );
            } else {
                result.unwrap();
            }
            let marker: serde_json::Value = serde_json::from_slice(
                &std::fs::read(admitted.join(".desktop-owner.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                marker["lease_hash"],
                serde_json::from_slice::<serde_json::Value>(&original).unwrap()["lease_hash"],
                "checkpoint {checkpoint} imported replacement ownership"
            );
            if checkpoint == 11 {
                assert_eq!(
                    std::fs::read(admitted.join(".desktop-owner.json")).unwrap(),
                    original
                );
            } else {
                assert_eq!(
                    marker["child_pid"],
                    std::process::id(),
                    "checkpoint {checkpoint}"
                );
            }
            assert!(
                !std::fs::read_dir(admitted).unwrap().any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".json.new")),
                "checkpoint {checkpoint} stranded a temporary file"
            );
            let released = owner.release();
            assert!(released.marker_removed && released.runtime_removed && released.lock_released);
            std::fs::remove_dir_all(untouched).unwrap();
            std::fs::remove_dir_all(admitted).unwrap();
        }
    }

    #[test]
    fn ticket_t_12_acquisition_marker_first_read_ignores_directory_swap() {
        assert_acquisition_marker_ignores_swap(1);
    }

    #[test]
    fn ticket_t_12_acquisition_marker_final_read_ignores_directory_swap() {
        assert_acquisition_marker_ignores_swap(2);
    }

    fn assert_acquisition_marker_ignores_swap(checkpoint: u8) {
        let path = directory();
        let replacement = path.with_extension("replacement");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&replacement)
            .unwrap();
        let marker =
            serde_json::json!({"pid": std::process::id(), "kind": "standalone"}).to_string();
        let decoy: &[u8] = if checkpoint == 1 {
            b"invalid decoy"
        } else {
            br#"{"pid":2147483647,"kind":"standalone"}"#
        };
        std::fs::write(path.join(".desktop-owner.json"), &marker).unwrap();
        std::fs::write(path.join("print-partner.db"), b"never open").unwrap();
        std::fs::write(replacement.join(".desktop-owner.json"), decoy).unwrap();
        MARKER_INSPECTION_SWAP.set(Some((checkpoint, false)));
        let result = StorageLease::acquire(&path);
        assert_eq!(
            MARKER_INSPECTION_SWAP.take(),
            None,
            "marker checkpoint was not reached"
        );
        let error = match result {
            Ok(owner) => {
                owner.release();
                None
            }
            Err(error) => Some(error.to_string()),
        };
        assert_eq!(
            error.as_deref(),
            Some("A prior writer may still be alive"),
            "checkpoint {checkpoint}"
        );
        assert_eq!(
            std::fs::read_to_string(path.join(".desktop-owner.json")).unwrap(),
            marker
        );
        assert_eq!(
            std::fs::read(path.join("print-partner.db")).unwrap(),
            b"never open"
        );
        assert_eq!(
            std::fs::read(replacement.join(".desktop-owner.json")).unwrap(),
            decoy
        );
        assert_eq!(std::fs::read_dir(&replacement).unwrap().count(), 1);
        assert!(!path.join(".desktop-lease").exists());
        std::fs::remove_dir_all(path).unwrap();
        std::fs::remove_dir_all(replacement).unwrap();
    }

    #[test]
    fn ticket_t_12_ownership_mutations_ignore_directory_swaps() {
        for checkpoint in [3, 4, 5] {
            for persistent in [false, true] {
                for fail_write in [false, true] {
                    let path = directory();
                    let replacement = path.with_extension("replacement");
                    let retired = path.with_extension("retired");
                    std::fs::DirBuilder::new()
                        .mode(0o700)
                        .create(&replacement)
                        .unwrap();
                    let stale = br#"{"pid":2147483647,"kind":"standalone"}"#;
                    let live = serde_json::json!({"pid":std::process::id(),"kind":"standalone"})
                        .to_string();
                    std::fs::write(path.join(".desktop-owner.json"), stale).unwrap();
                    std::fs::write(replacement.join(".desktop-owner.json"), &live).unwrap();
                    std::fs::create_dir(replacement.join(".desktop-lease")).unwrap();
                    std::fs::write(replacement.join(".desktop-lease/owner.json"), b"live guard")
                        .unwrap();
                    MARKER_INSPECTION_SWAP.set(Some((checkpoint, false)));
                    KEEP_MARKER_INSPECTION_SWAP.set(persistent);
                    FAIL_MARKER_WRITE.set(fail_write);
                    let result = StorageLease::acquire(&path);
                    FAIL_MARKER_WRITE.set(false);
                    assert_eq!(
                        MARKER_INSPECTION_SWAP.take(),
                        None,
                        "checkpoint {checkpoint}"
                    );
                    assert!(!KEEP_MARKER_INSPECTION_SWAP.take());
                    if persistent || fail_write {
                        assert!(
                            result.is_err(),
                            "checkpoint {checkpoint}, persistent {persistent}, failure {fail_write}"
                        );
                    } else {
                        let owner = result.unwrap();
                        assert_eq!(
                            std::fs::read(path.join(".desktop-lease/previous-marker.json"))
                                .unwrap(),
                            stale
                        );
                        let marker: serde_json::Value = serde_json::from_slice(
                            &std::fs::read(path.join(".desktop-owner.json")).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(marker["pid"], std::process::id());
                        let released = owner.release();
                        assert!(
                            released.lock_released
                                && released.marker_removed
                                && released.runtime_removed
                        );
                    }
                    let untouched = if persistent { &path } else { &replacement };
                    let admitted = if persistent { &retired } else { &path };
                    assert_eq!(
                        std::fs::read_to_string(untouched.join(".desktop-owner.json")).unwrap(),
                        live
                    );
                    assert_eq!(
                        std::fs::read(untouched.join(".desktop-lease/owner.json")).unwrap(),
                        b"live guard"
                    );
                    assert_eq!(std::fs::read_dir(untouched).unwrap().count(), 2);
                    assert!(
                        !admitted.join(".desktop-lease").exists(),
                        "checkpoint {checkpoint} stranded guard"
                    );
                    assert!(!std::fs::read_dir(admitted).unwrap().any(|entry| {
                        entry
                            .unwrap()
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".desktop-lease-candidate-")
                    }));
                    std::fs::remove_dir_all(untouched).unwrap();
                    std::fs::remove_dir_all(admitted).unwrap();
                }
            }
        }
    }

    #[test]
    fn ticket_t_12_release_ignores_transient_directory_swap() {
        let path = directory();
        let replacement = path.with_extension("replacement");
        let owner = StorageLease::acquire(&path).unwrap();
        let runtime = owner.runtime_dir().to_path_buf();
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&replacement)
            .unwrap();
        let live = serde_json::json!({"pid":std::process::id(),"kind":"standalone"}).to_string();
        std::fs::write(replacement.join(".desktop-owner.json"), &live).unwrap();
        std::fs::create_dir(replacement.join(".desktop-lease")).unwrap();
        std::fs::write(replacement.join(".desktop-lease/owner.json"), b"live guard").unwrap();
        MARKER_INSPECTION_SWAP.set(Some((6, false)));
        let released = owner.release();
        assert_eq!(MARKER_INSPECTION_SWAP.take(), None);
        assert!(released.marker_removed && released.runtime_removed && released.lock_released);
        assert_eq!(
            std::fs::read_to_string(replacement.join(".desktop-owner.json")).unwrap(),
            live
        );
        assert_eq!(
            std::fs::read(replacement.join(".desktop-lease/owner.json")).unwrap(),
            b"live guard"
        );
        assert_eq!(std::fs::read_dir(&replacement).unwrap().count(), 2);
        assert!(!path.join(".desktop-owner.json").exists());
        assert!(!path.join(".desktop-lease").exists());
        assert!(!runtime.exists());
        std::fs::remove_dir_all(path).unwrap();
        std::fs::remove_dir_all(replacement).unwrap();
    }

    #[test]
    fn ticket_t_12_release_preserves_live_replacement_after_persistent_swap() {
        let path = directory();
        let retired = path.with_extension("retired");
        let owner = StorageLease::acquire(&path).unwrap();
        let runtime = owner.runtime_dir().to_path_buf();
        std::fs::rename(&path, &retired).unwrap();
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        let live = serde_json::json!({"pid":std::process::id(),"kind":"standalone"}).to_string();
        std::fs::write(path.join(".desktop-owner.json"), &live).unwrap();
        std::fs::create_dir(path.join(".desktop-lease")).unwrap();
        std::fs::write(path.join(".desktop-lease/owner.json"), b"live guard").unwrap();
        let released = owner.release();
        assert!(released.marker_removed && released.runtime_removed && released.lock_released);
        assert_eq!(
            std::fs::read_to_string(path.join(".desktop-owner.json")).unwrap(),
            live
        );
        assert_eq!(
            std::fs::read(path.join(".desktop-lease/owner.json")).unwrap(),
            b"live guard"
        );
        assert!(!retired.join(".desktop-owner.json").exists());
        assert!(!retired.join(".desktop-lease").exists());
        assert!(!runtime.exists());
        std::fs::remove_dir_all(path).unwrap();
        std::fs::remove_dir_all(retired).unwrap();
    }

    #[test]
    fn ticket_t_12_acquisition_marker_refuses_symlink_to_regular_record() {
        for live in [false, true] {
            let path = directory();
            let record = serde_json::json!({
                "pid": if live { std::process::id() } else { i32::MAX as u32 },
                "kind": "standalone"
            })
            .to_string();
            std::fs::write(path.join("private-marker"), &record).unwrap();
            let marker = path.join(".desktop-owner.json");
            std::os::unix::fs::symlink("private-marker", &marker).unwrap();
            let error = StorageLease::acquire(&path).err().unwrap();
            assert_eq!(error.to_string(), "storage_lease_marker_invalid");
            assert_eq!(
                error
                    .downcast_ref::<std::io::Error>()
                    .and_then(std::io::Error::raw_os_error),
                Some(libc::ELOOP)
            );
            assert_eq!(
                std::fs::read_link(marker).unwrap(),
                Path::new("private-marker")
            );
            assert_eq!(
                std::fs::read_to_string(path.join("private-marker")).unwrap(),
                record
            );
            assert!(!path.join(".desktop-lease").exists());
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn ticket_t_12_persistent_swap_before_first_marker_read_preserves_live_replacement() {
        assert_persistent_swap_preserves_live_replacement(1);
    }

    #[test]
    fn ticket_t_12_persistent_swap_before_second_marker_read_preserves_live_replacement() {
        assert_persistent_swap_preserves_live_replacement(2);
    }

    fn assert_persistent_swap_preserves_live_replacement(checkpoint: u8) {
        let path = directory();
        let replacement = path.with_extension("replacement");
        let retired = path.with_extension("retired");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&replacement)
            .unwrap();
        let stale = br#"{"pid":2147483647,"kind":"standalone"}"#;
        let live = serde_json::json!({"pid":std::process::id(),"kind":"standalone"}).to_string();
        std::fs::write(path.join(".desktop-owner.json"), stale).unwrap();
        std::fs::write(replacement.join(".desktop-owner.json"), &live).unwrap();
        KEEP_MARKER_INSPECTION_SWAP.set(true);
        MARKER_INSPECTION_SWAP.set(Some((checkpoint, false)));
        let result = StorageLease::acquire(&path);
        assert_eq!(MARKER_INSPECTION_SWAP.take(), None);
        assert!(!KEEP_MARKER_INSPECTION_SWAP.take());
        let error = match result {
            Ok(owner) => {
                owner.release();
                None
            }
            Err(error) => Some(error.to_string()),
        };
        assert!(
            error.is_some(),
            "checkpoint {checkpoint}: persistent swap acquired replacement ownership"
        );
        assert_eq!(
            std::fs::read_to_string(path.join(".desktop-owner.json")).unwrap(),
            live
        );
        assert_eq!(
            std::fs::read(retired.join(".desktop-owner.json")).unwrap(),
            stale
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
        assert!(
            !retired.join(".desktop-lease").exists(),
            "admitted guard stranded after persistent swap"
        );
        std::fs::remove_dir_all(path).unwrap();
        std::fs::remove_dir_all(retired).unwrap();
    }

    pub(super) fn replace_directory_before_canonicalization(path: &Path) -> Result<()> {
        match REPLACE_DIRECTORY_BEFORE_CANONICALIZATION.take() {
            0 => {}
            1 => {
                std::fs::rename(path, path.with_extension("retired"))?;
                std::fs::DirBuilder::new().mode(0o700).create(path)?;
            }
            2 => {
                let retired = path.with_extension("retired");
                std::fs::rename(path, &retired)?;
                let replacement = path.with_extension("replacement");
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&replacement)?;
                std::os::unix::fs::symlink(replacement, path)?;
            }
            3 => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777))?,
            _ => unreachable!(),
        }
        Ok(())
    }

    #[test]
    fn ticket_t_12_directory_replacement_during_admission_is_refused() {
        for replacement in [1, 2] {
            let path = directory();
            let retired = path.with_extension("retired");
            let marker = br#"{"pid":2147483647,"kind":"standalone"}"#;
            std::fs::write(path.join(".desktop-owner.json"), marker).unwrap();
            std::fs::write(path.join("print-partner.db"), b"never open").unwrap();
            std::fs::write(path.join("desktop.toml"), b"port = 45678\n").unwrap();
            REPLACE_DIRECTORY_BEFORE_CANONICALIZATION.set(replacement);
            let result = StorageLease::acquire(&path);
            assert!(
                result.is_err(),
                "replacement {replacement} acquired ownership of an unchecked directory"
            );
            assert_eq!(
                result.err().unwrap().to_string(),
                "Data directory was replaced"
            );
            assert_eq!(
                std::fs::read(retired.join(".desktop-owner.json")).unwrap(),
                marker
            );
            assert_eq!(
                std::fs::read(retired.join("print-partner.db")).unwrap(),
                b"never open"
            );
            assert_eq!(
                std::fs::read(retired.join("desktop.toml")).unwrap(),
                b"port = 45678\n"
            );
            assert_eq!(std::fs::read_dir(&retired).unwrap().count(), 3);
            assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
            std::fs::remove_dir_all(retired).unwrap();
            if replacement == 2 {
                std::fs::remove_file(&path).unwrap();
                std::fs::remove_dir_all(path.with_extension("replacement")).unwrap();
            } else {
                std::fs::remove_dir_all(path).unwrap();
            }
        }
    }

    #[test]
    fn ticket_t_12_directory_permission_change_during_admission_is_refused() {
        let path = directory();
        REPLACE_DIRECTORY_BEFORE_CANONICALIZATION.set(3);
        let result = prepare_directory(&path);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir(&path).unwrap();
        assert_eq!(
            result.unwrap_err().to_string(),
            "Unsafe data directory permissions"
        );
    }

    #[test]
    fn ticket_t_12_replaced_directory_refuses_before_writer_database_preflight() {
        let path = directory();
        let retired = path.with_extension("retired");
        std::fs::write(path.join("print-partner.db"), b"never open").unwrap();
        REPLACE_DIRECTORY_BEFORE_CANONICALIZATION.set(1);
        let result = crate::WriterOwner::open(&path, crate::Limits::default());
        assert_eq!(
            result.err().unwrap().to_string(),
            "Data directory was replaced"
        );
        assert_eq!(
            std::fs::read(retired.join("print-partner.db")).unwrap(),
            b"never open"
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
        std::fs::remove_dir_all(retired).unwrap();
        std::fs::remove_dir(path).unwrap();
    }

    pub(super) fn replace_directory_before_writer_preflight(path: &Path) -> Result<()> {
        let replacement = REPLACE_DIRECTORY_BEFORE_WRITER_PREFLIGHT.take();
        match replacement {
            0 => {}
            4 => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o770))?,
            5 => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o500))?,
            _ => {
                REPLACE_DIRECTORY_BEFORE_CANONICALIZATION.set(replacement);
                replace_directory_before_canonicalization(path)?;
            }
        }
        Ok(())
    }

    #[test]
    fn ticket_t_12_writer_preflight_rejects_replaced_admitted_directory() {
        for replacement in [1, 2] {
            assert_writer_preflight_refuses(replacement, "Data directory was replaced");
        }
    }

    #[test]
    fn ticket_t_12_writer_preflight_rejects_changed_admitted_permissions() {
        for replacement in [3, 4, 5] {
            assert_writer_preflight_refuses(replacement, "Unsafe data directory permissions");
        }
    }

    fn assert_writer_preflight_refuses(replacement: u8, expected: &str) {
        let path = directory();
        let files: [(&str, &[u8]); 5] = [
            (
                ".desktop-owner.json",
                br#"{"pid":2147483647,"kind":"standalone"}"#,
            ),
            ("print-partner.db", b"never open"),
            ("print-partner.db-wal", b"copied wal"),
            ("print-partner.db-journal", b"copied journal"),
            ("desktop.toml", b"port = 45678\n"),
        ];
        for (name, bytes) in files {
            std::fs::write(path.join(name), bytes).unwrap();
        }
        crate::schema::PREFLIGHT_CALLS.set(0);
        REPLACE_DIRECTORY_BEFORE_WRITER_PREFLIGHT.set(replacement);
        let result = crate::WriterOwner::open(&path, crate::Limits::default());
        let error = result.err().map(|error| error.to_string());
        assert_eq!(crate::schema::PREFLIGHT_CALLS.get(), 0);
        let preserved = if replacement >= 3 {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path.clone()
        } else {
            path.with_extension("retired")
        };
        for (name, bytes) in files {
            assert_eq!(std::fs::read(preserved.join(name)).unwrap(), bytes);
        }
        assert_eq!(std::fs::read_dir(&preserved).unwrap().count(), files.len());
        if replacement < 3 {
            assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
        }
        std::fs::remove_dir_all(preserved).unwrap();
        if replacement == 2 {
            std::fs::remove_file(&path).unwrap();
            std::fs::remove_dir_all(path.with_extension("replacement")).unwrap();
        } else if replacement == 1 {
            std::fs::remove_dir_all(path).unwrap();
        }
        assert_eq!(
            error.as_deref(),
            Some(expected),
            "replacement {replacement}"
        );
    }

    #[test]
    fn ticket_t_12_writer_preflight_retains_admission_into_os_lock() {
        for replacement in [1, 2, 3] {
            let path = directory();
            let admitted = admit_directory(&path).unwrap();
            crate::schema::PREFLIGHT_CALLS.set(0);
            admitted.preflight().unwrap();
            assert_eq!(crate::schema::PREFLIGHT_CALLS.get(), 1);
            REPLACE_DIRECTORY_BEFORE_WRITER_PREFLIGHT.set(replacement);
            replace_directory_before_writer_preflight(&path).unwrap();
            let result = StorageLease::acquire_admitted(admitted);
            let expected = if replacement == 3 {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                "Unsafe data directory permissions"
            } else {
                assert_eq!(
                    std::fs::read_dir(path.with_extension("retired"))
                        .unwrap()
                        .count(),
                    0
                );
                std::fs::remove_dir(path.with_extension("retired")).unwrap();
                "Data directory was replaced"
            };
            assert_eq!(result.err().unwrap().to_string(), expected);
            assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
            if replacement == 2 {
                std::fs::remove_file(&path).unwrap();
                std::fs::remove_dir(path.with_extension("replacement")).unwrap();
            } else {
                std::fs::remove_dir(path).unwrap();
            }
        }
    }

    #[test]
    fn ticket_t_12_writer_preflight_rechecks_ancestor_permissions_before_lock() {
        let parent = directory();
        let path = parent.join("store");
        let admitted = admit_directory(&path).unwrap();
        let marker = br#"{"pid":2147483647,"kind":"standalone"}"#;
        std::fs::write(path.join(".desktop-owner.json"), marker).unwrap();
        std::fs::write(path.join("print-partner.db"), b"").unwrap();
        std::fs::write(path.join("desktop.toml"), b"port = 45678\n").unwrap();
        admitted.preflight().unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
        let error = StorageLease::acquire_admitted(admitted)
            .err()
            .map(|error| error.to_string());
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(error.as_deref(), Some("Unsafe data directory ancestor"));
        assert_eq!(
            std::fs::read(path.join(".desktop-owner.json")).unwrap(),
            marker
        );
        assert_eq!(std::fs::read(path.join("print-partner.db")).unwrap(), b"");
        assert_eq!(
            std::fs::read(path.join("desktop.toml")).unwrap(),
            b"port = 45678\n"
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 3);
        std::fs::remove_dir_all(parent).unwrap();
    }

    pub(super) fn replace_directory_during_lock(path: &Path, checkpoint: u8) -> Result<()> {
        let (selected, replacement) = REPLACE_DIRECTORY_DURING_LOCK.get();
        if selected == checkpoint {
            REPLACE_DIRECTORY_DURING_LOCK.set((0, 0));
            match replacement {
                4 => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o770))?,
                5 => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o500))?,
                6 => {
                    let retired = path.with_extension("retired");
                    std::fs::rename(path, &retired)?;
                    std::fs::DirBuilder::new().mode(0o700).create(path)?;
                    for name in [".desktop-owner.json", "print-partner.db", "desktop.toml"] {
                        std::fs::copy(retired.join(name), path.join(name))?;
                    }
                    std::fs::rename(retired.join(".desktop.lock"), path.join(".desktop.lock"))?;
                }
                _ => {
                    REPLACE_DIRECTORY_BEFORE_CANONICALIZATION.set(replacement);
                    replace_directory_before_canonicalization(path)?;
                }
            }
        }
        Ok(())
    }

    #[test]
    fn ticket_t_12_directory_replacement_through_os_lock_is_refused() {
        for checkpoint in [1, 2, 3, 4] {
            for replacement in [1, 2] {
                let path = directory();
                let retired = path.with_extension("retired");
                let marker = br#"{"pid":2147483647,"kind":"standalone"}"#;
                std::fs::write(path.join(".desktop-owner.json"), marker).unwrap();
                std::fs::write(path.join("print-partner.db"), b"never open").unwrap();
                std::fs::write(path.join("desktop.toml"), b"port = 45678\n").unwrap();
                REPLACE_DIRECTORY_DURING_LOCK.set((checkpoint, replacement));
                let result = StorageLease::acquire(&path);
                assert_eq!(
                    result.err().map(|error| error.to_string()),
                    Some("Data directory was replaced".to_owned()),
                    "checkpoint {checkpoint}, replacement {replacement}"
                );
                assert_eq!(
                    std::fs::read(retired.join(".desktop-owner.json")).unwrap(),
                    marker
                );
                assert_eq!(
                    std::fs::read(retired.join("print-partner.db")).unwrap(),
                    b"never open"
                );
                assert_eq!(
                    std::fs::read(retired.join("desktop.toml")).unwrap(),
                    b"port = 45678\n"
                );
                assert!(!retired.join(".desktop-lease").exists());
                assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
                if retired.join(".desktop.lock").exists() {
                    let lock = File::open(retired.join(".desktop.lock")).unwrap();
                    lock.try_lock_exclusive().unwrap();
                    FileExt::unlock(&lock).unwrap();
                }
                std::fs::remove_dir_all(retired).unwrap();
                if replacement == 2 {
                    std::fs::remove_file(&path).unwrap();
                    std::fs::remove_dir_all(path.with_extension("replacement")).unwrap();
                } else {
                    std::fs::remove_dir(path).unwrap();
                }
            }
        }
    }

    #[test]
    fn ticket_t_12_replaced_directory_with_same_lock_refuses_ownership_cleanup() {
        for checkpoint in [2, 3] {
            let path = directory();
            let retired = path.with_extension("retired");
            let files: [(&str, &[u8]); 3] = [
                (
                    ".desktop-owner.json",
                    br#"{"pid":2147483647,"kind":"standalone"}"#,
                ),
                ("print-partner.db", b"never open"),
                ("desktop.toml", b"port = 45678\n"),
            ];
            for (name, bytes) in files {
                std::fs::write(path.join(name), bytes).unwrap();
            }
            REPLACE_DIRECTORY_DURING_LOCK.set((checkpoint, 6));
            let result = StorageLease::acquire(&path);
            assert_eq!(
                result.err().map(|error| error.to_string()),
                Some("Data directory was replaced".to_owned())
            );
            for directory in [&path, &retired] {
                for (name, bytes) in files {
                    assert_eq!(std::fs::read(directory.join(name)).unwrap(), bytes);
                }
                assert!(!directory.join(".desktop-lease").exists());
            }
            let lock = File::open(path.join(".desktop.lock")).unwrap();
            lock.try_lock_exclusive().unwrap();
            FileExt::unlock(&lock).unwrap();
            std::fs::remove_dir_all(retired).unwrap();
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn ticket_t_12_directory_permission_change_through_os_lock_is_refused() {
        for checkpoint in [1, 2, 3] {
            for replacement in [3, 4, 5] {
                let path = directory();
                REPLACE_DIRECTORY_DURING_LOCK.set((checkpoint, replacement));
                let result = StorageLease::acquire(&path);
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                assert_eq!(
                    result.err().map(|error| error.to_string()),
                    Some("Unsafe data directory permissions".to_owned()),
                    "checkpoint {checkpoint}, replacement {replacement}"
                );
                assert!(!path.join(".desktop-owner.json").exists());
                assert!(!path.join(".desktop-lease").exists());
                std::fs::remove_dir_all(path).unwrap();
            }
        }
    }

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
        drop(guard::StorageLease::acquire(&admit_directory(path).unwrap().directory).unwrap());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn ticket_t_12_lock_identity_replacement_refuses_before_ownership_cleanup() {
        for checkpoint in [1, 2] {
            let path = directory();
            let marker = path.join(".desktop-owner.json");
            let database = path.join("print-partner.db");
            std::fs::write(&marker, br#"{"pid":2147483647,"kind":"standalone"}"#).unwrap();
            std::fs::write(&database, b"never open").unwrap();
            REPLACE_LOCK_BEFORE_VALIDATION.set(checkpoint);
            let error = StorageLease::acquire(&path).err().unwrap();
            assert_eq!(error.to_string(), "Data directory lock was replaced");
            for name in [".desktop.lock", ".desktop.retired"] {
                let file = File::open(path.join(name)).unwrap();
                file.try_lock_exclusive().unwrap();
                FileExt::unlock(&file).unwrap();
            }
            assert_eq!(
                std::fs::read(&marker).unwrap(),
                br#"{"pid":2147483647,"kind":"standalone"}"#
            );
            assert_eq!(std::fs::read(&database).unwrap(), b"never open");
            assert!(!path.join(".desktop-lease").exists());
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn ticket_t_7_writer_desktop_marker_removed_during_inspection_allows_handoff() {
        for writer in [false, true] {
            let path = directory();
            std::fs::write(
                path.join(".desktop-owner.json"),
                serde_json::json!({"pid": std::process::id(), "kind": "standalone"}).to_string(),
            )
            .unwrap();
            REMOVE_MARKER_BEFORE_READ.with(|remove| remove.set(true));
            if writer {
                let (owner, _) = crate::WriterOwner::open(&path, crate::Limits::default()).unwrap();
                assert!(path.join("print-partner.db").is_file());
                owner.shutdown().unwrap();
                assert!(!path.join(".desktop-owner.json").exists());
                assert!(!path.join(".desktop-lease").exists());
                std::fs::remove_dir_all(path).unwrap();
            } else {
                let owner = StorageLease::acquire(&path).unwrap();
                assert_released(owner.release(), &path);
            }
        }
    }

    #[test]
    fn gre_636_busy_lock_prevents_all_database_preflight() {
        let path = directory();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path.join("printpartner.lock"))
            .unwrap();
        fs4::FileExt::try_lock(&lock).unwrap();
        crate::schema::PREFLIGHT_CALLS.set(0);
        let error = crate::WriterOwner::open(&path, crate::Limits::default())
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            "Data directory already owned; stop the other Print Partner process before starting another instance"
        );
        assert_eq!(crate::schema::PREFLIGHT_CALLS.get(), 0);
        assert!(!path.join("print-partner.db").exists());
        drop(lock);
        let (owner, _) = crate::WriterOwner::open(&path, crate::Limits::default()).unwrap();
        assert_eq!(crate::schema::PREFLIGHT_CALLS.get(), 2);
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn release_unlocks_descriptors_inherited_by_an_unrelated_spawn() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        // A concurrent fork can retain the same open file description until exec.
        let inherited = owner.clone_file().unwrap();
        assert_released(owner.release(), &path);
        assert!(inherited.metadata().is_ok());
        drop(inherited);
    }

    #[test]
    fn unlock_failure_keeps_the_shared_lease_until_retry() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        FAIL_LOCK_UNLOCK.with(|fail| fail.set(true));
        let released = owner.release();
        assert!(released.ownership_retained && !released.lock_released);
        assert!(path.join(".desktop-lease/owner.json").is_file());
        assert!(guard::StorageLease::acquire(&admit_directory(&path).unwrap().directory).is_err());
        let lock = File::open(path.join(".desktop.lock")).unwrap();
        assert!(lock.try_lock_exclusive().is_err());
        assert_released(StorageLease::retry_failed_release(&path).unwrap(), &path);
    }

    #[test]
    fn failed_detachment_keeps_admission_closed_and_relocks_until_retry() {
        let path = directory();
        let owner = StorageLease::acquire(&path).unwrap();
        let identity: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(".desktop-lease/owner.json")).unwrap())
                .unwrap();
        let retired = path.join(format!(
            ".desktop-lease-release-{}",
            identity["instance"].as_str().unwrap()
        ));
        std::fs::create_dir(&retired).unwrap();
        std::fs::write(retired.join("block-detach"), b"retain").unwrap();
        let released = owner.release();
        assert!(released.ownership_retained && !released.lock_released);
        assert!(path.join(".desktop-lease/owner.json").is_file());
        assert!(guard::StorageLease::acquire(&admit_directory(&path).unwrap().directory).is_err());
        let lock = File::open(path.join(".desktop.lock")).unwrap();
        assert!(lock.try_lock_exclusive().is_err());
        std::fs::remove_dir_all(retired).unwrap();
        assert_released(StorageLease::retry_failed_release(&path).unwrap(), &path);
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
                assert!(
                    guard::StorageLease::acquire(&admit_directory(&path).unwrap().directory)
                        .is_err()
                );
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
        assert!(guard::StorageLease::acquire(&admit_directory(&path).unwrap().directory).is_err());
        let again = StorageLease::retry_failed_release(&path).unwrap();
        assert!(again.ownership_retained && !again.marker_removed && !again.lock_released);
        assert!(guard::StorageLease::acquire(&admit_directory(&path).unwrap().directory).is_err());
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
