mod directory;

use directory::Directory;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    borrow::Borrow,
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::{self, Read, Write},
    path::Path,
};
use unicode_normalization::UnicodeNormalization;

pub const MANIFEST: &str = ".printpartner-source-snapshot.json";
pub const MAX_CONTENT_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 10_000;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const CANDIDATE: &str = ".pp-source-candidate";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    UnsafePath,
    InvalidIdentity,
    DuplicatePath,
    Limit,
    CorruptSnapshot,
    Io(io::Error),
    Json(serde_json::Error),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "io: {error}"),
            Self::Json(error) => write!(f, "invalid-json: {error}"),
            _ => write!(f, "{}", self.category()),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}
impl Error {
    pub fn category(&self) -> &'static str {
        match self {
            Self::UnsafePath => "unsafe-path",
            Self::InvalidIdentity => "invalid-identity",
            Self::DuplicatePath => "duplicate-path",
            Self::Limit => "limit",
            Self::CorruptSnapshot => "corrupt-snapshot",
            Self::Io(_) => "io",
            Self::Json(_) => "invalid-json",
        }
    }
}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<rustix::io::Errno> for Error {
    fn from(e: rustix::io::Errno) -> Self {
        Self::Io(e.into())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourcePath(String);
impl TryFrom<String> for SourcePath {
    type Error = Error;
    fn try_from(value: String) -> Result<Self> {
        if value.is_empty()
            || value.len() > 4096
            || value.contains(['\\', '\0', ':'])
            || value.starts_with('/')
            || value.nfc().collect::<String>() != value
            || value
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
            || value.split('/').count() > 64
            || value.split('/').next() == Some(MANIFEST)
        {
            return Err(Error::UnsafePath);
        }
        Ok(Self(value))
    }
}
impl From<SourcePath> for String {
    fn from(value: SourcePath) -> Self {
        value.0
    }
}
impl SourcePath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Stl,
    Artifact,
    Readme,
    Md,
    Pdf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedFile {
    pub path: SourcePath,
    pub kind: FileKind,
    pub size_hint_bytes: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OmissionReason {
    DocumentationByteBudget,
    UnknownDocumentSize,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OmittedFile {
    pub path: SourcePath,
    pub kind: FileKind,
    pub size_hint_bytes: Option<u64>,
    pub reason: OmissionReason,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub max_stl_files: u64,
    pub max_documentation_bytes: u64,
    pub omitted_files: Vec<OmittedFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentFile {
    pub path: SourcePath,
    pub kind: FileKind,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRequest {
    pub upstream_revision_key: String,
    pub files: Vec<SelectedFile>,
    pub selection: Selection,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u8,
    upstream_revision_key: String,
    manifest_digest: String,
    selection: Selection,
    files: Vec<ContentFile>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSnapshot {
    pub tenant_id: String,
    pub source_id: u64,
    pub upstream_revision_key: String,
    pub manifest_digest: String,
    pub snapshot_locator: String,
    pub files: Vec<ContentFile>,
    pub selection: Selection,
    pub publication: Publication,
    pub stored_bytes: u64,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Publication {
    Created,
    Reused,
}

pub struct TenantRepos {
    tenant_id: String,
    root: Directory,
}
pub struct SourceRoot {
    tenant_id: String,
    source_id: u64,
    revisions: Directory,
}
pub struct LocalFiles {
    root: Directory,
}
#[derive(Clone, Copy)]
pub struct ArtifactBudget {
    stored_bytes: u64,
    content_bytes: u64,
}
impl ArtifactBudget {
    pub fn new(reserved_stored_bytes: u64, max_content_bytes: u64) -> Result<Self> {
        if max_content_bytes > MAX_CONTENT_BYTES {
            return Err(Error::Limit);
        }
        Ok(Self {
            stored_bytes: reserved_stored_bytes,
            content_bytes: max_content_bytes,
        })
    }
}
impl TenantRepos {
    pub fn open(tenant_id: String, configured_repos: &Path) -> Result<Self> {
        if tenant_id.trim().is_empty() || tenant_id.len() > 200 {
            return Err(Error::InvalidIdentity);
        }
        Ok(Self {
            tenant_id,
            root: Directory::open_root(configured_repos)?,
        })
    }
    pub fn source(&self, source_id: u64) -> Result<SourceRoot> {
        if source_id == 0 || source_id > MAX_SAFE_INTEGER {
            return Err(Error::InvalidIdentity);
        }
        Ok(SourceRoot {
            tenant_id: self.tenant_id.clone(),
            source_id,
            revisions: self
                .root
                .child(&source_id.to_string(), true)?
                .child("revisions", true)?,
        })
    }
}
impl LocalFiles {
    pub fn open(selected_directory: &Path) -> Result<Self> {
        Ok(Self {
            root: Directory::open_root(selected_directory)?,
        })
    }
}

fn validate_revision(key: &str) -> Result<()> {
    if key.is_empty()
        || key.len() > 200
        || !key.as_bytes()[0].is_ascii_alphanumeric()
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(Error::InvalidIdentity);
    }
    Ok(())
}
fn compare_paths(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
fn validate_request(request: &mut SnapshotRequest) -> Result<()> {
    validate_revision(&request.upstream_revision_key)?;
    if request.files.len() + request.selection.omitted_files.len() > MAX_ENTRIES
        || request.selection.max_stl_files > MAX_SAFE_INTEGER
        || request.selection.max_documentation_bytes > MAX_SAFE_INTEGER
    {
        return Err(Error::Limit);
    }
    let mut paths = BTreeSet::new();
    for file in &request.files {
        if file.size_hint_bytes.is_some_and(|n| n > MAX_SAFE_INTEGER) {
            return Err(Error::Limit);
        }
        if !paths.insert(file.path.0.to_lowercase()) {
            return Err(Error::DuplicatePath);
        }
    }
    for path in &paths {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if paths.contains(prefix) {
                return Err(Error::DuplicatePath);
            }
            parent = prefix;
        }
    }
    let mut tree_entries = paths.clone();
    for path in &paths {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            tree_entries.insert(format!("{prefix}/"));
            if tree_entries.len() > MAX_ENTRIES {
                return Err(Error::Limit);
            }
            parent = prefix;
        }
    }
    for file in &request.selection.omitted_files {
        if matches!(file.kind, FileKind::Stl | FileKind::Artifact)
            || file.size_hint_bytes.is_some_and(|n| n > MAX_SAFE_INTEGER)
        {
            return Err(Error::CorruptSnapshot);
        }
        if !paths.insert(file.path.0.to_lowercase()) {
            return Err(Error::DuplicatePath);
        }
    }
    request
        .files
        .sort_by(|a, b| compare_paths(a.path.as_str(), b.path.as_str()));
    request
        .selection
        .omitted_files
        .sort_by(|a, b| compare_paths(a.path.as_str(), b.path.as_str()));
    Ok(())
}
fn digest(files: &[ContentFile]) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(files)?)))
}
fn copy_hash(mut input: impl Read, mut output: impl Write, limit: u64) -> Result<(u64, String)> {
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or(Error::Limit)?;
        if count > limit {
            return Err(Error::Limit);
        }
        output.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
    }
    Ok((count, hex::encode(hash.finalize())))
}
fn tree_paths(
    dir: &Directory,
    prefix: &str,
    result: &mut BTreeSet<String>,
    depth: usize,
) -> Result<()> {
    if depth > 64 {
        return Err(Error::Limit);
    }
    for name in dir.entries()? {
        if prefix.is_empty() && name == MANIFEST {
            continue;
        }
        if result.len() >= MAX_ENTRIES {
            return Err(Error::Limit);
        }
        let path = format!("{prefix}{name}");
        SourcePath::try_from(path.clone())?;
        match dir.child(&name, false) {
            Ok(child) => {
                result.insert(format!("{path}/"));
                tree_paths(&child, &format!("{path}/"), result, depth + 1)?;
                child.sync()?;
            }
            Err(_) => {
                dir.file(&name, false)?;
                result.insert(path);
            }
        }
    }
    Ok(())
}
fn expected_paths(files: &[ContentFile]) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    for file in files {
        paths.insert(file.path.0.clone());
        let mut parent = file.path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            paths.insert(format!("{prefix}/"));
            parent = prefix;
        }
    }
    paths
}

fn canonical_destination(
    path: &SourcePath,
    directories: &mut BTreeMap<String, String>,
) -> Result<SourcePath> {
    let mut original = String::new();
    let mut canonical = String::new();
    let mut components = path.as_str().split('/').peekable();
    while let Some(component) = components.next() {
        if !original.is_empty() {
            original.push('/');
            canonical.push('/');
        }
        original.push_str(component);
        canonical.push_str(component);
        if components.peek().is_some() {
            canonical = directories
                .entry(original.to_lowercase())
                .or_insert_with(|| canonical.clone())
                .clone();
        }
    }
    SourcePath::try_from(canonical)
}

impl SourceRoot {
    pub fn materialize(
        &mut self,
        request: SnapshotRequest,
        input: &LocalFiles,
        budget: ArtifactBudget,
    ) -> Result<PublishedSnapshot> {
        self.materialize_lazy(request, || Ok(input), budget)
    }
    /// Open local inputs only if the revision needs a new publication.
    pub fn materialize_from_directory(
        &mut self,
        request: SnapshotRequest,
        input_directory: &Path,
        budget: ArtifactBudget,
    ) -> Result<PublishedSnapshot> {
        self.materialize_lazy(request, || LocalFiles::open(input_directory), budget)
    }
    fn materialize_lazy<I: Borrow<LocalFiles>>(
        &mut self,
        mut request: SnapshotRequest,
        open_input: impl FnOnce() -> Result<I>,
        budget: ArtifactBudget,
    ) -> Result<PublishedSnapshot> {
        validate_request(&mut request)?;
        self.revisions.0.lock_exclusive()?;
        let result = self.materialize_locked(request, open_input, budget);
        let unlocked = FileExt::unlock(&self.revisions.0);
        match result {
            Err(error) => Err(error),
            Ok(value) => {
                unlocked?;
                Ok(value)
            }
        }
    }
    fn materialize_locked<I: Borrow<LocalFiles>>(
        &self,
        request: SnapshotRequest,
        open_input: impl FnOnce() -> Result<I>,
        budget: ArtifactBudget,
    ) -> Result<PublishedSnapshot> {
        self.revisions.remove_tree(CANDIDATE)?;
        match self.revisions.child(&request.upstream_revision_key, false) {
            Ok(existing) => return self.load(&existing, &request.upstream_revision_key),
            Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let input = open_input()?;
        let candidate = self.revisions.child(CANDIDATE, true)?;
        let outcome = self.write_candidate(&candidate, request, input.borrow(), budget);
        let cleanup = self
            .revisions
            .remove_tree(CANDIDATE)
            .and_then(|()| self.revisions.sync());
        match outcome {
            Err(error) => Err(error),
            Ok(receipt) => {
                cleanup?;
                Ok(receipt)
            }
        }
    }
    fn write_candidate(
        &self,
        candidate: &Directory,
        request: SnapshotRequest,
        input: &LocalFiles,
        budget: ArtifactBudget,
    ) -> Result<PublishedSnapshot> {
        let mut bytes = 0;
        let mut docs = 0;
        let mut stls = 0;
        let mut files = Vec::new();
        let mut directories = BTreeMap::new();
        for selected in request.files {
            let source = input.root.file(selected.path.as_str(), false)?;
            let length = source.metadata()?.len();
            // Keep the original spelling for reading case-sensitive inputs, but
            // share one deterministic spelling for destination directories.
            let path = canonical_destination(&selected.path, &mut directories)?;
            let mut destination = candidate.file(path.as_str(), true)?;
            let (size_bytes, sha256) = copy_hash(
                source,
                &mut destination,
                budget.content_bytes.min(budget.stored_bytes) - bytes,
            )?;
            if length != size_bytes {
                return Err(Error::CorruptSnapshot);
            }
            destination.sync_all()?;
            bytes += size_bytes;
            if selected.kind == FileKind::Stl {
                stls += 1;
            } else {
                docs += size_bytes;
            }
            if stls > request.selection.max_stl_files
                || docs > request.selection.max_documentation_bytes
            {
                return Err(Error::Limit);
            }
            files.push(ContentFile {
                path,
                kind: selected.kind,
                size_bytes,
                sha256,
            });
        }
        files.sort_by(|a, b| compare_paths(a.path.as_str(), b.path.as_str()));
        let manifest = Manifest {
            version: 1,
            upstream_revision_key: request.upstream_revision_key,
            manifest_digest: digest(&files)?,
            selection: request.selection,
            files,
        };
        let mut encoded = serde_json::to_vec_pretty(&manifest)?;
        encoded.push(b'\n');
        if encoded.len() as u64 > MAX_MANIFEST_BYTES
            || bytes + encoded.len() as u64 > budget.stored_bytes
        {
            return Err(Error::Limit);
        }
        let mut file = candidate.file(MANIFEST, true)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        let mut paths = BTreeSet::new();
        tree_paths(candidate, "", &mut paths, 0)?;
        if paths != expected_paths(&manifest.files) {
            return Err(Error::CorruptSnapshot);
        }
        candidate.sync()?;
        self.revisions
            .publish(CANDIDATE, &manifest.upstream_revision_key)?;
        Ok(self.receipt(manifest, Publication::Created, bytes + encoded.len() as u64))
    }
    fn load(&self, existing: &Directory, key: &str) -> Result<PublishedSnapshot> {
        let mut raw = Vec::new();
        existing
            .file(MANIFEST, false)?
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut raw)?;
        if raw.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(Error::Limit);
        }
        let manifest: Manifest = serde_json::from_slice(&raw)?;
        let mut request = SnapshotRequest {
            upstream_revision_key: manifest.upstream_revision_key.clone(),
            files: manifest
                .files
                .iter()
                .map(|f| SelectedFile {
                    path: f.path.clone(),
                    kind: f.kind.clone(),
                    size_hint_bytes: Some(f.size_bytes),
                })
                .collect(),
            selection: manifest.selection.clone(),
        };
        validate_request(&mut request)?;
        if manifest.version != 1
            || manifest.upstream_revision_key != key
            || digest(&manifest.files)? != manifest.manifest_digest
            || !manifest
                .files
                .windows(2)
                .all(|p| compare_paths(p[0].path.as_str(), p[1].path.as_str()).is_lt())
        {
            return Err(Error::CorruptSnapshot);
        }
        let mut actual = BTreeSet::new();
        tree_paths(existing, "", &mut actual, 0)?;
        if actual != expected_paths(&manifest.files) {
            return Err(Error::CorruptSnapshot);
        }
        let mut bytes = 0;
        for file in &manifest.files {
            let (size, sha) = copy_hash(
                existing.file(file.path.as_str(), false)?,
                io::sink(),
                MAX_CONTENT_BYTES - bytes,
            )?;
            if size != file.size_bytes || sha != file.sha256 {
                return Err(Error::CorruptSnapshot);
            }
            bytes += size;
        }
        Ok(self.receipt(manifest, Publication::Reused, bytes + raw.len() as u64))
    }
    fn receipt(
        &self,
        manifest: Manifest,
        publication: Publication,
        stored_bytes: u64,
    ) -> PublishedSnapshot {
        PublishedSnapshot {
            tenant_id: self.tenant_id.clone(),
            source_id: self.source_id,
            snapshot_locator: format!(
                "{}/revisions/{}",
                self.source_id, manifest.upstream_revision_key
            ),
            upstream_revision_key: manifest.upstream_revision_key,
            manifest_digest: manifest.manifest_digest,
            files: manifest.files,
            selection: manifest.selection,
            publication,
            stored_bytes,
        }
    }
}
