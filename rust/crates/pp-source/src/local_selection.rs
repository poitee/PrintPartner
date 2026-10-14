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

impl LocalFiles {
    pub fn inventory(&self, paths: &[SourcePath], max_bytes: u64) -> Result<Vec<InputFile>> {
        validate_paths(paths)?;
        let mut result = Vec::new();
        let mut total = 0u64;
        for path in paths {
            let mut file = self.root.file(path.as_str(), false)?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            let mut buf = [0u8; 8192];
            loop {
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
