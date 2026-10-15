use crate::lease::StorageLease;
use anyhow::{Context, Result, bail, ensure};
use flate2::read::MultiGzDecoder;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const DATABASE: &str = "print-partner.db";
const METADATA: &str = "backup-metadata.json";
const JOURNAL: &str = ".offline-restore-journal.json";
const RESERVE: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 20 * 1024 * 1024 * 1024;
const ROOTS: &[&str] = &[
    "repos",
    "sources",
    "exports",
    "thumbs",
    "covers",
    "assistant-domain",
    "manifests",
    "custom_filaments.json",
    "kit-catalog.json",
    "kit-catalog.yaml",
    "path-hints.yaml",
];
const SIDECARS: &[&str] = &[
    "print-partner.db-wal",
    "print-partner.db-shm",
    "print-partner.db-journal",
];

#[derive(Clone, Debug)]
pub struct RestoreMetadata {
    pub created_at: String,
    pub app_version: String,
    pub scope: RestoreScope,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreScope {
    Legacy,
    Full,
    DatabaseOnly,
}

enum StageOwnership {
    Private,
    Journaled,
}

#[derive(Debug)]
pub struct RecoveryRequired;
impl std::fmt::Display for RecoveryRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recovery required; retain restore files")
    }
}
impl std::error::Error for RecoveryRequired {}

pub struct PreparedRestore {
    ownership: StageOwnership,
    stage: PathBuf,
    data: PathBuf,
    metadata: RestoreMetadata,
    replacements: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    version: String,
    format_version: u8,
    created_at: String,
    app_version: String,
    scope: Option<Scope>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    kind: String,
    included_roots: Vec<String>,
}

fn metadata(bytes: &[u8]) -> Result<RestoreMetadata> {
    let value: Metadata = serde_json::from_slice(bytes).context("Invalid backup metadata")?;
    time::OffsetDateTime::parse(
        &value.created_at,
        &time::format_description::well_known::Rfc3339,
    )
    .context("Invalid backup creation date")?;
    let scope = match (value.format_version, value.version.as_str(), value.scope) {
        (1, "1", _) => RestoreScope::Legacy,
        (2, "2", Some(scope))
            if scope.kind == "database-only" && scope.included_roots.is_empty() =>
        {
            RestoreScope::DatabaseOnly
        }
        (2, "2", Some(scope))
            if scope.kind == "full"
                && scope.included_roots.len() == ROOTS.len()
                && scope
                    .included_roots
                    .iter()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>()
                    == ROOTS.iter().copied().collect() =>
        {
            RestoreScope::Full
        }
        _ => bail!("Unsupported backup format or scope"),
    };
    Ok(RestoreMetadata {
        created_at: value.created_at,
        app_version: value.app_version,
        scope,
    })
}

fn root(name: &str) -> Option<&str> {
    ROOTS.iter().copied().enumerate().find_map(|(index, root)| {
        (name == root || (index < 7 && name.starts_with(&format!("{root}/")))).then_some(root)
    })
}
fn safe_path(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['\\', '\0', ':'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn sync(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
fn private_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new().mode(0o700).create(path)?;
    Ok(())
}
fn private_file(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?)
}
fn safe_tree(path: &Path) -> Result<()> {
    if !exists(path)? {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0,
        "Unsafe restore path permissions: {}",
        path.display()
    );
    ensure!(
        !meta.file_type().is_symlink() && (meta.is_file() || meta.is_dir()),
        "Unsafe restore path: {}",
        path.display()
    );
    if meta.is_file() {
        ensure!(
            meta.nlink() == 1,
            "Hard linked restore path: {}",
            path.display()
        );
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            safe_tree(&entry?.path())?;
        }
    }
    Ok(())
}
fn sync_tree(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        for entry in fs::read_dir(path)? {
            sync_tree(&entry?.path())?;
        }
    }
    sync(path)
}
fn remove(path: &Path) -> Result<()> {
    if !exists(path)? {
        return Ok(());
    }
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    sync(path.parent().context("Restore parent missing")?)
}
fn move_path(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to)?;
    sync(from.parent().context("Restore source parent missing")?)?;
    sync(to.parent().context("Restore destination parent missing")?)
}

impl PreparedRestore {
    pub fn metadata(&self) -> &RestoreMetadata {
        &self.metadata
    }

    pub fn prepare(owner: &StorageLease, archive: &Path) -> Result<Self> {
        let data = owner.data_dir();
        crate::lease::prepare_directory(data)?;
        ensure!(
            !exists(&data.join(JOURNAL))?,
            "Pending restore requires recovery before preparing another backup"
        );
        let input = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(archive)?;
        let stat = input.metadata()?;
        ensure!(
            stat.is_file() && stat.len() > 0,
            "Backup must be a nonempty regular file"
        );
        ensure!(
            fs2::available_space(data)? >= RESERVE,
            "Insufficient restore disk space"
        );
        let stage = data.join(format!(
            ".offline-restore-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        private_dir(&stage)?;
        let mut prepared = Self {
            ownership: StageOwnership::Private,
            stage,
            data: data.to_owned(),
            metadata: RestoreMetadata {
                created_at: String::new(),
                app_version: String::new(),
                scope: RestoreScope::DatabaseOnly,
            },
            replacements: Vec::new(),
        };
        let new = prepared.stage.join("new");
        private_dir(&new)?;
        private_dir(&prepared.stage.join("old"))?;
        let mut archive =
            tar::Archive::new(MultiGzDecoder::new(input).take(MAX_TOTAL + 100_000 * 1024));
        let mut seen = BTreeSet::new();
        let mut total = 0_u64;
        let mut pax = None;
        for (index, entry) in archive.entries()?.raw(true).enumerate() {
            let mut entry = entry?;
            let size = entry.size();
            total = total.checked_add(size).context("Archive size overflow")?;
            ensure!(
                index < 100_000
                    && size <= 8 * 1024 * 1024 * 1024
                    && total <= MAX_TOTAL
                    && total <= stat.len().saturating_mul(200),
                "Backup expansion limit exceeded"
            );
            let kind = entry.header().entry_type();
            if kind.is_pax_local_extensions() {
                ensure!(
                    pax.is_none() && size <= 64 * 1024,
                    "Oversized or nested PAX header"
                );
                let mut path = None;
                let mut declared_size = None;
                let mut keys = BTreeSet::new();
                for extension in entry.pax_extensions()?.context("Missing PAX metadata")? {
                    let extension = extension?;
                    let key = extension.key()?;
                    ensure!(keys.insert(key.to_owned()), "Duplicate PAX key");
                    match key {
                        "path" => path = Some(extension.value()?.to_owned()),
                        "size" => declared_size = Some(extension.value()?.parse::<u64>()?),
                        "mtime" | "atime" | "ctime" | "uid" | "gid" | "uname" | "gname" => {}
                        _ => bail!("Unsupported PAX attribute: {key}"),
                    }
                }
                pax = Some((path, declared_size));
                continue;
            }
            let (path, declared_size) = pax.take().unwrap_or_default();
            ensure!(
                declared_size.is_none_or(|declared| declared == size),
                "PAX size differs from entry size"
            );
            let bytes = entry.path_bytes();
            let raw = path
                .as_deref()
                .unwrap_or(std::str::from_utf8(&bytes).context("Non UTF-8 archive path")?);
            let name = raw.trim_end_matches('/').to_owned();
            ensure!(safe_path(&name), "Unsafe archive path: {raw}");
            ensure!(
                seen.len() < 100_000 && seen.insert(name.clone()),
                "Duplicate archive entry or entry limit exceeded"
            );
            let core_file = name == DATABASE || name == METADATA || name == SIDECARS[0];
            let archive_root = root(&name);
            ensure!(
                core_file || archive_root.is_some(),
                "Unexpected archive path: {name}"
            );
            ensure!(
                kind.is_file() || kind.is_dir(),
                "Links and special archive entries are unsupported"
            );
            if core_file || archive_root.is_some_and(|root| ROOTS[7..].contains(&root)) {
                ensure!(
                    kind.is_file(),
                    "Backup entry must be a regular file: {name}"
                );
            } else if archive_root == Some(name.as_str()) {
                ensure!(kind.is_dir(), "Backup root must be a directory: {name}");
            }
            ensure!(
                name != METADATA || size <= 64 * 1024,
                "Backup metadata exceeds 64 KiB"
            );
            ensure!(!kind.is_dir() || size == 0, "Directory contains file bytes");
            ensure!(
                fs2::available_space(data)? >= size.saturating_add(RESERVE),
                "Insufficient restore disk space"
            );
            let destination = new.join(&name);
            let parent = destination.parent().context("Archive parent missing")?;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
            if kind.is_dir() {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&destination)
                    .or_else(|e| {
                        if e.kind() == std::io::ErrorKind::AlreadyExists && destination.is_dir() {
                            Ok(())
                        } else {
                            Err(e)
                        }
                    })?;
            } else {
                let mut file = private_file(&destination)?;
                ensure!(
                    std::io::copy(&mut entry, &mut file)? == size,
                    "Truncated backup entry"
                );
                file.sync_all()?;
            }
        }
        let mut decoder = archive.into_inner();
        let mut padding = Vec::new();
        decoder
            .by_ref()
            .take(64 * 1024 + 1)
            .read_to_end(&mut padding)?;
        ensure!(
            decoder.limit() > 0
                && padding.len() <= 64 * 1024
                && padding.iter().all(|byte| *byte == 0),
            "Unexpected trailing backup data"
        );
        ensure!(pax.is_none(), "Dangling PAX header");
        ensure!(
            seen.contains(DATABASE) && seen.contains(METADATA),
            "Backup database or metadata missing"
        );
        prepared.metadata = metadata(&fs::read(new.join(METADATA))?)?;
        let roots = match prepared.metadata.scope {
            RestoreScope::Legacy => &ROOTS[..5],
            RestoreScope::Full => ROOTS,
            RestoreScope::DatabaseOnly => &[],
        };
        ensure!(
            seen.iter()
                .all(|name| root(name).is_none_or(|r| roots.contains(&r))),
            "Archive entries outside declared scope"
        );
        let conn =
            Connection::open_with_flags(new.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let pages: u32 = conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
        let page_size: u32 = conn.pragma_query_value(None, "page_size", |r| r.get(0))?;
        let database_bytes = u64::from(pages) * u64::from(page_size);
        ensure!(
            database_bytes <= 8 * 1024 * 1024 * 1024,
            "Staged SQLite database exceeds restore limit"
        );
        let growth = database_bytes.saturating_sub(fs::metadata(new.join(DATABASE))?.len());
        ensure!(
            fs2::available_space(data)? >= growth.saturating_add(RESERVE),
            "Insufficient SQLite checkpoint space"
        );
        crate::schema::validate_restore_schema(&conn)?;
        conn.execute_batch(
            "PRAGMA synchronous=FULL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;",
        )?;
        conn.close().map_err(|(_, e)| e)?;
        ensure!(
            fs2::available_space(data)? >= RESERVE,
            "Restore free-space reserve exhausted"
        );
        for sidecar in SIDECARS {
            remove(&new.join(sidecar))?;
        }
        prepared.replacements = std::iter::once(DATABASE.to_owned())
            .chain(SIDECARS.iter().map(|s| (*s).to_owned()))
            .chain(
                roots
                    .iter()
                    .filter(|r| {
                        prepared.metadata.scope != RestoreScope::Legacy || new.join(r).exists()
                    })
                    .map(|r| (*r).to_owned()),
            )
            .collect();
        for name in &prepared.replacements {
            safe_tree(&data.join(name))?;
        }
        sync_tree(&prepared.stage)?;
        sync(data)?;
        Ok(prepared)
    }

    /// The caller must stop and drain every writer while retaining this lease.
    pub fn activate(self, owner: &StorageLease) -> Result<()> {
        self.activate_with(owner, || Ok(()))
    }
    fn activate_with(
        mut self,
        owner: &StorageLease,
        mut boundary: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        ensure!(owner.data_dir() == self.data, "Restore lease mismatch");
        crate::lease::prepare_directory(&self.data)?;
        let entries = self
            .replacements
            .iter()
            .map(|name| {
                safe_tree(&self.data.join(name))?;
                Ok(Replacement {
                    name: name.clone(),
                    previous: exists(&self.data.join(name))?,
                    replacement: exists(&self.stage.join("new").join(name))?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let journal = Journal {
            version: 1,
            stage: self
                .stage
                .file_name()
                .context("Restore stage missing")?
                .to_str()
                .context("Invalid stage name")?
                .to_owned(),
            entries,
        };
        let mut file = private_file(&self.data.join(JOURNAL))?;
        self.ownership = StageOwnership::Journaled;
        file.write_all(&serde_json::to_vec(&journal)?)?;
        file.sync_all()?;
        sync(&self.data)?;
        let installed = (|| -> Result<()> {
            for entry in &journal.entries {
                if entry.previous {
                    move_path(
                        &self.data.join(&entry.name),
                        &self.stage.join("old").join(&entry.name),
                    )?;
                }
                boundary()?;
                if entry.replacement {
                    move_path(
                        &self.stage.join("new").join(&entry.name),
                        &self.data.join(&entry.name),
                    )?;
                }
                boundary()?;
            }
            Ok(())
        })();
        if let Err(error) = installed {
            return match recover_pending(owner) {
                Ok(()) => {
                    Err(error.context("Restore failed; original files restored; service stopped"))
                }
                Err(recovery) => Err(error
                    .context(format!("Rollback failed: {recovery:#}"))
                    .context(RecoveryRequired)),
            };
        }
        private_file(&self.stage.join("committed"))
            .and_then(|file| Ok(file.sync_all()?))
            .context(RecoveryRequired)?;
        sync(&self.stage).context(RecoveryRequired)?;
        let _ = recover_pending(owner);
        Ok(())
    }
}
impl Drop for PreparedRestore {
    fn drop(&mut self) {
        if matches!(self.ownership, StageOwnership::Private) {
            let _ = fs::remove_dir_all(&self.stage);
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    stage: String,
    entries: Vec<Replacement>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Replacement {
    name: String,
    previous: bool,
    replacement: bool,
}

pub(crate) fn pending_directory(data: &Path) -> Result<bool> {
    exists(&data.join(JOURNAL))
}
pub fn pending(owner: &StorageLease) -> Result<bool> {
    pending_directory(owner.data_dir())
}

pub fn recover_pending(owner: &StorageLease) -> Result<()> {
    let data = owner.data_dir();
    let path = data.join(JOURNAL);
    if !exists(&path)? {
        return Ok(());
    }
    crate::lease::prepare_directory(data)?;
    safe_tree(&path)?;
    ensure!(
        fs::metadata(&path)?.len() <= 64 * 1024,
        "Restore journal too large"
    );
    let journal: Journal = serde_json::from_slice(&fs::read(&path)?)?;
    ensure!(
        journal.version == 1
            && journal.stage.starts_with(".offline-restore-")
            && journal.stage.len() == ".offline-restore-".len() + 32
            && journal.stage[".offline-restore-".len()..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit()),
        "Invalid restore journal stage"
    );
    let mut names = BTreeSet::new();
    ensure!(
        journal.entries.len() <= ROOTS.len() + 4,
        "Invalid restore journal length"
    );
    for entry in &journal.entries {
        ensure!(
            (entry.name == DATABASE
                || ROOTS.contains(&entry.name.as_str())
                || SIDECARS.contains(&entry.name.as_str()))
                && names.insert(entry.name.clone()),
            "Invalid restore journal replacement"
        );
        safe_tree(&data.join(&entry.name))?;
    }
    let stage = data.join(&journal.stage);
    safe_tree(&stage)?;
    ensure!(
        stage.is_dir() && stage.join("old").is_dir() && stage.join("new").is_dir(),
        "Restore recovery files missing"
    );
    if !exists(&stage.join("committed"))? {
        for entry in journal.entries.iter().rev() {
            let live = data.join(&entry.name);
            let old = stage.join("old").join(&entry.name);
            if exists(&old)? {
                remove(&live)?;
                move_path(&old, &live)?;
            } else if !entry.previous
                && entry.replacement
                && !exists(&stage.join("new").join(&entry.name))?
            {
                remove(&live)?;
            } else if entry.previous {
                ensure!(
                    exists(&live)?,
                    "Original restore path missing; recovery required"
                );
            }
        }
    }
    fs::remove_file(path)?;
    sync(data)?;
    fs::remove_dir_all(stage)?;
    sync(data)
}

#[cfg(test)]
mod tests;
