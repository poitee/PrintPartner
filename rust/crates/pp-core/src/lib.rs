use anyhow::{Context, Result, bail};
use fs2::FileExt;
use pp_compat::{Bundle, CompatHandle, SpawnSpec, Supervisor};
use pp_gateway::{Gateway, LaunchTarget};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    net::{Ipv4Addr, SocketAddrV4},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::net::TcpListener;

pub struct DesktopLaunch {
    pub data_dir: PathBuf,
    pub bundle: Bundle,
    pub assets: PathBuf,
}

pub use pp_compat::{Bundle as VerifiedBundle, Status as CoreStatus};
pub use pp_gateway::LaunchTarget as DesktopLaunchTarget;

struct StorageOwner {
    lock: File,
    data_dir: PathBuf,
    runtime_dir: PathBuf,
    lease: String,
    release_allowed: bool,
}

impl StorageOwner {
    fn acquire(path: &Path) -> Result<Self> {
        std::fs::create_dir_all(path)?;
        let data_dir = path.canonicalize()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(data_dir.join(".desktop.lock"))?;
        lock.try_lock_exclusive()
            .context("Data directory already owned")?;
        let marker_path = data_dir.join(".desktop-owner.json");
        if marker_path.exists() {
            bail!("A prior writer marker remains; verify no prior writer is alive before recovery");
        }
        let lease = hex::encode(rand::random::<[u8; 32]>());
        let runtime_dir = std::env::temp_dir().join(format!(
            "pp-{}-{}",
            std::process::id(),
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir(&runtime_dir)?;
        std::fs::set_permissions(&runtime_dir, std::fs::Permissions::from_mode(0o700))?;
        let marker = serde_json::json!({"pid":std::process::id(),"lease_hash":hex::encode(Sha256::digest(lease.as_bytes())),"runtime_dir":runtime_dir});
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&marker_path)?;
            file.write_all(marker.to_string().as_bytes())?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_dir(&runtime_dir);
            return Err(error);
        }
        Ok(Self {
            lock,
            data_dir,
            runtime_dir,
            lease,
            release_allowed: true,
        })
    }
}

impl Drop for StorageOwner {
    fn drop(&mut self) {
        if !self.release_allowed {
            return;
        }
        let _ = std::fs::remove_file(self.data_dir.join(".desktop-owner.json"));
        let _ = std::fs::remove_dir(&self.runtime_dir);
    }
}

async fn bind_origin(owner: &StorageOwner) -> Result<TcpListener> {
    let path = owner.data_dir.join("desktop.toml");
    let port = if path.exists() {
        let config = std::fs::read_to_string(&path)?;
        let value = config
            .trim()
            .strip_prefix("port = ")
            .context("Invalid desktop.toml")?;
        let port: u16 = value.parse().context("Invalid persisted port")?;
        anyhow::ensure!(port > 0, "Invalid persisted port");
        port
    } else {
        0
    };
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
        .await
        .context("Persisted desktop origin is unavailable")?;
    if port == 0 {
        let temporary = owner.data_dir.join(format!(
            "desktop-{}.toml.new",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        writeln!(file, "port = {}", listener.local_addr()?.port())?;
        file.sync_all()?;
        std::fs::rename(temporary, path)?;
        File::open(&owner.data_dir)?.sync_all()?;
    }
    Ok(listener)
}

pub struct CoreHandle {
    compat: CompatHandle,
}
impl Clone for CoreHandle {
    fn clone(&self) -> Self {
        Self {
            compat: self.compat.clone(),
        }
    }
}
impl CoreHandle {
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<pp_compat::Status> {
        self.compat.status.clone()
    }
    pub async fn recover_compat(&self) -> Result<()> {
        self.compat.recover().await
    }
}

pub struct CoreRuntime {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    completion: Option<tokio::sync::oneshot::Receiver<ShutdownReceipt>>,
    worker: Option<std::thread::JoinHandle<()>>,
    origin: String,
    handle: CoreHandle,
    launch: Option<LaunchTarget>,
}
struct Resources {
    gateway: Gateway,
    supervisor: Supervisor,
    owner: StorageOwner,
}

#[derive(Serialize, Debug)]
pub struct ShutdownReceipt {
    pub proof_class: &'static str,
    pub compat_reaped: bool,
    pub storage_released: bool,
    pub gateway_stopped: bool,
    pub marker_removed: bool,
    pub runtime_removed: bool,
    pub errors: Vec<&'static str>,
}

impl ShutdownReceipt {
    fn failed(category: &'static str) -> Self {
        Self {
            proof_class: "headless_unsigned",
            compat_reaped: false,
            storage_released: false,
            gateway_stopped: false,
            marker_removed: false,
            runtime_removed: false,
            errors: vec![category],
        }
    }
    pub fn complete(&self) -> bool {
        self.compat_reaped
            && self.storage_released
            && self.gateway_stopped
            && self.errors.is_empty()
    }
}

async fn start_resources(input: DesktopLaunch) -> Result<Resources> {
    let assets = input
        .assets
        .canonicalize()
        .context("React assets unavailable")?;
    pp_compat::verify_bundle(&input.bundle, &assets)?;
    let mut owner = StorageOwner::acquire(&input.data_dir)?;
    let listener = bind_origin(&owner).await?;
    let supervisor = Supervisor::start(SpawnSpec {
        bundle: input.bundle,
        data_dir: owner.data_dir.clone(),
        runtime_dir: owner.runtime_dir.clone(),
        lease: owner.lease.clone(),
        lease_file: owner.lock.try_clone()?,
        port: listener.local_addr()?.port(),
    })?;
    owner.release_allowed = false;
    let mut status = supervisor.handle.status.clone();
    let ready = tokio::time::timeout(Duration::from_secs(32), async {
        loop {
            if matches!(*status.borrow(), CoreStatus::Ready { .. }) {
                return Ok(());
            }
            if matches!(*status.borrow(), CoreStatus::Guarded | CoreStatus::Stopped) {
                bail!("Compatibility startup failed");
            }
            status
                .changed()
                .await
                .context("Compatibility supervisor unavailable")?;
        }
    })
    .await;
    if !matches!(ready, Ok(Ok(()))) {
        if supervisor.shutdown().await.is_ok() {
            owner.release_allowed = true;
        } else {
            std::mem::forget(owner);
        }
        bail!("Compatibility readiness/release verification failed");
    }
    let gateway = match Gateway::start(listener, assets, supervisor.handle.clone()) {
        Ok(gateway) => gateway,
        Err(error) => {
            if supervisor.shutdown().await.is_ok() {
                owner.release_allowed = true;
            } else {
                std::mem::forget(owner);
            }
            return Err(error);
        }
    };
    Ok(Resources {
        gateway,
        supervisor,
        owner,
    })
}

impl CoreRuntime {
    pub async fn start(input: DesktopLaunch) -> Result<Self> {
        let (started, startup) = tokio::sync::oneshot::channel();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let (completed, completion) = tokio::sync::oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("pp-core-owner".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = started.send(Err(anyhow::Error::from(error)));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let mut resources = match start_resources(input).await {
                        Ok(resources) => resources,
                        Err(error) => {
                            let _ = started.send(Err(error));
                            return;
                        }
                    };
                    let public = resources.gateway.take_launch_target().map(|launch| {
                        (
                            resources.gateway.origin().to_owned(),
                            CoreHandle {
                                compat: resources.supervisor.handle.clone(),
                            },
                            launch,
                        )
                    });
                    if started.send(public).is_ok() {
                        let _ = stopped.await;
                    }
                    let receipt = stop_resources(resources).await;
                    let _ = completed.send(receipt);
                });
            })
            .context("Core owner thread unavailable")?;
        let (origin, handle, launch) = startup.await.context("Core owner startup failed")??;
        Ok(Self {
            stop: Some(stop),
            completion: Some(completion),
            worker: Some(worker),
            origin,
            handle,
            launch: Some(launch),
        })
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn handle(&self) -> CoreHandle {
        self.handle.clone()
    }
    pub fn take_launch_target(&mut self) -> Result<LaunchTarget> {
        self.launch
            .take()
            .context("Launch target already transferred")
    }
    pub async fn shutdown(mut self) -> ShutdownReceipt {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let mut receipt = match self.completion.take().expect("Completion consumed").await {
            Ok(receipt) => receipt,
            Err(_) => ShutdownReceipt::failed("core_owner_failed"),
        };
        if let Some(worker) = self.worker.take()
            && !matches!(
                tokio::task::spawn_blocking(move || worker.join()).await,
                Ok(Ok(()))
            )
        {
            receipt.errors.push("core_owner_join_failed");
        }
        receipt
    }
}

async fn stop_resources(mut resources: Resources) -> ShutdownReceipt {
    resources.gateway.drain().await;
    let compat_reaped = resources.supervisor.shutdown().await.is_ok();
    let gateway_stopped = resources.gateway.stop().await.is_ok();
    let mut receipt = ShutdownReceipt {
        proof_class: "headless_unsigned",
        compat_reaped,
        gateway_stopped,
        storage_released: false,
        marker_removed: false,
        runtime_removed: false,
        errors: Vec::new(),
    };
    if !gateway_stopped {
        receipt.errors.push("gateway_join_failed");
    }
    if !compat_reaped {
        receipt.errors.push("compat_cleanup_unproved");
        std::mem::forget(resources.owner);
        return receipt;
    }
    resources.owner.release_allowed = false;
    let marker = resources.owner.data_dir.join(".desktop-owner.json");
    let marker_result = std::fs::remove_file(&marker);
    receipt.marker_removed = marker_result.is_ok() && !marker.exists();
    if !receipt.marker_removed {
        receipt.errors.push("owner_marker_cleanup_failed");
    }
    receipt.runtime_removed = std::fs::remove_dir(&resources.owner.runtime_dir).is_ok()
        && !resources.owner.runtime_dir.exists();
    if !receipt.runtime_removed {
        receipt.errors.push("runtime_directory_cleanup_failed");
    }
    let unlocked = FileExt::unlock(&resources.owner.lock).is_ok();
    let reacquired = unlocked
        && OpenOptions::new()
            .read(true)
            .write(true)
            .open(resources.owner.data_dir.join(".desktop.lock"))
            .is_ok_and(|probe| probe.try_lock_exclusive().is_ok());
    if !reacquired {
        receipt.errors.push("storage_unlock_unproved");
    }
    receipt.storage_released = receipt.marker_removed && receipt.runtime_removed && reacquired;
    receipt
}

impl Drop for CoreRuntime {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
