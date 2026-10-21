use pp_core::{DesktopLaunch, ShutdownReceipt, SupervisorConfig};
use pp_gateway::ownership::cutover::{CutoverReceipt, CutoverRefusal};
use std::{
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    time::Duration,
};

pub fn temporary(case: &str) -> (Scratch, PathBuf) {
    let scratch = tempfile::Builder::new()
        .prefix(&format!("pp-{case}-"))
        .tempdir()
        .unwrap();
    let data = scratch.path().join("data");
    (Scratch(Some(scratch)), data)
}

pub const CLOSURE_PENDING: &str = ".pp-test-closure-pending";

pub struct Scratch(Option<tempfile::TempDir>);

impl Scratch {
    pub fn path(&self) -> &Path {
        self.0.as_ref().unwrap().path()
    }

    pub fn keep(mut self) -> PathBuf {
        self.0.take().unwrap().keep()
    }

    pub fn close(mut self) -> std::io::Result<()> {
        if closure_unproved(self.path()) {
            return Err(std::io::Error::other("scratch child closure unproved"));
        }
        self.0.take().unwrap().close()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(directory) = self.0.as_ref()
            && closure_unproved(directory.path())
        {
            eprintln!(
                "child closure unproved; retained scratch {:?}",
                self.0.take().map(tempfile::TempDir::keep)
            );
        }
    }
}

fn closure_unproved(root: &Path) -> bool {
    if root.join(CLOSURE_PENDING).try_exists().unwrap_or(true) {
        return true;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
    };
    for entry in entries {
        let Ok(entry) = entry else { return true };
        let Ok(kind) = entry.file_type() else {
            return true;
        };
        if kind.is_dir() && closure_unproved(&entry.path()) {
            return true;
        }
    }
    false
}

#[test]
fn unproved_closure_retains_scratch_on_panic() {
    let cleanup = tempfile::tempdir().unwrap();
    let root = tempfile::Builder::new().tempdir_in(cleanup.path()).unwrap();
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    std::fs::write(data.join(CLOSURE_PENDING), b"pending").unwrap();
    let path = root.path().to_owned();
    let failure = std::panic::catch_unwind(|| {
        let _scratch = Scratch(Some(root));
        panic!("exercise unproved closure while unwinding");
    });
    assert!(failure.is_err());
    assert!(data.join(CLOSURE_PENDING).is_file());
    std::fs::remove_file(data.join(CLOSURE_PENDING)).unwrap();
    cleanup.close().unwrap();
    assert!(!path.exists());
}

pub struct PrivatePermissions(pub PathBuf);

impl Drop for PrivatePermissions {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
    }
}

#[test]
fn unreadable_fixture_is_removed_after_panic() {
    use std::os::unix::fs::PermissionsExt;
    let mut root = PathBuf::new();
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (scratch, data) = temporary("unreadable-panic");
        root = scratch.path().to_owned();
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("fixture"), b"scratch").unwrap();
        let _permissions = PrivatePermissions(data.clone());
        std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o300)).unwrap();
        panic!("exercise permission restoration while unwinding");
    }));
    assert!(failure.is_err());
    assert!(!root.exists());
}

pub struct RawDropScratch {
    directory: Option<Scratch>,
    data: PathBuf,
    runtime: PathBuf,
    pid: u32,
}

impl RawDropScratch {
    pub fn new(directory: Scratch, data: PathBuf, runtime: PathBuf, pid: u32) -> Self {
        Self {
            directory: Some(directory),
            data,
            runtime,
            pid,
        }
    }
}

impl Drop for RawDropScratch {
    fn drop(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(16);
        while pp_core::process_alive(self.pid)
            || self.runtime.exists()
            || self.data.join(".desktop-owner.json").exists()
        {
            if std::time::Instant::now() >= deadline {
                // Deleting under an unproved writer would turn a test failure into data loss.
                eprintln!(
                    "raw Drop closure unproved; retained scratch {:?}",
                    self.directory.take().map(Scratch::keep)
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

// Ordinary fixtures join the owner before their TempDir unwinds. The raw Drop
// test uses pp_core::CoreRuntime directly and proves its asynchronous closure.
pub struct Runtime(Option<pp_core::CoreRuntime>, PathBuf);

impl Runtime {
    pub fn into_inner(mut self) -> pp_core::CoreRuntime {
        self.0.take().unwrap()
    }

    pub async fn start(launch: DesktopLaunch) -> anyhow::Result<Self> {
        let data = launch.data_dir.clone();
        pp_core::CoreRuntime::start(launch)
            .await
            .map(|runtime| Self(Some(runtime), data))
    }

    pub async fn start_with_compat_config(
        launch: DesktopLaunch,
        config: SupervisorConfig,
    ) -> anyhow::Result<Self> {
        let data = launch.data_dir.clone();
        pp_core::CoreRuntime::start_with_compat_config(launch, config)
            .await
            .map(|runtime| Self(Some(runtime), data))
    }

    pub async fn shutdown(mut self) -> Receipt {
        let runtime = self.0.take().unwrap();
        let data = self.1.clone();
        Worker::spawn(shutdown(runtime, data)).wait().await
    }

    pub async fn shutdown_with_cutover(
        mut self,
        operation: &str,
        parity: &str,
    ) -> Result<(Receipt, CutoverReceipt), Box<(Self, CutoverRefusal)>> {
        let runtime = self.0.take().unwrap();
        let data = self.1.clone();
        let operation = operation.to_owned();
        let parity = parity.to_owned();
        Worker::spawn(async move {
            let directory = runtime.runtime_dir().to_owned();
            std::fs::write(data.join(CLOSURE_PENDING), b"pending").unwrap();
            match runtime.shutdown_with_cutover(&operation, &parity).await {
                Ok((receipt, cutover)) => Ok((Receipt::new(receipt, directory, data), cutover)),
                Err(error) => {
                    let (runtime, refusal) = *error;
                    std::fs::remove_file(data.join(CLOSURE_PENDING)).unwrap();
                    Err(Box::new((Self(Some(runtime), data), refusal)))
                }
            }
        })
        .wait()
        .await
    }
}

impl Deref for Runtime {
    type Target = pp_core::CoreRuntime;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}

impl DerefMut for Runtime {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().unwrap()
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.take() {
            let data = self.1.clone();
            drop(Worker::spawn(shutdown(runtime, data)));
        }
    }
}

async fn shutdown(runtime: pp_core::CoreRuntime, data: PathBuf) -> Receipt {
    let directory = runtime.runtime_dir().to_owned();
    std::fs::write(data.join(CLOSURE_PENDING), b"pending").unwrap();
    Receipt::new(runtime.shutdown().await, directory, data)
}

#[derive(Debug, serde::Serialize)]
pub struct Receipt {
    #[serde(flatten)]
    receipt: ShutdownReceipt,
    #[serde(skip)]
    directory: PathBuf,
    #[serde(skip)]
    data: PathBuf,
}

impl Receipt {
    fn new(receipt: ShutdownReceipt, directory: PathBuf, data: PathBuf) -> Self {
        if receipt.compat_reaped {
            std::fs::remove_file(data.join(CLOSURE_PENDING)).unwrap();
        }
        Self {
            receipt,
            directory,
            data,
        }
    }

    pub fn prove_child_closed(&self, pid: u32) {
        let deadline = std::time::Instant::now() + Duration::from_secs(16);
        while pp_core::process_alive(pid) || !pp_core::process_group_absent(pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture child closure unproved for {pid}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::remove_file(self.data.join(CLOSURE_PENDING)).unwrap();
    }
}

impl Deref for Receipt {
    type Target = ShutdownReceipt;

    fn deref(&self) -> &Self::Target {
        &self.receipt
    }
}

impl Drop for Receipt {
    fn drop(&mut self) {
        if !closure_unproved(&self.data) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

struct Worker<T>(Option<std::thread::JoinHandle<T>>);

impl<T: Send + 'static> Worker<T> {
    fn spawn(future: impl std::future::Future<Output = T> + Send + 'static) -> Self {
        Self(Some(std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(future)
        })))
    }

    async fn wait(mut self) -> T {
        while !self.0.as_ref().unwrap().is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.0
            .take()
            .unwrap()
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }
}

impl<T> Drop for Worker<T> {
    fn drop(&mut self) {
        if let Some(worker) = self.0.take() {
            let _ = worker.join();
        }
    }
}

pub use super::process::output;
