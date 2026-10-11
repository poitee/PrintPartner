use crate::{Error, Result};
use rustix::fs::{self, AtFlags, Mode, OFlags, RawMode, RenameFlags};
use std::{
    fs::File,
    io,
    path::{Component, Path},
};

pub(crate) struct Directory(pub(crate) File);

impl Directory {
    pub(crate) fn open_root(path: &Path) -> Result<Self> {
        Self::open_root_as(path, rustix::process::geteuid().as_raw())
    }

    /// Opens `path` as the confinement root on behalf of `uid`. Every pinned
    /// component, from `/` to the root itself, is checked through its own
    /// handle so a replaced path cannot slip past the ownership check.
    fn open_root_as(path: &Path, uid: u32) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::UnsafePath);
        }
        let mut root = Self(File::from(fs::open(
            "/",
            Self::search_flags() | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?));
        // `/` is already pinned. A sticky directory is safe only when a
        // subsequently checked component confines access below it.
        let mut components = path.components().skip(1).peekable();
        root.check_ancestor(uid, components.peek().is_some())?;
        while let Some(component) = components.next() {
            match component {
                Component::Normal(name) => {
                    let name = name.to_str().ok_or(Error::UnsafePath)?;
                    root = Self(File::from(fs::openat(
                        &root.0,
                        name,
                        Self::search_flags()
                            | OFlags::DIRECTORY
                            | OFlags::NOFOLLOW
                            | OFlags::CLOEXEC,
                        Mode::empty(),
                    )?));
                    root.check_ancestor(uid, components.peek().is_some())?;
                }
                _ => return Err(Error::UnsafePath),
            }
        }
        // Only the selected root needs enumeration and fsync support. Reopen
        // the pinned directory rather than resolving the configured path again.
        root.child(".", false)
    }

    fn check_ancestor(&self, uid: u32, allow_sticky: bool) -> Result<()> {
        let stat = fs::fstat(&self.0)?;
        if ancestor_is_trusted(stat.st_uid, stat.st_mode as RawMode, uid, allow_sticky) {
            Ok(())
        } else {
            Err(Error::UnsafeAncestor)
        }
    }

    fn search_flags() -> OFlags {
        #[cfg(target_os = "linux")]
        {
            OFlags::PATH
        }
        #[cfg(target_os = "macos")]
        {
            OFlags::from_bits_retain(libc::O_SEARCH as _)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            OFlags::RDONLY
        }
    }

    pub(crate) fn child(&self, name: &str, create: bool) -> Result<Self> {
        if create {
            match fs::mkdirat(&self.0, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
                Ok(()) => self.sync()?,
                Err(rustix::io::Errno::EXIST) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(Self(File::from(fs::openat(
            &self.0,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?)))
    }

    pub(crate) fn parent(&self, path: &str, create: bool) -> Result<(Self, String)> {
        let mut parent = Self(self.0.try_clone()?);
        let mut segments = path.split('/').peekable();
        while let Some(segment) = segments.next() {
            if segments.peek().is_none() {
                return Ok((parent, segment.to_owned()));
            }
            parent = parent.child(segment, create)?;
        }
        Err(Error::UnsafePath)
    }

    pub(crate) fn file(&self, path: &str, create: bool) -> Result<File> {
        let (parent, name) = self.parent(path, create)?;
        let flags = OFlags::NOFOLLOW
            | OFlags::CLOEXEC
            | OFlags::NONBLOCK
            | if create {
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL
            } else {
                OFlags::RDONLY
            };
        let file = File::from(fs::openat(
            &parent.0,
            name.as_str(),
            flags,
            Mode::RUSR | Mode::WUSR,
        )?);
        if !file.metadata()?.is_file() {
            return Err(Error::UnsafePath);
        }
        Ok(file)
    }

    pub(crate) fn entries(&self) -> Result<Vec<String>> {
        let mut entries = Vec::new();
        for entry in fs::Dir::read_from(&self.0)? {
            let entry = entry?;
            let name = entry.file_name().to_str().map_err(|_| Error::UnsafePath)?;
            if name != "." && name != ".." {
                if entries.len() > crate::MAX_ENTRIES {
                    return Err(Error::Limit);
                }
                entries.push(name.to_owned());
            }
        }
        Ok(entries)
    }

    pub(crate) fn remove_tree(&self, name: &str) -> Result<()> {
        match self.child(name, false) {
            Ok(child) => {
                for entry in child.entries()? {
                    child.remove_tree(&entry)?;
                }
                fs::unlinkat(&self.0, name, AtFlags::REMOVEDIR)?;
            }
            Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => {
                fs::unlinkat(&self.0, name, AtFlags::empty())?;
            }
        }
        Ok(())
    }

    pub(crate) fn sync(&self) -> Result<()> {
        self.0.sync_all().map_err(Into::into)
    }

    pub(crate) fn publish(&self, candidate: &str, revision: &str) -> Result<()> {
        fs::renameat_with(
            &self.0,
            candidate,
            &self.0,
            revision,
            RenameFlags::NOREPLACE,
        )?;
        self.sync()
    }
}

/// A root ancestor is trusted when only `uid` or root can replace its entries:
/// it is owned by one of them and is not group/world-writable unless sticky.
/// Sticky `/tmp`-style ancestors are accepted because the next component must
/// itself pass this check, so other users cannot rename it away. The selected
/// root has no such checked child, so it must not be group/world-writable.
fn ancestor_is_trusted(owner: u32, mode: RawMode, uid: u32, allow_sticky: bool) -> bool {
    let mode = Mode::from_raw_mode(mode);
    (owner == uid || owner == 0)
        && (!mode.intersects(Mode::WGRP | Mode::WOTH)
            || (allow_sticky && mode.contains(Mode::SVTX)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, Permissions},
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pp-source-root-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            let tree = Self(fs::canonicalize(path).unwrap());
            tree.dir("", 0o755)
        }
        fn dir(self, name: &str, mode: u32) -> Self {
            let path = self.0.join(name);
            if !path.exists() {
                fs::create_dir(&path).unwrap();
            }
            fs::set_permissions(&path, Permissions::from_mode(mode)).unwrap();
            self
        }
        fn open(&self, name: &str) -> Result<Directory> {
            Directory::open_root(&self.0.join(name))
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn euid() -> u32 {
        rustix::process::geteuid().as_raw()
    }

    #[test]
    fn world_writable_ancestor_is_rejected() {
        let tree = Tree::new().dir("shared", 0o777).dir("shared/repos", 0o755);
        assert!(matches!(
            tree.open("shared/repos"),
            Err(Error::UnsafeAncestor)
        ));
    }

    #[test]
    fn group_writable_ancestor_is_rejected() {
        let tree = Tree::new().dir("team", 0o775).dir("team/repos", 0o700);
        assert!(matches!(
            tree.open("team/repos"),
            Err(Error::UnsafeAncestor)
        ));
    }

    #[test]
    fn world_writable_root_itself_is_rejected() {
        let tree = Tree::new().dir("repos", 0o777);
        assert!(matches!(tree.open("repos"), Err(Error::UnsafeAncestor)));
    }

    #[test]
    fn foreign_owned_ancestor_is_rejected() {
        assert!(!ancestor_is_trusted(1001, 0o755, 1000, true));
        assert!(!ancestor_is_trusted(1001, 0o1777, 1000, true));
        assert!(ancestor_is_trusted(1000, 0o755, 1000, false));
        assert!(ancestor_is_trusted(0, 0o755, 1000, false));

        let tree = Tree::new().dir("repos", 0o700);
        let root = tree.0.join("repos");
        // Unprivileged tests cannot chown, so open as a different user: the
        // fixture directories then belong to someone else. Root-owned
        // fixtures stay trusted, so only the pure policy runs as root.
        if euid() == 0 {
            return;
        }
        let other = euid().wrapping_add(1);
        assert!(Directory::open_root_as(&root, euid()).is_ok());
        assert!(matches!(
            Directory::open_root_as(&root, other),
            Err(Error::UnsafeAncestor)
        ));
        // When every directory above the fixture is root-owned (Linux /tmp),
        // pin the rejection to the selected root's own owner.
        let temp = tree.0.parent().unwrap();
        if temp
            .ancestors()
            .all(|path| fs::metadata(path).unwrap().uid() == 0)
        {
            // A sticky temp directory is trusted as an intermediate ancestor,
            // even though it is no longer accepted as the selected root.
            let temp_handle = Directory(File::open(temp).unwrap());
            assert!(temp_handle.check_ancestor(other, true).is_ok());
            assert!(matches!(
                Directory::open_root_as(&tree.0, other),
                Err(Error::UnsafeAncestor)
            ));
        }
    }

    #[test]
    fn owned_root_is_accepted() {
        let tree = Tree::new().dir("repos", 0o700).dir("repos/nested", 0o755);
        assert!(tree.open("repos").is_ok());
        assert!(tree.open("repos/nested").is_ok());
        assert!(ancestor_is_trusted(1000, 0o40755, 1000, false));
    }

    #[test]
    fn sticky_shared_ancestor_is_accepted() {
        // `/tmp`-style: world-writable with the sticky bit, owned by the user
        // (or root). Entries below it must still pass the ownership check.
        let tree = Tree::new().dir("tmp", 0o1777).dir("tmp/repos", 0o700);
        assert!(tree.open("tmp/repos").is_ok());
        assert!(ancestor_is_trusted(0, 0o41777, 1000, true));
        assert!(ancestor_is_trusted(1000, 0o1770, 1000, true));
        let tree = Tree::new().dir("tmp", 0o1777).dir("tmp/repos", 0o777);
        assert!(matches!(tree.open("tmp/repos"), Err(Error::UnsafeAncestor)));
    }

    #[test]
    fn sticky_writable_root_is_rejected() {
        for mode in [0o1777, 0o1770, 0o1707] {
            let tree = Tree::new().dir("repos", mode);
            assert!(matches!(tree.open("repos"), Err(Error::UnsafeAncestor)));
            assert!(!ancestor_is_trusted(0, mode, 1000, false));
        }
    }
}
