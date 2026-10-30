//! GitHub Source sync decisions (T-59-sync), ported from
//! `web/apps/server/src/services/github-sync.ts`, `source-update-check.ts` and
//! `repos-txt.ts`.
//!
//! Every GitHub read goes through [`GithubPort`]. A port implementation owns
//! the transport: authentication, pagination, response bounds and the checked
//! outbound network. This module decides which refs, commits and files a sync
//! uses. Downloads, the snapshot store and Source rows live elsewhere.

pub mod github_url;
pub mod plan;
pub mod repos_txt;

pub use github_url::{
    GithubRepoRef, SourceLocation, github_ref_name, normalize_github_source_location,
    parse_github_url, resolve_github_url_ref,
};
pub use plan::{
    FileKind, OmissionReason, PlannedFile, PlannedOmission, PlannedSelection, RawTree, RawTreeItem,
    SnapshotPlan, SyncLimits, classify_doc_path, plan_snapshot,
};
pub use repos_txt::{
    ReposTxtLine, parse_repos_txt_line, parse_repos_txt_text, repos_txt_skipped_names,
};

use std::{fmt, future::Future};

/// A failed GitHub read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortError {
    /// The HTTP status GitHub answered with, when it answered.
    pub status: Option<u16>,
    pub message: String,
}

/// Why a sync step stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncError {
    /// The Source or GitHub's answer failed a check. The text matches Node's.
    Refused(String),
    /// A GitHub read failed.
    Port(PortError),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(message) => f.write_str(message),
            Self::Port(error) => f.write_str(&error.message),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<PortError> for SyncError {
    fn from(error: PortError) -> Self {
        Self::Port(error)
    }
}

/// The GitHub REST reads a sync makes. `owner` and `repo` come from
/// [`parse_github_url`]; list reads return every page.
pub trait GithubPort: Sync {
    /// `GET /repos/{owner}/{repo}`: the repository's default branch.
    fn default_branch(
        &self,
        owner: &str,
        repo: &str,
    ) -> impl Future<Output = Result<Option<String>, PortError>> + Send;
    /// `GET /repos/{owner}/{repo}/branches`: branch names.
    fn list_branches(
        &self,
        owner: &str,
        repo: &str,
    ) -> impl Future<Output = Result<Vec<String>, PortError>> + Send;
    /// `GET /repos/{owner}/{repo}/tags`: tag names.
    fn list_tags(
        &self,
        owner: &str,
        repo: &str,
    ) -> impl Future<Output = Result<Vec<String>, PortError>> + Send;
    /// `GET /repos/{owner}/{repo}/commits/{git_ref}`: the commit SHA a branch,
    /// tag or SHA names.
    fn commit_sha(
        &self,
        owner: &str,
        repo: &str,
        git_ref: &str,
    ) -> impl Future<Output = Result<String, PortError>> + Send;
    /// `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=true`.
    fn tree(
        &self,
        owner: &str,
        repo: &str,
        tree_sha: &str,
    ) -> impl Future<Output = Result<RawTree, PortError>> + Send;
}

const INVALID_URL: &str = "Invalid GitHub repository URL";

fn parsed(url: &str) -> Result<GithubRepoRef, SyncError> {
    parse_github_url(url).ok_or_else(|| SyncError::Refused(INVALID_URL.into()))
}

/// A repository's branches, as `GET /sources/github/branches` returns them.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct BranchListing {
    pub owner: String,
    pub repo: String,
    pub default_branch: String,
    /// The branch a deep URL names, resolved against `branches`.
    pub url_branch: Option<String>,
    pub branches: Vec<String>,
}

/// `listGithubBranches`.
pub async fn list_branches<P: GithubPort>(port: &P, url: &str) -> Result<BranchListing, SyncError> {
    let found = parsed(url)?;
    let default_branch = port.default_branch(&found.owner, &found.repo).await?;
    let branches = port.list_branches(&found.owner, &found.repo).await?;
    let url_branch = found
        .branch_from_url
        .then(|| resolve_github_url_ref(url, &branches).unwrap_or_else(|| found.branch.clone()));
    Ok(BranchListing {
        default_branch: default_branch.unwrap_or_else(|| found.branch.clone()),
        owner: found.owner,
        repo: found.repo,
        url_branch,
        branches,
    })
}

/// A repository's tags, as `GET /sources/github/tags` returns them.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct TagListing {
    pub owner: String,
    pub repo: String,
    pub tags: Vec<String>,
}

/// `listGithubTags`.
pub async fn list_tags<P: GithubPort>(port: &P, url: &str) -> Result<TagListing, SyncError> {
    let found = parsed(url)?;
    let tags = port.list_tags(&found.owner, &found.repo).await?;
    Ok(TagListing {
        owner: found.owner,
        repo: found.repo,
        tags,
    })
}

/// `resolveGithubRefName`: the ref to sync. A deep URL whose tail is not one
/// known branch reads the branch list; a failed read keeps the URL's first segment.
pub async fn resolve_ref_name<P: GithubPort>(
    port: &P,
    url: &str,
    found: &GithubRepoRef,
    requested: Option<&str>,
) -> String {
    let requested = requested
        .map(github_url::js_trim)
        .filter(|value| !value.is_empty());
    if !found.branch_from_url {
        return requested.map_or_else(|| found.branch.clone(), str::to_owned);
    }
    if let Some(value) = requested
        && resolve_github_url_ref(url, &[value]).is_some()
    {
        return value.to_owned();
    }
    if github_url::deep_github_ref_tail(url).as_deref() == Some(found.branch.as_str()) {
        return found.branch.clone();
    }
    match port.list_branches(&found.owner, &found.repo).await {
        Ok(branches) => {
            resolve_github_url_ref(url, &branches).unwrap_or_else(|| found.branch.clone())
        }
        Err(_) => found.branch.clone(),
    }
}

/// `syncGithubSource` up to its first download: resolves the ref (a tag wins),
/// reads the commit and its tree, and selects the snapshot files.
pub async fn plan_github_sync<P: GithubPort>(
    port: &P,
    url: &str,
    branch: &str,
    tag: Option<&str>,
    limits: SyncLimits,
) -> Result<SnapshotPlan, SyncError> {
    let found = parsed(url)?;
    let tag = tag.map(github_url::js_trim).filter(|tag| !tag.is_empty());
    let ref_name = match tag {
        Some(tag) => tag.to_owned(),
        None => resolve_ref_name(port, url, &found, Some(branch)).await,
    };
    let commit_sha = port
        .commit_sha(&found.owner, &found.repo, &ref_name)
        .await?;
    let tree = port.tree(&found.owner, &found.repo, &commit_sha).await?;
    plan_snapshot(&commit_sha, &tree, limits)
}

/// `remote_update_status` metadata values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteUpdateStatus {
    UpToDate,
    UpdatesAvailable,
    Unknown,
}

/// The Source row fields the update check reads.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSourceRow {
    pub local_path: Option<String>,
    pub source_kind: String,
    pub source_type: Option<String>,
    pub url: String,
    pub branch: Option<String>,
    pub last_commit_sha: Option<String>,
    pub tag: Option<String>,
}

/// `isGitSource`: a synced GitHub or Git Source that is not local.
pub fn is_git_source(row: &GitSourceRow) -> bool {
    if row.local_path.as_deref().is_none_or(str::is_empty) {
        return false;
    }
    let kind = row.source_kind.to_lowercase();
    if kind != "github" && kind != "git" {
        return false;
    }
    let source_type = row.source_type.as_deref().filter(|kind| !kind.is_empty());
    source_type.unwrap_or("git") != "local" && !row.url.starts_with("file://")
}

/// `remoteUpdateStatusOctokit`: compares the ref's current commit with the
/// last synced one. Any failed read is `unknown`.
pub async fn remote_update_status<P: GithubPort>(
    port: &P,
    url: &str,
    branch: &str,
    last_sha: Option<&str>,
    tag: Option<&str>,
) -> RemoteUpdateStatus {
    let Some(found) = parse_github_url(url) else {
        return RemoteUpdateStatus::Unknown;
    };
    let ref_name = tag
        .map(github_url::js_trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .or_else(|| github_ref_name(url, Some(branch)).filter(|name| !name.is_empty()))
        .unwrap_or_else(|| found.branch.clone());
    let Ok(remote) = port.commit_sha(&found.owner, &found.repo, &ref_name).await else {
        return RemoteUpdateStatus::Unknown;
    };
    let compare = github_url::js_trim(last_sha.unwrap_or(""));
    if compare.is_empty() {
        RemoteUpdateStatus::Unknown
    } else if remote == compare {
        RemoteUpdateStatus::UpToDate
    } else {
        RemoteUpdateStatus::UpdatesAvailable
    }
}

/// One Source's update check: `None` when it is skipped as `not_git`.
pub async fn check_source_update<P: GithubPort>(
    port: &P,
    row: &GitSourceRow,
) -> Option<RemoteUpdateStatus> {
    if !is_git_source(row) {
        return None;
    }
    Some(
        remote_update_status(
            port,
            &row.url,
            row.branch.as_deref().unwrap_or("main"),
            row.last_commit_sha.as_deref(),
            row.tag.as_deref(),
        )
        .await,
    )
}

/// Whether a check records a `source.update_available` event: only when the
/// status turns to `updates_available`.
pub fn update_event_due(previous: Option<&str>, status: RemoteUpdateStatus) -> bool {
    status == RemoteUpdateStatus::UpdatesAvailable && previous != Some("updates_available")
}
