//! Repeats `pp_core::perf_launch::capture_run` and writes one Measurement
//! file per metric. Linux only: CPU ticks and PSS come from `/proc`.
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
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use pp_core::perf_launch::{CaptureOptions, CaptureRequest, write_capture};
use pp_perf::Toolchain;

fn parse(mut raw: impl Iterator<Item = OsString>) -> Result<CaptureRequest, String> {
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
    let whole = |flag: &str, n: f64| {
        (n.fract() == 0.0 && n <= f64::from(u32::MAX))
            .then_some(n as u32)
            .ok_or_else(|| format!("{flag} must be a whole number"))
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
    if command.is_empty() {
        return Err("a command is required after --".into());
    }
    Ok(CaptureRequest {
        kind: kind.ok_or("--kind is required")?,
        name: name.ok_or("--name is required")?,
        artifact: artifact.ok_or("--artifact is required")?,
        package,
        runs: whole("--runs", runs)? as usize,
        options: CaptureOptions {
            command,
            ready_timeout: Duration::from_secs_f64(ready),
            idle: Duration::from_secs_f64(idle),
            stop_timeout: Duration::from_secs(10),
        },
        noise_tolerance_pct: noise,
        simulated_printers: whole("--printers", printers)?,
        toolchain: Toolchain { rustc, node },
        out: out.ok_or("--out is required")?,
    })
}

fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1)).and_then(|request| write_capture(&request)) {
        Ok(written) => {
            for path in written {
                println!("{}", path.display());
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("pp-perf-capture: {error}");
            ExitCode::from(2)
        }
    }
}
