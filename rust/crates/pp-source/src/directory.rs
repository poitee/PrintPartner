use crate::{Error, Result};
use rustix::fs::{self, AtFlags, Mode, OFlags, RenameFlags};
use std::{
    fs::File,
    io,
    os::unix::fs::MetadataExt,
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
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?));
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = name.to_str().ok_or(Error::UnsafePath)?;
                    root = root.child(name, false)?;
                }
                _ => return Err(Error::UnsafePath),
            }
        }
        Ok(root)
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

    pub(crate) fn try_clone(&self) -> Result<Self> {
        Ok(Self(self.0.try_clone()?))
    }

    pub(crate) fn create_child_exclusive(&self, name: &str) -> Result<Self> {
        fs::mkdirat(&self.0, name, Mode::RUSR | Mode::WUSR | Mode::XUSR)?;
        self.child(name, false)
    }

    pub(crate) fn create_child_unsynced(&self, name: &str) -> Result<(Self, bool)> {
        let created = match fs::mkdirat(&self.0, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
            Ok(()) => true,
            Err(rustix::io::Errno::EXIST) => false,
            Err(error) => return Err(error.into()),
        };
        Ok((self.child(name, false)?, created))
    }

    pub(crate) fn file_exclusive(&self, name: &str) -> Result<File> {
        let file = File::from(fs::openat(
            &self.0,
            name,
            OFlags::WRONLY
                | OFlags::CREATE
                | OFlags::EXCL
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC
                | OFlags::NONBLOCK,
            Mode::RUSR | Mode::WUSR,
        )?);
        if !file.metadata()?.is_file() {
            return Err(Error::UnsafePath);
        }
        Ok(file)
    }

    pub(crate) fn rename_no_replace(&self, from: &str, to: &str) -> Result<()> {
        fs::renameat_with(&self.0, from, &self.0, to, RenameFlags::NOREPLACE)?;
        Ok(())
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
                if entries.len() >= crate::MAX_ENTRIES {
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

    pub(crate) fn remove_empty_directory(&self, name: &str) -> Result<()> {
        fs::unlinkat(&self.0, name, AtFlags::REMOVEDIR)?;
        Ok(())
    }

    pub(crate) fn remove_owned_file(&self, name: &str, owned: &File) -> Result<()> {
        self.require_owned_file(name, owned)?;
        fs::unlinkat(&self.0, name, AtFlags::empty())?;
        Ok(())
    }

    pub(crate) fn require_owned_file(&self, name: &str, owned: &File) -> Result<()> {
        let current = self.file(name, false)?;
        let current = current.metadata()?;
        let owned = owned.metadata()?;
        if !current.is_file() || current.dev() != owned.dev() || current.ino() != owned.ino() {
            return Err(Error::CorruptSnapshot);
        }
        Ok(())
    }

    pub(crate) fn remove_owned_empty_directory(&self, name: &str, owned: &Directory) -> Result<()> {
        self.require_owned_directory(name, owned)?;
        fs::unlinkat(&self.0, name, AtFlags::REMOVEDIR)?;
        Ok(())
    }

    pub(crate) fn require_owned_directory(&self, name: &str, owned: &Directory) -> Result<()> {
        let current = self.child(name, false)?;
        let current = current.0.metadata()?;
        let owned = owned.0.metadata()?;
        if !current.is_dir() || current.dev() != owned.dev() || current.ino() != owned.ino() {
            return Err(Error::CorruptSnapshot);
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
