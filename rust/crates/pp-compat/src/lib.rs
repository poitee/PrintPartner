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

/// Hash the measured release before a child exists. This is not the probe window.
/// `verify_backend` for this desktop inventory (41840 dependency files, Node
/// v24.21.0) measured 31.1s. Sixty seconds is under twice that reading: a slower
/// hash fails closed instead of consuming the 30s child probe window.
pub const RELEASE_PREFLIGHT: Duration = Duration::from_secs(60);
/// Health probes after the child process exists. A missing socket or a
/// commit/version mismatch still fails this window; it is not extended for hashing.
pub const CHILD_READINESS: Duration = Duration::from_secs(30);
/// Core watches two seconds past [`CHILD_READINESS`] so the supervisor can
/// finish its own deadline instead of being cancelled on the last probe.
pub const READINESS_OBSERVATION: Duration = Duration::from_secs(32);
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
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

    async fn ready(&self, bundle: &Bundle) -> bool {
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
        matches!(
            tokio::time::timeout(Duration::from_secs(2), probe).await,
            Ok(Ok(()))
        )
    }
}

#[derive(Clone)]
pub struct CompatHandle {
    endpoint: watch::Receiver<Option<Arc<Endpoint>>>,
    pub status: watch::Receiver<Status>,
    /// Flips true only after release verification and `record_child`, when the
    /// 30s probe window starts. Stays false while the inventory is still hashing.
    pub child_readiness_started: watch::Receiver<bool>,
    recover: mpsc::Sender<()>,
}

impl CompatHandle {
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
    task: Option<JoinHandle<Result<()>>>,
}

struct Process {
    child: Child,
    pid: u32,
    stdin: Option<ChildStdin>,
    endpoint: Arc<Endpoint>,
    logs: Vec<JoinHandle<()>>,
    // Last field: Drop runs `child` (kill_on_drop) before this write end closes.
    #[allow(dead_code)]
    parent_death: OwnedFd,
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
    match outcome {
        StopOutcome::Observed(_) | StopOutcome::ForcedAfterTimeout(_)
            if matches!(intent, StopIntent::Restart) =>
        {
            Ok(())
        }
        StopOutcome::ForcedAfterTimeout(status) => {
            bail!("Compatibility child required parent-forced termination: {status}")
        }
        StopOutcome::Observed(status)
            if status.success() || status.signal() == Some(libc::SIGKILL) =>
        {
            Ok(())
        }
        StopOutcome::Observed(status) => {
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

fn parent_death_pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    let created = unsafe {
        #[cfg(target_os = "linux")]
        {
            libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC)
        }
        #[cfg(not(target_os = "linux"))]
        {
            libc::pipe(fds.as_mut_ptr())
        }
    };
    if created != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(not(target_os = "linux"))]
    unsafe {
        for fd in fds {
            if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) != 0 {
                let error = std::io::Error::last_os_error();
                let _ = libc::close(fds[0]);
                let _ = libc::close(fds[1]);
                return Err(error);
            }
        }
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

#[cfg(target_os = "linux")]
unsafe fn parent_errno() -> libc::c_int {
    unsafe { *libc::__errno_location() }
}

#[cfg(target_os = "macos")]
unsafe fn parent_errno() -> libc::c_int {
    unsafe { *libc::__error() }
}

fn close_inherited_except(keep: RawFd) {
    unsafe {
        #[cfg(target_os = "linux")]
        {
            if keep > 0 {
                libc::close_range(0, (keep as libc::c_uint) - 1, 0);
            }
            libc::close_range(
                (keep as libc::c_uint).saturating_add(1),
                libc::c_uint::MAX,
                0,
            );
        }
        #[cfg(not(target_os = "linux"))]
        {
            let mut limit = libc::rlimit {
                rlim_cur: 256,
                rlim_max: 256,
            };
            let _ = libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit);
            let max = if limit.rlim_cur == libc::RLIM_INFINITY {
                65536
            } else {
                (limit.rlim_cur as u64).min(65536) as libc::c_int
            };
            let mut fd = 0;
            while fd < max {
                if fd != keep {
                    libc::close(fd);
                }
                fd += 1;
            }
        }
    }
}

fn configure_child(command: &mut Command, lease_fd: RawFd) -> std::io::Result<(OwnedFd, OwnedFd)> {
    command.process_group(0);
    let (read_end, write_end) = parent_death_pipe()?;
    let read_fd = read_end.as_raw_fd();
    let write_fd = write_end.as_raw_fd();
    #[cfg(target_os = "linux")]
    let parent = std::process::id() as libc::pid_t;
    unsafe {
        command.pre_exec(move || {
            // Fork the watcher before PDEATHSIG so it does not inherit that signal.
            // It stays in Node's group and SIGKILLs only this pid, after EOF, and
            // only while this pid is still its parent (a reused pid is left alone).
            let node_pid = libc::getpid();
            let watcher = libc::fork();
            if watcher < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if watcher == 0 {
                // Drop every inherited descriptor except the death pipe. The
                // spawn handshake pipe must not stay open, or the parent blocks
                // in Command::spawn forever.
                close_inherited_except(read_fd);
                let mut byte = [0u8; 1];
                loop {
                    let read = libc::read(read_fd, byte.as_mut_ptr().cast(), 1);
                    if read == 0 {
                        break;
                    }
                    if read < 0 {
                        #[cfg(any(target_os = "linux", target_os = "macos"))]
                        if parent_errno() == libc::EINTR {
                            continue;
                        }
                        libc::_exit(1);
                    }
                }
                if libc::getppid() == node_pid {
                    libc::kill(node_pid, libc::SIGKILL);
                }
                libc::_exit(0);
            }
            libc::close(read_fd);
            libc::close(write_fd);
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
                }
            }
            if libc::dup2(lease_fd, 198) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok((read_end, write_end))
}

impl Process {
    async fn spawn(spec: &SpawnSpec, capture: &logs::Logs) -> Result<Self> {
        // Verify before spawn and before the ownership marker. A slow hash must
        // fail this budget instead of consuming the 30s probe window.
        let bundle = spec.bundle.clone();
        let verified = tokio::time::timeout(
            RELEASE_PREFLIGHT,
            tokio::task::spawn_blocking(move || release::verify_backend(&bundle)),
        )
        .await
        .context("Release verification exceeded its budget")?;
        verified
            .context("Release verification stopped")?
            .context("Release verification failed")?;
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
        let (parent_read, parent_death) =
            configure_child(&mut command, spec.lease_file.as_raw_fd())
                .context("Could not arm parent-death watcher")?;
        let mut child = command.spawn().context("Could not start bundled Node")?;
        drop(parent_read);
        // Persist ownership before the child can receive setup or open storage.
        if let Err(error) =
            (spec.record_child)(&spec.data_dir, child.id().context("Missing child PID")?)
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error.context("Could not record child ownership"));
        }
        let mut stdin = child.stdin.take().context("Missing parent-liveness pipe")?;
        let setup = serde_json::json!({ "version":1, "data_dir":spec.data_dir, "socket_path":endpoint.socket,
            "generation":endpoint.generation, "key":hex::encode(key), "lease":spec.lease, "parent_pid":std::process::id(), "port":spec.port });
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
            parent_death,
        })
    }

    async fn stop(
        mut self,
        observed: Option<ExitStatus>,
        cancelled: &CancellationToken,
    ) -> Result<StopIntent> {
        self.endpoint.connections.close();
        self.stdin.take();
        let pid = self.pid;
        let mut errors = CleanupErrors::default();
        let mut outcome = observed.map(StopOutcome::Observed);
        if outcome.is_none() {
            match tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await {
                Ok(result) => {
                    if let Some(status) = errors.capture(result.context("Child reap failed")) {
                        outcome = Some(StopOutcome::Observed(status));
                    }
                }
                Err(_) => {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                    errors.capture(self.child.start_kill().context("Child termination failed"));
                    match tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await {
                        Ok(result) => {
                            if let Some(status) =
                                errors.capture(result.context("Child reap failed"))
                            {
                                outcome = Some(StopOutcome::ForcedAfterTimeout(status));
                            }
                        }
                        Err(error) => {
                            errors.capture::<()>(Err(error).context("Child reap timed out"));
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
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            crash_guard_window: Duration::from_secs(120),
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
        let (child_readiness, child_readiness_started) = watch::channel(false);
        let (recover, mut recovery) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let task = tokio::spawn(async move {
            let mut crashes = std::collections::VecDeque::new();
            let mut attempt = 0;
            loop {
                if cancelled.is_cancelled() {
                    break;
                }
                states.send_replace(Status::Starting);
                child_readiness.send_replace(false);
                logs.event("compat_starting", 30);
                let process = Process::spawn(&spec, &logs).await;
                if let Ok(mut process) = process {
                    // Hash and ownership record are done. Probes use the 30s child
                    // budget from this edge, not from the start of verification.
                    child_readiness.send_replace(true);
                    let deadline = tokio::time::Instant::now() + CHILD_READINESS;
                    let mut ready = false;
                    let mut observed_exit = None;
                    while tokio::time::Instant::now() < deadline {
                        if cancelled.is_cancelled() {
                            break;
                        }
                        if let Some(status) =
                            process.child.try_wait().context("Child status failed")?
                        {
                            observed_exit = Some(status);
                            break;
                        }
                        if process.endpoint.ready(&spec.bundle).await {
                            ready = true;
                            break;
                        }
                        tokio::select! {
                            biased;
                            _ = cancelled.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                        }
                    }
                    if ready {
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
                                    if process.endpoint.ready(&spec.bundle).await { failures = 0; } else { failures += 1; }
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
                    let stop_intent = match process.stop(observed_exit, &cancelled).await {
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
                child_readiness_started,
                recover,
            },
            stop,
            task: Some(task),
        })
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

    fn node_binary() -> std::path::PathBuf {
        let configured = std::env::var_os("PP_TEST_NODE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/usr/bin/node"));
        if configured.is_absolute() || configured.components().count() > 1 {
            return configured;
        }
        let Some(paths) = std::env::var_os("PATH") else {
            return configured;
        };
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join(&configured);
            if candidate.is_file() {
                return candidate;
            }
        }
        configured
    }

    fn pid_is_gone(pid: i32) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    /// `kill(pid, 0)` is true for a zombie. A preserved peer has to still be
    /// running: `try_wait` has not reaped it, and Linux does not report `Z`.
    fn peer_is_running(peer: &mut std::process::Child) -> bool {
        let state = linux_proc_state(peer.id());
        let unreaped = peer.try_wait().unwrap().is_none();
        unreaped && state.is_none_or(|state| state != 'Z' && state != 'X')
    }

    fn linux_proc_state(pid: u32) -> Option<char> {
        #[cfg(target_os = "linux")]
        {
            let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let close = text.rfind(')')?;
            return text[close + 1..].split_whitespace().next()?.chars().next();
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = pid;
            None
        }
    }

    #[tokio::test]
    async fn parent_death_fixture() {
        let Some(pidfile) = std::env::var_os("PP_COMPAT_DEATH_PIDFILE") else {
            return;
        };
        let lease = std::fs::File::open("/dev/null").unwrap();
        let node = node_binary();
        let mut command = tokio::process::Command::new(&node);
        command
            .arg("-e")
            .arg("setInterval(() => {}, 1e9)")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let (parent_read, parent_death) =
            super::configure_child(&mut command, std::os::fd::AsRawFd::as_raw_fd(&lease)).unwrap();
        let mut child = command.spawn().unwrap();
        drop(parent_read);
        // Process death, not this function returning, closes the write end.
        std::mem::forget(parent_death);
        let pidfile = std::path::PathBuf::from(pidfile);
        let temporary = pidfile.with_extension("tmp");
        std::fs::write(&temporary, child.id().unwrap().to_string()).unwrap();
        std::fs::rename(temporary, pidfile).unwrap();
        child.wait().await.unwrap();
    }

    #[test]
    fn readiness_budgets_stay_split() {
        assert_eq!(super::CHILD_READINESS, Duration::from_secs(30));
        assert_eq!(
            super::READINESS_OBSERVATION,
            super::CHILD_READINESS + Duration::from_secs(2)
        );
        assert!(super::RELEASE_PREFLIGHT > super::CHILD_READINESS);
        assert_ne!(super::RELEASE_PREFLIGHT, super::READINESS_OBSERVATION);
    }

    #[test]
    fn zombie_peer_is_not_running() {
        let mut peer = std::process::Command::new("true").spawn().unwrap();
        let pid = peer.id() as i32;
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut saw_zombie = false;
        while std::time::Instant::now() < deadline {
            let state = linux_proc_state(peer.id());
            let kill_sees_it = unsafe { libc::kill(pid, 0) } == 0;
            if state == Some('Z') && kill_sees_it {
                saw_zombie = true;
                assert!(!peer_is_running(&mut peer));
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            saw_zombie,
            "expected kill(pid, 0) to see a zombie before try_wait reaped it"
        );
    }

    #[test]
    fn separate_group_child_dies_with_force_killed_parent() {
        use std::os::unix::process::CommandExt;
        let node = node_binary();
        let pidfile = std::env::temp_dir().join(format!(
            "pp-compat-death-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut owner = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["parent_death_fixture", "--nocapture"])
            .env("PP_COMPAT_DEATH_PIDFILE", &pidfile)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !pidfile.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !pidfile.exists() {
            let _ = owner.kill();
            let output = owner.wait_with_output().unwrap();
            panic!(
                "node fixture never spawned: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().parse().unwrap();
        let group = unsafe { libc::getpgid(pid) };
        assert!(node.is_file(), "node binary missing: {}", node.display());
        #[cfg(target_os = "linux")]
        {
            let exe = std::fs::read_link(format!("/proc/{pid}/exe")).unwrap();
            assert_eq!(
                std::fs::canonicalize(&exe).unwrap_or(exe),
                std::fs::canonicalize(&node).unwrap(),
                "death subject must be the real node binary"
            );
        }
        // The peer only keeps the group from being orphaned. A targeted kill of
        // the stopped Node must leave this peer alive.
        let mut peer = std::process::Command::new("sleep")
            .arg("600")
            .process_group(pid)
            .spawn()
            .unwrap();
        let peer_pid = peer.id() as i32;
        assert_eq!(unsafe { libc::getpgid(peer_pid) }, pid);
        assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let state = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&state.stdout).contains('T') {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "node did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            libc::kill(-(owner.id() as i32), libc::SIGKILL);
        }
        owner.wait().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !pid_is_gone(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let node_gone = pid_is_gone(pid);
        let peer_alive = peer_is_running(&mut peer);
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        let _ = peer.kill();
        let _ = peer.wait();
        std::fs::remove_file(pidfile).unwrap();
        assert_eq!(
            group, pid,
            "fixture must reproduce Node's separate process group"
        );
        assert!(node_gone, "stopped Node outlived its force-killed parent");
        assert!(peer_alive, "group peer was killed with the Node pid");
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

        let (parent_death_read, parent_death) = super::parent_death_pipe().unwrap();
        drop(parent_death_read);
        let process = super::Process {
            child,
            pid,
            stdin: None,
            endpoint,
            logs: vec![first_log, later_log],
            parent_death,
        };
        let active = tokio_util::sync::CancellationToken::new();
        let error = process.stop(Some(observed), &active).await.unwrap_err();

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
    fn planned_shutdown_accepts_only_observed_success_or_server_sigkill() {
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
