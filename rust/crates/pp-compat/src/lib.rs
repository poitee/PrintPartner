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
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    process::{Child, ChildStdin, Command},
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

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
        let stream = UnixStream::connect(&self.socket)
            .await
            .context("Compatibility socket unavailable")?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        let response = sender
            .send_request(request)
            .await
            .context("Compatibility dispatch outcome unknown")?;
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

impl Process {
    async fn spawn(spec: &SpawnSpec, capture: &logs::Logs) -> Result<Self> {
        release::verify_backend(&spec.bundle)?;
        let generation = hex::encode(rand::random::<[u8; 16]>());
        let key = rand::random::<[u8; 32]>();
        let socket = spec.runtime_dir.join(format!("{}.sock", &generation[..12]));
        let endpoint = Arc::new(Endpoint {
            socket,
            generation,
            key,
        });
        let mut command = Command::new(&spec.bundle.node);
        command
            .arg(&spec.bundle.entry)
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

    async fn stop(mut self) -> Result<()> {
        self.stdin.take();
        let pid = Some(self.pid);
        let waited = match tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await {
            Ok(result) => result,
            Err(_) => {
                if let Some(pid) = pid {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                self.child
                    .start_kill()
                    .context("Child termination failed")?;
                tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                    .await
                    .context("Child reap timed out")?
            }
        };
        waited.context("Child reap failed")?;
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
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
            .context("Process group still present")?;
        }
        for mut log in self.logs {
            match tokio::time::timeout(Duration::from_secs(1), &mut log).await {
                Ok(result) => result.context("Log reader join failed")?,
                Err(_) => {
                    log.abort();
                    let _ = log.await;
                    bail!("Log reader join timed out");
                }
            }
        }
        match tokio::fs::remove_file(&self.endpoint.socket).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => bail!("Compatibility socket cleanup failed"),
        }
        Ok(())
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
                    while tokio::time::Instant::now() < deadline {
                        if cancelled.is_cancelled()
                            || process.child.try_wait().ok().flatten().is_some()
                        {
                            break;
                        }
                        if process.endpoint.ready(&spec.bundle).await {
                            ready = true;
                            break;
                        }
                        tokio::select! { _ = cancelled.cancelled() => break, _ = tokio::time::sleep(Duration::from_millis(250)) => {} }
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
                                _ = cancelled.cancelled() => break,
                                _ = process.child.wait() => break,
                                _ = tokio::time::sleep(Duration::from_secs(10)) => {
                                    if process.endpoint.ready(&spec.bundle).await { failures = 0; } else { failures += 1; }
                                    if failures >= 3 { break; }
                                }
                            }
                        }
                        // Preserve escalation for repeated crashes, but forget old failures
                        // once the child has stayed ready for the crash-guard window.
                        if ready_since.elapsed() >= Duration::from_secs(120) {
                            attempt = 0;
                        }
                    }
                    endpoints.send_replace(None);
                    if let Err(error) = process.stop().await {
                        states.send_replace(Status::Stopped);
                        return Err(error);
                    }
                    logs.event("compat_reaped", 30);
                }
                if cancelled.is_cancelled() {
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
