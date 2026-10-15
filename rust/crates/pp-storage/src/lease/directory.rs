use std::{
    ffi::CString,
    fs::File,
    io::{self, Read},
    ops::Deref,
    os::fd::{AsRawFd, FromRawFd},
};

pub(super) struct Directory(pub(super) File);

impl Deref for Directory {
    type Target = File;
    fn deref(&self) -> &File {
        &self.0
    }
}

impl Directory {
    fn open(&self, name: &str, flags: i32) -> io::Result<File> {
        let name = CString::new(name)?;
        let fd = unsafe {
            libc::openat(
                self.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) fn open_dir(&self, name: &str) -> io::Result<Self> {
        self.open(name, libc::O_RDONLY | libc::O_DIRECTORY)
            .map(Self)
    }

    pub(super) fn create_file(&self, name: &str) -> io::Result<File> {
        self.open(name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)
    }

    pub(super) fn read_file(&self, name: &str) -> io::Result<Vec<u8>> {
        let mut file = self.open(name, libc::O_RDONLY)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub(super) fn create_dir(&self, name: &str) -> io::Result<()> {
        let name = CString::new(name)?;
        let result = unsafe { libc::mkdirat(self.as_raw_fd(), name.as_ptr(), 0o700) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn rename(&self, name: &str, target: &Self, destination: &str) -> io::Result<()> {
        let name = CString::new(name)?;
        let destination = CString::new(destination)?;
        let result = unsafe {
            libc::renameat(
                self.as_raw_fd(),
                name.as_ptr(),
                target.as_raw_fd(),
                destination.as_ptr(),
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn unlink(&self, name: &str, flags: i32) -> io::Result<()> {
        let name = CString::new(name)?;
        let result = unsafe { libc::unlinkat(self.as_raw_fd(), name.as_ptr(), flags) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        Ok(())
    }

    pub(super) fn remove_file(&self, name: &str) -> io::Result<()> {
        self.unlink(name, 0)
    }

    pub(super) fn remove_dir(&self, name: &str) -> io::Result<()> {
        self.unlink(name, libc::AT_REMOVEDIR)
    }
}
