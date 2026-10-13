use pp_core::{
    GroupStopReport, MUTATION_DRAIN, SIGTERM_GRACE, ShutdownGate, drive_shutdown_group,
    process_alive, process_group_absent, reap_process_group, reject_and_arm_eof, restarts_allowed,
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::process::Command;

fn child_program() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let dir = std::env::var_os("CARGO_TARGET_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let source = dir.join(format!("pp-t3-drain-child-{}.rs", std::process::id()));
        let binary = dir.join(format!("pp-t3-drain-child-{}", std::process::id()));
        std::fs::write(&source, include_str!("fixtures/drain_child.rs")).unwrap();
        let status = std::process::Command::new(
            std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned()),
        )
        .args(["--edition=2021", "-O"])
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .status()
        .expect("rustc unavailable");
        assert!(status.success(), "drain child failed to compile");
        binary
    })
}

struct GroupGuard(u32);
impl Drop for GroupGuard {
    fn drop(&mut self) {
        reap_process_group(self.0);
    }
}

async fn spawn(mode: &str, argument: &Path) -> (tokio::process::Child, u32, GroupGuard) {
    let mut command = Command::new(child_program());
    command
        .arg(mode)
        .arg(argument)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let child = command.spawn().unwrap();
    let pid = child.id().unwrap();
    (child, pid, GroupGuard(pid))
}

async fn wait_for_text(path: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if std::fs::read_to_string(path)
            .unwrap_or_default()
            .contains(expected)
        {
            return;
        }
        assert!(Instant::now() < deadline, "child was not ready");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Ok(pid) = text.trim().parse::<u32>()
            && process_alive(pid)
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "grandchild was not started");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn arm_shutdown(
    stdin: &mut Option<tokio::process::ChildStdin>,
    eof_watchdog: bool,
    mut reject: impl FnMut(),
) -> bool {
    reject_and_arm_eof(eof_watchdog, stdin, &mut reject)
}

async fn finish_shutdown(
    child: &mut tokio::process::Child,
    pid: u32,
    eof_closed: bool,
    grace: Duration,
) -> GroupStopReport {
    drive_shutdown_group(child, pid, eof_closed, grace, None)
        .await
        .unwrap()
}

#[tokio::test]
async fn ticket_t_3_drain_deadlines_and_restart_hook() {
    assert_eq!(MUTATION_DRAIN, Duration::from_secs(5));
    assert_eq!(SIGTERM_GRACE, Duration::from_secs(10));
    assert!(!restarts_allowed(true));
    assert!(restarts_allowed(false));
}

#[tokio::test]
async fn ticket_t_3_drain_rejects_new_work_and_does_not_resend() {
    let gate = ShutdownGate::new();
    let work = gate.track().unwrap();
    let resent = Arc::new(AtomicUsize::new(0));
    let cancel = gate.cancellation();
    let resent_task = resent.clone();
    let handle = tokio::spawn(async move {
        tokio::select! {
            _ = cancel.cancelled() => drop(work),
            _ = tokio::time::sleep(Duration::from_secs(30)) => {
                resent_task.fetch_add(1, Ordering::SeqCst);
                drop(work);
            }
        }
    });
    gate.reject_new();
    assert!(gate.track().is_err());
    let started = Instant::now();
    assert!(gate.wait_idle(Duration::from_secs(5)).await);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(resent.load(Ordering::SeqCst), 0);
    handle.await.unwrap();
}

#[tokio::test]
async fn ticket_t_3_drain_waits_out_blocking_work_before_close() {
    let gate = ShutdownGate::new();
    let work = gate.track().unwrap();
    gate.reject_new();
    let started = Instant::now();
    assert!(!gate.wait_idle(Duration::from_millis(80)).await);
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(80));
    assert!(elapsed < Duration::from_millis(500));
    drop(work);
    assert!(gate.wait_idle(Duration::from_millis(50)).await);
}

#[tokio::test]
async fn ticket_t_3_drain_sigterm_reaps_the_group() {
    let dir = std::env::temp_dir().join(format!("pp-t3-coop-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let pidfile = dir.join("grand.pid");
    let (mut child, pid, _guard) = spawn("cooperative", &pidfile).await;
    let grand = wait_for_pid(&pidfile).await;
    let mut stdin = child.stdin.take();
    let mut rejected_while_alive = false;
    let started = Instant::now();
    let eof_closed = arm_shutdown(&mut stdin, true, || {
        rejected_while_alive = process_alive(pid);
    });
    let report = finish_shutdown(&mut child, pid, eof_closed, Duration::from_secs(2)).await;
    let elapsed = started.elapsed();
    assert!(rejected_while_alive);
    assert!(report.sigterm_sent);
    assert!(report.eof_closed);
    assert!(!report.grace_exhausted);
    assert!(!report.restarts_enabled);
    assert!(report.group_absent);
    assert!(process_group_absent(pid));
    assert!(!process_alive(grand));
    assert!(elapsed < Duration::from_secs(2));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn ticket_t_3_drain_force_kill_waits_out_the_grace() {
    let dir = std::env::temp_dir().join(format!("pp-t3-force-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let pidfile = dir.join("grand.pid");
    let (mut child, pid, _guard) = spawn("stubborn", &pidfile).await;
    let grand = wait_for_pid(&pidfile).await;
    let mut stdin = child.stdin.take();
    let grace = Duration::from_millis(250);
    let started = Instant::now();
    let eof_closed = arm_shutdown(&mut stdin, false, || {});
    let report = finish_shutdown(&mut child, pid, eof_closed, grace).await;
    let elapsed = started.elapsed();
    assert!(report.sigterm_sent);
    assert!(!report.eof_closed);
    assert!(report.grace_exhausted);
    assert!(!report.restarts_enabled);
    assert!(report.group_absent);
    assert!(!process_alive(pid));
    assert!(!process_alive(grand));
    assert!(elapsed >= grace);
    assert!(elapsed < Duration::from_secs(2));
    assert!(stdin.is_some());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn ticket_t_3_drain_second_start_sees_a_dead_group() {
    let mut pids = Vec::new();
    for index in 0..2 {
        let dir = std::env::temp_dir().join(format!("pp-t3-repeat-{}-{index}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("grand.pid");
        let (mut child, pid, _guard) = spawn("cooperative", &pidfile).await;
        let _grand = wait_for_pid(&pidfile).await;
        assert!(pids.iter().all(|previous| process_group_absent(*previous)));
        let mut stdin = child.stdin.take();
        let eof_closed = arm_shutdown(&mut stdin, true, || {});
        let report = finish_shutdown(&mut child, pid, eof_closed, Duration::from_secs(2)).await;
        assert!(report.group_absent);
        assert!(process_group_absent(pid));
        pids.push(pid);
        std::fs::remove_dir_all(&dir).unwrap();
    }
    assert_ne!(pids[0], pids[1]);
}

#[tokio::test]
async fn ticket_t_3_drain_eof_watchdog_follows_the_compat_flag() {
    let dir = std::env::temp_dir().join(format!("pp-t3-eof-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let armed = dir.join("armed");
    let disarmed = dir.join("disarmed");
    let (mut armed_child, armed_pid, _armed_guard) = spawn("eof", &armed).await;
    wait_for_text(&armed, "READY").await;
    let mut armed_stdin = armed_child.stdin.take();
    let armed_closed = arm_shutdown(&mut armed_stdin, true, || {});
    let armed_report = finish_shutdown(
        &mut armed_child,
        armed_pid,
        armed_closed,
        Duration::from_secs(2),
    )
    .await;
    let armed_events = std::fs::read_to_string(&armed).unwrap();
    assert!(armed_report.eof_closed);
    assert!(!armed_report.grace_exhausted);
    assert!(armed_events.contains("EOF"));
    assert!(armed_stdin.is_none());

    let (mut child, pid, _guard) = spawn("eof", &disarmed).await;
    wait_for_text(&disarmed, "READY").await;
    let mut stdin = child.stdin.take();
    let grace = Duration::from_millis(200);
    let started = Instant::now();
    let eof_closed = arm_shutdown(&mut stdin, false, || {});
    let report = finish_shutdown(&mut child, pid, eof_closed, grace).await;
    let events = std::fs::read_to_string(&disarmed).unwrap_or_default();
    assert!(!report.eof_closed);
    assert!(report.grace_exhausted);
    assert!(report.group_absent);
    assert!(events.contains("READY"));
    assert!(!events.contains("EOF"));
    assert!(started.elapsed() >= grace);
    assert!(stdin.is_some());
    std::fs::remove_dir_all(&dir).unwrap();
}
