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

async fn shutdown(supervisor: super::Supervisor) -> super::CompatExit {
    let fuse = wall_fuse(Duration::from_secs(8));
    tokio::select! {
        biased;
        _ = fuse.cancelled() => panic!("shutdown exceeded 8s wall time"),
        result = supervisor.shutdown() => result.expect("supervisor shutdown"),
    }
}

#[tokio::test]
async fn ticket_t_3_drain_supervisor_shutdown_reports_graceful_exit() {
    let scratch = Scratch::new("graceful");
    let supervisor =
        super::Supervisor::launch_shell(shell_spec(&scratch), super::SupervisorConfig::default())
            .unwrap();
    wait_live(&scratch.pidfile(), 1).await;
    assert_eq!(shutdown(supervisor).await, super::CompatExit::Graceful);
    assert!(live_pids(&scratch.pidfile()).is_empty());
}

const READY: &str = r#"exec /usr/bin/node -e 'const http=require("node:http"); const input=require("node:readline").createInterface({input:process.stdin}); input.on("close",()=>process.exit(0)); input.once("line",line=>{const setup=JSON.parse(line); http.createServer((req,res)=>{res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ok:true,version:"ticket-t-2-unreleased",release:{commit:"ticket-t-2-unreleased"}}));}).listen(setup.socket_path);});'"#;

#[tokio::test]
async fn ticket_t_3_drain_supervisor_crash_after_disarm_is_not_graceful() {
    let scratch = Scratch::new("disarmed-crash");
    let supervisor = super::Supervisor::launch_shell(
        super::ShellSpec {
            script: READY,
            ..shell_spec(&scratch)
        },
        super::SupervisorConfig::default(),
    )
    .unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| {
        matches!(state, super::Status::Ready { .. })
    })
    .await;
    let pid = match *status.borrow() {
        super::Status::Ready { pid, .. } => pid,
        _ => unreachable!(),
    };
    supervisor.disarm_restarts();
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGTERM) }, 0);
    wait_status(&mut status, |state| matches!(state, super::Status::Stopped)).await;
    assert!(!supervisor.stop.is_cancelled());
    assert!(live_pids(&scratch.pidfile()).is_empty());
    assert_eq!(recorded_pids(&scratch.pidfile()), vec![pid]);
    assert_eq!(shutdown(supervisor).await, super::CompatExit::Interrupted);
}

#[tokio::test]
async fn ticket_t_3_drain_supervisor_recovered_crash_can_shutdown_gracefully() {
    let scratch = Scratch::new("recovered-crash");
    let supervisor = super::Supervisor::launch_shell(
        super::ShellSpec {
            script: READY,
            ..shell_spec(&scratch)
        },
        super::SupervisorConfig::default(),
    )
    .unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| {
        matches!(state, super::Status::Ready { .. })
    })
    .await;
    let first = recorded_pids(&scratch.pidfile())[0];
    assert_eq!(unsafe { libc::kill(first as i32, libc::SIGTERM) }, 0);
    wait_status(
        &mut status,
        |state| matches!(state, super::Status::Ready { pid, .. } if *pid != first),
    )
    .await;
    supervisor.disarm_restarts();
    assert_eq!(shutdown(supervisor).await, super::CompatExit::Graceful);
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 2);
    assert!(live_pids(&scratch.pidfile()).is_empty());
}

#[tokio::test]
async fn ticket_t_3_drain_supervisor_shutdown_reports_forced_exit() {
    let scratch = Scratch::new("forced");
    let spec = super::ShellSpec {
        script: "trap '' TERM; while :; do sleep 1; done",
        ..shell_spec(&scratch)
    };
    let supervisor =
        super::Supervisor::launch_shell(spec, super::SupervisorConfig::default()).unwrap();
    wait_live(&scratch.pidfile(), 1).await;
    let started = std::time::Instant::now();
    assert_eq!(
        supervisor.shutdown().await.unwrap(),
        super::CompatExit::Forced
    );
    assert!(started.elapsed() >= super::drain::SIGTERM_GRACE);
    assert!(live_pids(&scratch.pidfile()).is_empty());
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
    let rows = diagnostic_rows(&scratch);
    assert_eq!(
        rows.iter()
            .filter(|row| row["event"] == "compat_reaped")
            .count(),
        3
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["event"] == "compat_failure")
            .count(),
        0
    );
    assert!(wall.elapsed() < Duration::from_secs(8));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_3_drain_readiness_timeout_no_leaked_task() {
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
    assert_eq!(shutdown(supervisor).await, super::CompatExit::Interrupted);
    assert!(live_pids(&scratch.pidfile()).is_empty());
    assert!(wall.elapsed() < Duration::from_secs(8));
    let rows = diagnostic_rows(&scratch);
    let failure = rows
        .iter()
        .find(|row| row["event"] == "compat_failure")
        .unwrap();
    assert_eq!(failure["reason"], "readiness_timeout");
    assert!(failure["termination"].is_null());
}

fn diagnostic_rows(scratch: &Scratch) -> Vec<serde_json::Value> {
    std::fs::read_to_string(scratch.root.join("data/logs/desktop.jsonl"))
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}

#[tokio::test]
async fn ticket_t_2_crash_diagnostics_preserve_exit_without_backend_secrets() {
    let scratch = Scratch::new("crash-facts");
    let mut spec = shell_spec(&scratch);
    spec.script = "read line; printf '%s\\n' '{\"level\":50,\"event\":\"desktop_start_failed\",\"message\":\"SECRET_TOKEN_PRIVATE_PATH\"}'; exit 7";
    let supervisor =
        super::Supervisor::launch_shell(spec, super::SupervisorConfig::default()).unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| {
        matches!(state, super::Status::Backoff { .. })
    })
    .await;
    supervisor.disarm_restarts();
    shutdown(supervisor).await;
    assert!(live_pids(&scratch.pidfile()).is_empty());
    let rows = diagnostic_rows(&scratch);
    let failure = rows
        .iter()
        .find(|row| row["event"] == "compat_failure")
        .unwrap();
    assert_eq!(failure["reason"], "child_exit");
    assert_eq!(
        failure["termination"],
        serde_json::json!({"kind":"exit_code","value":7})
    );
    assert!(rows.iter().any(|row| row["event"] == "compat_start_failed"));
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("SECRET_TOKEN_PRIVATE_PATH")
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_3_drain_never_started_child_is_graceful() {
    let scratch = Scratch::new("spawn-facts");
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
    supervisor.disarm_restarts();
    assert_eq!(shutdown(supervisor).await, super::CompatExit::Graceful);
    let rows = diagnostic_rows(&scratch);
    let failure = rows
        .iter()
        .find(|row| row["event"] == "compat_failure")
        .unwrap();
    assert_eq!(failure["reason"], "spawn_failed");
    assert!(failure["termination"].is_null());
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains(scratch.root.to_str().unwrap())
    );
}

#[tokio::test]
async fn ticket_t_2_crash_signal_is_distinct_from_parent_cleanup() {
    let scratch = Scratch::new("signal-facts");
    let mut spec = shell_spec(&scratch);
    spec.script = "read line; kill -TERM $$";
    let supervisor =
        super::Supervisor::launch_shell(spec, super::SupervisorConfig::default()).unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| {
        matches!(state, super::Status::Backoff { .. })
    })
    .await;
    supervisor.disarm_restarts();
    shutdown(supervisor).await;
    let rows = diagnostic_rows(&scratch);
    let failure = rows
        .iter()
        .find(|row| row["event"] == "compat_failure")
        .unwrap();
    assert_eq!(failure["reason"], "child_exit");
    assert_eq!(
        failure["termination"],
        serde_json::json!({"kind":"signal","value":15})
    );
    assert!(live_pids(&scratch.pidfile()).is_empty());
}

async fn health_failure_shutdown(disarm_while_ready: bool) {
    let scratch = Scratch::new("health-facts");
    let mut spec = shell_spec(&scratch);
    spec.script = r#"exec /usr/bin/node -e 'const http=require("node:http"); const input=require("node:readline").createInterface({input:process.stdin}); input.on("close",()=>process.exit(0)); input.once("line",line=>{const setup=JSON.parse(line); let checks=0; http.createServer((req,res)=>{checks++; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ok:checks===1,version:"ticket-t-2-unreleased",release:{commit:"ticket-t-2-unreleased"}}));}).listen(setup.socket_path);});'"#;
    let supervisor =
        super::Supervisor::launch_shell(spec, super::SupervisorConfig::default()).unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| {
        matches!(state, super::Status::Ready { .. })
    })
    .await;
    if disarm_while_ready {
        supervisor.disarm_restarts();
    }
    tokio::time::timeout(Duration::from_secs(35), async {
        while !matches!(
            *status.borrow(),
            super::Status::Stopped | super::Status::Backoff { .. }
        ) {
            status.changed().await.unwrap();
        }
    })
    .await
    .expect("three real ten-second liveness checks");
    supervisor.disarm_restarts();
    assert!(!supervisor.stop.is_cancelled());
    assert_eq!(shutdown(supervisor).await, super::CompatExit::Interrupted);
    let rows = diagnostic_rows(&scratch);
    assert!(rows.iter().any(|row| row["event"] == "compat_reaped"));
    if !disarm_while_ready {
        let failures: Vec<_> = rows
            .iter()
            .filter(|row| row["event"] == "compat_failure")
            .collect();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0]["reason"], "health_lost");
        assert!(failures[0]["termination"].is_null());
    }
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 1);
    assert!(live_pids(&scratch.pidfile()).is_empty());
}

#[tokio::test]
async fn ticket_t_3_drain_health_failure_after_disarm_is_interrupted() {
    health_failure_shutdown(true).await;
}

#[tokio::test]
async fn ticket_t_2_three_health_failures_record_cause_without_cleanup_exit() {
    health_failure_shutdown(false).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_2_guard_logs_five_failure_facts_then_stops_restarts() {
    let scratch = Scratch::new("guard-facts");
    let supervisor = super::Supervisor::start_with_config(
        release_spec(&scratch),
        super::SupervisorConfig::default(),
    )
    .unwrap();
    let mut status = supervisor.handle.status.clone();
    wait_status(&mut status, |state| matches!(state, super::Status::Guarded)).await;
    let rows = diagnostic_rows(&scratch);
    assert_eq!(
        rows.iter()
            .filter(|row| row["event"] == "compat_failure")
            .count(),
        5
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["event"] == "compat_crash_guard")
            .count(),
        1
    );
    supervisor.disarm_restarts();
    shutdown(supervisor).await;
    let rows = diagnostic_rows(&scratch);
    assert_eq!(
        rows.iter()
            .filter(|row| row["event"] == "compat_starting")
            .count(),
        5
    );
}

fn crash_guard_spec(scratch: &Scratch) -> super::ShellSpec {
    let mut spec = shell_spec(scratch);
    spec.script = r#"read line || exit 1; data=${line#*'"data_dir":"'}; data=${data%%'"'*}; if [ -f "$data/hold" ]; then while read line; do :; done; else exit 7; fi"#;
    spec
}

fn shell_exited(pid: u32) -> bool {
    if super::drain::process_group_absent(pid) {
        return true;
    }
    // Observe the exit without taking the supervisor's wait status.
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    result == 0 && unsafe { info.si_pid() } == pid as i32
}

async fn wait_shell_crash(
    supervisor: &super::Supervisor,
    scratch: &Scratch,
    expected: usize,
    guarded: bool,
) {
    let fuse = wall_fuse(Duration::from_secs(8));
    let policy_started = tokio::time::Instant::now();
    let mut startup_ticks = 0;
    let mut cleanup_ticks = 0;
    let mut next_tick = std::time::Instant::now();
    loop {
        let state = supervisor.handle.status.borrow().clone();
        let pids = recorded_pids(&scratch.pidfile());
        if pids.len() == expected
            && if guarded {
                matches!(state, super::Status::Guarded)
            } else {
                matches!(state, super::Status::Backoff { .. })
            }
        {
            break;
        }
        assert!(
            !fuse.is_cancelled(),
            "crash {expected} stalled at {state:?}"
        );
        let pid = pids.get(expected - 1).copied();
        if std::time::Instant::now() >= next_tick {
            let tick = match state {
                super::Status::Starting if startup_ticks < 8 && pid.is_some_and(shell_exited) => {
                    startup_ticks += 1;
                    Some(Duration::from_millis(250))
                }
                super::Status::Stopping
                    if cleanup_ticks < 2 && pid.is_some_and(super::drain::process_group_absent) =>
                {
                    cleanup_ticks += 1;
                    Some(Duration::from_millis(10))
                }
                _ => None,
            };
            if let Some(tick) = tick {
                tokio::time::advance(tick).await;
                next_tick = std::time::Instant::now() + Duration::from_secs(1);
            }
        }
        tokio::task::yield_now().await;
    }
    assert!(policy_started.elapsed() <= Duration::from_millis(2020));
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), expected);
    assert!(live_pids(&scratch.pidfile()).is_empty());
    let rows = diagnostic_rows(scratch);
    let failures: Vec<_> = rows
        .iter()
        .filter(|row| row["event"] == "compat_failure")
        .collect();
    assert_eq!(failures.len(), expected);
    for failure in failures {
        assert_eq!(failure["reason"], "child_exit");
        assert_eq!(
            failure["termination"],
            serde_json::json!({"kind":"exit_code","value":7})
        );
    }
    assert_eq!(
        rows.iter()
            .filter(|row| row["event"] == "compat_reaped")
            .count(),
        expected
    );
}

async fn advance_crash_backoff(supervisor: &super::Supervisor) {
    let attempt = match *supervisor.handle.status.borrow() {
        super::Status::Backoff { attempt } => attempt,
        ref state => panic!("expected pending restart, got {state:?}"),
    };
    tokio::time::advance(super::backoff(attempt)).await;
}

async fn shutdown_guard_shell(supervisor: super::Supervisor, scratch: &Scratch) {
    let pid = *recorded_pids(&scratch.pidfile()).last().unwrap();
    let stopping = supervisor.shutdown();
    tokio::pin!(stopping);
    let fuse = wall_fuse(Duration::from_secs(8));
    let mut cleanup_tick = false;
    loop {
        tokio::select! {
            biased;
            _ = fuse.cancelled() => panic!("shell shutdown stalled"),
            result = &mut stopping => { result.unwrap(); return; }
            _ = tokio::task::yield_now() => {}
        }
        if !cleanup_tick && super::drain::process_group_absent(pid) {
            tokio::time::advance(Duration::from_millis(10)).await;
            cleanup_tick = true;
        }
    }
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_2_five_shell_crashes_guard_until_explicit_recovery() {
    let scratch = Scratch::new("guard-runtime");
    let supervisor = super::Supervisor::launch_shell(
        crash_guard_spec(&scratch),
        super::SupervisorConfig::default(),
    )
    .unwrap();
    let started = tokio::time::Instant::now();
    for count in 1..=5 {
        wait_shell_crash(&supervisor, &scratch, count, count == 5).await;
        if count == 4 {
            tokio::time::advance(Duration::from_secs(100)).await;
        } else if count < 5 {
            advance_crash_backoff(&supervisor).await;
        }
    }
    assert!(started.elapsed() >= Duration::from_secs(100));
    assert!(started.elapsed() < Duration::from_secs(120));
    tokio::time::advance(Duration::from_secs(300)).await;
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert!(matches!(
        *supervisor.handle.status.borrow(),
        super::Status::Guarded
    ));
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 5);
    assert!(live_pids(&scratch.pidfile()).is_empty());

    std::fs::write(scratch.root.join("data/hold"), "").unwrap();
    let handle = supervisor.handle.clone();
    handle.recover().await.unwrap();
    wait_live(&scratch.pidfile(), 6).await;
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 6);
    let recovered = *recorded_pids(&scratch.pidfile()).last().unwrap();
    assert_eq!(live_pids(&scratch.pidfile()), vec![recovered]);
    assert!(handle.recover().await.is_err());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 6);
    assert_eq!(live_pids(&scratch.pidfile()), vec![recovered]);
    shutdown_guard_shell(supervisor, &scratch).await;
    tokio::time::advance(Duration::from_secs(300)).await;
    assert!(matches!(*handle.status.borrow(), super::Status::Stopped));
    assert_eq!(recorded_pids(&scratch.pidfile()).len(), 6);
    assert!(live_pids(&scratch.pidfile()).is_empty());
    assert_eq!(
        diagnostic_rows(&scratch)
            .iter()
            .filter(|row| row["event"] == "compat_reaped")
            .count(),
        6
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ticket_t_2_shell_crashes_expire_outside_default_guard_window() {
    let scratch = Scratch::new("guard-expiry");
    let supervisor = super::Supervisor::launch_shell(
        crash_guard_spec(&scratch),
        super::SupervisorConfig::default(),
    )
    .unwrap();
    for count in 1..=4 {
        wait_shell_crash(&supervisor, &scratch, count, false).await;
        if count < 4 {
            advance_crash_backoff(&supervisor).await;
        }
    }
    tokio::time::advance(Duration::from_secs(121)).await;
    let recent = tokio::time::Instant::now();
    for count in 5..=9 {
        wait_shell_crash(&supervisor, &scratch, count, count == 9).await;
        if count < 9 {
            advance_crash_backoff(&supervisor).await;
        }
    }
    assert!(recent.elapsed() < Duration::from_secs(120));
    assert_eq!(
        diagnostic_rows(&scratch)
            .iter()
            .filter(|row| row["event"] == "compat_crash_guard")
            .count(),
        1
    );
    shutdown_guard_shell(supervisor, &scratch).await;
    assert!(live_pids(&scratch.pidfile()).is_empty());
}
