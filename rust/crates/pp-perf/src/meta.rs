//! Package size, machine and timestamp metadata for a capture.

use std::path::Path;

use crate::record::Machine;

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
