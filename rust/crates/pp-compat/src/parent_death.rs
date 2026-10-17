use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use tokio::process::Command;

fn parent_death_pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    let created = unsafe {
        #[cfg(target_os = "linux")]
        {
            libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC)
        }
        #[cfg(not(target_os = "linux"))]
        {
            libc::pipe(fds.as_mut_ptr())
        }
    };
    if created != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(not(target_os = "linux"))]
    unsafe {
        for fd in fds {
            if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) != 0 {
                let error = std::io::Error::last_os_error();
                let _ = libc::close(fds[0]);
                let _ = libc::close(fds[1]);
                return Err(error);
            }
        }
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

#[cfg(target_os = "linux")]
unsafe fn parent_errno() -> libc::c_int {
    unsafe { *libc::__errno_location() }
}

#[cfg(target_os = "macos")]
unsafe fn parent_errno() -> libc::c_int {
    unsafe { *libc::__error() }
}

fn close_inherited_except(keep: RawFd) {
    unsafe {
        #[cfg(target_os = "linux")]
        {
            let lower = keep == 0 || libc::close_range(0, keep as u32 - 1, 0) == 0;
            let upper = libc::close_range(keep as u32 + 1, u32::MAX, 0) == 0;
            if lower && upper {
                return;
            }
        }
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
            libc::_exit(1);
        }
        let maximum = if limit.rlim_max == libc::RLIM_INFINITY {
            limit.rlim_cur
        } else {
            limit.rlim_max
        };
        for fd in 0..maximum.min(libc::c_int::MAX as libc::rlim_t) as RawFd {
            if fd != keep {
                libc::close(fd);
            }
        }
    }
}

pub(super) struct ParentDeathGuard {
    write: Option<OwnedFd>,
    pub(super) watcher: libc::pid_t,
}

impl ParentDeathGuard {
    pub(super) fn release(&mut self) {
        if let Some(write) = self.write.take() {
            unsafe {
                let byte = [0u8];
                while libc::write(write.as_raw_fd(), byte.as_ptr().cast(), 1) < 0
                    && parent_errno() == libc::EINTR
                {}
            }
            drop(write);
            self.reap();
        }
    }

    fn reap(&self) {
        unsafe {
            while libc::waitpid(self.watcher, std::ptr::null_mut(), 0) < 0
                && parent_errno() == libc::EINTR
            {}
        }
    }
}

impl Drop for ParentDeathGuard {
    fn drop(&mut self) {
        if self.write.take().is_some() {
            self.reap();
        }
    }
}

pub(super) fn configure_child(
    command: &mut Command,
    storage_lock_fd: RawFd,
) -> std::io::Result<(OwnedFd, ParentDeathGuard)> {
    command.process_group(0);
    let (read_end, write_end) = parent_death_pipe()?;
    let read_fd = read_end.as_raw_fd();
    let write_fd = write_end.as_raw_fd();
    let parent = std::process::id() as libc::pid_t;
    let (ready_read, ready_write) = parent_death_pipe()?;
    let watcher = unsafe { libc::fork() };
    if watcher < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if watcher == 0 {
        unsafe {
            if libc::setsid() < 0 {
                libc::_exit(1);
            }
            let ready = [1u8];
            if libc::write(ready_write.as_raw_fd(), ready.as_ptr().cast(), 1) != 1 {
                libc::_exit(1);
            }
            close_inherited_except(read_fd);
            let mut pid = 0 as libc::pid_t;
            let mut received = 0;
            while received < std::mem::size_of_val(&pid) {
                let count = libc::read(
                    read_fd,
                    (&mut pid as *mut libc::pid_t)
                        .cast::<u8>()
                        .add(received)
                        .cast(),
                    std::mem::size_of_val(&pid) - received,
                );
                if count < 0 && parent_errno() == libc::EINTR {
                    continue;
                }
                if count <= 0 {
                    libc::_exit(0);
                }
                received += count as usize;
            }
            let mut byte = [0u8];
            loop {
                let count = libc::read(read_fd, byte.as_mut_ptr().cast(), 1);
                if count < 0 && parent_errno() == libc::EINTR {
                    continue;
                }
                if count == 1 {
                    libc::_exit(0);
                }
                if count == 0 {
                    libc::kill(-pid, libc::SIGKILL);
                }
                libc::_exit(0);
            }
        }
    }
    let guard = ParentDeathGuard {
        write: Some(write_end),
        watcher,
    };
    drop(ready_write);
    let mut ready = [0u8];
    loop {
        let count = unsafe { libc::read(ready_read.as_raw_fd(), ready.as_mut_ptr().cast(), 1) };
        if count < 0 && unsafe { parent_errno() } == libc::EINTR {
            continue;
        }
        if count != 1 || ready != [1] {
            return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
        }
        break;
    }
    drop(ready_read);
    unsafe {
        command.pre_exec(move || {
            libc::close(read_fd);
            let pid = libc::getpid();
            if libc::write(
                write_fd,
                (&pid as *const libc::pid_t).cast(),
                std::mem::size_of_val(&pid),
            ) != std::mem::size_of_val(&pid) as isize
            {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(write_fd);
            if libc::getppid() != parent {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            if libc::dup2(storage_lock_fd, 198) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok((read_end, guard))
}
