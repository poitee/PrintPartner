use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
pub(crate) fn process_identity(pid: u32) -> Result<String> {
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let fields = stat.rsplit_once(')').context("Invalid process stat")?.1;
    let start = fields
        .split_whitespace()
        .nth(19)
        .context("Missing process start time")?;
    anyhow::ensure!(
        start.chars().all(|c| c.is_ascii_digit()),
        "Invalid process start time"
    );
    Ok(format!("{}:{start}", boot.trim()))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn process_identity(pid: u32) -> Result<String> {
    anyhow::ensure!(
        pid == std::process::id(),
        "Other process identity unavailable"
    );
    static IDENTITY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    Ok(IDENTITY
        .get_or_init(|| format!("instance:{}", hex::encode(rand::random::<[u8; 16]>())))
        .clone())
}

pub(crate) fn owner_is_stale(pid: u32, identity: Option<&str>) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result < 0 {
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    }
    #[cfg(target_os = "linux")]
    if std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit_once(')')
            .is_some_and(|(_, fields)| matches!(fields.split_whitespace().next(), Some("Z" | "X")))
    }) {
        return true;
    }
    identity.is_some_and(|identity| process_identity(pid).is_ok_and(|actual| actual != identity))
}

// On platforms without foreign-process identity lookup, use an instance token.
// A live foreign PID cannot be declared stale from a token mismatch there.
pub fn record_child(directory: &Path, pid: u32) -> Result<()> {
    #[cfg(target_os = "linux")]
    let identity = process_identity(pid)?;
    #[cfg(not(target_os = "linux"))]
    let identity = format!("instance:{}", hex::encode(rand::random::<[u8; 16]>()));
    let path = directory.join(".desktop-owner.json");
    let mut marker: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    anyhow::ensure!(
        marker["pid"].as_u64() == Some(u64::from(std::process::id())),
        "Desktop owner marker belongs to another process"
    );
    marker["child_pid"] = pid.into();
    marker["child_process_identity"] = identity.into();
    publish_child_marker(directory, &path, &marker)
}

fn publish_child_marker(directory: &Path, path: &Path, marker: &serde_json::Value) -> Result<()> {
    let temporary = directory.join(format!(
        ".desktop-owner-{}.json.new",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(marker)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        std::fs::File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn ensure_stale_owner(marker: &serde_json::Value) -> Result<()> {
    let pid = marker["pid"]
        .as_u64()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
        .context("Invalid prior writer PID")? as u32;
    anyhow::ensure!(
        owner_is_stale(pid, marker["process_identity"].as_str())
            && (marker["kind"] == "standalone"
                || (marker["storage_protocol_version"].as_u64() == Some(1)
                    && marker.get("child_pid").is_none()
                    && marker.get("child_process_identity").is_none())
                || child_is_stale(marker)),
        "A prior writer may still be alive"
    );
    Ok(())
}

pub(crate) fn child_is_stale(marker: &serde_json::Value) -> bool {
    let Some(pid) = marker["child_pid"]
        .as_u64()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
    else {
        return false;
    };
    let Some(identity) = marker["child_process_identity"]
        .as_str()
        .filter(|identity| !identity.is_empty())
    else {
        return false;
    };
    owner_is_stale(pid as u32, Some(identity))
}

#[derive(Deserialize, Serialize)]
struct Owner {
    pid: u32,
    process_identity: String,
    instance: String,
}

pub(crate) struct StorageLease {
    path: Option<PathBuf>,
    pub(crate) identity: String,
    detached: PathBuf,
}
impl StorageLease {
    pub(crate) fn acquire(directory: &Path) -> Result<Self> {
        let identity = process_identity(std::process::id())?;
        let owner = Owner {
            pid: std::process::id(),
            process_identity: identity.clone(),
            instance: hex::encode(rand::random::<[u8; 16]>()),
        };
        let candidate = directory.join(format!(".desktop-lease-candidate-{}", owner.instance));
        let lease = directory.join(".desktop-lease");
        std::fs::create_dir(&candidate)?;
        let result = (|| {
            std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700))?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(candidate.join("owner.json"))?;
            file.write_all(&serde_json::to_vec(&owner)?)?;
            file.sync_all()?;
            for _ in 0..16 {
                match std::fs::symlink_metadata(&lease) {
                    Ok(metadata) => {
                        anyhow::ensure!(metadata.is_dir(), "storage_lease_marker_invalid")
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        match std::fs::rename(&candidate, &lease) {
                            Ok(()) => {
                                return Ok(Self {
                                    path: Some(lease),
                                    identity,
                                    detached: directory
                                        .join(format!(".desktop-lease-release-{}", owner.instance)),
                                });
                            }
                            Err(error)
                                if matches!(
                                    error.raw_os_error(),
                                    Some(libc::ENOTEMPTY | libc::EEXIST)
                                ) =>
                            {
                                continue;
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                let bytes = match std::fs::read(lease.join("owner.json")) {
                    Ok(bytes) => bytes,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound
                            && !lease.try_exists()? =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error).context("storage_lease_marker_invalid"),
                };
                let prior: Owner =
                    serde_json::from_slice(&bytes).context("storage_lease_marker_invalid")?;
                anyhow::ensure!(
                    prior.pid > 0
                        && prior.pid <= i32::MAX as u32
                        && prior.instance.len() == 32
                        && prior.instance.bytes().all(|c| c.is_ascii_hexdigit())
                        && !prior.process_identity.trim().is_empty(),
                    "storage_lease_marker_invalid"
                );
                anyhow::ensure!(
                    owner_is_stale(prior.pid, Some(&prior.process_identity)),
                    "Data directory already owned"
                );
                // A retained nonempty destination prevents stale observers from retiring a new lease.
                match std::fs::rename(
                    &lease,
                    directory.join(format!(".desktop-lease-retired-{}", prior.instance)),
                ) {
                    Ok(()) => {}
                    Err(error)
                        if matches!(
                            error.raw_os_error(),
                            Some(libc::ENOENT | libc::ENOTEMPTY | libc::EEXIST)
                        ) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            bail!("Data directory ownership changed repeatedly; retry startup")
        })();
        let _ = std::fs::remove_dir_all(candidate);
        result
    }
    pub(crate) fn release(&mut self) -> Result<()> {
        if let Some(path) = &self.path {
            if path != &self.detached {
                std::fs::rename(path, &self.detached)?;
                self.path = Some(self.detached.clone());
            }
            std::fs::remove_dir_all(self.path.as_ref().expect("Lease path present"))?;
            self.path = None;
        }
        Ok(())
    }
}
impl Drop for StorageLease {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn child_recording_refuses_a_different_owner_without_modifying_its_marker() {
        let directory = std::env::temp_dir().join(format!(
            "pp-child-owner-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(".desktop-owner.json");
        let marker = br#"{"pid":0,"lease_hash":"original"}"#;
        std::fs::write(&path, marker).unwrap();
        let error = super::record_child(&directory, std::process::id()).unwrap_err();
        assert!(error.to_string().contains("another process"));
        assert_eq!(std::fs::read(&path).unwrap(), marker);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_child_marker_publication_removes_its_temporary_file() {
        let directory = std::env::temp_dir().join(format!(
            "pp-child-publication-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(".desktop-owner.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), "original").unwrap();
        assert!(super::publish_child_marker(&directory, &path, &serde_json::json!({})).is_err());
        assert_eq!(
            std::fs::read_to_string(path.join("keep")).unwrap(),
            "original"
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn own_instance_identity_is_stable_and_lease_can_restart() {
        let directory = std::env::temp_dir().join(format!(
            "pp-macos-lease-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let identity = super::process_identity(std::process::id()).unwrap();
        assert!(identity.starts_with("instance:"));
        assert_eq!(
            identity,
            super::process_identity(std::process::id()).unwrap()
        );
        let lease = super::StorageLease::acquire(&directory).unwrap();
        assert_eq!(lease.identity, identity);
        assert!(super::StorageLease::acquire(&directory).is_err());
        drop(lease);
        let stale = directory.join(".desktop-lease");
        std::fs::create_dir(&stale).unwrap();
        std::fs::write(
            stale.join("owner.json"),
            serde_json::to_vec(&super::Owner {
                pid: std::process::id(),
                process_identity: "instance:prior-process".into(),
                instance: hex::encode(rand::random::<[u8; 16]>()),
            })
            .unwrap(),
        )
        .unwrap();
        drop(super::StorageLease::acquire(&directory).unwrap());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unidentified_live_process_is_not_stale() {
        let pid = unsafe { libc::getppid() } as u32;
        assert_ne!(pid, std::process::id());
        assert!(super::process_identity(pid).is_err());
        assert!(!super::owner_is_stale(pid, Some("different-instance")));
        assert!(!super::owner_is_stale(pid, None));
    }

    #[test]
    fn child_marker_requires_complete_info_and_a_stale_child() {
        use serde_json::json;
        assert!(!super::child_is_stale(&json!({})));
        assert!(!super::child_is_stale(
            &json!({"child_pid": 0, "child_process_identity": "prior"})
        ));
        assert!(!super::child_is_stale(
            &json!({"child_pid": std::process::id()})
        ));
        assert!(!super::child_is_stale(
            &json!({"child_pid": std::process::id(), "child_process_identity": ""})
        ));
        let identity = super::process_identity(std::process::id()).unwrap();
        assert!(!super::child_is_stale(
            &json!({"child_pid": std::process::id(), "child_process_identity": identity})
        ));
        let mut dead = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = dead.id();
        #[cfg(target_os = "linux")]
        let stale_before_reaping = {
            let identity = super::process_identity(pid).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !super::owner_is_stale(pid, Some(&identity))
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
            super::owner_is_stale(pid, Some(&identity))
        };
        dead.wait().unwrap();
        #[cfg(target_os = "linux")]
        assert!(
            stale_before_reaping,
            "a zombie must not block lease recovery"
        );
        assert!(super::child_is_stale(
            &json!({"child_pid": pid, "child_process_identity": "prior"})
        ));
    }

    #[test]
    fn matching_process_identity_remains_live() {
        let pid = std::process::id();
        let identity = super::process_identity(pid).unwrap();
        assert!(!super::owner_is_stale(pid, Some(&identity)));
        assert!(!super::owner_is_stale(pid, None));
        assert!(super::owner_is_stale(pid, Some("prior-boot:prior-start")));
    }
}
