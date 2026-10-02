use crate::{Directory, LocalFiles, PathCollisions, SourcePath, SourceRoot, compare_paths};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fmt,
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    sync::atomic::{AtomicBool, Ordering},
};

const CANDIDATE: &str = ".candidate";
pub const MAX_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_INFLATED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum ArchiveError {
    Source(crate::Error),
    Zip(zip::result::ZipError),
    InvalidArchive,
    UnsafeEntry,
    DuplicateEntry,
    Unsupported,
    Limit,
    Cancelled,
    Busy,
    Cleanup {
        operation: Box<ArchiveError>,
        cleanup: Box<ArchiveError>,
    },
}
impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Source(e) => write!(f, "{e}"),
            Self::Zip(e) => write!(f, "invalid-archive: {e}"),
            Self::InvalidArchive => write!(f, "invalid-archive"),
            Self::UnsafeEntry => write!(f, "unsafe-entry"),
            Self::DuplicateEntry => write!(f, "duplicate-entry"),
            Self::Unsupported => write!(f, "unsupported-archive"),
            Self::Limit => write!(f, "archive-limit"),
            Self::Cancelled => write!(f, "cancelled"),
            Self::Busy => write!(f, "archive-busy"),
            Self::Cleanup { operation, cleanup } => write!(f, "{operation}; cleanup: {cleanup}"),
        }
    }
}
impl std::error::Error for ArchiveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Source(error) => Some(error),
            Self::Zip(error) => Some(error),
            Self::Cleanup { operation, .. } => Some(operation),
            _ => None,
        }
    }
}
impl From<crate::Error> for ArchiveError {
    fn from(e: crate::Error) -> Self {
        Self::Source(e)
    }
}
impl From<io::Error> for ArchiveError {
    fn from(e: io::Error) -> Self {
        Self::Source(e.into())
    }
}
impl From<zip::result::ZipError> for ArchiveError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Zip(e)
    }
}
type Result<T> = std::result::Result<T, ArchiveError>;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveLimits {
    pub max_compressed_bytes: u64,
    pub max_inflated_bytes: u64,
    pub max_entries: usize,
}
impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_compressed_bytes: MAX_COMPRESSED_BYTES,
            max_inflated_bytes: MAX_INFLATED_BYTES,
            max_entries: 10_000,
        }
    }
}
pub struct ZipInput(File);
impl ZipInput {
    pub fn open(files: &LocalFiles, path: &SourcePath) -> Result<Self> {
        Ok(Self(files.root.file(path.as_str(), false)?))
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFile {
    pub path: SourcePath,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReceipt {
    pub tenant_id: String,
    pub source_id: u64,
    pub compressed_bytes: u64,
    pub archive_sha256: String,
    pub inflated_bytes: u64,
    pub entry_count: usize,
    pub stl_count: usize,
    pub files: Vec<ExtractedFile>,
    pub directories: Vec<SourcePath>,
}

struct Stage {
    parent: Directory,
    root: Directory,
    cleaned: bool,
}
impl Stage {
    fn cleanup(&mut self) -> Result<()> {
        self.parent.remove_tree(CANDIDATE)?;
        self.parent.sync()?;
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = self.cleanup();
        }
    }
}
pub struct ExtractedArchive {
    stage: Stage,
    files: LocalFiles,
    receipt: ArchiveReceipt,
}
impl ExtractedArchive {
    pub fn files(&self) -> &LocalFiles {
        &self.files
    }
    pub fn receipt(&self) -> &ArchiveReceipt {
        &self.receipt
    }
    pub fn discard(mut self) -> Result<()> {
        self.stage.cleanup()
    }
}

impl SourceRoot {
    pub fn extract_zip(
        &mut self,
        mut input: ZipInput,
        limits: ArchiveLimits,
        cancelled: &AtomicBool,
    ) -> Result<ExtractedArchive> {
        if limits.max_compressed_bytes > MAX_COMPRESSED_BYTES
            || limits.max_inflated_bytes > MAX_INFLATED_BYTES
            || limits.max_entries > 10_000
        {
            return Err(ArchiveError::Limit);
        }
        check_cancel(cancelled)?;
        let parent = self.revisions.child(".pp-source-archives", true)?;
        match parent.0.try_lock_exclusive() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return Err(ArchiveError::Busy);
            }
            Err(error) => return Err(error.into()),
        }
        parent.remove_tree(CANDIDATE)?;
        let root = parent.child(CANDIDATE, true)?;
        let mut stage = Stage {
            parent,
            root,
            cleaned: false,
        };
        let outcome = self.extract_to(&mut input, limits, cancelled, &stage);
        match outcome {
            Ok((files, receipt)) => Ok(ExtractedArchive {
                stage,
                files,
                receipt,
            }),
            Err(operation) => match stage.cleanup() {
                Ok(()) => Err(operation),
                Err(cleanup) => Err(ArchiveError::Cleanup {
                    operation: Box::new(operation),
                    cleanup: Box::new(cleanup),
                }),
            },
        }
    }
    fn extract_to(
        &self,
        input: &mut ZipInput,
        limits: ArchiveLimits,
        cancelled: &AtomicBool,
        stage: &Stage,
    ) -> Result<(LocalFiles, ArchiveReceipt)> {
        input.0.seek(SeekFrom::Start(0))?;
        let mut compressed = stage.root.file("archive.zip", true)?;
        let (compressed_bytes, archive_sha256) = transfer(
            &mut input.0,
            &mut compressed,
            limits.max_compressed_bytes,
            cancelled,
        )?;
        compressed.sync_all()?;
        let mut archive_file = stage.root.file("archive.zip", false)?;
        let entries = inspect_index(&mut archive_file, compressed_bytes, limits, cancelled)?;
        let mut archive = zip::ZipArchive::with_config(
            zip::read::Config {
                archive_offset: zip::read::ArchiveOffset::Known(0),
            },
            archive_file,
        )?;
        if archive.len() != entries.len() {
            return Err(ArchiveError::InvalidArchive);
        }
        let files = LocalFiles {
            root: stage.root.child("files", true)?,
        };
        let mut receipt = ArchiveReceipt {
            tenant_id: self.tenant_id.clone(),
            source_id: self.source_id,
            compressed_bytes,
            archive_sha256,
            inflated_bytes: 0,
            entry_count: entries.len(),
            stl_count: 0,
            files: vec![],
            directories: vec![],
        };
        let mut directories = BTreeSet::new();
        for (index, entry) in entries.iter().enumerate() {
            check_cancel(cancelled)?;
            let mut member = archive.by_index(index)?;
            if member.name_raw() != entry.raw_name.as_bytes() {
                return Err(ArchiveError::InvalidArchive);
            }
            let path = entry.path.as_str();
            let mut parent = path;
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                directories.insert(prefix.to_owned());
                parent = prefix;
            }
            if entry.directory {
                if member.size() != 0 {
                    return Err(ArchiveError::InvalidArchive);
                }
                let (parent, name) = files.root.parent(path, true)?;
                parent.child(&name, true)?;
                directories.insert(path.to_owned());
                let (size, _) = transfer(&mut member, io::sink(), 0, cancelled)?;
                if size != 0 {
                    return Err(ArchiveError::InvalidArchive);
                }
            } else {
                let mut destination = files.root.file(path, true)?;
                let (size_bytes, sha256) = transfer(
                    &mut member,
                    &mut destination,
                    limits.max_inflated_bytes - receipt.inflated_bytes,
                    cancelled,
                )?;
                if size_bytes != member.size() {
                    return Err(ArchiveError::InvalidArchive);
                }
                receipt.inflated_bytes += size_bytes;
                if path.to_ascii_lowercase().ends_with(".stl") {
                    receipt.stl_count += 1;
                }
                receipt.files.push(ExtractedFile {
                    path: entry.path.clone(),
                    size_bytes,
                    sha256,
                });
            }
        }
        receipt
            .files
            .sort_by(|a, b| compare_paths(a.path.as_str(), b.path.as_str()));
        receipt.directories = directories
            .into_iter()
            .map(SourcePath::try_from)
            .collect::<std::result::Result<_, _>>()?;
        receipt
            .directories
            .sort_by(|a, b| compare_paths(a.as_str(), b.as_str()));
        check_cancel(cancelled)?;
        Ok((files, receipt))
    }
}

fn check_cancel(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(ArchiveError::Cancelled)
    } else {
        Ok(())
    }
}
fn transfer(
    mut input: impl Read,
    mut output: impl Write,
    limit: u64,
    cancelled: &AtomicBool,
) -> Result<(u64, String)> {
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    let mut hash = Sha256::new();
    loop {
        check_cancel(cancelled)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n as u64).ok_or(ArchiveError::Limit)?;
        if bytes > limit {
            return Err(ArchiveError::Limit);
        }
        output.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
    }
    Ok((bytes, hex::encode(hash.finalize())))
}
struct Entry {
    raw_name: String,
    path: SourcePath,
    directory: bool,
}
fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("fixed header field"),
    )
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed header field"),
    )
}
fn inspect_index(
    file: &mut File,
    length: u64,
    limits: ArchiveLimits,
    cancelled: &AtomicBool,
) -> Result<Vec<Entry>> {
    let tail_size = length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_size as i64)))?;
    let mut tail = vec![0u8; tail_size];
    file.read_exact(&mut tail)?;
    let end = (0..tail_size.saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..i + 4] == *b"PK\x05\x06" && i + 22 + u16_at(&tail, i + 20) as usize == tail_size
        })
        .ok_or(ArchiveError::InvalidArchive)?;
    let footer = &tail[end..];
    let count = u16_at(footer, 10) as usize;
    let central_size = u32_at(footer, 12) as u64;
    let central_offset = u32_at(footer, 16) as u64;
    if u16_at(footer, 4) != 0
        || u16_at(footer, 6) != 0
        || u16_at(footer, 8) as usize != count
        || count == 65_535
        || central_size == u32::MAX as u64
        || central_offset == u32::MAX as u64
    {
        return Err(ArchiveError::Unsupported);
    }
    if count > limits.max_entries || central_size > MAX_METADATA_BYTES {
        return Err(ArchiveError::Limit);
    }
    if central_offset + central_size != length - tail_size as u64 + end as u64 {
        return Err(ArchiveError::InvalidArchive);
    }
    file.seek(SeekFrom::Start(central_offset))?;
    let mut entries = Vec::with_capacity(count);
    let mut paths = PathCollisions::default();
    for _ in 0..count {
        check_cancel(cancelled)?;
        let mut header = [0u8; 46];
        file.read_exact(&mut header)?;
        if header[..4] != *b"PK\x01\x02" {
            return Err(ArchiveError::InvalidArchive);
        }
        let flags = u16_at(&header, 8);
        let compression = u16_at(&header, 10);
        let mode = u32_at(&header, 38) >> 16;
        if flags & (1 | 0x40 | 0x2000) != 0
            || ![0, 8].contains(&compression)
            || u16_at(&header, 34) != 0
            || (mode & 0o170000 != 0 && ![0o100000, 0o040000].contains(&(mode & 0o170000)))
        {
            return Err(ArchiveError::Unsupported);
        }
        let name_length = u16_at(&header, 28) as usize;
        if name_length == 0 || name_length > 4097 {
            return Err(ArchiveError::UnsafeEntry);
        }
        let mut name = vec![0; name_length];
        file.read_exact(&mut name)?;
        let raw_name = String::from_utf8(name).map_err(|_| ArchiveError::Unsupported)?;
        if raw_name.chars().any(char::is_control) {
            return Err(ArchiveError::UnsafeEntry);
        }
        let directory = raw_name.ends_with('/');
        let path = SourcePath::try_from(if directory {
            raw_name[..raw_name.len() - 1].to_owned()
        } else {
            raw_name.clone()
        })
        .map_err(|_| ArchiveError::UnsafeEntry)?;
        paths
            .insert(&path, directory)
            .map_err(|error| match error {
                crate::Error::DuplicatePath => ArchiveError::DuplicateEntry,
                crate::Error::Limit => ArchiveError::Limit,
                other => ArchiveError::Source(other),
            })?;
        validate_local_header(file, &header, &raw_name, central_offset)?;
        let skip = u16_at(&header, 30) as i64 + u16_at(&header, 32) as i64;
        file.seek(SeekFrom::Current(skip))?;
        if file.stream_position()? > central_offset + central_size {
            return Err(ArchiveError::InvalidArchive);
        }
        entries.push(Entry {
            raw_name,
            path,
            directory,
        });
    }
    if file.stream_position()? != central_offset + central_size {
        return Err(ArchiveError::InvalidArchive);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(entries)
}

fn validate_local_header(
    file: &mut File,
    central: &[u8; 46],
    name: &str,
    central_offset: u64,
) -> Result<()> {
    let next = file.stream_position()?;
    let local_offset = u32_at(central, 42) as u64;
    if local_offset >= central_offset {
        return Err(ArchiveError::InvalidArchive);
    }
    file.seek(SeekFrom::Start(local_offset))?;
    let mut local = [0u8; 30];
    file.read_exact(&mut local)?;
    if local[..4] != *b"PK\x03\x04"
        || u16_at(&local, 6) != u16_at(central, 8)
        || u16_at(&local, 8) != u16_at(central, 10)
        || u16_at(&local, 26) as usize != name.len()
    {
        return Err(ArchiveError::InvalidArchive);
    }
    if u16_at(&local, 6) & 8 == 0
        && (u32_at(&local, 14) != u32_at(central, 16)
            || u32_at(&local, 18) != u32_at(central, 20)
            || u32_at(&local, 22) != u32_at(central, 24))
    {
        return Err(ArchiveError::InvalidArchive);
    }
    let payload_end = local_offset
        + 30
        + name.len() as u64
        + u16_at(&local, 28) as u64
        + u32_at(central, 20) as u64;
    if payload_end > central_offset {
        return Err(ArchiveError::InvalidArchive);
    }
    let mut local_name = vec![0; name.len()];
    file.read_exact(&mut local_name)?;
    if local_name != name.as_bytes() {
        return Err(ArchiveError::InvalidArchive);
    }
    file.seek(SeekFrom::Start(next))?;
    Ok(())
}
