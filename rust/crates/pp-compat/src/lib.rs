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
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    Starting,
    Ready { generation: String, pid: u32 },
    Backoff { attempt: usize },
    Guarded,
    Stopped,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadinessFailure {
    Transport,
    Timeout,
    HealthDenied,
    Body,
    Json,
    ReleaseMismatch,
}

impl ReadinessFailure {
    fn event(self) -> &'static str {
        match self {
            Self::Transport => "compat_readiness_transport",
            Self::Timeout => "compat_readiness_timeout",
            Self::HealthDenied => "compat_readiness_health_denied",
            Self::Body => "compat_readiness_body",
            Self::Json => "compat_readiness_json",
            Self::ReleaseMismatch => "compat_readiness_release_mismatch",
        }
    }
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

    async fn readiness_probe(&self, bundle: &Bundle) -> Result<(), ReadinessFailure> {
        let response = self
            .forward(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .map_err(|_| ReadinessFailure::Transport)?,
            )
            .await
            .map_err(|_| ReadinessFailure::Transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ReadinessFailure::HealthDenied);
        }
        let bytes = http_body_util::Limited::new(response.into_body(), 65536)
            .collect()
            .await
            .map_err(|_| ReadinessFailure::Body)?
            .to_bytes();
        validate_health_response(status, &bytes, bundle)
    }

    async fn ready_with_timeout(
        &self,
        bundle: &Bundle,
        duration: Duration,
    ) -> Result<(), ReadinessFailure> {
        match tokio::time::timeout(duration, self.readiness_probe(bundle)).await {
            Ok(result) => result,
            Err(_) => Err(ReadinessFailure::Timeout),
        }
    }

    async fn ready(&self, bundle: &Bundle) -> Result<(), ReadinessFailure> {
        self.ready_with_timeout(bundle, Duration::from_secs(2))
            .await
    }
}

fn validate_health_response(
    status: axum::http::StatusCode,
    bytes: &[u8],
    bundle: &Bundle,
) -> Result<(), ReadinessFailure> {
    if !status.is_success() {
        return Err(ReadinessFailure::HealthDenied);
    }
    let health: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ReadinessFailure::Json)?;
    if health["ok"] != true
        || health["version"] != bundle.runtime_version
        || health["release"]["commit"] != bundle.commit
    {
        return Err(ReadinessFailure::ReleaseMismatch);
    }
    Ok(())
}

#[derive(Clone)]
pub struct CompatHandle {
    endpoint: watch::Receiver<Option<Arc<Endpoint>>>,
    pub status: watch::Receiver<Status>,
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
        StopOutcome::ForcedAfterTimeout(status) => {
            bail!("Compatibility child required parent-forced termination: {status}")
        }
        StopOutcome::Observed(_) if matches!(intent, StopIntent::Restart) => Ok(()),
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
            .env("PP_COMMIT", release::manifest()?.commit)
            .env("PRINT_PARTNER_UPDATE_CHECK", "0")
            .env("AI_ENABLED", "0")
            .env("HOST", "127.0.0.1")
            .env("DEPLOY_MODE", "self-host")
            .env_remove("DATABASE_URL")
            .env_remove("MULTI_USER")
            .env_remove("PRINT_PARTNER_DATA_DIR")
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

impl Supervisor {
    pub fn start(spec: SpawnSpec) -> Result<Self> {
        let logs = logs::Logs::open(spec.data_dir.join("logs"))?;
        let (endpoints, endpoint) = watch::channel(None);
        let (states, status) = watch::channel(Status::Starting);
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
                logs.event("compat_starting", 30);
                let process = Process::spawn(&spec, &logs).await;
                if let Ok(mut process) = process {
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
                    let mut ready = false;
                    let mut last_readiness_failure = None;
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
                        match process.endpoint.ready(&spec.bundle).await {
                            Ok(()) => {
                                ready = true;
                                break;
                            }
                            Err(failure) => last_readiness_failure = Some(failure),
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
                                    if process.endpoint.ready(&spec.bundle).await.is_ok() { failures = 0; } else { failures += 1; }
                                    if failures >= 3 { break; }
                                }
                            }
                        }
                    } else if let Some(failure) = last_readiness_failure {
                        logs.event(failure.event(), 40);
                    }
                    endpoints.send_replace(None);
                    let stop_intent = process.stop(observed_exit, &cancelled).await?;
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
                    .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(120))
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
        path::PathBuf,
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

    fn test_bundle() -> super::Bundle {
        super::Bundle {
            node: PathBuf::from("node"),
            entry: PathBuf::from("desktop.js"),
            web_root: PathBuf::from("web"),
            runtime_version: "1.2.3-web".to_owned(),
            commit: "test-commit".to_owned(),
        }
    }

    #[test]
    fn health_response_validation_preserves_fixed_failure_categories() {
        let bundle = test_bundle();
        assert_eq!(
            super::validate_health_response(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                br#"{"ok":true}"#,
                &bundle,
            ),
            Err(super::ReadinessFailure::HealthDenied)
        );
        assert_eq!(
            super::validate_health_response(axum::http::StatusCode::OK, b"not-json", &bundle),
            Err(super::ReadinessFailure::Json)
        );
        assert_eq!(
            super::validate_health_response(
                axum::http::StatusCode::OK,
                br#"{"ok":true,"version":"wrong","release":{"commit":"test-commit"}}"#,
                &bundle,
            ),
            Err(super::ReadinessFailure::ReleaseMismatch)
        );
        assert_eq!(
            super::validate_health_response(
                axum::http::StatusCode::OK,
                br#"{"ok":true,"version":"1.2.3-web","release":{"commit":"test-commit"}}"#,
                &bundle,
            ),
            Ok(())
        );
    }

    #[tokio::test]
    async fn readiness_probe_separates_transport_from_timeout() {
        let root = std::env::temp_dir().join(format!(
            "pp-compat-readiness-categories-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&root).unwrap();
        let bundle = test_bundle();
        let missing = super::Endpoint {
            socket: root.join("missing.sock"),
            generation: "test-generation".to_owned(),
            key: [0; 32],
            connections: std::sync::Arc::new(super::Connections::new()),
        };
        assert_eq!(
            missing
                .ready_with_timeout(&bundle, Duration::from_millis(20))
                .await,
            Err(super::ReadinessFailure::Transport)
        );

        let socket = root.join("waiting.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let waiting = super::Endpoint {
            socket,
            generation: "test-generation".to_owned(),
            key: [0; 32],
            connections: std::sync::Arc::new(super::Connections::new()),
        };
        assert_eq!(
            waiting
                .ready_with_timeout(&bundle, Duration::from_millis(20))
                .await,
            Err(super::ReadinessFailure::Timeout)
        );
        server.abort();
        let _ = server.await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readiness_failure_events_are_fixed() {
        assert_eq!(
            [
                super::ReadinessFailure::Transport,
                super::ReadinessFailure::Timeout,
                super::ReadinessFailure::HealthDenied,
                super::ReadinessFailure::Body,
                super::ReadinessFailure::Json,
                super::ReadinessFailure::ReleaseMismatch,
            ]
            .map(super::ReadinessFailure::event),
            [
                "compat_readiness_transport",
                "compat_readiness_timeout",
                "compat_readiness_health_denied",
                "compat_readiness_body",
                "compat_readiness_json",
                "compat_readiness_release_mismatch",
            ]
        );
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
            .is_err()
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
