use anyhow::{Context, Result, ensure};
use pp_storage::lease::StorageLease;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

pub(super) struct Snapshot {
    device: u64,
    inode: u64,
    pub bytes: Vec<u8>,
}

pub(super) fn read(owner: &StorageLease, name: &str) -> Result<Option<Snapshot>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(owner.data_dir().join(name))
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Desktop configuration unavailable"),
    };
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "Invalid {name}");
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4096, "Invalid {name}");
    Ok(Some(Snapshot {
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes,
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Boundary {
    Write,
    FileSync,
    Recheck,
    Rename,
    DirectorySync,
}

pub(super) fn publish(
    owner: &StorageLease,
    name: &str,
    bytes: &[u8],
    previous: Option<&Snapshot>,
) -> Result<()> {
    publish_with(owner, name, bytes, previous, |_| Ok(()))
}

pub(super) fn publish_with(
    owner: &StorageLease,
    name: &str,
    bytes: &[u8],
    previous: Option<&Snapshot>,
    mut boundary: impl FnMut(Boundary) -> Result<()>,
) -> Result<()> {
    let temporary = owner.data_dir().join(format!(
        "{name}-{}.new",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        boundary(Boundary::Write)?;
        file.write_all(bytes)?;
        boundary(Boundary::FileSync)?;
        file.sync_all()?;
        if let Some(previous) = previous {
            boundary(Boundary::Recheck)?;
            let current = read(owner, name)?.context("Desktop configuration changed")?;
            ensure!(
                current.device == previous.device
                    && current.inode == previous.inode
                    && current.bytes == previous.bytes,
                "Desktop configuration changed"
            );
            boundary(Boundary::Rename)?;
            std::fs::rename(&temporary, owner.data_dir().join(name))?;
        } else {
            std::fs::hard_link(&temporary, owner.data_dir().join(name))?;
        }
        Ok(())
    })();
    let cleanup = match std::fs::remove_file(&temporary) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    };
    result?;
    cleanup?;
    boundary(Boundary::DirectorySync)?;
    File::open(owner.data_dir())?.sync_all()?;
    Ok(())
}
