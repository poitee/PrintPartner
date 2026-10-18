use pp_core::{DesktopLaunch, ShutdownReceipt, SupervisorConfig};
use pp_gateway::ownership::cutover::{CutoverReceipt, CutoverRefusal};
use std::{
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    time::Duration,
};

pub fn temporary(case: &str) -> (tempfile::TempDir, PathBuf) {
    let scratch = tempfile::Builder::new()
        .prefix(&format!("pp-{case}-"))
        .tempdir()
        .unwrap();
    let data = scratch.path().join("data");
    (scratch, data)
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

pub fn assert_empty(root: &Path) {
    let leftovers: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert!(
        leftovers.is_empty(),
        "runtime suite leaked scratch: {leftovers:?}"
    );
}

pub struct RawDropScratch {
    directory: Option<tempfile::TempDir>,
    data: PathBuf,
    runtime: PathBuf,
    pid: u32,
}

impl RawDropScratch {
    pub fn new(directory: tempfile::TempDir, data: PathBuf, runtime: PathBuf, pid: u32) -> Self {
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
                    self.directory.take().map(tempfile::TempDir::keep)
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn leak_check_rejects_leftovers() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("leaked-file"), b"leak").unwrap();
    let failure = std::panic::catch_unwind(|| assert_empty(root.path()));
    let message = failure.unwrap_err().downcast::<String>().unwrap();
    assert!(message.contains("runtime suite leaked scratch:"));
    assert!(message.contains("leaked-file"));
}

// Ordinary fixtures join the owner before their TempDir unwinds. The raw Drop
// test uses pp_core::CoreRuntime directly and proves its asynchronous closure.
pub struct Runtime(Option<pp_core::CoreRuntime>);

impl Runtime {
    pub fn into_inner(mut self) -> pp_core::CoreRuntime {
        self.0.take().unwrap()
    }

    pub async fn start(launch: DesktopLaunch) -> anyhow::Result<Self> {
        pp_core::CoreRuntime::start(launch)
            .await
            .map(|runtime| Self(Some(runtime)))
    }

    pub async fn start_with_compat_config(
        launch: DesktopLaunch,
        config: SupervisorConfig,
    ) -> anyhow::Result<Self> {
        pp_core::CoreRuntime::start_with_compat_config(launch, config)
            .await
            .map(|runtime| Self(Some(runtime)))
    }

    pub async fn shutdown(mut self) -> Receipt {
        let runtime = self.0.take().unwrap();
        Worker::spawn(async move {
            let directory = runtime.runtime_dir().to_owned();
            Receipt {
                receipt: runtime.shutdown().await,
                directory,
            }
        })
        .wait()
        .await
    }

    pub async fn shutdown_with_cutover(
        mut self,
        operation: &str,
        parity: &str,
    ) -> Result<(Receipt, CutoverReceipt), Box<(Self, CutoverRefusal)>> {
        let runtime = self.0.take().unwrap();
        let operation = operation.to_owned();
        let parity = parity.to_owned();
        Worker::spawn(async move {
            let directory = runtime.runtime_dir().to_owned();
            match runtime.shutdown_with_cutover(&operation, &parity).await {
                Ok((receipt, cutover)) => Ok((Receipt { receipt, directory }, cutover)),
                Err(error) => {
                    let (runtime, refusal) = *error;
                    Err(Box::new((Self(Some(runtime)), refusal)))
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
            drop(Worker::spawn(async move {
                let directory = runtime.runtime_dir().to_owned();
                Receipt {
                    receipt: runtime.shutdown().await,
                    directory,
                }
            }));
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct Receipt {
    #[serde(flatten)]
    receipt: ShutdownReceipt,
    #[serde(skip)]
    directory: PathBuf,
}

impl Deref for Receipt {
    type Target = ShutdownReceipt;

    fn deref(&self) -> &Self::Target {
        &self.receipt
    }
}

impl Drop for Receipt {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
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
