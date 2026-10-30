//! Launches an app under test and measures one run of it for T-53
//! (GRE-388). Spawning lives here because pp-core owns process lifecycle;
//! records, the regression gate and `/proc` sampling stay in `pp_perf`.
//!
//! The launcher knows only a command and a readiness signal: the app is ready
//! when it prints its first line on stdout, as `pp-server` prints its origin.

use std::ffi::OsString;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime};

use pp_perf::{
    Artifact, Measurement, Metric, PssError, SCHEMA_VERSION, Toolchain, clock_ticks_per_second,
    package_bytes, sample_process_tree, this_machine, tree_cpu_ticks, utc_timestamp,
};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct CaptureOptions {
    /// Program and arguments of the app under test.
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
    /// core. A tree busy on two cores reads 200. Ticks of a descendant that
    /// exits during the window leave the sum with it, so this can undercount.
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
    /// CPU ticks and PSS are read from Linux `/proc`.
    NoClockTicks,
    Proc(PssError),
    /// Seeding simulated printers into the app failed.
    Seed(String),
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
            Self::Seed(detail) => write!(f, "seeding simulated printers: {detail}"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl From<PssError> for CaptureError {
    fn from(error: PssError) -> Self {
        Self::Proc(error)
    }
}

/// The launched app once it has printed its ready line.
#[derive(Clone, Debug)]
pub struct ReadyApp {
    pub pid: u32,
    /// The first stdout line, such as the origin `pp-server` announces.
    pub ready_line: String,
    /// From just before spawn to the ready line.
    pub startup: Duration,
}

/// Starts the command in its own process group, waits for its first stdout
/// line, then runs `while_ready` against the live app. The app is stopped on
/// every path, success or error: SIGTERM, SIGKILL after `stop_timeout`, then
/// SIGKILL to whatever is left in its group.
pub fn with_ready_app<T>(
    command: &[OsString],
    ready_timeout: Duration,
    stop_timeout: Duration,
    while_ready: impl FnOnce(&ReadyApp) -> Result<T, CaptureError>,
) -> Result<T, CaptureError> {
    let (program, args) = command.split_first().ok_or(CaptureError::EmptyCommand)?;
    let started = Instant::now();
    let mut process = Command::new(program);
    process
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut process, 0);
    let mut child = process.spawn().map_err(CaptureError::Spawn)?;
    let (ready, ready_rx) = mpsc::channel();
    // Keep draining stdout after the ready line so the app never blocks on a
    // full pipe while it is measured. Not joined: a process outside the app's
    // group may still hold stdout, and the reader ends once the pipe closes.
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            let first = lines.next().and_then(Result::ok);
            let _ = ready.send(first);
            for _ in lines.map_while(Result::ok) {}
        });
    }
    let result = match ready_rx.recv_timeout(ready_timeout) {
        Ok(Some(ready_line)) => while_ready(&ReadyApp {
            pid: child.id(),
            ready_line,
            startup: started.elapsed(),
        }),
        Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(CaptureError::ExitedBeforeReady)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => Err(CaptureError::NotReady(ready_timeout)),
    };
    stop(&mut child, stop_timeout);
    result
}

/// One measured run: [`with_ready_app`], then process-tree CPU over the idle
/// window and PSS.
pub fn capture_run(options: &CaptureOptions) -> Result<RunSample, CaptureError> {
    let ticks_per_second = clock_ticks_per_second().ok_or(CaptureError::NoClockTicks)?;
    with_ready_app(
        &options.command,
        options.ready_timeout,
        options.stop_timeout,
        |app| {
            let before = tree_cpu_ticks(app.pid)?;
            let window = Instant::now();
            std::thread::sleep(options.idle);
            let after = tree_cpu_ticks(app.pid)?;
            let seconds = window.elapsed().as_secs_f64();
            // A descendant that exits takes its ticks out of the sum, so the
            // count can only be undercounted, never negative.
            let used = after.saturating_sub(before) as f64 / ticks_per_second as f64;
            let pss = sample_process_tree(app.pid)?;
            Ok(RunSample {
                startup_ready_ms: app.startup.as_secs_f64() * 1000.0,
                idle_cpu_percent: used / seconds * 100.0,
                pss_bytes: pss.pss_bytes,
                ready_line: app.ready_line.clone(),
            })
        },
    )
}

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

/// One capture: repeated runs of one artifact, written as Measurement files.
#[derive(Clone, Debug)]
pub struct CaptureRequest {
    pub kind: String,
    pub name: String,
    /// Hashed into every record.
    pub artifact: PathBuf,
    /// What package size measures; the artifact itself when `None`.
    pub package: Option<PathBuf>,
    pub runs: usize,
    pub options: CaptureOptions,
    pub noise_tolerance_pct: f64,
    /// Simulated Moonraker printers to seed before the measured runs (0 for
    /// none). Seeding is `pp-server`-specific: see [`crate::perf_seed`]. The
    /// command must name a data directory the setup launch and the measured
    /// runs share.
    pub printers: u32,
    pub toolchain: Toolchain,
    pub out: PathBuf,
}

/// The files `write_capture` creates in `out`, one per metric.
pub const CAPTURE_FILES: [(&str, Metric); 4] = [
    ("startup_ready_ms.json", Metric::StartupReadyMs),
    ("idle_cpu_percent.json", Metric::IdleCpuPercent),
    ("memory_linux_pss_bytes.json", Metric::MemoryLinuxPssBytes),
    ("package_bytes.json", Metric::PackageBytes),
];

/// What [`write_capture`] wrote, and how much the simulators were asked.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureSummary {
    pub files: Vec<PathBuf>,
    /// Printers the app listed after seeding; recorded in every Measurement.
    pub simulated_printers: u32,
    /// Requests the simulators answered during the measured runs. Their CPU
    /// is the harness's, outside the measured tree.
    pub simulator_requests: usize,
}

/// Seeds `printers` simulated printers if asked, then repeats
/// [`capture_run`] with the simulators answering and writes one Measurement
/// per metric into `out`. Each file is created new, so an earlier capture is
/// never overwritten.
pub fn write_capture(request: &CaptureRequest) -> Result<CaptureSummary, String> {
    if request.runs == 0 {
        return Err("at least one run is required".into());
    }
    // Refuse before spending the runs; `create_new` below still guards a race.
    for (file, _) in CAPTURE_FILES {
        let path = request.out.join(file);
        if path.exists() {
            return Err(format!("{}: already exists", path.display()));
        }
    }
    let artifact = Artifact {
        kind: request.kind.clone(),
        name: request.name.clone(),
        sha256: sha256_file(&request.artifact)
            .map_err(|e| format!("{}: {e}", request.artifact.display()))?,
    };
    let package = request.package.as_deref().unwrap_or(&request.artifact);
    let simulators = crate::perf_seed::SimulatedPrinters::start(request.printers as usize)
        .map_err(|e| format!("starting simulated printers: {e}"))?;
    let simulated_printers = if request.printers == 0 {
        0
    } else {
        let options = &request.options;
        let seeded = crate::perf_seed::seed_printers(
            &options.command,
            &simulators,
            options.ready_timeout,
            options.stop_timeout,
        )
        .map_err(|e| format!("setup run: {e}"))?;
        u32::try_from(seeded).map_err(|_| "too many seeded printers".to_owned())?
    };
    let before_runs = simulators.requests();
    let mut samples: [Vec<f64>; 4] = Default::default();
    for run in 1..=request.runs {
        let sample = capture_run(&request.options).map_err(|e| format!("run {run}: {e}"))?;
        let size = package_bytes(package).map_err(|e| format!("{}: {e}", package.display()))?;
        samples[0].push(sample.startup_ready_ms);
        samples[1].push(sample.idle_cpu_percent);
        samples[2].push(sample.pss_bytes as f64);
        samples[3].push(size as f64);
    }
    let simulator_requests = simulators.requests() - before_runs;
    drop(simulators);
    let captured_at = utc_timestamp(SystemTime::now());
    let machine = this_machine();
    std::fs::create_dir_all(&request.out).map_err(|e| format!("{}: {e}", request.out.display()))?;
    let mut written = Vec::with_capacity(CAPTURE_FILES.len());
    for ((file, metric), samples) in CAPTURE_FILES.into_iter().zip(samples) {
        let measurement = Measurement {
            schema: SCHEMA_VERSION,
            metric,
            samples,
            noise_tolerance_pct: request.noise_tolerance_pct,
            simulated_printers,
            captured_at: captured_at.clone(),
            machine: machine.clone(),
            artifact: artifact.clone(),
            toolchain: request.toolchain.clone(),
        };
        let path = request.out.join(file);
        let text = serde_json::to_string_pretty(&measurement).map_err(|e| e.to_string())?;
        std::fs::File::create_new(&path)
            .and_then(|mut f| f.write_all(format!("{text}\n").as_bytes()))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        written.push(path);
    }
    Ok(CaptureSummary {
        files: written,
        simulated_printers,
        simulator_requests,
    })
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}
