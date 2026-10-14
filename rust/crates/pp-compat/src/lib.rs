pub mod drain;
mod logs;
mod release;
use anyhow::{Context, Result, bail};
use axum::{
    body::Body,
    http::{HeaderValue, Request, Response},
};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
pub use release::verify_bundle;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    os::fd::AsRawFd,
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    process::{Child, ChildStdin, Command},
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};

#[derive(Clone)]
pub struct Bundle {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub web_root: PathBuf,
    pub runtime_version: String,
    pub commit: String,
}

pub struct SpawnSpec {
    pub bundle: Bundle,
    pub data_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub lease: String,
    pub lease_file: std::fs::File,
    pub port: u16,
    pub record_child: fn(&std::path::Path, u32) -> Result<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    Starting,
    Ready { generation: String, pid: u32 },
    Backoff { attempt: usize },
    Guarded,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone)]
pub struct Endpoint {
    socket: PathBuf,
    generation: String,
    key: [u8; 32],
    connections: Arc<Connections>,
}

struct Connections {
    closed: Mutex<bool>,
    tasks: TaskTracker,
    cancelled: CancellationToken,
}
impl Connections {
    fn new() -> Self {
        Self {
            closed: Mutex::new(false),
            tasks: TaskTracker::new(),
            cancelled: CancellationToken::new(),
        }
    }
    fn admit(&self) -> Result<TaskTrackerToken> {
        let closed = self.closed.lock().expect("Connection gate poisoned");
        anyhow::ensure!(!*closed, "Compatibility generation is stopping");
        Ok(self.tasks.token())
    }
    fn close(&self) {
        *self.closed.lock().expect("Connection gate poisoned") = true;
        self.cancelled.cancel();
        self.tasks.close();
    }
    async fn join(&self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(2), self.tasks.wait())
            .await
            .context("Compatibility connection join timed out")
    }
}

#[derive(Serialize, Deserialize)]
struct Principal<'a> {
    version: u8,
    generation: &'a str,
    tenant: &'a str,
    actor: &'a str,
    method: &'a str,
    target: &'a str,
    issued_at: u64,
}

impl Endpoint {
    /// Socket endpoint with no child. Tests drop publication while a refresh is blocked on it.
    pub fn bound_to(socket: impl Into<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            socket: socket.into(),
            generation: "test-generation".into(),
            key: [9; 32],
            connections: Arc::new(Connections::new()),
        })
    }

    pub async fn forward(&self, mut request: Request<Body>) -> Result<Response<Body>> {
        let admitted = self.connections.admit()?;
        let target = request
            .uri()
            .path_and_query()
            .context("Missing request target")?
            .as_str()
            .to_owned();
        let assertion = Principal {
            version: 1,
            generation: &self.generation,
            tenant: "default",
            actor: "desktop-owner",
            method: request.method().as_str(),
            target: &target,
            issued_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
        };
        let encoded = hex::encode(serde_json::to_vec(&assertion)?);
        let mut signer = Hmac::<Sha256>::new_from_slice(&self.key)?;
        signer.update(encoded.as_bytes());
        let signature = hex::encode(signer.finalize().into_bytes());
        request
            .headers_mut()
            .insert("x-pp-principal", HeaderValue::from_str(&encoded)?);
        request
            .headers_mut()
            .insert("x-pp-signature", HeaderValue::from_str(&signature)?);
        request
            .headers_mut()
            .insert("host", HeaderValue::from_static("desktop-compat"));
        let stream = tokio::select! {
            biased;
            _ = self.connections.cancelled.cancelled() => bail!("Compatibility connection stopped"),
            stream = UnixStream::connect(&self.socket) => stream.context("Compatibility socket unavailable")?,
        };
        let (mut sender, connection) = tokio::select! {
            biased;
            _ = self.connections.cancelled.cancelled() => bail!("Compatibility connection stopped"),
            handshake = hyper::client::conn::http1::handshake(TokioIo::new(stream)) => handshake?,
        };
        let cancelled = self.connections.cancelled.clone();
        tokio::spawn(async move {
            let _admitted = admitted;
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => {},
                _ = connection.with_upgrades() => {},
            }
        });
        let response = tokio::select! {
            biased;
            _ = self.connections.cancelled.cancelled() => bail!("Compatibility dispatch outcome unknown"),
            response = sender.send_request(request) => response.context("Compatibility dispatch outcome unknown")?,
        };
        Ok(response.map(Body::new))
    }

    async fn ready(&self, bundle: &Bundle, cancelled: &CancellationToken) -> bool {
        let probe = async {
            let response = self
                .forward(Request::builder().uri("/health").body(Body::empty())?)
                .await?;
            if !response.status().is_success() {
                bail!("Health denied");
            }
            let bytes = http_body_util::Limited::new(response.into_body(), 65536)
                .collect()
                .await
                .map_err(|_| anyhow::anyhow!("Invalid health response body"))?
                .to_bytes();
            let health: serde_json::Value = serde_json::from_slice(&bytes)?;
            if health["ok"] != true
                || health["version"] != bundle.runtime_version
                || health["release"]["commit"] != bundle.commit
            {
                bail!("Release or database health mismatch");
            }
            Ok::<(), anyhow::Error>(())
        };
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => false,
            result = tokio::time::timeout(Duration::from_secs(2), probe) => {
                matches!(result, Ok(Ok(())))
            }
        }
    }
}

#[derive(Clone)]
pub struct CompatHandle {
    endpoint: watch::Receiver<Option<Arc<Endpoint>>>,
    pub status: watch::Receiver<Status>,
    recover: mpsc::Sender<()>,
}

impl CompatHandle {
    /// No child endpoint is published. Node-owned routes must fail closed.
    pub fn unpublished() -> Self {
        let (_endpoints, endpoint) = watch::channel(None);
        let (_states, status) = watch::channel(Status::Starting);
        let (recover, _recovery) = mpsc::channel(1);
        Self {
            endpoint,
            status,
            recover,
        }
    }

    /// Caller replaces the published child. `None` is an unpublished backend.
    pub fn replaceable(
        endpoint: Option<Arc<Endpoint>>,
    ) -> (Self, watch::Sender<Option<Arc<Endpoint>>>) {
        let (tx, rx) = watch::channel(endpoint);
        let (_states, status) = watch::channel(Status::Starting);
        let (recover, _recovery) = mpsc::channel(1);
        (
            Self {
                endpoint: rx,
                status,
                recover,
            },
            tx,
        )
    }

    pub fn endpoint(&self) -> Option<Arc<Endpoint>> {
        self.endpoint.borrow().clone()
    }
    pub async fn recover(&self) -> Result<()> {
        if !matches!(*self.status.borrow(), Status::Guarded) {
            bail!("Recovery is available only after the crash guard stops the child");
        }
        self.recover.send(()).await.context("Supervisor stopped")
    }
}

pub struct Supervisor {
    pub handle: CompatHandle,
    stop: CancellationToken,
    restarts_disarmed: CancellationToken,
    task: Option<JoinHandle<Result<()>>>,
}

fn restarts_blocked(cancelled: &CancellationToken, disarmed: &CancellationToken) -> bool {
    !drain::restarts_allowed(cancelled.is_cancelled() || disarmed.is_cancelled())
}

fn startup_probe_publishes(blocked: bool, probe_ready: bool) -> bool {
    probe_ready && !blocked
}

struct Process {
    child: Child,
    pid: u32,
    stdin: Option<ChildStdin>,
    endpoint: Arc<Endpoint>,
    logs: Vec<JoinHandle<()>>,
}

#[derive(Debug)]
enum StopOutcome {
    Observed(ExitStatus),
    ForcedAfterTimeout(ExitStatus),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopIntent {
    PlannedShutdown,
    Restart,
}

#[derive(Default)]
struct CleanupErrors {
    first: Option<anyhow::Error>,
}

impl CleanupErrors {
    fn capture<T>(&mut self, result: Result<T>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(error) => {
                if self.first.is_none() {
                    self.first = Some(error);
                }
                None
            }
        }
    }

    fn finish(self) -> Result<()> {
        match self.first {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn validate_stop_outcome(outcome: StopOutcome, intent: StopIntent) -> Result<()> {
    match (outcome, intent) {
        (StopOutcome::Observed(_) | StopOutcome::ForcedAfterTimeout(_), StopIntent::Restart) => {
            Ok(())
        }
        (StopOutcome::ForcedAfterTimeout(status), StopIntent::PlannedShutdown)
            if status.signal() == Some(libc::SIGKILL)
                || status.signal() == Some(libc::SIGTERM)
                || status.success() =>
        {
            Ok(())
        }
        (StopOutcome::ForcedAfterTimeout(status), StopIntent::PlannedShutdown) => {
            bail!("Compatibility child required parent-forced termination: {status}")
        }
        (StopOutcome::Observed(status), StopIntent::PlannedShutdown)
            if status.success()
                || status.signal() == Some(libc::SIGKILL)
                || status.signal() == Some(libc::SIGTERM) =>
        {
            Ok(())
        }
        (StopOutcome::Observed(status), StopIntent::PlannedShutdown) => {
            bail!("Compatibility child exited unexpectedly during shutdown: {status}")
        }
    }
}

fn classify_stop_outcome(
    outcome: StopOutcome,
    cancelled: &CancellationToken,
) -> Result<StopIntent> {
    let intent = if cancelled.is_cancelled() {
        StopIntent::PlannedShutdown
    } else {
        StopIntent::Restart
    };
    validate_stop_outcome(outcome, intent)?;
    Ok(intent)
}

impl Process {
    async fn spawn(spec: &SpawnSpec, capture: &logs::Logs) -> Result<Self> {
        release::verify_backend(&spec.bundle)?;
        let package_root = release::package_root(&spec.bundle)?;
        let preload = spec
            .bundle
            .entry
            .parent()
            .context("Missing backend root")?
            .join("desktop-resolution.js")
            .canonicalize()
            .context("Measured desktop preload unavailable")?;
        let mut root_argument = std::ffi::OsString::from("--pp-desktop-package-root=");
        root_argument.push(package_root);
        let generation = hex::encode(rand::random::<[u8; 16]>());
        let key = rand::random::<[u8; 32]>();
        let socket = spec.runtime_dir.join(format!("{}.sock", &generation[..12]));
        let endpoint = Arc::new(Endpoint {
            socket,
            generation,
            key,
            connections: Arc::new(Connections::new()),
        });
        let mut command = Command::new(&spec.bundle.node);
        command
            .arg("--no-global-search-paths")
            .arg("--import")
            .arg(preload)
            .arg(&spec.bundle.entry)
            .arg(root_argument)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .current_dir(&spec.bundle.web_root)
            .env_clear()
            .envs(
                ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]
                    .iter()
                    .filter_map(|name| std::env::var_os(name).map(|value| (*name, value))),
            )
            .env("PP_COMMIT", release::manifest()?.commit)
            .env("PRINT_PARTNER_UPDATE_CHECK", "0")
            .env("AI_ENABLED", "0")
            .env("HOST", "127.0.0.1")
            .env("DEPLOY_MODE", "self-host")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.process_group(0);
        let lease_fd = spec.lease_file.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(lease_fd, 198) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().context("Could not start bundled Node")?;
        // Persist ownership before the child can receive setup or open storage.
        if let Err(error) =
            (spec.record_child)(&spec.data_dir, child.id().context("Missing child PID")?)
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error.context("Could not record child ownership"));
        }
        let child_identity = (|| -> Result<String> {
            let marker: serde_json::Value =
                serde_json::from_slice(&std::fs::read(spec.data_dir.join(".desktop-owner.json"))?)?;
            marker["child_process_identity"]
                .as_str()
                .filter(|identity| !identity.is_empty())
                .map(str::to_string)
                .context("Recorded child identity missing")
        })();
        let child_identity = match child_identity {
            Ok(identity) => identity,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error.context("Could not read recorded child ownership"));
            }
        };
        let mut stdin = child.stdin.take().context("Missing parent-liveness pipe")?;
        let setup = serde_json::json!({ "version":1, "data_dir":spec.data_dir, "socket_path":endpoint.socket,
            "generation":endpoint.generation, "key":hex::encode(key), "lease":spec.lease, "parent_pid":std::process::id(),
            "port":spec.port, "child_process_identity":child_identity });
        if stdin
            .write_all(format!("{setup}\n").as_bytes())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("Compatibility setup failed");
        }
        let mut logs = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            let capture = capture.clone();
            logs.push(tokio::spawn(async move { capture.capture(stdout).await }));
        }
        if let Some(stderr) = child.stderr.take() {
            let capture = capture.clone();
            logs.push(tokio::spawn(async move { capture.capture(stderr).await }));
        }
        Ok(Self {
            pid: child.id().context("Missing child PID")?,
            child,
            stdin: Some(stdin),
            endpoint,
            logs,
        })
    }

    async fn stop(
        mut self,
        observed: Option<ExitStatus>,
        cancelled: &CancellationToken,
        eof_watchdog: bool,
    ) -> Result<StopIntent> {
        let pid = self.pid;
        let mut errors = CleanupErrors::default();
        let mut outcome = None;
        if cancelled.is_cancelled() {
            let eof_closed = {
                let connections = Arc::clone(&self.endpoint.connections);
                let mut reject = move || connections.close();
                drain::reject_and_arm_eof(eof_watchdog, &mut self.stdin, &mut reject)
            };
            match drain::drive_shutdown_group(
                &mut self.child,
                pid,
                eof_closed,
                drain::SIGTERM_GRACE,
                observed,
            )
            .await
            {
                Ok(report) => {
                    outcome = Some(match report.exit {
                        drain::GroupExit::Observed(status) => StopOutcome::Observed(status),
                        drain::GroupExit::Forced(status) => StopOutcome::ForcedAfterTimeout(status),
                    });
                    if !report.group_absent {
                        errors.capture::<()>(Err(anyhow::anyhow!("Process group still present")));
                    }
                }
                Err(error) => {
                    errors.capture::<()>(Err(error));
                }
            }
        } else {
            self.endpoint.connections.close();
            self.stdin.take();
            outcome = observed.map(StopOutcome::Observed);
            if outcome.is_none() {
                let shutdown = cancelled.cancelled();
                tokio::pin!(shutdown);
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        match drain::drive_shutdown_group(
                            &mut self.child,
                            pid,
                            true,
                            drain::SIGTERM_GRACE,
                            None,
                        )
                        .await
                        {
                            Ok(report) => {
                                outcome = Some(match report.exit {
                                    drain::GroupExit::Observed(status) => StopOutcome::Observed(status),
                                    drain::GroupExit::Forced(status) => {
                                        StopOutcome::ForcedAfterTimeout(status)
                                    }
                                });
                                if !report.group_absent {
                                    errors.capture::<()>(Err(anyhow::anyhow!(
                                        "Process group still present"
                                    )));
                                }
                            }
                            Err(error) => {
                                errors.capture::<()>(Err(error));
                            }
                        }
                    }
                    finished = tokio::time::timeout(Duration::from_secs(10), self.child.wait()) => {
                        match finished {
                            Ok(result) => {
                                if let Some(status) =
                                    errors.capture(result.context("Child reap failed"))
                                {
                                    outcome = Some(StopOutcome::Observed(status));
                                }
                            }
                            Err(_) => {
                                unsafe {
                                    libc::kill(-(pid as i32), libc::SIGKILL);
                                }
                                errors.capture(
                                    self.child.start_kill().context("Child termination failed"),
                                );
                                match tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                                    .await
                                {
                                    Ok(result) => {
                                        if let Some(status) =
                                            errors.capture(result.context("Child reap failed"))
                                        {
                                            outcome =
                                                Some(StopOutcome::ForcedAfterTimeout(status));
                                        }
                                    }
                                    Err(error) => {
                                        errors.capture::<()>(
                                            Err(error).context("Child reap timed out"),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            errors.capture(
                tokio::time::timeout(Duration::from_secs(2), async {
                    loop {
                        let result = unsafe { libc::kill(-(pid as i32), 0) };
                        if result < 0
                            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                        {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .context("Process group still present"),
            );
        }
        errors.capture(self.endpoint.connections.join().await);
        for mut log in self.logs {
            let result = match tokio::time::timeout(Duration::from_secs(1), &mut log).await {
                Ok(result) => result.context("Log reader join failed"),
                Err(_) => {
                    log.abort();
                    let _ = log.await;
                    Err(anyhow::anyhow!("Log reader join timed out"))
                }
            };
            errors.capture(result);
        }
        errors.capture(match tokio::fs::remove_file(&self.endpoint.socket).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("Compatibility socket cleanup failed"),
        });
        let intent = outcome
            .map(|outcome| classify_stop_outcome(outcome, cancelled))
            .transpose()?;
        errors.finish()?;
        intent.context("Compatibility child outcome unavailable after cleanup")
    }
}

pub fn backoff(attempt: usize) -> Duration {
    Duration::from_millis([500, 1000, 2000, 4000, 8000, 30_000][attempt.min(5)])
}

/// Timing policy owned by an individual compatibility supervisor.
#[derive(Clone, Copy, Debug)]
pub struct SupervisorConfig {
    /// Ready time required to reset backoff, and age beyond which crashes expire.
    pub crash_guard_window: Duration,
    /// Close compat stdin during planned shutdown. Restart cleanup always closes it.
    pub eof_watchdog: bool,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            crash_guard_window: Duration::from_secs(120),
            eof_watchdog: true,
        }
    }
}

impl Supervisor {
    pub fn start(spec: SpawnSpec) -> Result<Self> {
        Self::start_with_config(spec, SupervisorConfig::default())
    }

    /// Start with a per-instance timing policy; `start` uses production defaults.
    pub fn start_with_config(spec: SpawnSpec, config: SupervisorConfig) -> Result<Self> {
        let logs = logs::Logs::open(spec.data_dir.join("logs"))?;
        let (endpoints, endpoint) = watch::channel(None);
        let (states, status) = watch::channel(Status::Starting);
        let (recover, mut recovery) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let restarts_disarmed = CancellationToken::new();
        let disarmed = restarts_disarmed.clone();
        let task = tokio::spawn(async move {
            let mut crashes = std::collections::VecDeque::new();
            let mut attempt = 0;
            loop {
                if restarts_blocked(&cancelled, &disarmed) {
                    break;
                }
                states.send_replace(Status::Starting);
                logs.event("compat_starting", 30);
                let process = Process::spawn(&spec, &logs).await;
                if let Ok(mut process) = process {
                    let mut ready = false;
                    let mut observed_exit = None;
                    if !restarts_blocked(&cancelled, &disarmed) {
                        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
                        while tokio::time::Instant::now() < deadline {
                            if restarts_blocked(&cancelled, &disarmed) {
                                break;
                            }
                            if let Some(status) =
                                process.child.try_wait().context("Child status failed")?
                            {
                                observed_exit = Some(status);
                                break;
                            }
                            let probe = tokio::select! {
                                biased;
                                _ = cancelled.cancelled() => None,
                                _ = disarmed.cancelled() => None,
                                probe = process.endpoint.ready(&spec.bundle, &cancelled) => {
                                    Some(probe)
                                }
                            };
                            match probe {
                                None => break,
                                Some(probe_ready) => {
                                    ready = startup_probe_publishes(
                                        restarts_blocked(&cancelled, &disarmed),
                                        probe_ready,
                                    );
                                    if ready || restarts_blocked(&cancelled, &disarmed) {
                                        break;
                                    }
                                }
                            }
                            tokio::select! {
                                biased;
                                _ = cancelled.cancelled() => break,
                                _ = disarmed.cancelled() => break,
                                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                            }
                        }
                    }
                    if ready && !restarts_blocked(&cancelled, &disarmed) {
                        logs.event("compat_ready", 30);
                        let pid = process.child.id().unwrap_or_default();
                        endpoints.send_replace(Some(process.endpoint.clone()));
                        states.send_replace(Status::Ready {
                            generation: process.endpoint.generation.clone(),
                            pid,
                        });
                        let ready_since = tokio::time::Instant::now();
                        let mut failures = 0;
                        loop {
                            tokio::select! {
                                biased;
                                _ = cancelled.cancelled() => break,
                                result = process.child.wait() => {
                                    observed_exit = Some(result.context("Child reap failed")?);
                                    break;
                                },
                                _ = tokio::time::sleep(Duration::from_secs(10)) => {
                                    if process.endpoint.ready(&spec.bundle, &cancelled).await { failures = 0; } else { failures += 1; }
                                    if failures >= 3 { break; }
                                }
                            }
                        }
                        // Preserve escalation for repeated crashes, but forget old failures
                        // once the child has stayed ready for the crash-guard window.
                        if ready_since.elapsed() >= config.crash_guard_window {
                            attempt = 0;
                        }
                    }
                    endpoints.send_replace(None);
                    states.send_replace(Status::Stopping);
                    let stop_intent = match process
                        .stop(observed_exit, &cancelled, config.eof_watchdog)
                        .await
                    {
                        Ok(intent) => intent,
                        Err(error) => {
                            states.send_replace(Status::Failed);
                            return Err(error);
                        }
                    };
                    logs.event("compat_reaped", 30);
                    if stop_intent == StopIntent::PlannedShutdown {
                        break;
                    }
                } else if cancelled.is_cancelled() {
                    break;
                }
                if restarts_blocked(&cancelled, &disarmed) {
                    break;
                }
                let now = tokio::time::Instant::now();
                crashes.push_back(now);
                while crashes
                    .front()
                    .is_some_and(|t| now.duration_since(*t) > config.crash_guard_window)
                {
                    crashes.pop_front();
                }
                if crashes.len() >= 5 {
                    logs.event("compat_crash_guard", 50);
                    states.send_replace(Status::Guarded);
                    tokio::select! { _ = cancelled.cancelled() => break, _ = recovery.recv() => { crashes.clear(); attempt = 0; } }
                } else {
                    states.send_replace(Status::Backoff { attempt });
                    tokio::select! { _ = cancelled.cancelled() => break, _ = tokio::time::sleep(backoff(attempt)) => {} }
                    attempt += 1;
                }
            }
            endpoints.send_replace(None);
            states.send_replace(Status::Stopped);
            Ok(())
        });
        Ok(Self {
            handle: CompatHandle {
                endpoint,
                status,
                recover,
            },
            stop,
            restarts_disarmed,
            task: Some(task),
        })
    }

    pub fn disarm_restarts(&self) {
        self.restarts_disarmed.cancel();
    }

    pub async fn shutdown(mut self) -> Result<()> {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.await
                .context("Compatibility supervisor join failed")??;
        }
        Ok(())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[cfg(test)]
mod tests {
    use std::{
        os::unix::process::ExitStatusExt,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    struct AttemptOnDrop(Arc<AtomicBool>);

    impl Drop for AttemptOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn cancellation_dominates_an_observed_abnormal_exit() {
        let cancelled = tokio_util::sync::CancellationToken::new();
        cancelled.cancel();

        assert!(
            super::classify_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(libc::SIGABRT)),
                &cancelled,
            )
            .is_err()
        );
    }

    #[test]
    fn startup_sleep_cancellation_classifies_as_planned_shutdown() {
        let cancelled = tokio_util::sync::CancellationToken::new();
        cancelled.cancel();

        assert_eq!(
            super::classify_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(0)),
                &cancelled,
            )
            .unwrap(),
            super::StopIntent::PlannedShutdown
        );
    }

    #[test]
    fn observed_abnormal_exit_without_cancellation_still_restarts() {
        let active = tokio_util::sync::CancellationToken::new();

        assert_eq!(
            super::classify_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(libc::SIGABRT)),
                &active,
            )
            .unwrap(),
            super::StopIntent::Restart
        );
    }

    #[test]
    fn forced_exit_without_cancellation_still_restarts() {
        let active = tokio_util::sync::CancellationToken::new();

        assert_eq!(
            super::classify_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGKILL,
                )),
                &active,
            )
            .unwrap(),
            super::StopIntent::Restart
        );
    }

    #[tokio::test]
    async fn process_stop_continues_cleanup_after_log_join_error() {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg("exit 0").process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let observed = child.wait().await.unwrap();
        assert!(observed.success());

        let runtime_dir = std::env::temp_dir().join(format!(
            "pp-compat-stop-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&runtime_dir).unwrap();
        let socket = runtime_dir.join("compat.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let connections = Arc::new(super::Connections::new());
        let endpoint = Arc::new(super::Endpoint {
            socket: socket.clone(),
            generation: "stop-regression".to_owned(),
            key: [0; 32],
            connections: connections.clone(),
        });

        let first_log = tokio::spawn(std::future::pending::<()>());
        first_log.abort();
        let later_attempted = Arc::new(AtomicBool::new(false));
        let later_release = tokio_util::sync::CancellationToken::new();
        let (later_started, started) = tokio::sync::oneshot::channel();
        let later_log = {
            let attempted = later_attempted.clone();
            let release = later_release.clone();
            tokio::spawn(async move {
                let _attempt = AttemptOnDrop(attempted);
                let _ = later_started.send(());
                release.cancelled().await;
            })
        };
        started.await.unwrap();

        let process = super::Process {
            child,
            pid,
            stdin: None,
            endpoint,
            logs: vec![first_log, later_log],
        };
        let active = tokio_util::sync::CancellationToken::new();
        let error = process
            .stop(Some(observed), &active, true)
            .await
            .unwrap_err();

        let error_message = error.to_string();
        let later_cleanup_attempted = later_attempted.load(Ordering::SeqCst);
        let socket_absent = !socket.exists();
        let process_group_absent = unsafe { libc::kill(-(pid as i32), 0) } < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        let connections_closed = *connections.closed.lock().unwrap();

        later_release.cancel();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !later_attempted.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(listener);
        if socket.exists() {
            std::fs::remove_file(&socket).unwrap();
        }
        std::fs::remove_dir(&runtime_dir).unwrap();

        assert!(error_message.contains("Log reader join failed"));
        assert!(later_cleanup_attempted);
        assert!(socket_absent);
        assert!(process_group_absent);
        assert!(connections_closed);
    }

    #[test]
    fn planned_shutdown_accepts_term_or_forced_group_exit() {
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(0)),
                super::StopIntent::PlannedShutdown,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(libc::SIGKILL)),
                super::StopIntent::PlannedShutdown,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(libc::SIGTERM)),
                super::StopIntent::PlannedShutdown,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(libc::SIGABRT)),
                super::StopIntent::PlannedShutdown,
            )
            .is_err()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(7 << 8)),
                super::StopIntent::PlannedShutdown,
            )
            .is_err()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGKILL,
                )),
                super::StopIntent::PlannedShutdown,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGTERM,
                )),
                super::StopIntent::PlannedShutdown,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGABRT,
                )),
                super::StopIntent::PlannedShutdown,
            )
            .is_err()
        );
    }

    #[test]
    fn ticket_t_3_drain_planned_shutdown_accepts_sigterm_at_the_grace_boundary() {
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGTERM,
                )),
                super::StopIntent::PlannedShutdown,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGABRT,
                )),
                super::StopIntent::PlannedShutdown,
            )
            .is_err()
        );
    }

    #[test]
    fn unplanned_observed_exit_preserves_recovery_path() {
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::Observed(std::process::ExitStatus::from_raw(libc::SIGABRT)),
                super::StopIntent::Restart,
            )
            .is_ok()
        );
        assert!(
            super::validate_stop_outcome(
                super::StopOutcome::ForcedAfterTimeout(std::process::ExitStatus::from_raw(
                    libc::SIGKILL,
                )),
                super::StopIntent::Restart,
            )
            .is_ok()
        );
    }

    #[test]
    fn production_crash_guard_window() {
        assert_eq!(
            super::SupervisorConfig::default().crash_guard_window,
            std::time::Duration::from_secs(120)
        );
    }

    struct OwnedStop {
        intent: super::StopIntent,
        elapsed: Duration,
        rejected: bool,
        group_absent: bool,
    }

    async fn stop_owned_child(child: tokio::process::Child, eof_watchdog: bool) -> OwnedStop {
        stop_owned_child_at(child, eof_watchdog, None).await
    }

    async fn stop_owned_child_at(
        mut child: tokio::process::Child,
        eof_watchdog: bool,
        cancel_after: Option<Duration>,
    ) -> OwnedStop {
        let pid = child.id().unwrap();
        let stdin = child.stdin.take();
        let runtime_dir = std::env::temp_dir().join(format!(
            "pp-t3-stop-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&runtime_dir).unwrap();
        let socket = runtime_dir.join("compat.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let connections = Arc::new(super::Connections::new());
        let endpoint = Arc::new(super::Endpoint {
            socket: socket.clone(),
            generation: "t3-drain".to_owned(),
            key: [0; 32],
            connections: connections.clone(),
        });
        let process = super::Process {
            child,
            pid,
            stdin,
            endpoint,
            logs: Vec::new(),
        };
        let cancelled = tokio_util::sync::CancellationToken::new();
        if let Some(delay) = cancel_after {
            let later = cancelled.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                later.cancel();
            });
        } else {
            cancelled.cancel();
        }
        let started = std::time::Instant::now();
        let intent = process.stop(None, &cancelled, eof_watchdog).await.unwrap();
        let rejected = connections.admit().is_err();
        let group_absent = unsafe { libc::kill(-(pid as i32), 0) } < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        drop(listener);
        let _ = std::fs::remove_dir_all(&runtime_dir);
        OwnedStop {
            intent,
            elapsed: started.elapsed(),
            rejected,
            group_absent,
        }
    }

    #[tokio::test]
    async fn ticket_t_3_drain_process_stop_sigterms_cooperative_child() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("trap 'exit 0' TERM; sleep 30")
            .stdin(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let child = command.spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let outcome = stop_owned_child(child, true).await;
        assert_eq!(outcome.intent, super::StopIntent::PlannedShutdown);
        assert!(
            outcome.elapsed < Duration::from_secs(3),
            "{:?}",
            outcome.elapsed
        );
        assert!(outcome.rejected);
        assert!(outcome.group_absent);
    }

    #[tokio::test]
    async fn ticket_t_3_drain_restart_cleanup_switches_to_sigterm_when_shutdown_starts() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("trap 'exit 0' TERM; sleep 30")
            .stdin(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let child = command.spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let outcome = stop_owned_child_at(child, false, Some(Duration::from_millis(100))).await;
        assert_eq!(outcome.intent, super::StopIntent::PlannedShutdown);
        assert!(
            outcome.elapsed < Duration::from_secs(3),
            "{:?}",
            outcome.elapsed
        );
        assert!(outcome.rejected);
        assert!(outcome.group_absent);
    }

    #[tokio::test]
    async fn ticket_t_3_drain_process_stop_force_kills_after_sigterm_grace() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("trap '' TERM; while true; do sleep 30; done")
            .stdin(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let child = command.spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let outcome = stop_owned_child(child, false).await;
        assert_eq!(outcome.intent, super::StopIntent::PlannedShutdown);
        assert!(
            outcome.elapsed >= Duration::from_secs(10),
            "{:?}",
            outcome.elapsed
        );
        assert!(
            outcome.elapsed < Duration::from_secs(13),
            "{:?}",
            outcome.elapsed
        );
        assert!(outcome.rejected);
        assert!(outcome.group_absent);
    }

    #[test]
    fn ticket_t_3_drain_disarmed_restarts_block_before_cancel() {
        let cancelled = tokio_util::sync::CancellationToken::new();
        let disarmed = tokio_util::sync::CancellationToken::new();
        assert!(!super::restarts_blocked(&cancelled, &disarmed));
        disarmed.cancel();
        assert!(super::restarts_blocked(&cancelled, &disarmed));
        assert!(!cancelled.is_cancelled());
        assert!(!super::startup_probe_publishes(true, true));
        assert!(super::startup_probe_publishes(false, true));
        assert!(!super::startup_probe_publishes(false, false));
    }

    #[tokio::test]
    async fn ticket_t_3_drain_ready_probe_returns_when_shutdown_cancels() {
        let dir = std::env::temp_dir().join(format!("pp-t3-ready-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let socket = dir.join("compat.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let held = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ = accepted_tx.send(());
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(stream);
        });
        let endpoint = super::Endpoint {
            socket,
            generation: "t3-drain".to_owned(),
            key: [0; 32],
            connections: Arc::new(super::Connections::new()),
        };
        let bundle = super::Bundle {
            node: std::path::PathBuf::from("node"),
            entry: std::path::PathBuf::from("entry"),
            web_root: dir.clone(),
            runtime_version: "0".to_owned(),
            commit: "0".to_owned(),
        };
        let cancelled = tokio_util::sync::CancellationToken::new();
        let probe_cancel = cancelled.clone();
        let probe = tokio::spawn(async move { endpoint.ready(&bundle, &probe_cancel).await });
        accepted_rx.await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = std::time::Instant::now();
        cancelled.cancel();
        let ready = probe.await.unwrap();
        let elapsed = started.elapsed();
        assert!(!ready);
        assert!(
            elapsed < Duration::from_millis(500),
            "health probe kept running after cancel: {elapsed:?}"
        );
        held.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ticket_t_3_drain_reaps_group_when_leader_wait_fails() {
        let dir = std::env::temp_dir().join(format!("pp-t3-reap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let pidfile = dir.join("grand.pid");
        let script = format!(
            "trap '' TERM; sh -c 'trap \"\" TERM; while true; do sleep 300; done' & echo $! > '{}'; wait",
            pidfile.display()
        );
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let grand = wait_for_live_pid(&pidfile).await;
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        let collected = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), 0) };
        assert_eq!(collected, pid as i32);
        let started = std::time::Instant::now();
        let result = super::drain::drive_shutdown_group(
            &mut child,
            pid,
            false,
            Duration::from_secs(2),
            None,
        )
        .await;
        assert!(
            result.is_err(),
            "leader wait was expected to fail: {result:?}"
        );
        assert!(
            !super::drain::process_alive(grand),
            "grandchild survived a failed leader wait"
        );
        assert!(super::drain::process_group_absent(pid));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn wait_for_live_pid(path: &std::path::Path) -> u32 {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(text) = std::fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse::<u32>()
                && super::drain::process_alive(pid)
            {
                return pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild was not started"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn product_backoff_schedule() {
        assert_eq!(
            (0..8)
                .map(|n| super::backoff(n).as_millis())
                .collect::<Vec<_>>(),
            vec![500, 1000, 2000, 4000, 8000, 30000, 30000, 30000]
        );
    }
}
