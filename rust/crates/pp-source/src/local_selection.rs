use crate::{Directory, Error, LocalFiles, MAX_ENTRIES, PathCollisions, Result, SourcePath};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InputFile {
    pub path: SourcePath,
    pub size: u64,
    pub sha256: String,
}

fn walk(root: &Directory, prefix: &str, files: &mut Vec<SourcePath>) -> Result<()> {
    for name in root.entries()? {
        if name.starts_with('.') {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let path = SourcePath::try_from(relative.clone())?;
        match root.child(&name, false) {
            Ok(child) => walk(&child, &relative, files)?,
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotADirectory => {
                root.file(&name, false)?;
                files.push(path);
                if files.len() > MAX_ENTRIES {
                    return Err(Error::Limit);
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Bytes stored under `root`, counting every regular file.
pub fn stored_bytes(root: &Path, cancelled: &AtomicBool) -> Result<u64> {
    fn count(dir: &Directory, cancelled: &AtomicBool) -> Result<u64> {
        let mut total = 0u64;
        for entry in dir.entries()? {
            if cancelled.load(Ordering::Acquire) {
                return Err(Error::Limit);
            }
            let bytes = match dir.child(&entry, false) {
                Ok(child) => count(&child, cancelled)?,
                Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotADirectory => {
                    dir.file(&entry, false)?.metadata()?.len()
                }
                Err(e) => return Err(e),
            };
            total = total.checked_add(bytes).ok_or(Error::Limit)?;
        }
        Ok(total)
    }
    count(&Directory::open_root(root)?, cancelled)
}

impl LocalFiles {
    /// Every regular file below the selected directory in path order. Names
    /// starting with `.` are skipped; a link or special file is refused.
    pub fn paths(&self) -> Result<Vec<SourcePath>> {
        let mut paths = Vec::new();
        walk(&self.root, "", &mut paths)?;
        paths.sort_by(|a, b| crate::compare_paths(a.as_str(), b.as_str()));
        Ok(paths)
    }
    pub fn inventory(&self, paths: &[SourcePath], max_bytes: u64) -> Result<Vec<InputFile>> {
        self.inventory_until(paths, max_bytes, &AtomicBool::new(false))
    }
    /// `inventory` that stops with `Error::Limit` once `cancelled` is set.
    pub fn inventory_until(
        &self,
        paths: &[SourcePath],
        max_bytes: u64,
        cancelled: &AtomicBool,
    ) -> Result<Vec<InputFile>> {
        validate_paths(paths)?;
        let mut result = Vec::new();
        let mut total = 0u64;
        for path in paths {
            let mut file = self.root.file(path.as_str(), false)?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            let mut buf = [0u8; 8192];
            loop {
                if cancelled.load(Ordering::Acquire) {
                    return Err(Error::Limit);
                }
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                total += n as u64;
                if total > max_bytes {
                    return Err(Error::Limit);
                }
                hash.update(&buf[..n]);
            }
            result.push(InputFile {
                path: path.clone(),
                size,
                sha256: hex::encode(hash.finalize()),
            });
        }
        Ok(result)
    }
    pub fn capture(
        &self,
        paths: &[SourcePath],
        owned_root: &Path,
        operation: &str,
        max_bytes: u64,
        cancelled: &AtomicBool,
    ) -> Result<(LocalFiles, Vec<InputFile>)> {
        crate::validate_revision(operation)?;
        validate_paths(paths)?;
        let parent = Directory::open_root(owned_root)?;
        let imports = parent.child(".pp-imports", true)?;
        let root = match imports.create_child_exclusive(operation) {
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Error::InvalidIdentity);
            }
            result => result?,
        };
        imports.sync()?;
        let owned = LocalFiles { root };
        let mut total = 0u64;
        for path in paths {
            let mut input = self.root.file(path.as_str(), false)?;
            let (parent, name) = owned.root.parent(path.as_str(), true)?;
            let mut output = parent.file_exclusive(&name)?;
            let mut buf = [0u8; 8192];
            loop {
                if cancelled.load(Ordering::Acquire) {
                    return Err(Error::Limit);
                }
                let n = input.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > max_bytes {
                    return Err(Error::Limit);
                }
                output.write_all(&buf[..n])?;
            }
            output.sync_all()?;
            parent.sync()?;
        }
        owned.root.sync()?;
        imports.sync()?;
        let inventory = owned.inventory(paths, max_bytes)?;
        Ok((owned, inventory))
    }
}

fn validate_paths(paths: &[SourcePath]) -> Result<()> {
    if paths.len() > MAX_ENTRIES {
        return Err(Error::Limit);
    }
    let mut collisions = PathCollisions::default();
    for path in paths {
        collisions.insert(path, false)?;
    }
    Ok(())
}
