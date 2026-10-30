//! Repeats `capture_run` and writes one `Measurement` file per metric.
//!
//! pp-perf-capture --kind KIND --name NAME --artifact FILE [--package PATH]
//!     [--runs N] [--idle-secs S] [--ready-timeout-secs S] [--noise-pct P]
//!     [--printers N] [--rustc VERSION] [--node VERSION] --out DIR -- COMMAND...
//!
//! The command must print one line on stdout when it is ready (`pp-server`
//! prints its origin). `--artifact` is hashed into the record; `--package`
//! (default: the artifact) is what package size measures. `--printers` records
//! how many simulated printers the command was given; this tool starts none.
//! Each file in DIR is created new, so earlier captures are never overwritten.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, SystemTime};

use pp_perf::{
    Artifact, CaptureOptions, Measurement, Metric, SCHEMA_VERSION, Toolchain, capture_run,
    package_bytes, this_machine, utc_timestamp,
};
use sha2::{Digest, Sha256};

struct Args {
    kind: String,
    name: String,
    artifact: PathBuf,
    package: Option<PathBuf>,
    runs: usize,
    idle: Duration,
    ready_timeout: Duration,
    noise_pct: f64,
    printers: u32,
    rustc: Option<String>,
    node: Option<String>,
    out: PathBuf,
    command: Vec<OsString>,
}

fn parse(mut raw: impl Iterator<Item = OsString>) -> Result<Args, String> {
    let value = |flag: &str, raw: &mut dyn Iterator<Item = OsString>| {
        raw.next()
            .ok_or_else(|| format!("{flag} needs a value"))
            .and_then(|v| v.into_string().map_err(|_| format!("{flag} is not UTF-8")))
    };
    let number = |flag: &str, text: String| {
        text.parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or_else(|| format!("{flag} must be a non-negative number"))
    };
    let (mut kind, mut name, mut artifact, mut out) = (None, None, None, None);
    let (mut package, mut rustc, mut node) = (None, None, None);
    let (mut runs, mut idle, mut ready, mut noise, mut printers) = (5.0, 5.0, 120.0, 10.0, 0.0);
    let mut command = Vec::new();
    while let Some(flag) = raw.next() {
        let flag = flag.into_string().map_err(|_| "flags must be UTF-8")?;
        match flag.as_str() {
            "--kind" => kind = Some(value(&flag, &mut raw)?),
            "--name" => name = Some(value(&flag, &mut raw)?),
            "--artifact" => artifact = Some(PathBuf::from(value(&flag, &mut raw)?)),
            "--package" => package = Some(PathBuf::from(value(&flag, &mut raw)?)),
            "--out" => out = Some(PathBuf::from(value(&flag, &mut raw)?)),
            "--rustc" => rustc = Some(value(&flag, &mut raw)?),
            "--node" => node = Some(value(&flag, &mut raw)?),
            "--runs" => runs = number(&flag, value(&flag, &mut raw)?)?,
            "--idle-secs" => idle = number(&flag, value(&flag, &mut raw)?)?,
            "--ready-timeout-secs" => ready = number(&flag, value(&flag, &mut raw)?)?,
            "--noise-pct" => noise = number(&flag, value(&flag, &mut raw)?)?,
            "--printers" => printers = number(&flag, value(&flag, &mut raw)?)?,
            "--" => {
                command.extend(raw.by_ref());
                break;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let whole = |flag: &str, n: f64| {
        (n.fract() == 0.0 && n <= f64::from(u32::MAX))
            .then_some(n as u32)
            .ok_or_else(|| format!("{flag} must be a whole number"))
    };
    let runs = whole("--runs", runs)? as usize;
    if runs == 0 {
        return Err("--runs must be at least 1".into());
    }
    if command.is_empty() {
        return Err("a command is required after --".into());
    }
    Ok(Args {
        kind: kind.ok_or("--kind is required")?,
        name: name.ok_or("--name is required")?,
        artifact: artifact.ok_or("--artifact is required")?,
        package,
        runs,
        idle: Duration::from_secs_f64(idle),
        ready_timeout: Duration::from_secs_f64(ready),
        noise_pct: noise,
        printers: whole("--printers", printers)?,
        rustc,
        node,
        out: out.ok_or("--out is required")?,
        command,
    })
}

fn sha256_file(path: &PathBuf) -> std::io::Result<String> {
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

fn run(args: Args) -> Result<(), String> {
    let artifact = Artifact {
        kind: args.kind,
        name: args.name,
        sha256: sha256_file(&args.artifact)
            .map_err(|e| format!("{}: {e}", args.artifact.display()))?,
    };
    let package = args.package.unwrap_or_else(|| args.artifact.clone());
    let options = CaptureOptions {
        command: args.command,
        ready_timeout: args.ready_timeout,
        idle: args.idle,
        stop_timeout: Duration::from_secs(10),
    };
    let mut startup = Vec::with_capacity(args.runs);
    let mut cpu = Vec::with_capacity(args.runs);
    let mut pss = Vec::with_capacity(args.runs);
    let mut size = Vec::with_capacity(args.runs);
    for run in 1..=args.runs {
        let sample = capture_run(&options).map_err(|e| format!("run {run}: {e}"))?;
        startup.push(sample.startup_ready_ms);
        cpu.push(sample.idle_cpu_percent);
        pss.push(sample.pss_bytes as f64);
        size.push(
            package_bytes(&package).map_err(|e| format!("{}: {e}", package.display()))? as f64,
        );
    }
    let record = |metric, samples| Measurement {
        schema: SCHEMA_VERSION,
        metric,
        samples,
        noise_tolerance_pct: args.noise_pct,
        simulated_printers: args.printers,
        captured_at: utc_timestamp(SystemTime::now()),
        machine: this_machine(),
        artifact: artifact.clone(),
        toolchain: Toolchain {
            rustc: args.rustc.clone(),
            node: args.node.clone(),
        },
    };
    std::fs::create_dir_all(&args.out).map_err(|e| format!("{}: {e}", args.out.display()))?;
    for (file, measurement) in [
        (
            "startup_ready_ms.json",
            record(Metric::StartupReadyMs, startup),
        ),
        ("idle_cpu_percent.json", record(Metric::IdleCpuPercent, cpu)),
        (
            "memory_linux_pss_bytes.json",
            record(Metric::MemoryLinuxPssBytes, pss),
        ),
        ("package_bytes.json", record(Metric::PackageBytes, size)),
    ] {
        let path = args.out.join(file);
        let text = serde_json::to_string_pretty(&measurement).map_err(|e| e.to_string())?;
        std::fs::File::create_new(&path)
            .and_then(|mut f| f.write_all(format!("{text}\n").as_bytes()))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        println!("{}", path.display());
    }
    Ok(())
}

fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1)).and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pp-perf-capture: {error}");
            ExitCode::from(2)
        }
    }
}
