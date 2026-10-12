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
    io::Write,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    pin::Pin,
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex},
    task::Poll,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncWriteExt, ReadBuf},
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
    // Write end of the pipe the parent-death watcher blocks on. Closing it,
    // including when this process is killed, is what wakes the watcher.
    parent_death: Option<OwnedFd>,
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

struct ParentDeathGuard {
    write: OwnedFd,
    read: Option<OwnedFd>,
}

impl ParentDeathGuard {
    fn keep_write(mut self) -> OwnedFd {
        self.read.take();
        self.write
    }
}

fn set_cloexec(fd: std::os::fd::RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn write_pid(pid: libc::pid_t, storage: &mut [u8; 16]) -> *const libc::c_char {
    let mut number = pid as u32;
    let mut digits = [0u8; 16];
    let mut index = digits.len();
    if number == 0 {
        index -= 1;
        digits[index] = b'0';
    }
    while number > 0 {
        index -= 1;
        digits[index] = b'0' + (number % 10) as u8;
        number /= 10;
    }
    let length = digits.len() - index;
    storage[..length].copy_from_slice(&digits[index..]);
    storage[length] = 0;
    storage.as_ptr().cast()
}

unsafe fn close_fds_from(first: i32) {
    #[cfg(target_os = "linux")]
    unsafe {
        if libc::syscall(
            libc::SYS_close_range,
            first as libc::c_uint,
            libc::c_uint::MAX,
            0,
        ) == 0
        {
            return;
        }
    }
    let mut limit = libc::rlimit {
        rlim_cur: 4096,
        rlim_max: 4096,
    };
    let cap = 65536 as libc::rlim_t;
    let max = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 {
        std::cmp::min(limit.rlim_cur, cap) as i32
    } else {
        4096
    };
    let mut fd = first;
    while fd < max {
        unsafe { libc::close(fd) };
        fd += 1;
    }
}

/// The forked watcher still maps the server. exec a tiny shell so it does not
/// keep that memory or any inherited lease fd. Its parent is the Node pid, so
/// a reused pid is not this parent and is not signalled.
fn exec_parent_death_watcher(read_fd: i32, write_fd: i32, node_pid: libc::pid_t) -> ! {
    unsafe {
        #[cfg(target_os = "linux")]
        libc::prctl(libc::PR_SET_PDEATHSIG, 0);
        if read_fd != 0 && libc::dup2(read_fd, 0) < 0 {
            libc::_exit(127);
        }
        libc::close(write_fd);
        if read_fd != 0 {
            libc::close(read_fd);
        }
        close_fds_from(1);
        let mut pid_buf = [0u8; 16];
        let pid_arg = write_pid(node_pid, &mut pid_buf);
        let shell = b"/bin/sh\0";
        let flag = b"-c\0";
        let name = b"_\0";
        let script = b"target=$1\nwhile IFS= read -r _; do :; done\nset -- $(ps -o ppid= -p $$)\n[ \"$1\" = \"$target\" ] && kill -9 \"$target\"\n\0";
        let path = b"PATH=/bin:/usr/bin\0";
        let argv = [
            shell.as_ptr().cast::<libc::c_char>(),
            flag.as_ptr().cast::<libc::c_char>(),
            script.as_ptr().cast::<libc::c_char>(),
            name.as_ptr().cast::<libc::c_char>(),
            pid_arg,
            std::ptr::null(),
        ];
        let envp = [path.as_ptr().cast::<libc::c_char>(), std::ptr::null()];
        libc::execve(shell.as_ptr().cast(), argv.as_ptr(), envp.as_ptr());
        libc::_exit(127);
    }
}

fn arm_parent_death_watcher(command: &mut Command) -> std::io::Result<ParentDeathGuard> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    set_cloexec(read.as_raw_fd()).and_then(|_| set_cloexec(write.as_raw_fd()))?;
    let read_fd = read.as_raw_fd();
    let write_fd = write.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            let node_pid = libc::getpid();
            let watcher = libc::fork();
            if watcher < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if watcher == 0 {
                exec_parent_death_watcher(read_fd, write_fd, node_pid);
            }
            libc::close(read_fd);
            Ok(())
        });
    }
    Ok(ParentDeathGuard {
        write,
        read: Some(read),
    })
}

fn configure_child(
    command: &mut Command,
    lease_fd: std::os::fd::RawFd,
) -> std::io::Result<ParentDeathGuard> {
    command.process_group(0);
    // Arm before the lease dup. A stopped Node cannot observe stdin EOF, so a
    // separate watcher signals that pid only. A peer in the group is left alone.
    let guard = arm_parent_death_watcher(command)?;
    #[cfg(target_os = "linux")]
    let parent = std::process::id() as libc::pid_t;
    unsafe {
        command.pre_exec(move || {
            // Node has its own group for normal shutdown; tie it to the Rust owner too.
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
    Ok(guard)
}

const STARTUP_DIAGNOSTIC_LIMIT: u64 = 16 * 1024;
const STARTUP_DIAGNOSTIC_NAME: &str = "startup-diagnostic.txt";

fn startup_diagnostic_target() -> Option<PathBuf> {
    let value = std::env::var_os("PP_COMPAT_STARTUP_DIAGNOSTIC")?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn managed_component(name: &std::ffi::OsStr) -> bool {
    let Some(text) = name.to_str() else {
        return true;
    };
    matches!(
        text,
        "print-partner.db"
            | "print-partner.db-wal"
            | "print-partner.db-shm"
            | "print-partner.db-journal"
            | ".desktop.lock"
            | ".desktop-owner.json"
            | ".desktop-lease"
            | "owner.json"
    ) || text.ends_with(".sock")
}

fn path_allows_diagnostic(path: &Path) -> bool {
    path.components().all(|component| match component {
        std::path::Component::RootDir | std::path::Component::CurDir => true,
        std::path::Component::Normal(name) => !managed_component(name),
        _ => false,
    })
}

fn line_carries_setup_secret(line: &[u8]) -> bool {
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim();
    text.contains("\"lease\"")
        || text.contains("\"key\"")
        || text.contains("\"generation\"")
        || trimmed.starts_with("generation=")
        || trimmed.starts_with("generation:")
}

fn redact_diagnostic_line(line: &[u8]) -> Vec<u8> {
    if line_carries_setup_secret(line) {
        return b"[redacted]".to_vec();
    }
    if line.len() > 1024 {
        let mut short = line[..1024].to_vec();
        short.extend_from_slice(b"...[truncated]");
        return short;
    }
    line.to_vec()
}

struct HeldDiagnostic {
    file: std::fs::File,
    written: u64,
}

enum DiagnosticSlot {
    Closed,
    Refused,
    Open(HeldDiagnostic),
}

fn diagnostic_slot() -> &'static Mutex<DiagnosticSlot> {
    static SLOT: Mutex<DiagnosticSlot> = Mutex::new(DiagnosticSlot::Closed);
    &SLOT
}

fn diagnostic_roots() -> &'static Mutex<Vec<PathBuf>> {
    static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    &ROOTS
}

fn remember_diagnostic_roots(data_dir: &Path, runtime_dir: &Path) {
    let Ok(mut roots) = diagnostic_roots().lock() else {
        return;
    };
    roots.clear();
    roots.push(data_dir.to_path_buf());
    roots.push(runtime_dir.to_path_buf());
}

fn path_is_forbidden(path: &Path) -> bool {
    let Ok(roots) = diagnostic_roots().lock() else {
        return true;
    };
    roots
        .iter()
        .any(|root| path == root || path.starts_with(root))
}

fn directory_identity(fd: std::os::fd::RawFd) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/self/fd/{fd}")).ok()
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let mut buf = vec![0u8; 4096];
        let rc = unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|byte| *byte == 0).unwrap_or(buf.len());
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..end])))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = fd;
        None
    }
}

fn open_private_diagnostic(dir: &Path) -> Option<HeldDiagnostic> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    if !path_allows_diagnostic(dir) || path_is_forbidden(dir) {
        return None;
    }
    let meta = std::fs::symlink_metadata(dir).ok()?;
    if !meta.file_type().is_dir()
        || meta.file_type().is_symlink()
        || meta.permissions().mode() & 0o077 != 0
    {
        return None;
    }
    let bytes = dir.as_os_str().as_bytes();
    if bytes.contains(&0) {
        return None;
    }
    let c_dir = std::ffi::CString::new(bytes).ok()?;
    let dir_fd = unsafe {
        libc::open(
            c_dir.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if dir_fd < 0 {
        return None;
    }
    let dir_owned = unsafe { OwnedFd::from_raw_fd(dir_fd) };
    let identity = directory_identity(dir_owned.as_raw_fd())?;
    if path_is_forbidden(&identity) || !path_allows_diagnostic(&identity) {
        return None;
    }
    let name = std::ffi::CString::new(STARTUP_DIAGNOSTIC_NAME).ok()?;
    let file_fd = unsafe {
        libc::openat(
            dir_owned.as_raw_fd(),
            name.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if file_fd < 0 {
        return None;
    }
    Some(HeldDiagnostic {
        file: std::fs::File::from(unsafe { OwnedFd::from_raw_fd(file_fd) }),
        written: 0,
    })
}

fn write_held(held: &mut HeldDiagnostic, label: &str, bytes: &[u8]) {
    if held.written >= STARTUP_DIAGNOSTIC_LIMIT {
        return;
    }
    let mut record = format!("[{label}]\n").into_bytes();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        record.extend_from_slice(&redact_diagnostic_line(&bytes[start..index]));
        record.push(b'\n');
        start = index + 1;
    }
    if start < bytes.len() {
        record.extend_from_slice(&redact_diagnostic_line(&bytes[start..]));
        record.push(b'\n');
    }
    let room = (STARTUP_DIAGNOSTIC_LIMIT - held.written) as usize;
    let take = record.len().min(room);
    if held.file.write_all(&record[..take]).is_ok() {
        held.written += take as u64;
    }
}

fn note_startup_diagnostic(label: &str, bytes: &[u8]) {
    let Some(dir) = startup_diagnostic_target() else {
        return;
    };
    let Ok(mut slot) = diagnostic_slot().lock() else {
        return;
    };
    if matches!(*slot, DiagnosticSlot::Closed) {
        *slot = match open_private_diagnostic(&dir) {
            Some(held) => DiagnosticSlot::Open(held),
            None => DiagnosticSlot::Refused,
        };
    }
    let DiagnosticSlot::Open(held) = &mut *slot else {
        return;
    };
    write_held(held, label, bytes);
}

#[cfg(test)]
fn close_startup_diagnostic_slot() {
    if let Ok(mut slot) = diagnostic_slot().lock() {
        *slot = DiagnosticSlot::Closed;
    }
}

#[cfg(test)]
fn reset_startup_diagnostic() {
    close_startup_diagnostic_slot();
    if let Ok(mut roots) = diagnostic_roots().lock() {
        roots.clear();
    }
}

#[cfg(test)]
fn forbid_diagnostic_roots(paths: &[PathBuf]) {
    if let Ok(mut roots) = diagnostic_roots().lock() {
        *roots = paths.to_vec();
    }
}

struct DiagnosticCopy<R> {
    inner: R,
    pending: Vec<u8>,
    label: &'static str,
}

impl<R> DiagnosticCopy<R> {
    fn new(inner: R, label: &'static str) -> Self {
        Self {
            inner,
            pending: Vec::new(),
            label,
        }
    }

    fn flush_pending(&mut self, eof: bool) {
        if startup_diagnostic_target().is_none() {
            self.pending.clear();
            return;
        }
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=index).collect();
            note_startup_diagnostic(self.label, &line[..line.len() - 1]);
        }
        if eof && !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            note_startup_diagnostic(self.label, &line);
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for DiagnosticCopy<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let start = buf.filled().len();
        let poll = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &poll
            && startup_diagnostic_target().is_some()
        {
            let fresh = buf.filled()[start..].to_vec();
            if fresh.is_empty() {
                this.flush_pending(true);
            } else {
                this.pending.extend_from_slice(&fresh);
                this.flush_pending(false);
            }
        }
        poll
    }
}

impl Process {
    async fn spawn(spec: &SpawnSpec, capture: &logs::Logs) -> Result<Self> {
        remember_diagnostic_roots(&spec.data_dir, &spec.runtime_dir);
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
        note_startup_diagnostic(
            "artifact",
            format!(
                "node={}\nentry={}",
                spec.bundle.node.display(),
                spec.bundle.entry.display()
            )
            .as_bytes(),
        );
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
        let parent_death = configure_child(&mut command, spec.lease_file.as_raw_fd())
            .context("Could not arm the Node parent-death watcher")?;
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                drop(parent_death);
                return Err(error).context("Could not start bundled Node");
            }
        };
        let parent_death = parent_death.keep_write();
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
            logs.push(tokio::spawn(async move {
                capture.capture(DiagnosticCopy::new(stdout, "stdout")).await
            }));
        }
        if let Some(stderr) = child.stderr.take() {
            let capture = capture.clone();
            logs.push(tokio::spawn(async move {
                capture.capture(DiagnosticCopy::new(stderr, "stderr")).await
            }));
        }
        Ok(Self {
            pid: child.id().context("Missing child PID")?,
            child,
            stdin: Some(stdin),
            endpoint,
            logs,
            parent_death: Some(parent_death),
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
        drop(self.parent_death.take());
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
                if let Err(error) = &process {
                    note_startup_diagnostic("spawn", format!("{error:#}").as_bytes());
                }
                if let Ok(mut process) = process {
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
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
                    if !ready {
                        if let Some(status) = &observed_exit {
                            note_startup_diagnostic("child-exit", status.to_string().as_bytes());
                        } else if !cancelled.is_cancelled() {
                            note_startup_diagnostic(
                                "ready-timeout",
                                b"supervisor ready deadline exceeded",
                            );
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
                            note_startup_diagnostic("stop", format!("{error:#}").as_bytes());
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
                    note_startup_diagnostic("guarded", b"crash guard");
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

    fn is_bare_program_name(path: &std::path::Path) -> bool {
        use std::path::Component;
        matches!(
            path.components().next(),
            Some(Component::Normal(_)) if path.components().count() == 1
        )
    }

    fn is_executable_file(path: &std::path::Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .ok()
            .filter(|meta| meta.is_file())
            .is_some_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }

    fn resolve_test_runtime_executable(path: std::path::PathBuf) -> std::path::PathBuf {
        if !is_bare_program_name(&path) {
            return path;
        }
        let Some(path_env) = std::env::var_os("PATH") else {
            return path;
        };
        for dir in std::env::split_paths(&path_env) {
            let candidate = dir.join(&path);
            if is_executable_file(&candidate) {
                return candidate;
            }
        }
        path
    }

    fn death_fixture_node() -> std::path::PathBuf {
        if let Some(path) = std::env::var_os("PP_TEST_NODE") {
            return resolve_test_runtime_executable(path.into());
        }
        let fallback = std::path::PathBuf::from(
            "/opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node",
        );
        if fallback.is_file() {
            fallback
        } else {
            resolve_test_runtime_executable(std::path::PathBuf::from("node"))
        }
    }

    fn process_live(pid: i32) -> bool {
        if unsafe { libc::kill(pid, 0) } < 0 {
            return false;
        }
        let listed = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&listed.stdout)
            .split_whitespace()
            .any(|state| !state.starts_with('Z'))
    }

    fn shell_watcher_alive(node: i32) -> bool {
        let listed = std::process::Command::new("ps")
            .args(["-axo", "ppid=,args="])
            .output()
            .unwrap();
        String::from_utf8_lossy(&listed.stdout).lines().any(|line| {
            let mut parts = line.split_whitespace();
            parts.next() == Some(&node.to_string()) && line.contains("target=$1")
        })
    }

    #[tokio::test]
    async fn parent_death_fixture() {
        let Some(pidfile) = std::env::var_os("PP_COMPAT_DEATH_PIDFILE") else {
            return;
        };
        let lease = std::fs::File::open("/dev/null").unwrap();
        let node = death_fixture_node();
        let mut command = tokio::process::Command::new(&node);
        command
            .arg("-e")
            .arg("setInterval(() => {}, 1000000)")
            .stdin(std::process::Stdio::null());
        let _guard =
            super::configure_child(&mut command, std::os::fd::AsRawFd::as_raw_fd(&lease)).unwrap();
        let mut child = command.spawn().unwrap();
        let pidfile = std::path::PathBuf::from(pidfile);
        let temporary = pidfile.with_extension("tmp");
        std::fs::write(&temporary, child.id().unwrap().to_string()).unwrap();
        std::fs::rename(temporary, pidfile).unwrap();
        child.wait().await.unwrap();
    }

    #[test]
    fn separate_group_child_dies_with_force_killed_parent() {
        use std::os::unix::process::CommandExt;
        let node = death_fixture_node();
        let mut header = [0u8; 4];
        std::io::Read::read_exact(&mut std::fs::File::open(&node).unwrap(), &mut header).unwrap();
        assert!(
            header == *b"\x7fELF"
                || matches!(
                    header,
                    [0xfe, 0xed, 0xfa, 0xce]
                        | [0xfe, 0xed, 0xfa, 0xcf]
                        | [0xcf, 0xfa, 0xed, 0xfe]
                        | [0xce, 0xfa, 0xed, 0xfe]
                        | [0xca, 0xfe, 0xba, 0xbe]
                ),
            "PP_TEST_NODE is not an ELF or Mach-O: {header:?} {}",
            node.display()
        );
        let pidfile = std::env::temp_dir().join(format!(
            "pp-compat-death-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut owner = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["parent_death_fixture", "--nocapture"])
            .env("PP_COMPAT_DEATH_PIDFILE", &pidfile)
            .stdout(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !pidfile.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !pidfile.exists() {
            let _ = owner.kill();
            let _ = owner.wait();
            panic!("child never spawned");
        }
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().parse().unwrap();
        let group = unsafe { libc::getpgid(pid) };
        assert!(
            process_live(pid),
            "node child was not alive before the parent died"
        );
        assert!(
            shell_watcher_alive(pid),
            "parent-death shell watcher was not a child of the node"
        );
        #[cfg(target_os = "linux")]
        {
            let exe =
                std::fs::canonicalize(std::fs::read_link(format!("/proc/{pid}/exe")).unwrap())
                    .unwrap();
            assert_eq!(exe, std::fs::canonicalize(&node).unwrap());
        }
        let mut peer = std::process::Command::new("sleep")
            .arg("60")
            .process_group(pid)
            .spawn()
            .unwrap();
        let peer_pid = peer.id() as i32;
        unsafe {
            libc::kill(-(owner.id() as i32), libc::SIGKILL);
        }
        owner.wait().unwrap();
        let started = std::time::Instant::now();
        let deadline = started + Duration::from_secs(5);
        while process_live(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let survived = process_live(pid);
        let peer_alive = process_live(peer_pid);
        let elapsed_ms = started.elapsed().as_millis();
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        let _ = peer.kill();
        let _ = peer.wait();
        std::fs::remove_file(&pidfile).unwrap();
        assert_eq!(
            group, pid,
            "fixture must reproduce Node's separate process group"
        );
        assert!(
            !survived,
            "separate-group node outlived its force-killed parent"
        );
        assert!(
            peer_alive,
            "group peer died with the node; the watcher must not signal the group"
        );
        println!(
            "parent-death absence observed at {elapsed_ms} ms. Poll interval is 10 ms. The elapsed time is sample resolution, not signal latency."
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
            parent_death: None,
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

    fn private_dir(label: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("pp-diag-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    fn mode_bits(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    struct ClearDiagnosticEnv;
    impl Drop for ClearDiagnosticEnv {
        fn drop(&mut self) {
            // SAFETY: this test owns the variable and clears the process slot on every exit.
            unsafe {
                std::env::remove_var("PP_COMPAT_STARTUP_DIAGNOSTIC");
            }
            super::reset_startup_diagnostic();
        }
    }

    fn arm_diagnostic(dir: &std::path::Path) -> ClearDiagnosticEnv {
        super::close_startup_diagnostic_slot();
        // SAFETY: the variable is private to this test and Drop removes it.
        unsafe {
            std::env::set_var("PP_COMPAT_STARTUP_DIAGNOSTIC", dir);
        }
        ClearDiagnosticEnv
    }

    fn sample_setup() -> (Vec<u8>, String) {
        let lease = "c0ffee-lease-value";
        let key = "c0ffee-key-value";
        let generation = "c0ffee-generation-value";
        let input = format!(
            "{{\"version\":1,\"lease\":\"{lease}\",\"key\":\"{key}\"}}\n\"generation\":\"{generation}\"\ngeneration={generation}\n{{\n\"lease\": \"{lease}\",\n\"key\": \"{key}\",\n\"generation\": \"{generation}\"\n}}\nready check failed: ENOENT desktop.js\n"
        );
        let expected = "\
[stderr]
[redacted]
[redacted]
[redacted]
{
[redacted]
[redacted]
[redacted]
}
ready check failed: ENOENT desktop.js
";
        (input.into_bytes(), expected.to_string())
    }

    #[test]
    fn startup_diagnostic_redacts_setup_and_keeps_the_reason() {
        let dir = private_dir("redact");
        let _guard = arm_diagnostic(&dir);
        let (input, expected) = sample_setup();
        super::note_startup_diagnostic("stderr", &input);
        let text = std::fs::read_to_string(dir.join("startup-diagnostic.txt")).unwrap();
        assert_eq!(text, expected);
        let raw = String::from_utf8(input).unwrap();
        for secret in [
            "c0ffee-lease-value",
            "c0ffee-key-value",
            "c0ffee-generation-value",
        ] {
            assert!(!text.contains(secret), "{secret} remained in {text}");
            assert!(raw.contains(secret));
        }
        assert!(text.contains("ready check failed: ENOENT desktop.js"));
    }

    #[tokio::test]
    async fn startup_diagnostic_tee_forwards_bytes_and_records_stderr() {
        use tokio::io::AsyncWriteExt;
        let dir = private_dir("tee");
        let _guard = arm_diagnostic(&dir);
        let (input, _) = sample_setup();
        let (mut writer, reader) = tokio::io::duplex(1024);
        let mut tee = super::DiagnosticCopy::new(reader, "stderr");
        let write_input = input.clone();
        let write = async move {
            writer.write_all(&write_input).await.unwrap();
            drop(writer);
        };
        let read = async {
            let mut got = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut tee, &mut got)
                .await
                .unwrap();
            got
        };
        let ((), got) = tokio::join!(write, read);
        assert_eq!(got, input);
        let text = std::fs::read_to_string(dir.join("startup-diagnostic.txt")).unwrap();
        let expected = "\
[stderr]
[redacted]
[stderr]
[redacted]
[stderr]
[redacted]
[stderr]
{
[stderr]
[redacted]
[stderr]
[redacted]
[stderr]
[redacted]
[stderr]
}
[stderr]
ready check failed: ENOENT desktop.js
";
        assert_eq!(text, expected);
        assert!(!text.contains("c0ffee-lease-value"), "{text}");
        assert!(!text.contains("c0ffee-key-value"), "{text}");
        assert!(!text.contains("c0ffee-generation-value"), "{text}");
    }

    #[test]
    fn startup_diagnostic_unset_and_empty_do_not_create_a_file() {
        let dir = private_dir("noop");
        super::reset_startup_diagnostic();
        // SAFETY: the variable is removed before this test returns.
        unsafe {
            std::env::remove_var("PP_COMPAT_STARTUP_DIAGNOSTIC");
        }
        super::note_startup_diagnostic("stderr", b"should-not-write");
        assert!(!dir.join("startup-diagnostic.txt").exists());
        unsafe {
            std::env::set_var("PP_COMPAT_STARTUP_DIAGNOSTIC", "");
        }
        super::note_startup_diagnostic("stderr", b"should-not-write");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        unsafe {
            std::env::remove_var("PP_COMPAT_STARTUP_DIAGNOSTIC");
        }
    }

    fn assert_unchanged(path: &std::path::Path, bytes: &[u8], mode: u32) {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(mode_bits(path), mode);
    }

    #[test]
    fn startup_diagnostic_refuses_existing_file_symlink_and_preexisting_name() {
        use std::os::unix::fs::PermissionsExt;
        let dir = private_dir("refuse");
        let victim = dir.join("victim-existing.txt");
        std::fs::write(&victim, b"MANAGED_HEADER_DO_NOT_TOUCH").unwrap();
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o640)).unwrap();
        let _guard = arm_diagnostic(&victim);
        super::note_startup_diagnostic("artifact", b"node=/tmp/evil\n");
        assert_unchanged(&victim, b"MANAGED_HEADER_DO_NOT_TOUCH", 0o640);
        drop(_guard);

        let target = dir.join("symlink-target.txt");
        std::fs::write(&target, b"TARGET_ORIGINAL").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        let link = dir.join("diag-symlink");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let _guard = arm_diagnostic(&link);
        super::note_startup_diagnostic("stderr", b"via symlink\n");
        assert_unchanged(&target, b"TARGET_ORIGINAL", 0o640);
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        drop(_guard);

        let linked_dir = private_dir("linked-real");
        std::fs::write(linked_dir.join("marker"), b"keep-marker").unwrap();
        let dir_link = dir.join("dir-link");
        std::os::unix::fs::symlink(&linked_dir, &dir_link).unwrap();
        let _guard = arm_diagnostic(&dir_link);
        super::note_startup_diagnostic("stderr", b"through-dir-link\n");
        assert!(!linked_dir.join("startup-diagnostic.txt").exists());
        assert_eq!(
            std::fs::read(linked_dir.join("marker")).unwrap(),
            b"keep-marker"
        );
        drop(_guard);

        let occupied = private_dir("occupied");
        let existing = occupied.join("startup-diagnostic.txt");
        std::fs::write(&existing, b"PREFIX").unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o640)).unwrap();
        let _guard = arm_diagnostic(&occupied);
        super::note_startup_diagnostic("stderr", b"must-not-append\n");
        assert_unchanged(&existing, b"PREFIX", 0o640);
    }

    #[test]
    fn startup_diagnostic_refuses_database_runtime_and_lease_targets() {
        use std::os::unix::fs::PermissionsExt;
        let root = private_dir("managed");
        let cases = [
            ("print-partner.db", b"db-bytes".as_slice()),
            ("print-partner.db-wal", b"wal-bytes"),
            (".desktop.lock", b"lock-bytes"),
            (".desktop-owner.json", b"owner-bytes"),
            ("owner.json", b"lease-owner-bytes"),
            ("runtime.sock", b"sock-bytes"),
        ];
        for (name, bytes) in cases {
            let path = root.join(name);
            std::fs::write(&path, bytes).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
            let _guard = arm_diagnostic(&path);
            super::note_startup_diagnostic("artifact", b"node=/tmp/evil\n");
            assert_unchanged(&path, bytes, 0o640);
            drop(_guard);
        }
        let lease = root.join(".desktop-lease");
        std::fs::create_dir(&lease).unwrap();
        std::fs::set_permissions(&lease, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(lease.join("owner.json"), b"lease-file").unwrap();
        let _guard = arm_diagnostic(&lease);
        super::note_startup_diagnostic("artifact", b"node=/tmp/evil\n");
        assert!(!lease.join("startup-diagnostic.txt").exists());
        assert_eq!(
            std::fs::read(lease.join("owner.json")).unwrap(),
            b"lease-file"
        );
        drop(_guard);

        let data = private_dir("data-root");
        let database = data.join("print-partner.db");
        std::fs::write(&database, b"live-db").unwrap();
        std::fs::set_permissions(&database, std::fs::Permissions::from_mode(0o640)).unwrap();
        super::forbid_diagnostic_roots(&[data.clone()]);
        let _guard = arm_diagnostic(&data);
        super::note_startup_diagnostic("artifact", b"node=/tmp/evil\n");
        assert!(!data.join("startup-diagnostic.txt").exists());
        assert_unchanged(&database, b"live-db", 0o640);
        drop(_guard);

        let runtime = private_dir("runtime-root");
        let sock = runtime.join("abcd1234abcd.sock");
        std::fs::write(&sock, b"sock").unwrap();
        std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600)).unwrap();
        super::forbid_diagnostic_roots(&[runtime.clone()]);
        let _guard = arm_diagnostic(&runtime);
        super::note_startup_diagnostic("artifact", b"node=/tmp/evil\n");
        assert!(!runtime.join("startup-diagnostic.txt").exists());
        assert_unchanged(&sock, b"sock", 0o600);
    }

    #[test]
    fn startup_diagnostic_keeps_the_original_inode_after_path_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let dir = private_dir("replace");
        let _guard = arm_diagnostic(&dir);
        super::note_startup_diagnostic("stderr", b"first-line\n");
        let created = dir.join("startup-diagnostic.txt");
        assert_eq!(mode_bits(&created), 0o600);
        let kept = dir.join("kept");
        std::fs::rename(&created, &kept).unwrap();
        let victim = dir.join("victim");
        std::fs::write(&victim, b"VICTIM").unwrap();
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::os::unix::fs::symlink(&victim, &created).unwrap();
        super::note_startup_diagnostic("stderr", b"second-line\n");
        assert_unchanged(&victim, b"VICTIM", 0o640);
        let kept_text = std::fs::read_to_string(&kept).unwrap();
        assert_eq!(kept_text, "[stderr]\nfirst-line\n[stderr]\nsecond-line\n");
        assert!(!kept_text.contains("VICTIM"));
    }

    #[test]
    fn startup_diagnostic_stops_at_sixteen_kibibytes() {
        let dir = private_dir("cap");
        let _guard = arm_diagnostic(&dir);
        super::note_startup_diagnostic("stderr", b"visible-reason\n");
        for _ in 0..40 {
            super::note_startup_diagnostic("stderr", &[b'A'; 4000]);
        }
        super::note_startup_diagnostic("stderr", b"TAIL_SHOULD_NOT_APPEAR\n");
        let bytes = std::fs::read(dir.join("startup-diagnostic.txt")).unwrap();
        assert!(bytes.len() <= 16 * 1024, "{}", bytes.len());
        assert!(
            bytes.starts_with(b"[stderr]\nvisible-reason\n"),
            "{bytes:?}"
        );
        assert!(
            !bytes
                .windows(22)
                .any(|window| window == b"TAIL_SHOULD_NOT_APPEAR")
        );
    }
}
