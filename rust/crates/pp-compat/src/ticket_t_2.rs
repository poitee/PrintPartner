#![cfg(test)]

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tokio_util::sync::CancellationToken;

const STAY: &str = "read line || exit 1; while read line; do :; done";

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-t2-{label}-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        Self { root }
    }

    fn pidfile(&self) -> PathBuf {
        self.root.join("pids")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Ok(text) = std::fs::read_to_string(self.pidfile()) {
            for pid in text.lines().filter_map(|line| line.parse::<i32>().ok()) {
                unsafe { libc::kill(-pid, libc::SIGKILL) };
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn wall_fuse(limit: Duration) -> CancellationToken {
    let token = CancellationToken::new();
    let cancel = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(limit);
        cancel.cancel();
    });
    token
}

fn recorded_pids(path: &Path) -> Vec<u32> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.parse().ok())
        .collect()
}

fn live_pids(path: &Path) -> Vec<u32> {
    recorded_pids(path)
        .into_iter()
        .filter(|pid| super::drain::process_alive(*pid))
        .collect()
}

fn ignore_child(_: &Path, _: u32) -> anyhow::Result<()> {
    Ok(())
}

fn bundle(scratch: &Scratch) -> super::Bundle {
    super::Bundle {
        node: scratch.root.join("node"),
        entry: scratch.root.join("desktop.js"),
        web_root: scratch.root.join("web"),
        runtime_version: "ticket-t-2-unreleased".into(),
        commit: "ticket-t-2-unreleased".into(),
    }
}

fn release_spec(scratch: &Scratch) -> super::SpawnSpec {
    let lease_file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(scratch.root.join("lease"))
        .unwrap();
    super::SpawnSpec {
        bundle: bundle(scratch),
        data_dir: scratch.root.join("data"),
        runtime_dir: scratch.root.join("runtime"),
        lease: "lease".into(),
        lease_file,
        port: 0,
        record_child: ignore_child,
    }
}

fn shell_spec(scratch: &Scratch) -> super::ShellSpec {
    super::ShellSpec {
        script: STAY,
        bundle: bundle(scratch),
        data_dir: scratch.root.join("data"),
        runtime_dir: scratch.root.join("runtime"),
        pidfile: scratch.pidfile(),
        port: 0,
    }
}

async fn wait_status(
    status: &mut tokio::sync::watch::Receiver<super::Status>,
    ready: impl Fn(&super::Status) -> bool,
) {
    let fuse = wall_fuse(Duration::from_secs(8));
    loop {
        if ready(&status.borrow()) {
            return;
        }
        tokio::select! {
            biased;
            _ = fuse.cancelled() => panic!("status stayed {:?} for 8s wall time", *status.borrow()),
            changed = status.changed() => {
                changed.unwrap_or_else(|_| panic!("supervisor ended at {:?}", *status.borrow()));
            }
        }
    }
}

async fn wait_live(path: &Path, expected_records: usize) {
    let fuse = wall_fuse(Duration::from_secs(8));
    loop {
        let recorded = recorded_pids(path);
        let live = live_pids(path);
        if recorded.len() >= expected_records && live.len() == 1 {
            return;
        }
        tokio::select! {
            biased;
            _ = fuse.cancelled() => panic!(
                "expected {expected_records} spawns and 1 live child, recorded={recorded:?} live={live:?}"
            ),
            _ = tokio::task::yield_now() => {}
        }
    }
}

async fn shutdown(supervisor: super::Supervisor) {
    let fuse = wall_fuse(Duration::from_secs(8));
    tokio::select! {
        biased;
        _ = fuse.cancelled() => panic!("shutdown exceeded 8s wall time"),
        result = supervisor.shutdown() => result.expect("supervisor shutdown"),
    }
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_2_shutdown_cancels_pending_restart() {
    let scratch = Scratch::new("shutdown");
    let wall = std::time::Instant::now();
    let supervisor = super::Supervisor::start_with_config(
        release_spec(&scratch),
        super::SupervisorConfig::default(),
    )
    .unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| {
        matches!(state, super::Status::Backoff { .. })
    })
    .await;
    let mark = tokio::time::Instant::now();
    supervisor.disarm_restarts();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        mark.elapsed(),
        Duration::ZERO,
        "pending restart timer kept running after controlled shutdown"
    );
    assert!(
        matches!(*supervisor.handle.status.borrow(), super::Status::Stopped),
        "controlled shutdown left the restart timer running: {:?}",
        *supervisor.handle.status.borrow()
    );
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(
        matches!(*supervisor.handle.status.borrow(), super::Status::Stopped),
        "restart timer fired during the drain window: {:?}",
        *supervisor.handle.status.borrow()
    );
    shutdown(supervisor).await;
    assert!(wall.elapsed() < Duration::from_secs(8));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_2_repeated_start_stop_no_duplicate_child() {
    let scratch = Scratch::new("restart");
    let wall = std::time::Instant::now();
    tokio::time::resume();
    for nth in 1..=3 {
        let supervisor = super::Supervisor::launch_shell(
            shell_spec(&scratch),
            super::SupervisorConfig::default(),
        )
        .unwrap();
        wait_live(&scratch.pidfile(), nth).await;
        assert_eq!(
            live_pids(&scratch.pidfile()).len(),
            1,
            "start left more than one child alive"
        );
        shutdown(supervisor).await;
        assert!(
            live_pids(&scratch.pidfile()).is_empty(),
            "stop left a child alive: {:?}",
            live_pids(&scratch.pidfile())
        );
    }
    assert_eq!(
        recorded_pids(&scratch.pidfile()).len(),
        3,
        "repeated start/stop spawned a duplicate child: {:?}",
        recorded_pids(&scratch.pidfile())
    );
    assert!(wall.elapsed() < Duration::from_secs(8));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_2_readiness_timeout_no_leaked_task() {
    let scratch = Scratch::new("ready");
    let wall = std::time::Instant::now();
    let supervisor =
        super::Supervisor::launch_shell(shell_spec(&scratch), super::SupervisorConfig::default())
            .unwrap();
    let mut status = supervisor.handle.status.clone();
    let fuse = wall_fuse(Duration::from_secs(8));
    let mut resumed = false;
    loop {
        let state = status.borrow().clone();
        if matches!(state, super::Status::Stopping) && !resumed {
            // The readiness budget is virtual. Reaping the child is real.
            tokio::time::resume();
            resumed = true;
        }
        if matches!(state, super::Status::Backoff { .. }) {
            break;
        }
        tokio::select! {
            biased;
            _ = fuse.cancelled() => panic!("readiness timeout did not settle from {state:?}"),
            changed = status.changed() => {
                changed.unwrap_or_else(|_| panic!("supervisor ended at {:?}", *status.borrow()));
            }
        }
    }
    assert_eq!(
        recorded_pids(&scratch.pidfile()).len(),
        1,
        "readiness timeout spawned more than one child: {:?}",
        recorded_pids(&scratch.pidfile())
    );
    assert!(
        live_pids(&scratch.pidfile()).is_empty(),
        "readiness timeout left the child alive: {:?}",
        live_pids(&scratch.pidfile())
    );
    if resumed {
        tokio::time::pause();
    }
    let mark = tokio::time::Instant::now();
    supervisor.disarm_restarts();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        mark.elapsed(),
        Duration::ZERO,
        "readiness timeout left the restart timer running"
    );
    assert_eq!(
        recorded_pids(&scratch.pidfile()).len(),
        1,
        "restart timer survived readiness timeout: {:?}",
        recorded_pids(&scratch.pidfile())
    );
    assert!(
        live_pids(&scratch.pidfile()).is_empty(),
        "restart timer leaked a child: {:?}",
        live_pids(&scratch.pidfile())
    );
    assert!(
        matches!(*supervisor.handle.status.borrow(), super::Status::Stopped),
        "restart task still running after readiness timeout: {:?}",
        *supervisor.handle.status.borrow()
    );
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 1);
    assert!(
        matches!(*supervisor.handle.status.borrow(), super::Status::Stopped),
        "restart timer fired during the drain window"
    );
    shutdown(supervisor).await;
    assert!(live_pids(&scratch.pidfile()).is_empty());
    assert!(wall.elapsed() < Duration::from_secs(8));
}
