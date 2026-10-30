//! One measured run of an app process: startup to readiness, idle CPU and
//! process-tree memory, plus the size of the package it ships in.

use std::ffi::OsString;
use std::fmt;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::cpu::{clock_ticks_per_second, tree_cpu_ticks};
use crate::pss::{PssError, sample_process_tree};
use crate::record::Machine;

#[derive(Clone, Debug)]
pub struct CaptureOptions {
    /// Program and arguments. The app is ready when it prints its first line
    /// on stdout, as `pp-server` prints its origin once the runtime is up.
    pub command: Vec<OsString>,
    pub ready_timeout: Duration,
    /// How long the ready app is left alone while its CPU time is counted.
    pub idle: Duration,
    /// How long the app gets to exit after SIGTERM before it is killed.
    pub stop_timeout: Duration,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunSample {
    pub startup_ready_ms: f64,
    /// Process-tree CPU time over the idle window, as a percentage of one
    /// core. A tree busy on two cores reads 200.
    pub idle_cpu_percent: f64,
    /// Linux PSS of the process tree, sampled after the idle window.
    pub pss_bytes: u64,
    /// The first stdout line, such as the origin `pp-server` announces.
    pub ready_line: String,
}

#[derive(Debug)]
pub enum CaptureError {
    EmptyCommand,
    Spawn(std::io::Error),
    /// The app closed stdout or exited before printing a line.
    ExitedBeforeReady,
    NotReady(Duration),
    NoClockTicks,
    Proc(PssError),
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyCommand => write!(f, "no command to run"),
            Self::Spawn(error) => write!(f, "could not start the command: {error}"),
            Self::ExitedBeforeReady => write!(f, "the app closed stdout before its ready line"),
            Self::NotReady(timeout) => write!(f, "no ready line within {timeout:?}"),
            Self::NoClockTicks => write!(f, "clock ticks per second are unavailable"),
            Self::Proc(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl From<PssError> for CaptureError {
    fn from(error: PssError) -> Self {
        Self::Proc(error)
    }
}

/// Starts the command, waits for its ready line, counts CPU over the idle
/// window, samples PSS, then stops it with SIGTERM (SIGKILL after
/// `stop_timeout`). The app is stopped on every path, success or error.
pub fn capture_run(options: &CaptureOptions) -> Result<RunSample, CaptureError> {
    let (program, args) = options
        .command
        .split_first()
        .ok_or(CaptureError::EmptyCommand)?;
    let ticks_per_second = clock_ticks_per_second().ok_or(CaptureError::NoClockTicks)?;
    let started = Instant::now();
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // Its own process group, so `stop` can clear anything the app leaves behind.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(CaptureError::Spawn)?;
    let (ready, ready_rx) = mpsc::channel();
    let stdout = child.stdout.take().expect("stdout is piped");
    // Keep draining stdout after the ready line so the app never blocks on a
    // full pipe while it is measured.
    let reader = std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        let first = lines.next().and_then(Result::ok);
        let _ = ready.send(first);
        for _ in lines.map_while(Result::ok) {}
    });
    let result = measure(&mut child, &ready_rx, started, ticks_per_second, options);
    stop(&mut child, options.stop_timeout);
    // Not joined: a process outside the app's group may still hold stdout,
    // and the reader ends on its own once the pipe closes.
    drop(reader);
    result
}

fn measure(
    child: &mut Child,
    ready_rx: &mpsc::Receiver<Option<String>>,
    started: Instant,
    ticks_per_second: u64,
    options: &CaptureOptions,
) -> Result<RunSample, CaptureError> {
    let ready_line = match ready_rx.recv_timeout(options.ready_timeout) {
        Ok(Some(line)) => line,
        Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(CaptureError::ExitedBeforeReady);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(CaptureError::NotReady(options.ready_timeout));
        }
    };
    let startup_ready_ms = started.elapsed().as_secs_f64() * 1000.0;
    let pid = child.id();
    let before = tree_cpu_ticks(pid)?;
    let window = Instant::now();
    std::thread::sleep(options.idle);
    let after = tree_cpu_ticks(pid)?;
    let seconds = window.elapsed().as_secs_f64();
    // A descendant that exits takes its ticks out of the sum, so the count can
    // only be undercounted, never negative.
    let used = after.saturating_sub(before) as f64 / ticks_per_second as f64;
    let pss = sample_process_tree(pid)?;
    Ok(RunSample {
        startup_ready_ms,
        idle_cpu_percent: used / seconds * 100.0,
        pss_bytes: pss.pss_bytes,
        ready_line,
    })
}

/// SIGTERM to the app, SIGKILL after `timeout`, then SIGKILL to whatever is
/// left in its process group, so no process outlives the run.
fn stop(child: &mut Child, timeout: Duration) {
    #[cfg(unix)]
    let group = libc::pid_t::try_from(child.id()).ok();
    if !matches!(child.try_wait(), Ok(Some(_))) {
        #[cfg(unix)]
        if let Some(pid) = group {
            // SAFETY: the pid names our own unreaped child, so it cannot be reused.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline && !matches!(child.try_wait(), Ok(Some(_))) {
            std::thread::sleep(Duration::from_millis(20));
        }
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    #[cfg(unix)]
    if let Some(pgid) = group {
        // SAFETY: the kernel keeps a pid reserved while its process group has
        // members, and an empty group answers ESRCH, so this hits only the app's group.
        unsafe { libc::kill(-pgid, libc::SIGKILL) };
    }
}

/// Bytes on disk under `path`: a file's length, or the sum over a directory
/// tree. Symlinks count as themselves and are not followed.
pub fn package_bytes(path: &Path) -> std::io::Result<u64> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Ok(metadata.len());
    }
    let mut total = 0u64;
    for entry in std::fs::read_dir(path)? {
        total += package_bytes(&entry?.path())?;
    }
    Ok(total)
}

/// The machine this process runs on, as a [`Machine`] record. Fields the OS
/// does not expose read `unknown`.
pub fn this_machine() -> Machine {
    let read = |path: &str| std::fs::read_to_string(path).ok();
    let cpu_model = read("/proc/cpuinfo")
        .and_then(|info| {
            info.lines()
                .find_map(|line| line.strip_prefix("model name"))
                .and_then(|rest| rest.split_once(':'))
                .map(|(_, model)| model.trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    Machine {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        kernel: read("/proc/sys/kernel/osrelease")
            .map(|release| release.trim().to_owned())
            .unwrap_or_else(|| "unknown".into()),
        cpu_model,
        logical_cpus: std::thread::available_parallelism()
            .map_or(0, |n| u32::try_from(n.get()).unwrap_or(u32::MAX)),
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a time at or after the Unix epoch.
pub fn utc_timestamp(time: std::time::SystemTime) -> String {
    let seconds = time
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // Howard Hinnant's civil_from_days, for days since 1970-01-01.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}
