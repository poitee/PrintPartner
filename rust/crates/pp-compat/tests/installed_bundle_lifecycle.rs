#[cfg(target_os = "macos")]
use anyhow::Context;
use anyhow::{Result, ensure};
use pp_compat::Status;
#[cfg(target_os = "macos")]
use pp_compat::{Bundle, SpawnSpec, Supervisor};
#[cfg(target_os = "macos")]
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::{
    env,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(target_os = "macos")]
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
    #[cfg(target_os = "macos")]
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
            #[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn required_path(name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(env::var_os(name).context(format!("{name} is required"))?);
    ensure!(path.is_absolute(), "{name} must be absolute");
    Ok(path)
}

#[cfg(target_os = "macos")]
fn free_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(target_os = "macos")]
async fn wait_for_ready(
    status: &mut tokio::sync::watch::Receiver<Status>,
) -> std::result::Result<(String, u32), ReadinessFailure> {
    wait_for_ready_with_timeout(status, Duration::from_secs(35)).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
enum ReadinessFailureCategory {
    #[serde(rename = "readiness_timeout")]
    Timeout,
    #[serde(rename = "child_backoff")]
    ChildBackoff,
    #[serde(rename = "crash_guard")]
    CrashGuard,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "status_channel_closed")]
    StatusChannelClosed,
}

#[derive(Debug)]
struct ReadinessFailure {
    category: ReadinessFailureCategory,
    error: anyhow::Error,
}

impl ReadinessFailure {
    fn new(category: ReadinessFailureCategory, error: anyhow::Error) -> Self {
        Self { category, error }
    }
}

async fn wait_for_ready_with_timeout(
    status: &mut tokio::sync::watch::Receiver<Status>,
    duration: Duration,
) -> std::result::Result<(String, u32), ReadinessFailure> {
    let observed = async {
        loop {
            match status.borrow().clone() {
                Status::Starting => {}
                Status::Ready { generation, pid } => return Ok((generation, pid)),
                Status::Backoff { attempt } => {
                    return Err(ReadinessFailure::new(
                        ReadinessFailureCategory::ChildBackoff,
                        anyhow::anyhow!("Compatibility child entered backoff {attempt}"),
                    ));
                }
                Status::Guarded => {
                    return Err(ReadinessFailure::new(
                        ReadinessFailureCategory::CrashGuard,
                        anyhow::anyhow!("Compatibility child entered crash guard"),
                    ));
                }
                Status::Stopped => {
                    return Err(ReadinessFailure::new(
                        ReadinessFailureCategory::Stopped,
                        anyhow::anyhow!("Compatibility child stopped before readiness"),
                    ));
                }
            }
            status.changed().await.map_err(|error| {
                ReadinessFailure::new(
                    ReadinessFailureCategory::StatusChannelClosed,
                    anyhow::Error::new(error).context("Compatibility status channel closed"),
                )
            })?;
        }
    };
    match tokio::time::timeout(duration, observed).await {
        Ok(result) => result,
        Err(error) => Err(ReadinessFailure::new(
            ReadinessFailureCategory::Timeout,
            anyhow::Error::new(error).context("Compatibility readiness timed out"),
        )),
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ShutdownOutcome {
    Completed,
    TimedOut,
    Failed,
}

#[derive(Serialize)]
struct FailureRecord {
    category: ReadinessFailureCategory,
    status_before: StatusSnapshot,
    status_after: StatusSnapshot,
    shutdown: ShutdownOutcome,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum StatusSnapshot {
    Starting,
    Ready,
    Backoff,
    Guarded,
    Stopped,
}

impl From<&Status> for StatusSnapshot {
    fn from(status: &Status) -> Self {
        match status {
            Status::Starting => Self::Starting,
            Status::Ready { .. } => Self::Ready,
            Status::Backoff { .. } => Self::Backoff,
            Status::Guarded => Self::Guarded,
            Status::Stopped => Self::Stopped,
        }
    }
}

fn known_event(event: &str) -> bool {
    matches!(
        event,
        "compat_starting"
            | "compat_ready"
            | "compat_reaped"
            | "compat_crash_guard"
            | "compat_start_failed"
            | "compat_output"
            | "compat_readiness_transport"
            | "compat_readiness_timeout"
            | "compat_readiness_health_denied"
            | "compat_readiness_body"
            | "compat_readiness_json"
            | "compat_readiness_release_mismatch"
    )
}

fn write_failure_artifact(
    failure_dir: &Path,
    data_dir: &Path,
    category: ReadinessFailureCategory,
    status_before: &Status,
    status_after: &Status,
    shutdown: ShutdownOutcome,
) -> Result<()> {
    ensure!(
        failure_dir.is_absolute(),
        "Failure directory must be absolute"
    );
    ensure!(!failure_dir.exists(), "Failure directory must be new");
    std::fs::create_dir(failure_dir)?;
    std::fs::set_permissions(failure_dir, std::fs::Permissions::from_mode(0o700))?;

    let mut record = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(failure_dir.join("readiness.json"))?;
    serde_json::to_writer_pretty(
        &mut record,
        &FailureRecord {
            category,
            status_before: status_before.into(),
            status_after: status_after.into(),
            shutdown,
        },
    )?;
    record.write_all(b"\n")?;
    record.sync_all()?;

    let mut retained = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(failure_dir.join("desktop.jsonl"))?;
    match File::open(data_dir.join("logs/desktop.jsonl")) {
        Ok(source) => {
            for line in BufReader::new(source).lines() {
                let Ok(line) = line else { continue };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let Some(time) = value["time"].as_u64() else {
                    continue;
                };
                let Some(event) = value["event"].as_str().filter(|event| known_event(event)) else {
                    continue;
                };
                let Some(level) = value["level"]
                    .as_u64()
                    .filter(|level| [10, 20, 30, 40, 50, 60].contains(level))
                else {
                    continue;
                };
                serde_json::to_writer(
                    &mut retained,
                    &serde_json::json!({"time": time, "event": event, "level": level}),
                )?;
                retained.write_all(b"\n")?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    retained.sync_all()?;
    Ok(())
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn write_receipt(path: &Path, receipt: &LifecycleReceipt<'_>) -> Result<()> {
    ensure!(!path.exists(), "Lifecycle receipt path must be new");
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&serde_json::to_vec_pretty(receipt)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

#[cfg(target_os = "macos")]
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
    let failure_dir = required_path("PP_COMPAT_TEST_FAILURE_DIR")?;
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
    let (generation, ready_pid) = match wait_for_ready(&mut status).await {
        Ok(ready) => ready,
        Err(failure) => {
            let status_before = status.borrow().clone();
            let shutdown =
                match tokio::time::timeout(Duration::from_secs(16), supervisor.shutdown()).await {
                    Ok(Ok(())) => ShutdownOutcome::Completed,
                    Ok(Err(_)) => {
                        eprintln!("compat_diagnostic_shutdown_failed");
                        ShutdownOutcome::Failed
                    }
                    Err(_) => {
                        eprintln!("compat_diagnostic_shutdown_timed_out");
                        ShutdownOutcome::TimedOut
                    }
                };
            let status_after = status.borrow().clone();
            if write_failure_artifact(
                &failure_dir,
                &ownership.data_dir,
                failure.category,
                &status_before,
                &status_after,
                shutdown,
            )
            .is_err()
            {
                eprintln!("compat_diagnostic_capture_failed");
            }
            return Err(failure.error);
        }
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn private_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pp-compat-{name}-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ))
    }

    #[test]
    fn failure_artifact_survives_owned_fixture_cleanup() {
        let root = private_root("failure-artifact");
        std::fs::create_dir(&root).unwrap();
        let data_dir = root.join("owned-data");
        let runtime_dir = root.join("owned-runtime");
        let failure_dir = root.join("preserved-failure");
        let ownership = TestOwnership::create(data_dir.clone(), runtime_dir.clone()).unwrap();
        let logs = data_dir.join("logs");
        std::fs::create_dir(&logs).unwrap();
        std::fs::write(
            logs.join("desktop.jsonl"),
            concat!(
                "{\"time\":7,\"event\":\"compat_starting\",\"level\":30,\"message\":\"private-child-output\"}\n",
                "{\"time\":8,\"event\":\"untrusted-event-name\",\"level\":50,\"token\":\"private-token\"}\n",
                "not-json\n"
            ),
        )
        .unwrap();

        write_failure_artifact(
            &failure_dir,
            &data_dir,
            ReadinessFailureCategory::Timeout,
            &Status::Starting,
            &Status::Ready {
                generation: "private-generation".to_owned(),
                pid: 123,
            },
            ShutdownOutcome::Completed,
        )
        .unwrap();
        drop(ownership);

        assert!(!data_dir.exists());
        assert!(!runtime_dir.exists());
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(failure_dir.join("readiness.json")).unwrap())
                .unwrap();
        assert_eq!(record["category"], "readiness_timeout");
        assert_eq!(record["status_before"]["state"], "starting");
        assert_eq!(record["status_after"]["state"], "ready");
        assert_eq!(record["shutdown"], "completed");
        let record_text = record.to_string();
        assert!(!record_text.contains("private-generation"));
        assert!(!record_text.contains("123"));
        assert_eq!(
            serde_json::to_value([
                ShutdownOutcome::Completed,
                ShutdownOutcome::TimedOut,
                ShutdownOutcome::Failed,
            ])
            .unwrap(),
            serde_json::json!(["completed", "timed_out", "failed"])
        );
        let retained = std::fs::read_to_string(failure_dir.join("desktop.jsonl")).unwrap();
        let rows = retained
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![serde_json::json!({
                "time": 7,
                "event": "compat_starting",
                "level": 30
            })]
        );
        assert!(!retained.contains("private-child-output"));
        assert!(!retained.contains("private-token"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn readiness_wait_reports_fixed_failure_categories() {
        let (_timeout_sender, mut timeout_status) = tokio::sync::watch::channel(Status::Starting);
        let timeout = wait_for_ready_with_timeout(&mut timeout_status, Duration::ZERO)
            .await
            .unwrap_err();
        assert_eq!(timeout.category, ReadinessFailureCategory::Timeout);
        assert_eq!(
            timeout.error.to_string(),
            "Compatibility readiness timed out"
        );

        let (_backoff_sender, mut backoff_status) =
            tokio::sync::watch::channel(Status::Backoff { attempt: 2 });
        let backoff = wait_for_ready_with_timeout(&mut backoff_status, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(backoff.category, ReadinessFailureCategory::ChildBackoff);
        assert_eq!(
            backoff.error.to_string(),
            "Compatibility child entered backoff 2"
        );

        let (_guard_sender, mut guard_status) = tokio::sync::watch::channel(Status::Guarded);
        let guard = wait_for_ready_with_timeout(&mut guard_status, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(guard.category, ReadinessFailureCategory::CrashGuard);
        assert_eq!(
            guard.error.to_string(),
            "Compatibility child entered crash guard"
        );

        let (_stopped_sender, mut stopped_status) = tokio::sync::watch::channel(Status::Stopped);
        let stopped = wait_for_ready_with_timeout(&mut stopped_status, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(stopped.category, ReadinessFailureCategory::Stopped);
        assert_eq!(
            stopped.error.to_string(),
            "Compatibility child stopped before readiness"
        );

        let (closed_sender, mut closed_status) = tokio::sync::watch::channel(Status::Starting);
        drop(closed_sender);
        let closed = wait_for_ready_with_timeout(&mut closed_status, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(
            closed.category,
            ReadinessFailureCategory::StatusChannelClosed
        );
        assert_eq!(
            closed.error.to_string(),
            "Compatibility status channel closed"
        );
    }
}
