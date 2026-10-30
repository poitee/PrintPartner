//! The snapshot a GitHub commit's tree yields, ported from `selectedTreeFiles`
//! and the selection half of `syncGithubSource` in `github-sync.ts`.

use super::SyncError;
use std::{cmp::Ordering, collections::HashMap};
use unicode_normalization::UnicodeNormalization;

pub const SOURCE_MANIFEST_FILENAME: &str = "print-partner.manifest.yaml";
pub const SOURCE_PHASE_MANIFEST_FILENAME: &str = "pp-phases.json";
pub const MAX_PHASE_MANIFEST_BYTES: u64 = 1024 * 1024;
const MANIFEST_SNAPSHOT_FORMAT_VERSION: u32 = 2;
const PHASE_SNAPSHOT_FORMAT_VERSION: u32 = 3;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SOURCE_SNAPSHOT_MANIFEST_FILE: &str = ".printpartner-source-snapshot.json";

/// A snapshot file's kind. Serializes like `pp_source::FileKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Stl,
    Artifact,
    Readme,
    Md,
    Pdf,
}

/// A file to download. Serializes like `pp_source::SelectedFile`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub path: String,
    pub kind: FileKind,
    pub size_hint_bytes: Option<u64>,
}

/// Why a document stays out of the snapshot. Serializes like `pp_source::OmissionReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OmissionReason {
    DocumentationByteBudget,
    UnknownDocumentSize,
}

/// A document left out. Serializes like `pp_source::OmittedFile`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOmission {
    pub path: String,
    pub kind: FileKind,
    pub size_hint_bytes: Option<u64>,
    pub reason: OmissionReason,
}

/// The caps and omissions a snapshot records. Serializes like `pp_source::Selection`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedSelection {
    pub max_stl_files: u64,
    pub max_documentation_bytes: u64,
    pub omitted_files: Vec<PlannedOmission>,
}

/// One `git/trees?recursive=true` item as GitHub returned it.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub struct RawTreeItem {
    pub path: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub mode: Option<String>,
    pub size: Option<u64>,
    pub sha: Option<String>,
}

/// A recursive tree listing for one commit.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub struct RawTree {
    pub tree: Vec<RawTreeItem>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryType {
    Blob,
    Tree,
    Commit,
}

/// A tree item kept by `fetchGithubTreeEntries`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    path: String,
    kind: EntryType,
    mode: Option<String>,
    size: Option<u64>,
    blob_sha: Option<String>,
}

/// Drops items with no path or an unknown type, and keeps only 40-hex blob SHAs.
pub fn tree_entries(tree: &RawTree) -> Vec<TreeEntry> {
    tree.tree
        .iter()
        .filter_map(|item| {
            let path = item.path.as_deref().filter(|path| !path.is_empty())?;
            let kind = match item.kind.as_deref()? {
                "blob" => EntryType::Blob,
                "tree" => EntryType::Tree,
                "commit" => EntryType::Commit,
                _ => return None,
            };
            Some(TreeEntry {
                path: path.to_owned(),
                kind,
                mode: item.mode.clone(),
                size: item.size,
                blob_sha: item
                    .sha
                    .as_deref()
                    .filter(|sha| is_hex_sha(sha))
                    .map(str::to_ascii_lowercase),
            })
        })
        .collect()
}

pub(crate) fn is_hex_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Caps the caller applies to one GitHub snapshot. Node also refuses negative
/// limits; `u64` cannot hold one, so a caller converting from JSON refuses them first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncLimits {
    pub max_stl_files: u64,
    pub max_documentation_bytes: u64,
    /// Timeout for each raw file response and body stream.
    pub file_timeout_ms: u64,
}

impl Default for SyncLimits {
    fn default() -> Self {
        Self {
            max_stl_files: 500,
            max_documentation_bytes: 1024 * 1024 * 1024,
            file_timeout_ms: 120_000,
        }
    }
}

/// The immutable revision a commit yields and the files to download for it.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPlan {
    pub commit_sha: String,
    pub upstream_revision_key: String,
    /// STLs, then metadata, then the documents inside the budget.
    pub files: Vec<PlannedFile>,
    pub selection: PlannedSelection,
}

/// `classifyDocPath`.
pub fn classify_doc_path(path: &str) -> Option<FileKind> {
    let lower = path.to_lowercase();
    if lower.ends_with(".pdf") {
        return Some(FileKind::Pdf);
    }
    if !lower.ends_with(".md") {
        return None;
    }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    Some(if base == "readme.md" || base.starts_with("readme.") {
        FileKind::Readme
    } else {
        FileKind::Md
    })
}

fn is_metadata_path(path: &str) -> bool {
    path == SOURCE_MANIFEST_FILENAME || path == SOURCE_PHASE_MANIFEST_FILENAME
}

fn snapshot_kind(path: &str) -> Option<FileKind> {
    if path.to_lowercase().ends_with(".stl") {
        Some(FileKind::Stl)
    } else if is_metadata_path(path) {
        Some(FileKind::Artifact)
    } else {
        classify_doc_path(path)
    }
}

/// `sourceRelativePath`. The snapshot store applies its own, stricter path
/// rules when it publishes these files (`rust/crates/pp-source/README.md`).
fn source_path(path: &str) -> Result<&str, SyncError> {
    let unsafe_path = path.is_empty()
        || path.contains(['\\', '\0'])
        || path.starts_with('/')
        || path.nfc().collect::<String>() != path
        || path
            .split('/')
            .any(|segment| matches!(segment, "" | "." | ".."));
    if unsafe_path {
        return Err(SyncError::Refused(format!(
            "Unsafe Source snapshot path: {path}"
        )));
    }
    if path == SOURCE_SNAPSHOT_MANIFEST_FILE {
        return Err(SyncError::Refused(format!(
            "Source content cannot use reserved path: {path}"
        )));
    }
    Ok(path)
}

fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn is_regular_blob(entry: &TreeEntry) -> bool {
    entry.kind == EntryType::Blob && matches!(entry.mode.as_deref(), Some("100644" | "100755"))
}

/// `selectedTreeFiles`: snapshot-kind entries in UTF-16 path order, with
/// case-insensitive duplicates allowed only for identical blobs.
fn selected_tree_files(entries: &[TreeEntry]) -> Result<Vec<&TreeEntry>, SyncError> {
    let mut sorted = entries.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| utf16_order(&left.path, &right.path));
    let mut selected = Vec::new();
    let mut by_folded_path = HashMap::<String, &TreeEntry>::new();
    for entry in sorted {
        let Some(kind) = snapshot_kind(&entry.path) else {
            continue;
        };
        if !is_regular_blob(entry) {
            return Err(SyncError::Refused(format!(
                "GitHub Source contains an unsupported selected entry: {}",
                entry.path
            )));
        }
        let folded = source_path(&entry.path)?.to_lowercase();
        if let Some(prior) = by_folded_path.get(&folded) {
            if entry.blob_sha.is_some()
                && entry.blob_sha == prior.blob_sha
                && snapshot_kind(&prior.path) == Some(kind)
            {
                continue;
            }
            return Err(SyncError::Refused(format!(
                "Duplicate Source snapshot path: {}; case-insensitive paths do not have identical Git blob identities",
                entry.path
            )));
        }
        by_folded_path.insert(folded, entry);
        selected.push(entry);
    }
    Ok(selected)
}

fn revision_key(commit_sha: &str, selected: &[&TreeEntry]) -> String {
    let has = |name: &str| selected.iter().any(|entry| entry.path == name);
    if has(SOURCE_PHASE_MANIFEST_FILENAME) {
        format!("{commit_sha}.snapshot-v{PHASE_SNAPSHOT_FORMAT_VERSION}")
    } else if has(SOURCE_MANIFEST_FILENAME) {
        format!("{commit_sha}.snapshot-v{MANIFEST_SNAPSHOT_FORMAT_VERSION}")
    } else {
        commit_sha.to_owned()
    }
}

/// The root collation order, which `en-US` shares and `pp_storage` uses for
/// Source documents. Node's `localeCompare` follows the process's default
/// locale, so a Node server under another locale can order documents, and pick
/// which ones fit the budget, differently. Rust does not follow the system locale.
fn collator() -> Result<icu_collator::CollatorBorrowed<'static>, SyncError> {
    icu_collator::Collator::try_new(Default::default(), Default::default())
        .map_err(|error| SyncError::Refused(format!("{error}")))
}

fn selected(entry: &TreeEntry, kind: FileKind) -> Result<PlannedFile, SyncError> {
    Ok(PlannedFile {
        path: source_path(&entry.path)?.to_owned(),
        kind,
        size_hint_bytes: entry.size,
    })
}

/// Selects one commit's snapshot files in the order and with the refusals
/// `syncGithubSource` applies before it downloads anything.
pub fn plan_snapshot(
    commit_sha: &str,
    tree: &RawTree,
    limits: SyncLimits,
) -> Result<SnapshotPlan, SyncError> {
    if tree.truncated {
        return Err(SyncError::Refused(
            "GitHub returned a truncated repository tree; Source snapshot was not created".into(),
        ));
    }
    if !is_hex_sha(commit_sha) {
        return Err(SyncError::Refused(
            "GitHub returned an invalid commit SHA".into(),
        ));
    }
    let entries = tree_entries(tree);
    let chosen = selected_tree_files(&entries)?;
    let stls = chosen
        .iter()
        .copied()
        .filter(|entry| snapshot_kind(&entry.path) == Some(FileKind::Stl))
        .collect::<Vec<_>>();
    let metadata = chosen
        .iter()
        .copied()
        .filter(|entry| is_metadata_path(&entry.path))
        .collect::<Vec<_>>();
    let docs = chosen
        .iter()
        .copied()
        .filter(|entry| classify_doc_path(&entry.path).is_some())
        .collect::<Vec<_>>();
    if metadata
        .iter()
        .find(|entry| entry.path == SOURCE_PHASE_MANIFEST_FILENAME)
        .and_then(|entry| entry.size)
        .is_some_and(|size| size > MAX_PHASE_MANIFEST_BYTES)
    {
        return Err(SyncError::Refused(format!(
            "Source phase manifest exceeds the {MAX_PHASE_MANIFEST_BYTES} byte limit"
        )));
    }

    if limits.max_stl_files > MAX_SAFE_INTEGER {
        return Err(SyncError::Refused(
            "STL file limit must be a non-negative safe integer".into(),
        ));
    }
    if stls.len() as u64 > limits.max_stl_files {
        return Err(SyncError::Refused(format!(
            "GitHub Source contains {} STL files, exceeding the limit of {}",
            stls.len(),
            limits.max_stl_files
        )));
    }
    let max_docs = limits.max_documentation_bytes;
    if max_docs > MAX_SAFE_INTEGER {
        return Err(SyncError::Refused(
            "Documentation byte limit must be a non-negative safe integer".into(),
        ));
    }
    if limits.file_timeout_ms == 0 || limits.file_timeout_ms > MAX_SAFE_INTEGER {
        return Err(SyncError::Refused(
            "GitHub file timeout must be a positive safe integer".into(),
        ));
    }

    let mut used = metadata
        .iter()
        .map(|entry| entry.size.unwrap_or(0))
        .fold(0u64, u64::saturating_add);
    if used > max_docs {
        return Err(SyncError::Refused(format!(
            "GitHub Source metadata exceeds the {max_docs} byte documentation limit"
        )));
    }
    let collator = collator()?;
    let mut ordered_docs = docs;
    ordered_docs.sort_by(|left, right| collator.compare(&left.path, &right.path));
    let mut kept_docs = Vec::new();
    let mut omitted_files = Vec::new();
    for entry in ordered_docs {
        let Some(kind) = classify_doc_path(&entry.path) else {
            continue;
        };
        let Some(size) = entry.size else {
            omitted_files.push(PlannedOmission {
                path: source_path(&entry.path)?.to_owned(),
                kind,
                size_hint_bytes: None,
                reason: OmissionReason::UnknownDocumentSize,
            });
            continue;
        };
        if size > 0 && used.saturating_add(size) > max_docs {
            omitted_files.push(PlannedOmission {
                path: source_path(&entry.path)?.to_owned(),
                kind,
                size_hint_bytes: Some(size),
                reason: OmissionReason::DocumentationByteBudget,
            });
            continue;
        }
        used = used.saturating_add(size);
        kept_docs.push((entry, kind));
    }

    let mut files = Vec::new();
    for entry in &stls {
        files.push(selected(entry, FileKind::Stl)?);
    }
    for entry in &metadata {
        files.push(selected(entry, FileKind::Artifact)?);
    }
    for (entry, kind) in kept_docs {
        files.push(selected(entry, kind)?);
    }
    Ok(SnapshotPlan {
        commit_sha: commit_sha.to_owned(),
        upstream_revision_key: revision_key(commit_sha, &chosen),
        files,
        selection: PlannedSelection {
            max_stl_files: limits.max_stl_files,
            max_documentation_bytes: max_docs,
            omitted_files,
        },
    })
}
