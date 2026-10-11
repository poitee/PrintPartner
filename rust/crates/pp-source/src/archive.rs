use crate::{
    Directory, LocalFiles, PathCollisions, SourceLockGuard, SourcePath, SourceRoot, compare_paths,
};
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
pub const MAX_METADATA_BYTES: u64 = 8 * 1024 * 1024;
/// Each file entry may inflate to at most this multiple of its compressed size.
pub const MAX_COMPRESSION_RATIO: u64 = 100;
/// Entries up to this many inflated bytes are exempt from the ratio cap, so
/// small highly compressible files (padding, empty meshes) stay valid.
pub const COMPRESSION_RATIO_FLOOR_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
pub enum ArchiveError {
    Source(crate::Error),
    Zip(zip::result::ZipError),
    InvalidArchive,
    UnsafeEntry,
    DuplicateEntry,
    Unsupported,
    Limit,
    CompressionRatio,
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
            Self::CompressionRatio => write!(f, "compression-ratio"),
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
    // The per-Source revisions lock shared with snapshot materialization, so
    // a live archive stage and a peer's snapshot candidate never coexist.
    // Dropped after `Drop::drop` removes the stage, so the lock outlives it.
    _lock: SourceLockGuard,
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
/// Owned extraction readiness. It holds the Source's revisions lock until
/// consumed: the originating `SourceRoot` may materialize from it, while other
/// handles block in `materialize` or get `archive-busy` from `extract_zip`.
/// Prefer `discard()`, which reports cleanup errors; dropping also cleans up
/// but cannot report failure.
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
        // This handle's own materialize joins the hold instead of waiting.
        let lock = self.lock.try_acquire_alone()?.ok_or(ArchiveError::Busy)?;
        let parent = self.revisions.child(".pp-source-archives", true)?;
        parent.remove_tree(CANDIDATE)?;
        let root = match parent.child(CANDIDATE, true) {
            Ok(root) => root,
            Err(error) => {
                // Creation can fail after mkdir (e.g. parent fsync); never
                // leave the candidate behind.
                let _ = parent.remove_tree(CANDIDATE);
                return Err(error.into());
            }
        };
        let mut stage = Stage {
            parent,
            root,
            cleaned: false,
            _lock: lock,
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
        let mut archive_file = stage.root.file_read_write("archive.zip")?;
        let (entries, eocd_offset) =
            inspect_index(&mut archive_file, compressed_bytes, limits, cancelled)?;
        bind_zip_reader_to_validated_eocd(&mut archive_file, eocd_offset)?;
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
            // The reader may resolve sizes from ZIP64 extra fields; the ratio
            // cap and limits are only sound for the sizes checked in preflight.
            if member.name_raw() != entry.raw_name.as_bytes()
                || member.compressed_size() != entry.compressed_bytes
                || member.size() != entry.inflated_bytes
            {
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
                let remaining = limits.max_inflated_bytes - receipt.inflated_bytes;
                let ratio_limit = ratio_limit(entry.compressed_bytes);
                let (size_bytes, sha256) = match transfer(
                    &mut member,
                    &mut destination,
                    remaining.min(ratio_limit),
                    cancelled,
                ) {
                    Err(ArchiveError::Limit) if ratio_limit < remaining => {
                        return Err(ArchiveError::CompressionRatio);
                    }
                    result => result?,
                };
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
    compressed_bytes: u64,
    inflated_bytes: u64,
}
fn ratio_limit(compressed_bytes: u64) -> u64 {
    compressed_bytes
        .saturating_mul(MAX_COMPRESSION_RATIO)
        .max(COMPRESSION_RATIO_FLOOR_BYTES)
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
const ZIP32_EOCD_SIGNATURE: &[u8] = b"PK\x05\x06";
const ZIP64_EOCD_SIGNATURE: &[u8] = b"PK\x06\x06";
const ZIP64_EOCD_LOCATOR_SIGNATURE: &[u8] = b"PK\x06\x07";

fn comment_contains_zip_end_record(comment: &[u8]) -> bool {
    for signature in [
        ZIP32_EOCD_SIGNATURE,
        ZIP64_EOCD_SIGNATURE,
        ZIP64_EOCD_LOCATOR_SIGNATURE,
    ] {
        if comment
            .windows(signature.len())
            .any(|window| window == signature)
        {
            return true;
        }
    }
    false
}

/// Truncate the staged copy at the validated EOCD and clear its comment length so
/// the ZIP crate cannot index a decoy end record embedded in the archive comment.
fn bind_zip_reader_to_validated_eocd(file: &mut File, eocd_offset: u64) -> Result<()> {
    file.seek(SeekFrom::Start(eocd_offset + 20))?;
    file.write_all(&[0u8; 2])?;
    file.set_len(eocd_offset + 22)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

fn inspect_index(
    file: &mut File,
    length: u64,
    limits: ArchiveLimits,
    cancelled: &AtomicBool,
) -> Result<(Vec<Entry>, u64)> {
    let tail_size = length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_size as i64)))?;
    let mut tail = vec![0u8; tail_size];
    file.read_exact(&mut tail)?;
    let tail_start = length - tail_size as u64;
    let mut chosen = None;
    for i in (0..tail_size.saturating_sub(21)).rev() {
        if tail[i..i + 4] != *ZIP32_EOCD_SIGNATURE {
            continue;
        }
        let comment_len = u16_at(&tail, i + 20) as usize;
        if i + 22 + comment_len != tail_size {
            continue;
        }
        let footer = &tail[i..];
        let central_size = u32_at(footer, 12) as u64;
        let central_offset = u32_at(footer, 16) as u64;
        let eocd_offset = tail_start + i as u64;
        if central_offset + central_size != eocd_offset {
            continue;
        }
        let comment = &footer[22..22 + comment_len];
        if comment_contains_zip_end_record(comment) {
            return Err(ArchiveError::InvalidArchive);
        }
        if chosen.is_some() {
            return Err(ArchiveError::InvalidArchive);
        }
        chosen = Some((footer, eocd_offset));
    }
    let Some((footer, eocd_offset)) = chosen else {
        return Err(ArchiveError::InvalidArchive);
    };
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
        // Reject advertised bombs before inflating; transfer enforces the same
        // cap on actual bytes because these sizes are untrusted.
        let compressed_bytes = u32_at(&header, 20) as u64;
        let inflated_bytes = u32_at(&header, 24) as u64;
        if inflated_bytes > ratio_limit(compressed_bytes) {
            return Err(ArchiveError::CompressionRatio);
        }
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
            compressed_bytes,
            inflated_bytes,
        });
    }
    if file.stream_position()? != central_offset + central_size {
        return Err(ArchiveError::InvalidArchive);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok((entries, eocd_offset))
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
