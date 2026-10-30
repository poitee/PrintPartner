//! Linux process-tree CPU time, for the idle-CPU metric.

use std::path::Path;

use crate::pss::{PssError, malformed, process_tree_at, read_optional};

/// CPU time used so far by `root` and its live descendants, in clock ticks.
pub fn tree_cpu_ticks(root: u32) -> Result<u64, PssError> {
    if cfg!(target_os = "linux") {
        tree_cpu_ticks_at(Path::new("/proc"), root)
    } else {
        Err(PssError::Unsupported)
    }
}

/// Same as [`tree_cpu_ticks`], reading a procfs-shaped directory. Sums
/// `utime` and `stime` of every process in the tree. A descendant that exits
/// mid-read is skipped, and its ticks leave the sum with it; the root is not.
pub fn tree_cpu_ticks_at(proc_root: &Path, root: u32) -> Result<u64, PssError> {
    let mut ticks = 0u64;
    for pid in process_tree_at(proc_root, root)? {
        let path = proc_root.join(pid.to_string()).join("stat");
        match read_optional(&path)? {
            Some(stat) => {
                let used = cpu_ticks(&stat).map_err(|detail| malformed(path.clone(), detail))?;
                ticks = ticks
                    .checked_add(used)
                    .ok_or_else(|| malformed(path, "tree CPU ticks overflow u64".into()))?;
            }
            None if pid == root => return Err(PssError::RootMissing(root)),
            None => {}
        }
    }
    Ok(ticks)
}

/// Kernel clock ticks per second (`sysconf(_SC_CLK_TCK)`).
pub fn clock_ticks_per_second() -> Option<u64> {
    #[cfg(unix)]
    {
        // SAFETY: sysconf reads a constant and has no preconditions.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        u64::try_from(ticks).ok().filter(|&ticks| ticks > 0)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// `utime + stime`: fields 14 and 15 of `stat`, counted after the last `)`
/// because the command name may hold spaces and parentheses.
fn cpu_ticks(stat: &str) -> Result<u64, String> {
    let rest = stat
        .rsplit_once(')')
        .map(|(_, rest)| rest)
        .ok_or("no command name")?;
    let mut fields = rest.split_whitespace().skip(11);
    let mut field = |name: &str| -> Result<u64, String> {
        let text = fields.next().ok_or(format!("no {name}"))?;
        text.parse()
            .map_err(|_| format!("{name} {text:?} is not a number"))
    };
    let (utime, stime) = (field("utime")?, field("stime")?);
    utime
        .checked_add(stime)
        .ok_or_else(|| "utime + stime overflows u64".into())
}
