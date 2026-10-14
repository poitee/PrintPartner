use anyhow::{Context, Result, bail};
use pp_compat::{Bundle, CompatHandle, SpawnSpec, Supervisor};
use pp_gateway::{Gateway, LaunchTarget};
use pp_storage::lease::StorageLease;
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    time::Duration,
};
use tokio::net::TcpListener;

mod drain;
mod rebuild;

#[cfg(feature = "desktop_rebuild")]
pub mod layout;

#[cfg(feature = "desktop_rebuild")]
pub mod profile_interpreter;

#[cfg(feature = "desktop_rebuild")]
pub mod review_observations;

#[cfg(test)]
mod origin_tests;

pub use rebuild::DesktopRebuild;

pub use drain::{ShutdownGate, TrackedShutdownWork};
pub use pp_compat::drain::{
    GroupStopReport, SIGTERM_GRACE, drive_shutdown_group, process_alive, process_group_absent,
    reap_process_group, reject_and_arm_eof, restarts_allowed,
};
pub use pp_gateway::MUTATION_DRAIN;

pub struct DesktopLaunch {
    pub data_dir: PathBuf,
    pub bundle: Bundle,
    pub assets: PathBuf,
}

pub use pp_compat::SupervisorConfig;
pub use pp_compat::recent_diagnostics;
pub use pp_compat::{Bundle as VerifiedBundle, Status as CoreStatus};
pub use pp_gateway::LaunchTarget as DesktopLaunchTarget;

async fn bind_origin(owner: &StorageLease) -> Result<TcpListener> {
    let path = owner.data_dir().join("desktop.toml");
    let config = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => {
            anyhow::ensure!(file.metadata()?.is_file(), "Invalid desktop.toml");
            let mut config = String::new();
            file.take(4097).read_to_string(&mut config)?;
            anyhow::ensure!(config.len() <= 4096, "Invalid desktop.toml");
            Some(config)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("Desktop configuration unavailable"),
    };
    let port = if let Some(config) = config {
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
        persist_initial_origin(owner, listener.local_addr()?.port())?;
    }
    Ok(listener)
}

fn persist_initial_origin(owner: &StorageLease, port: u16) -> Result<()> {
    let temporary = owner.data_dir().join(format!(
        "desktop-{}.toml.new",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| -> Result<()> {
        writeln!(file, "port = {port}")?;
        file.sync_all()?;
        std::fs::hard_link(&temporary, owner.data_dir().join("desktop.toml"))?;
        Ok(())
    })();
    let cleanup = std::fs::remove_file(&temporary);
    result?;
    cleanup?;
    File::open(owner.data_dir())?.sync_all()?;
    Ok(())
}

pub struct CoreHandle {
    compat: CompatHandle,
    monitoring: pp_gateway::MonitoringControl,
    gate: ShutdownGate,
}
impl Clone for CoreHandle {
    fn clone(&self) -> Self {
        Self {
            compat: self.compat.clone(),
            monitoring: self.monitoring.clone(),
            gate: self.gate.clone(),
        }
    }
}
impl CoreHandle {
    /// Power adapters can cancel/join status sockets before acknowledging sleep.
    /// Hide-to-tray deliberately leaves monitoring running.
    pub async fn suspend_monitoring(&self) {
        self.monitoring.suspend().await;
    }
    pub fn resume_monitoring(&self) {
        self.monitoring.resume();
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<pp_compat::Status> {
        self.compat.status.clone()
    }
    pub async fn recover_compat(&self) -> Result<()> {
        self.compat.recover().await
    }

    pub fn track_shutdown_work(&self) -> Result<TrackedShutdownWork, &'static str> {
        self.gate.track()
    }
}

pub struct CoreRuntime {
    desktop_rebuild: DesktopRebuild,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    completion: Option<tokio::sync::oneshot::Receiver<ShutdownReceipt>>,
    worker: Option<std::thread::JoinHandle<()>>,
    origin: String,
    handle: CoreHandle,
    launch: Option<LaunchTarget>,
    shutdown_requested: pp_gateway::ShutdownRequested,
}
struct Resources {
    gateway: Gateway,
    supervisor: Supervisor,
    owner: StorageLease,
    gate: ShutdownGate,
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

async fn start_resources(
    input: DesktopLaunch,
    compat_config: SupervisorConfig,
) -> Result<Resources> {
    let assets = input
        .assets
        .canonicalize()
        .context("React assets unavailable")?;
    pp_compat::verify_bundle(&input.bundle, &assets)?;
    std::fs::create_dir_all(&input.data_dir)?;
    if let Some(released) = StorageLease::retry_failed_release_if_present(&input.data_dir)? {
        anyhow::ensure!(
            released.marker_removed
                && released.runtime_removed
                && released.lock_released
                && !released.ownership_retained,
            "Storage cleanup still incomplete; ownership retained"
        );
    }
    let mut owner = StorageLease::acquire(&input.data_dir)?;
    pp_gateway::ownership::boot_bundled_source_sync(owner.data_dir())
        .map_err(|error| anyhow::anyhow!("Source Sync ownership admission failed: {error}"))?;
    let listener = bind_origin(&owner).await?;
    let supervisor = Supervisor::start_with_config(
        SpawnSpec {
            bundle: input.bundle,
            data_dir: owner.data_dir().to_owned(),
            runtime_dir: owner.runtime_dir().to_owned(),
            lease: owner.secret().to_owned(),
            lease_file: owner.clone_file()?,
            port: listener.local_addr()?.port(),
            record_child: pp_storage::lease::record_child,
        },
        compat_config,
    )?;
    owner.retain_on_drop();
    let mut status = supervisor.handle.status.clone();
    let ready = tokio::time::timeout(Duration::from_secs(32), async {
        loop {
            match *status.borrow() {
                CoreStatus::Ready { .. } => return Ok(()),
                CoreStatus::Guarded | CoreStatus::Stopped | CoreStatus::Failed => {
                    bail!("Compatibility startup failed");
                }
                CoreStatus::Starting | CoreStatus::Backoff { .. } | CoreStatus::Stopping => {}
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
            owner.allow_drop_cleanup();
        } else {
            owner.retain_until_process_exit();
        }
        bail!("Compatibility readiness/release verification failed");
    }
    let gateway = match Gateway::start(listener, assets, supervisor.handle.clone()) {
        Ok(gateway) => gateway,
        Err(error) => {
            if supervisor.shutdown().await.is_ok() {
                owner.allow_drop_cleanup();
            } else {
                owner.retain_until_process_exit();
            }
            return Err(error);
        }
    };
    Ok(Resources {
        gateway,
        supervisor,
        owner,
        gate: ShutdownGate::new(),
    })
}

impl CoreRuntime {
    pub async fn start(input: DesktopLaunch) -> Result<Self> {
        Self::start_with_compat_config(input, SupervisorConfig::default()).await
    }

    /// Start with a per-instance compatibility timing policy.
    pub async fn start_with_compat_config(
        input: DesktopLaunch,
        compat_config: SupervisorConfig,
    ) -> Result<Self> {
        let desktop_rebuild = DesktopRebuild::from_env();
        if desktop_rebuild.enabled() {
            pp_gateway::ownership::manifest::admit_bundled_manifest().map_err(|error| {
                anyhow::anyhow!("Operation ownership admission failed: {error}")
            })?;
        }
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
                    let mut resources = match start_resources(input, compat_config).await {
                        Ok(resources) => resources,
                        Err(error) => {
                            let _ = started.send(Err(error));
                            return;
                        }
                    };
                    let requested_by_gateway = resources.gateway.shutdown_requested();
                    let requested_by_adapter = requested_by_gateway.clone();
                    let public = resources.gateway.take_launch_target().map(|launch| {
                        (
                            resources.gateway.origin().to_owned(),
                            CoreHandle {
                                compat: resources.supervisor.handle.clone(),
                                monitoring: resources.gateway.monitoring_control(),
                                gate: resources.gate.clone(),
                            },
                            launch,
                            requested_by_adapter,
                        )
                    });
                    if started.send(public).is_ok() {
                        tokio::select! {
                            _ = stopped => {}
                            _ = requested_by_gateway.wait() => {}
                        }
                    }
                    let receipt = stop_resources(resources).await;
                    let _ = completed.send(receipt);
                });
            })
            .context("Core owner thread unavailable")?;
        let (origin, handle, launch, shutdown_requested) =
            startup.await.context("Core owner startup failed")??;
        Ok(Self {
            desktop_rebuild,
            stop: Some(stop),
            completion: Some(completion),
            worker: Some(worker),
            origin,
            handle,
            launch: Some(launch),
            shutdown_requested,
        })
    }
    pub fn desktop_rebuild(&self) -> DesktopRebuild {
        self.desktop_rebuild
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
    pub fn shutdown_requested(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let requested = self.shutdown_requested.clone();
        async move { requested.wait().await }
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

async fn stop_resources(resources: Resources) -> ShutdownReceipt {
    let _ = drain::reject_and_wait(
        MUTATION_DRAIN,
        &resources.gate,
        || resources.gateway.begin_drain(),
        |bound| resources.gateway.wait_idle(bound),
        || resources.supervisor.disarm_restarts(),
    )
    .await;
    resources.gateway.finish_drain();
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
        resources.owner.retain_until_process_exit();
        return receipt;
    }
    let released = resources.owner.release();
    receipt.marker_removed = released.marker_removed;
    receipt.runtime_removed = released.runtime_removed;
    if !released.marker_removed {
        receipt.errors.push("owner_marker_cleanup_failed");
    }
    if !released.runtime_removed {
        receipt.errors.push("runtime_directory_cleanup_failed");
    }
    if released.ownership_retained {
        receipt.errors.push("storage_ownership_retained");
    }
    if !released.lock_released {
        receipt.errors.push("storage_unlock_unproved");
    }
    receipt.storage_released =
        released.marker_removed && released.runtime_removed && released.lock_released;
    receipt
}

impl Drop for CoreRuntime {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
