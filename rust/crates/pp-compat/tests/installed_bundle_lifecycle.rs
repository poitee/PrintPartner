#![cfg(target_os = "macos")]

use anyhow::{Context, Result, bail, ensure};
use pp_compat::{Bundle, SpawnSpec, Status, Supervisor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{File, OpenOptions},
    io::Write,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    os::{
        fd::AsRawFd,
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
struct ReleaseIdentity {
    runtime_version: String,
    commit: String,
    node: PathBuf,
    web: PathBuf,
    os: String,
    arch: String,
    node_version: String,
    node_abi: String,
}

struct TestOwnership {
    data_dir: PathBuf,
    runtime_dir: PathBuf,
    lease: String,
    lock: File,
}

impl TestOwnership {
    fn create(data_dir: PathBuf, runtime_dir: PathBuf) -> Result<Self> {
        ensure!(
            data_dir.is_absolute(),
            "Test data directory must be absolute"
        );
        ensure!(
            runtime_dir.is_absolute(),
            "Test runtime directory must be absolute"
        );
        ensure!(!data_dir.exists(), "Test data directory must be new");
        ensure!(!runtime_dir.exists(), "Test runtime directory must be new");
        std::fs::create_dir(&data_dir)?;
        std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))?;
        std::fs::create_dir(&runtime_dir)?;
        std::fs::set_permissions(&runtime_dir, std::fs::Permissions::from_mode(0o700))?;
        let data_dir = data_dir.canonicalize()?;
        let runtime_dir = runtime_dir.canonicalize()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(data_dir.join(".desktop.lock"))?;
        let locked = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        ensure!(locked == 0, "Could not lock test data directory");
        let lease = hex::encode(rand::random::<[u8; 32]>());
        let marker = serde_json::json!({
            "pid": std::process::id(),
            "lease_hash": hex::encode(Sha256::digest(lease.as_bytes())),
            "runtime_dir": runtime_dir,
        });
        let mut marker_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(data_dir.join(".desktop-owner.json"))?;
        marker_file.write_all(marker.to_string().as_bytes())?;
        marker_file.sync_all()?;
        Ok(Self {
            data_dir,
            runtime_dir,
            lease,
            lock,
        })
    }
}

impl Drop for TestOwnership {
    fn drop(&mut self) {
        let _ = unsafe { libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN) };
        let _ = std::fs::remove_dir_all(&self.runtime_dir);
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

#[derive(Serialize)]
struct LifecycleReceipt<'a> {
    status: &'static str,
    source_commit: &'a str,
    runtime_version: &'a str,
    bundled_node_version: &'a str,
    bundled_node_abi: &'a str,
    bundle_architecture: &'a str,
    ready_generation: &'a str,
    ready_pid: u32,
    port: u16,
    health: &'static str,
    shutdown: &'static str,
    child_pid_absent: bool,
    runtime_socket_absent: bool,
    environment_overrides: [&'static str; 9],
}

fn required_path(name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(env::var_os(name).context(format!("{name} is required"))?);
    ensure!(path.is_absolute(), "{name} must be absolute");
    Ok(path)
}

fn free_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

async fn wait_for_ready(
    status: &mut tokio::sync::watch::Receiver<Status>,
) -> Result<(String, u32)> {
    tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            match status.borrow().clone() {
                Status::Starting => {}
                Status::Ready { generation, pid } => return Ok((generation, pid)),
                Status::Backoff { attempt } => {
                    bail!("Compatibility child entered backoff {attempt}")
                }
                Status::Guarded => bail!("Compatibility child entered crash guard"),
                Status::Stopped => bail!("Compatibility child stopped before readiness"),
            }
            status
                .changed()
                .await
                .context("Compatibility status channel closed")?;
        }
    })
    .await
    .context("Compatibility readiness timed out")?
}

fn process_exists(pid: u32) -> Result<bool> {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error.into())
}

fn write_receipt(path: &Path, receipt: &LifecycleReceipt<'_>) -> Result<()> {
    ensure!(!path.exists(), "Lifecycle receipt path must be new");
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&serde_json::to_vec_pretty(receipt)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

#[tokio::test]
async fn installed_bundle_start_health_shutdown() -> Result<()> {
    ensure!(
        env::var_os("LD_PRELOAD").is_none(),
        "LD_PRELOAD is forbidden"
    );
    ensure!(
        env::var_os("DYLD_INSERT_LIBRARIES").is_none(),
        "DYLD_INSERT_LIBRARIES is forbidden"
    );
    let contents = required_path("PP_COMPAT_BUNDLE_CONTENTS")?.canonicalize()?;
    let release: ReleaseIdentity = serde_json::from_slice(&std::fs::read(
        contents.join("Resources/desktop-runtime/release.json"),
    )?)?;
    ensure!(release.os == "macos", "Installed release is not macOS");
    let web_root = contents.join(&release.web);
    let bundle = Bundle {
        node: contents.join(&release.node),
        entry: web_root.join("apps/server/dist/current/desktop.js"),
        web_root,
        runtime_version: release.runtime_version.clone(),
        commit: release.commit.clone(),
    };
    let ownership = TestOwnership::create(
        required_path("PP_COMPAT_TEST_DATA_DIR")?,
        required_path("PP_COMPAT_TEST_RUNTIME_DIR")?,
    )?;
    let port = free_loopback_port()?;
    let supervisor = Supervisor::start(SpawnSpec {
        bundle,
        data_dir: ownership.data_dir.clone(),
        runtime_dir: ownership.runtime_dir.clone(),
        lease: ownership.lease.clone(),
        lease_file: ownership.lock.try_clone()?,
        port,
    })?;
    let mut status = supervisor.handle.status.clone();
    let (generation, ready_pid) = wait_for_ready(&mut status).await?;
    ensure!(process_exists(ready_pid)?, "Ready child PID is absent");
    let socket = ownership
        .runtime_dir
        .join(format!("{}.sock", &generation[..12]));
    ensure!(socket.exists(), "Ready runtime socket is absent");
    tokio::time::timeout(Duration::from_secs(16), supervisor.shutdown())
        .await
        .context("Compatibility shutdown timed out")??;
    ensure!(
        matches!(status.borrow().clone(), Status::Stopped),
        "Compatibility status did not reach Stopped"
    );
    ensure!(
        !process_exists(ready_pid)?,
        "Compatibility child PID survived shutdown"
    );
    ensure!(
        !socket.exists(),
        "Compatibility runtime socket survived shutdown"
    );
    write_receipt(
        &required_path("PP_COMPAT_TEST_RECEIPT")?,
        &LifecycleReceipt {
            status: "passed",
            source_commit: &release.commit,
            runtime_version: &release.runtime_version,
            bundled_node_version: &release.node_version,
            bundled_node_abi: &release.node_abi,
            bundle_architecture: &release.arch,
            ready_generation: &generation,
            ready_pid,
            port,
            health: "authenticated_release_match",
            shutdown: "stopped_with_observed_accepted_exit",
            child_pid_absent: true,
            runtime_socket_absent: true,
            environment_overrides: [
                "AI_ENABLED=0",
                "DATABASE_URL removed",
                "DEPLOY_MODE=self-host",
                "HOST=127.0.0.1",
                "NODE_OPTIONS removed",
                "NODE_PATH removed",
                "PRINT_PARTNER_UPDATE_CHECK=0",
                "MULTI_USER removed",
                "PRINT_PARTNER_DATA_DIR removed",
            ],
        },
    )?;
    Ok(())
}
