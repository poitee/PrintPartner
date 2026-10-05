use crate::directory::Directory;
use rustix::fs;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
};

pub trait ReadBudget {
    type Error;
    fn entry(&mut self, depth: usize, bytes: usize) -> Result<(), Self::Error>;
    fn artifact(&mut self, total: u64, chunk: usize) -> Result<(), Self::Error>;
    fn document(&mut self, total: usize, chunk: usize) -> Result<(), Self::Error>;
}
#[derive(Debug)]
pub enum Failure<E> {
    Budget(E),
    Io(io::ErrorKind),
    UnsafePath,
}
pub struct Inventory {
    root: Option<Directory>,
    paths: Vec<String>,
}
impl Inventory {
    pub fn paths(&self) -> &[String] {
        &self.paths
    }
    pub fn scan<B: ReadBudget>(logical: &Path, budget: &mut B) -> Result<Self, Failure<B::Error>> {
        let mut inventory = Self {
            root: None,
            paths: Vec::new(),
        };
        if !std::fs::symlink_metadata(logical).is_ok_and(|m| m.is_dir()) {
            return Ok(inventory);
        }
        let Ok(canonical) = logical.canonicalize() else {
            return Ok(inventory);
        };
        let Ok(root) = Directory::open_root(&canonical) else {
            return Ok(inventory);
        };
        walk(&root, "", 0, &mut inventory.paths, budget)?;
        inventory.root = Some(root);
        Ok(inventory)
    }
    pub fn hash<B: ReadBudget>(
        &self,
        index: usize,
        budget: &mut B,
    ) -> Result<(u64, String), Failure<B::Error>> {
        let path = self.paths.get(index).ok_or(Failure::UnsafePath)?;
        let root = self.root.as_ref().ok_or(Failure::UnsafePath)?;
        let mut file = root
            .file(path, false)
            .map_err(|_| Failure::Io(io::ErrorKind::Other))?;
        let mut buf = [0u8; 65536];
        let mut hash = Sha256::new();
        let mut total = 0;
        loop {
            let n = file.read(&mut buf).map_err(|e| Failure::Io(e.kind()))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            budget.artifact(total, n).map_err(Failure::Budget)?;
            hash.update(&buf[..n]);
        }
        Ok((total, hex::encode(hash.finalize())))
    }
}
fn walk<B: ReadBudget>(
    dir: &Directory,
    prefix: &str,
    depth: usize,
    out: &mut Vec<String>,
    budget: &mut B,
) -> Result<(), Failure<B::Error>> {
    let Ok(entries) = fs::Dir::read_from(&dir.0) else {
        return Ok(());
    };
    let mut names = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy();
        if name == "." || name == ".." {
            continue;
        }
        let len = prefix.len() + usize::from(!prefix.is_empty()) + name.len();
        budget.entry(depth, len).map_err(Failure::Budget)?;
        names.push(name.into_owned());
    }
    names.sort();
    for name in names {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(stat) = fs::statat(&dir.0, name.as_str(), fs::AtFlags::SYMLINK_NOFOLLOW) else {
            continue;
        };
        match fs::FileType::from_raw_mode(stat.st_mode) {
            fs::FileType::Directory => {
                if let Ok(child) = dir.child(&name, false) {
                    walk(&child, &path, depth + 1, out, budget)?;
                }
            }
            fs::FileType::RegularFile if name.to_lowercase().ends_with(".stl") => out.push(path),
            _ => {}
        }
    }
    Ok(())
}
pub fn confined_document<B: ReadBudget>(
    grant: &Path,
    path: &Path,
    budget: &mut B,
) -> Result<Option<Vec<u8>>, Failure<B::Error>> {
    let root = grant.canonicalize().map_err(|e| Failure::Io(e.kind()))?;
    let full = match path.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Failure::Io(e.kind())),
    };
    let relative = full.strip_prefix(&root).map_err(|_| Failure::UnsafePath)?;
    let directory = Directory::open_root(&root).map_err(|_| Failure::UnsafePath)?;
    let relative = relative.to_str().ok_or(Failure::UnsafePath)?;
    let mut file = directory
        .file(relative, false)
        .map_err(|_| Failure::Io(io::ErrorKind::Other))?;
    let mut data = Vec::new();
    let mut block = [0u8; 8192];
    loop {
        let n = file.read(&mut block).map_err(|e| Failure::Io(e.kind()))?;
        if n == 0 {
            break;
        }
        budget
            .document(data.len() + n, n)
            .map_err(Failure::Budget)?;
        data.extend_from_slice(&block[..n]);
    }
    Ok(Some(data))
}
pub fn resolve_logical(base: &Path, path: &str) -> PathBuf {
    let input = Path::new(path);
    let combined = if input.is_absolute() {
        input.to_path_buf()
    } else {
        base.join(input)
    };
    let mut out = PathBuf::new();
    for c in combined.components() {
        match c {
            std::path::Component::ParentDir => {
                if out.file_name().is_some() {
                    out.pop();
                }
            }
            std::path::Component::CurDir => {}
            _ => out.push(c),
        }
    }
    out
}
