//! Linux process-tree memory as proportional set size (PSS).

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessTreePss {
    pub root: u32,
    /// The root and every live descendant that was summed, ascending.
    pub pids: Vec<u32>,
    pub pss_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PssError {
    /// PSS is a Linux measure; macOS uses footprint or RSS instead.
    Unsupported,
    RootMissing(u32),
    Io {
        path: PathBuf,
        detail: String,
    },
    Malformed {
        path: PathBuf,
        detail: String,
    },
}

impl fmt::Display for PssError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => write!(f, "process-tree PSS is only available on Linux"),
            Self::RootMissing(pid) => write!(f, "process {pid} is not running"),
            Self::Io { path, detail } => write!(f, "{}: {detail}", path.display()),
            Self::Malformed { path, detail } => write!(f, "{}: {detail}", path.display()),
        }
    }
}

impl std::error::Error for PssError {}

/// Sums PSS over `root` and its descendants from `/proc`.
pub fn sample_process_tree(root: u32) -> Result<ProcessTreePss, PssError> {
    if cfg!(target_os = "linux") {
        sample_process_tree_at(Path::new("/proc"), root)
    } else {
        Err(PssError::Unsupported)
    }
}

/// Same as [`sample_process_tree`], reading a procfs-shaped directory. A
/// descendant that exits while the tree is read is skipped; the root is not.
/// Children of a process that exits mid-scan may be missed too, so sample a
/// tree only once its process set has settled. Other read errors fail the
/// sample rather than shrinking the tree.
pub fn sample_process_tree_at(proc_root: &Path, root: u32) -> Result<ProcessTreePss, PssError> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let entries = std::fs::read_dir(proc_root).map_err(|e| io(proc_root, &e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io(proc_root, &e))?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if let Some(parent) =
            read_optional(&entry.path().join("stat"))?.map(|stat| parent_pid(&stat))
        {
            let parent = parent.map_err(|detail| malformed(entry.path().join("stat"), detail))?;
            children.entry(parent).or_default().push(pid);
        }
    }
    let mut tree = BTreeSet::from([root]);
    let mut pending = vec![root];
    while let Some(pid) = pending.pop() {
        for &child in children.get(&pid).into_iter().flatten() {
            if tree.insert(child) {
                pending.push(child);
            }
        }
    }
    let mut pids = Vec::with_capacity(tree.len());
    let mut pss_bytes = 0u64;
    for pid in tree {
        let path = proc_root.join(pid.to_string()).join("smaps_rollup");
        match read_optional(&path)? {
            Some(rollup) => {
                let bytes = pss_kib(&rollup)
                    .and_then(|kib| {
                        kib.checked_mul(1024)
                            .ok_or_else(|| "Pss overflows u64 bytes".into())
                    })
                    .map_err(|detail| malformed(path.clone(), detail))?;
                pss_bytes = pss_bytes
                    .checked_add(bytes)
                    .ok_or_else(|| malformed(path, "tree PSS overflows u64 bytes".into()))?;
                pids.push(pid);
            }
            None if pid == root => return Err(PssError::RootMissing(root)),
            None => {}
        }
    }
    Ok(ProcessTreePss {
        root,
        pids,
        pss_bytes,
    })
}

fn malformed(path: PathBuf, detail: String) -> PssError {
    PssError::Malformed { path, detail }
}

fn io(path: &Path, error: &std::io::Error) -> PssError {
    PssError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    }
}

/// Reads a per-process file; `None` when the process has already exited.
fn read_optional(path: &Path) -> Result<Option<String>, PssError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        // ESRCH surfaces as an uncategorized error when the task exits mid-read.
        Err(e) if e.kind() == ErrorKind::NotFound || e.raw_os_error() == Some(3) => Ok(None),
        Err(e) => Err(io(path, &e)),
    }
}

/// `pid (comm) state ppid ...`; comm may hold spaces and parentheses, so
/// fields are counted after the last `)`.
fn parent_pid(stat: &str) -> Result<u32, String> {
    let rest = stat
        .rsplit_once(')')
        .map(|(_, rest)| rest)
        .ok_or("no command name")?;
    let field = rest.split_whitespace().nth(1).ok_or("no parent pid")?;
    field
        .parse()
        .map_err(|_| format!("parent pid {field:?} is not a number"))
}

fn pss_kib(rollup: &str) -> Result<u64, String> {
    let line = rollup
        .lines()
        .find(|line| line.starts_with("Pss:"))
        .ok_or("no Pss line")?;
    let mut fields = line.split_whitespace().skip(1);
    match (fields.next().map(str::parse::<u64>), fields.next()) {
        (Some(Ok(kib)), Some("kB")) => Ok(kib),
        _ => Err(format!("unreadable Pss line {line:?}")),
    }
}
