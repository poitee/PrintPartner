use crate::{
    Directory, Error, FileKind, LocalFiles, MAX_ENTRIES, PublishedSnapshot, Result, SelectedFile,
    SourcePath, SourceRoot,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InputFile {
    pub path: SourcePath,
    pub size: u64,
    pub sha256: String,
}

fn walk(root: &Directory, prefix: &str, files: &mut Vec<SourcePath>, hidden: bool) -> Result<()> {
    for name in root.entries()? {
        if !hidden && name.starts_with('.') {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let path = SourcePath::try_from(relative.clone())?;
        match root.child(&name, false) {
            Ok(child) => walk(&child, &relative, files, hidden)?,
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

impl LocalFiles {
    pub fn paths(&self) -> Result<Vec<SourcePath>> {
        let mut paths = Vec::new();
        walk(&self.root, "", &mut paths, false)?;
        paths.sort_by(|a, b| crate::compare_paths(a.as_str(), b.as_str()));
        Ok(paths)
    }
    pub fn inventory(&self, paths: &[SourcePath], max_bytes: u64) -> Result<Vec<InputFile>> {
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
        let parent = Directory::open_root(owned_root)?;
        let imports = parent.child(".pp-imports", true)?;
        if imports.entries()?.contains(&operation.to_string()) {
            return Err(Error::InvalidIdentity);
        }
        let owned = LocalFiles {
            root: imports.child(operation, true)?,
        };
        let mut collisions = crate::PathCollisions::default();
        let mut total = 0u64;
        for path in paths {
            collisions.insert(path, false)?;
            let mut input = self.root.file(path.as_str(), false)?;
            let mut output = owned.root.file(path.as_str(), true)?;
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
            owned.root.parent(path.as_str(), false)?.0.sync()?;
        }
        owned.root.sync()?;
        imports.sync()?;
        let inventory = owned.inventory(paths, max_bytes)?;
        Ok((owned, inventory))
    }
    pub fn local_snapshot_selection(&self) -> Result<(String, Vec<SelectedFile>)> {
        static COLLATOR: OnceLock<icu_collator::CollatorBorrowed<'static>> = OnceLock::new();
        let collator = COLLATOR.get_or_init(|| {
            icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled ICU data")
        });
        let mut paths = self.paths()?;
        paths.retain(|p| classify(p.as_str()).is_some());
        paths.sort_by(|a, b| collator.compare(a.as_str(), b.as_str()));
        let inventory = self.inventory(&paths, crate::MAX_CONTENT_BYTES)?;
        let mut hash = Sha256::new();
        let mut files = Vec::new();
        let mut stls = 0;
        for file in inventory {
            let kind = classify(file.path.as_str()).ok_or(Error::InvalidIdentity)?;
            if kind == FileKind::Stl {
                stls += 1;
            }
            if stls > 500 || (file.path.as_str() == "pp-phases.json" && file.size > 1024 * 1024) {
                return Err(Error::Limit);
            }
            hash.update(serde_json::to_vec(&file)?);
            hash.update(b"\n");
            files.push(SelectedFile {
                path: file.path,
                kind,
                size_hint_bytes: Some(file.size),
            });
        }
        if files.is_empty() {
            return Err(Error::InvalidIdentity);
        }
        Ok((hex::encode(hash.finalize()), files))
    }
}
fn classify(path: &str) -> Option<FileKind> {
    let lower = path.to_lowercase();
    if lower.ends_with(".stl") {
        Some(FileKind::Stl)
    } else if lower.ends_with(".3mf")
        || lower.ends_with(".zip")
        || path == "pp-phases.json"
        || path == "print-partner.manifest.yaml"
    {
        Some(FileKind::Artifact)
    } else if lower.ends_with(".pdf") {
        Some(FileKind::Pdf)
    } else if lower.ends_with(".md") {
        Some(
            if lower
                .rsplit('/')
                .next()
                .is_some_and(|b| b == "readme.md" || b.starts_with("readme."))
            {
                FileKind::Readme
            } else {
                FileKind::Md
            },
        )
    } else {
        None
    }
}
pub fn discard_owned(root: &Path, operation: &str) -> Result<()> {
    crate::validate_revision(operation)?;
    let parent = Directory::open_root(root)?.child(".pp-imports", true)?;
    parent.remove_tree(operation)?;
    parent.sync()
}
pub fn stored_bytes(root: &Path) -> Result<u64> {
    fn count(dir: &Directory) -> Result<u64> {
        let mut total = 0u64;
        for entry in dir.entries()? {
            match dir.child(&entry, false) {
                Ok(child) => total = total.checked_add(count(&child)?).ok_or(Error::Limit)?,
                Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotADirectory => {
                    total = total
                        .checked_add(dir.file(&entry, false)?.metadata()?.len())
                        .ok_or(Error::Limit)?
                }
                Err(e) => return Err(e),
            }
        }
        Ok(total)
    }
    count(&Directory::open_root(root)?)
}
impl SourceRoot {
    pub fn verify_published(&self, key: &str) -> Result<PublishedSnapshot> {
        crate::validate_revision(key)?;
        self.load(&self.revisions.child(key, false)?, key)
    }
}

impl SourceRoot {
    pub fn discard_staging(&mut self) -> Result<()> {
        self.revisions.0.try_lock_exclusive()?;
        let result = (|| {
            for name in [".pp-source-archives", ".pp-source-media"] {
                let parent = match self.revisions.child(name, false) {
                    Ok(parent) => parent,
                    Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                parent.0.try_lock_exclusive()?;
                parent.remove_tree(".candidate")?;
                parent.sync()?;
            }
            self.revisions.remove_tree(crate::CANDIDATE)?;
            self.revisions.sync()
        })();
        let unlocked = FileExt::unlock(&self.revisions.0);
        result?;
        unlocked?;
        Ok(())
    }
}
