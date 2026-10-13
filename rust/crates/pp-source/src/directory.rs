use crate::{Error, Result};
use rustix::fs::{self, AtFlags, Mode, OFlags, RenameFlags};
use std::{
    fs::File,
    io,
    path::{Component, Path},
};

pub(crate) struct Directory(pub(crate) File);

impl Directory {
    pub(crate) fn open_root(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::UnsafePath);
        }
        let mut root = Self(File::from(fs::open(
            "/",
            Self::search_flags() | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?));
        for component in path.components() {
            match component {
                Component::RootDir => {}
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
                }
                _ => return Err(Error::UnsafePath),
            }
        }
        // Only the selected root needs enumeration and fsync support. Reopen
        // the pinned directory rather than resolving the configured path again.
        root.child(".", false)
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
