use anyhow::{Context, Result};
use std::{process::ExitStatus, time::Duration};
use tokio::process::{Child, ChildStdin};

pub const SIGTERM_GRACE: Duration = Duration::from_secs(10);
const GROUP_REAP: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum GroupExit {
    Observed(ExitStatus),
    Forced(ExitStatus),
}

#[derive(Debug)]
pub struct GroupStopReport {
    pub exit: GroupExit,
    pub eof_closed: bool,
    pub sigterm_sent: bool,
    pub grace_exhausted: bool,
    pub elapsed: Duration,
    pub group_absent: bool,
    pub restarts_enabled: bool,
}

pub fn restarts_allowed(shutting_down: bool) -> bool {
    !shutting_down
}

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

pub fn process_group_absent(pid: u32) -> bool {
    !group_alive(pid)
}

pub fn reap_process_group(pid: u32) {
    if pid > 0 {
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
}

fn group_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(-(pid as i32), 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

pub fn reject_and_arm_eof(
    eof_watchdog: bool,
    stdin: &mut Option<ChildStdin>,
    reject_new_work: &mut dyn FnMut(),
) -> bool {
    reject_new_work();
    if eof_watchdog {
        drop(stdin.take());
        true
    } else {
        false
    }
}

pub async fn drive_shutdown_group(
    child: &mut Child,
    pid: u32,
    eof_closed: bool,
    grace: Duration,
    already_exited: Option<ExitStatus>,
) -> Result<GroupStopReport> {
    let started = tokio::time::Instant::now();
    let (exit, sigterm_sent, grace_exhausted) = if let Some(status) = already_exited {
        (GroupExit::Observed(status), false, false)
    } else {
        reap_process_group_signal(pid, libc::SIGTERM);
        match tokio::time::timeout(grace, child.wait()).await {
            Ok(result) => (
                GroupExit::Observed(result.context("Child reap failed")?),
                true,
                false,
            ),
            Err(_) => {
                reap_process_group(pid);
                let _ = child.start_kill();
                match tokio::time::timeout(GROUP_REAP, child.wait()).await {
                    Ok(result) => (
                        GroupExit::Forced(result.context("Child reap failed")?),
                        true,
                        true,
                    ),
                    Err(error) => {
                        let _ = wait_until_group_absent(pid).await;
                        return Err(error).context("Child reap timed out");
                    }
                }
            }
        }
    };
    reap_process_group(pid);
    let group_absent = wait_until_group_absent(pid).await.is_ok();
    Ok(GroupStopReport {
        exit,
        eof_closed,
        sigterm_sent,
        grace_exhausted,
        elapsed: started.elapsed(),
        group_absent,
        restarts_enabled: false,
    })
}

fn reap_process_group_signal(pid: u32, signal: i32) {
    if pid > 0 {
        unsafe { libc::kill(-(pid as i32), signal) };
    }
}

async fn wait_until_group_absent(pid: u32) -> Result<()> {
    tokio::time::timeout(GROUP_REAP, async {
        loop {
            if !group_alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .context("Process group still present")
}
