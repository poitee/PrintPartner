//! T-30 single instance. The desktop that owns a data directory listens on
//! `<data>/.desktop-focus.sock`. A second desktop refused by that directory's
//! lock asks it to show its window and exits. The data directory is 0700 and
//! the listener exists only while its owner holds the lock: it is bound after
//! core startup admits the directory and removed before core shutdown
//! releases it. The owner answers only a same-uid peer naming the device and
//! inode of its own data directory, so it never focuses for another directory.
//! Focus is best effort: any failure keeps the existing startup error.

use anyhow::{Context, Result, ensure};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

pub const SOCKET: &str = ".desktop-focus.sock";
const REQUEST: &str = "focus v1";
const FOCUSED: &str = "focused";
const MISMATCH: &str = "mismatch";
const LIMIT: u64 = 128;
const TIMEOUT: Duration = Duration::from_secs(2);

/// Refusals from the desktop lock. The standalone-Node refusal is excluded:
/// that owner has no window to focus.
const OWNED: [&str; 2] = [
    "Data directory already owned",
    "Data directory already owned; stop the other Print Partner process before starting another instance",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
}

impl Identity {
    fn of(data: &Path) -> Result<Self> {
        let metadata = std::fs::metadata(data).context("Focus data directory unavailable")?;
        ensure!(metadata.is_dir(), "Focus data directory unavailable");
        Ok(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }

    fn line(self) -> String {
        format!("{REQUEST} {} {}\n", self.dev, self.ino)
    }

    fn parse(line: &str) -> Option<Self> {
        let mut parts = line
            .trim_end_matches('\n')
            .strip_prefix(REQUEST)?
            .split(' ');
        let (Some(""), Some(dev), Some(ino), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        Some(Self {
            dev: dev.parse().ok()?,
            ino: ino.parse().ok()?,
        })
    }
}

/// True when startup failed because another desktop holds this data directory.
pub fn owned_by_another_desktop(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| OWNED.contains(&cause.to_string().as_str()))
}

/// Listener for focus requests. Dropping it stops the listener and removes the
/// socket, so drop it before the lock owner shuts down.
pub struct FocusServer {
    path: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl FocusServer {
    /// Bind the focus socket of a data directory whose lock this process holds.
    /// A leftover socket from a crashed owner is replaced; anything else at
    /// the path is left alone and focus stays off. Call inside a tokio runtime.
    pub fn start(data: &Path, focus: impl Fn() + Send + Sync + 'static) -> Result<Self> {
        let identity = Identity::of(data)?;
        let uid = std::fs::metadata(data)?.uid();
        let path = data.join(SOCKET);
        match std::fs::symlink_metadata(&path) {
            Ok(existing) if existing.file_type().is_socket() => {
                std::fs::remove_file(&path).context("Focus socket cleanup failed")?
            }
            Ok(_) => anyhow::bail!("Focus socket path occupied"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("Focus socket path unavailable"),
        }
        let listener =
            std::os::unix::net::UnixListener::bind(&path).context("Focus socket bind failed")?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let listener = tokio::net::UnixListener::from_std(listener)?;
        let focus = std::sync::Arc::new(focus);
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let focus = focus.clone();
                tokio::spawn(async move {
                    let _ =
                        tokio::time::timeout(TIMEOUT, answer(stream, uid, identity, &*focus)).await;
                });
            }
        });
        Ok(Self { path, task })
    }
}

async fn answer<F: Fn() + ?Sized>(
    stream: tokio::net::UnixStream,
    uid: u32,
    identity: Identity,
    focus: &F,
) -> Result<()> {
    ensure!(stream.peer_cred()?.uid() == uid, "Focus peer uid mismatch");
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    tokio::io::AsyncReadExt::take(tokio::io::BufReader::new(read), LIMIT)
        .read_line(&mut line)
        .await?;
    let reply = if Identity::parse(&line) == Some(identity) {
        focus();
        FOCUSED
    } else {
        MISMATCH
    };
    write.write_all(format!("{reply}\n").as_bytes()).await?;
    Ok(())
}

impl Drop for FocusServer {
    fn drop(&mut self) {
        self.task.abort();
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| metadata.file_type().is_socket())
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Ask the desktop that owns `data` to show its window. Returns true only when
/// that owner confirmed the same data directory and focused.
pub fn request(data: &Path) -> Result<bool> {
    let path = data.join(SOCKET);
    if !std::fs::symlink_metadata(&path)?.file_type().is_socket() {
        return Ok(false);
    }
    let line = Identity::of(data)?.line();
    let mut stream = std::os::unix::net::UnixStream::connect(&path)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.write_all(line.as_bytes())?;
    let mut reply = String::new();
    BufReader::new(std::io::Read::take(&stream, LIMIT)).read_line(&mut reply)?;
    Ok(reply.trim_end() == FOCUSED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn data_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("pp-t30-")
            .tempdir()
            .unwrap()
    }

    fn counter() -> (Arc<AtomicUsize>, impl Fn() + Send + Sync + 'static) {
        let count = Arc::new(AtomicUsize::new(0));
        let hits = count.clone();
        (count, move || {
            hits.fetch_add(1, Ordering::SeqCst);
        })
    }

    async fn ask(data: &Path) -> Result<bool> {
        let data = data.to_owned();
        tokio::task::spawn_blocking(move || request(&data)).await?
    }

    #[tokio::test]
    async fn ticket_t_30_same_data_directory_focuses_the_owner_window() {
        let data = data_dir();
        let (count, focus) = counter();
        let server = FocusServer::start(data.path(), focus).unwrap();
        let socket = data.path().join(SOCKET);
        assert_eq!(
            std::fs::symlink_metadata(&socket).unwrap().mode() & 0o777,
            0o600
        );
        assert!(ask(data.path()).await.unwrap());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(server);
        assert!(!socket.exists(), "socket removed with its owner");
        assert!(ask(data.path()).await.is_err(), "no owner, no focus");
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ticket_t_30_other_data_directory_identity_is_refused() {
        let (owner, other) = (data_dir(), data_dir());
        let (count, focus) = counter();
        let _server = FocusServer::start(owner.path(), focus).unwrap();
        let socket = owner.path().join(SOCKET);
        let line = Identity::of(other.path()).unwrap().line();
        let reply = tokio::task::spawn_blocking(move || {
            let mut stream = std::os::unix::net::UnixStream::connect(socket).unwrap();
            stream.write_all(line.as_bytes()).unwrap();
            let mut reply = String::new();
            BufReader::new(&stream).read_line(&mut reply).unwrap();
            reply
        })
        .await
        .unwrap();
        assert_eq!(reply, "mismatch\n");
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn ticket_t_30_garbled_request_is_refused() {
        let data = data_dir();
        let (count, focus) = counter();
        let _server = FocusServer::start(data.path(), focus).unwrap();
        let socket = data.path().join(SOCKET);
        for line in ["focus v1 1\n", "focus v2 1 2\n", "focus v1 a b\n", "x\n"] {
            let socket = socket.clone();
            let reply = tokio::task::spawn_blocking(move || {
                let mut stream = std::os::unix::net::UnixStream::connect(socket).unwrap();
                stream.write_all(line.as_bytes()).unwrap();
                let mut reply = String::new();
                BufReader::new(&stream).read_line(&mut reply).unwrap();
                reply
            })
            .await
            .unwrap();
            assert_eq!(reply, "mismatch\n", "{line:?}");
        }
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn ticket_t_30_stale_socket_is_replaced_and_planted_file_is_kept() {
        let data = data_dir();
        let socket = data.path().join(SOCKET);
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert!(
            std::fs::symlink_metadata(&socket)
                .unwrap()
                .file_type()
                .is_socket()
        );
        let (count, focus) = counter();
        let server = FocusServer::start(data.path(), focus).unwrap();
        assert!(ask(data.path()).await.unwrap());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(server);

        std::fs::write(&socket, b"not a socket").unwrap();
        let (_, focus) = counter();
        assert!(FocusServer::start(data.path(), focus).is_err());
        assert_eq!(std::fs::read(&socket).unwrap(), b"not a socket");
        assert!(
            !ask(data.path()).await.unwrap(),
            "a planted file is never contacted"
        );
    }

    #[test]
    fn ticket_t_30_only_desktop_lock_refusals_ask_for_focus() {
        let owned = anyhow::anyhow!(OWNED[1]).context("Desktop core startup failed");
        assert!(owned_by_another_desktop(&owned));
        let standalone = anyhow::anyhow!(
            "Data directory already owned by standalone Node; stop it before starting Rust"
        )
        .context("Desktop core startup failed");
        assert!(!owned_by_another_desktop(&standalone));
    }
}
