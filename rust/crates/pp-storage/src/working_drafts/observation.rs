use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy)]
pub enum Resource {
    Entries,
    Depth,
    Path,
    PathBytes,
    ArtifactBytes,
    DocumentBytes,
    Nodes,
    Visits,
    Rules,
}
#[derive(Debug)]
pub enum ReadFailure {
    UnsafeLocator,
    InvalidGrant,
    LimitExceeded(Resource),
    Cancelled,
    Unavailable,
    Io(std::io::ErrorKind),
    InvalidDocument,
}
impl std::fmt::Display for ReadFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ReadFailure {}
pub type ReadResult<T> = std::result::Result<T, ReadFailure>;
#[derive(Clone, Copy)]
pub struct PreparationLimits {
    pub entries: usize,
    pub depth: usize,
    pub path: usize,
    pub path_bytes: usize,
    pub artifact_bytes: u64,
    pub document_bytes: usize,
    pub total_document_bytes: usize,
    pub nodes: usize,
    pub visits: usize,
    pub rules: usize,
}
impl Default for PreparationLimits {
    fn default() -> Self {
        Self {
            entries: 10000,
            depth: 64,
            path: 4096,
            path_bytes: 8 * 1024 * 1024,
            artifact_bytes: 1024 * 1024 * 1024,
            document_bytes: 1024 * 1024,
            total_document_bytes: 8 * 1024 * 1024,
            nodes: 100000,
            visits: 100000,
            rules: 10000,
        }
    }
}
impl PreparationLimits {
    pub fn validate(&self) -> ReadResult<()> {
        let max = Self::default();
        if self.entries > max.entries
            || self.depth > max.depth
            || self.path > max.path
            || self.path_bytes > max.path_bytes
            || self.artifact_bytes > max.artifact_bytes
            || self.document_bytes > max.document_bytes
            || self.total_document_bytes > max.total_document_bytes
            || self.nodes > max.nodes
            || self.visits > max.visits
            || self.rules > max.rules
        {
            Err(ReadFailure::InvalidGrant)
        } else {
            Ok(())
        }
    }
}
pub struct PreparationBudget<'a> {
    cancelled: &'a AtomicBool,
    limits: PreparationLimits,
    visits: usize,
    entries: usize,
    paths: usize,
    artifacts: u64,
    documents: usize,
    expanded: usize,
    nodes: usize,
    rules: usize,
}
impl<'a> PreparationBudget<'a> {
    pub(crate) fn new(cancelled: &'a AtomicBool, limits: PreparationLimits) -> Self {
        Self {
            cancelled,
            limits,
            visits: 0,
            entries: 0,
            paths: 0,
            artifacts: 0,
            documents: 0,
            expanded: 0,
            nodes: 0,
            rules: 0,
        }
    }
    pub fn check(&self) -> ReadResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ReadFailure::Cancelled)
        } else {
            Ok(())
        }
    }
    pub fn entry(&mut self, depth: usize, path_bytes: usize) -> ReadResult<()> {
        self.check()?;
        if depth > self.limits.depth {
            return Err(ReadFailure::LimitExceeded(Resource::Depth));
        }
        if path_bytes > self.limits.path {
            return Err(ReadFailure::LimitExceeded(Resource::Path));
        }
        self.entries += 1;
        self.paths += path_bytes;
        if self.entries > self.limits.entries {
            return Err(ReadFailure::LimitExceeded(Resource::Entries));
        }
        if self.paths > self.limits.path_bytes {
            return Err(ReadFailure::LimitExceeded(Resource::PathBytes));
        }
        Ok(())
    }
    pub fn artifact(&mut self, file_bytes: u64, chunk: usize) -> ReadResult<()> {
        self.check()?;
        self.artifacts += chunk as u64;
        if file_bytes > self.limits.artifact_bytes || self.artifacts > self.limits.artifact_bytes {
            Err(ReadFailure::LimitExceeded(Resource::ArtifactBytes))
        } else {
            Ok(())
        }
    }
    pub fn document(&mut self, file_bytes: usize, chunk: usize) -> ReadResult<()> {
        self.check()?;
        self.documents += chunk;
        if file_bytes > self.limits.document_bytes
            || self.documents > self.limits.total_document_bytes
        {
            Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
        } else {
            Ok(())
        }
    }
    pub(crate) fn expansion(&mut self, bytes: usize) -> ReadResult<()> {
        self.check()?;
        self.expanded = self
            .expanded
            .checked_add(bytes)
            .ok_or(ReadFailure::LimitExceeded(Resource::DocumentBytes))?;
        if self.expanded > self.limits.total_document_bytes {
            Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
        } else {
            Ok(())
        }
    }
    pub(crate) fn node(&mut self, depth: usize) -> ReadResult<()> {
        self.check()?;
        self.nodes += 1;
        if depth > self.limits.depth {
            return Err(ReadFailure::LimitExceeded(Resource::Depth));
        }
        if self.nodes > self.limits.nodes {
            Err(ReadFailure::LimitExceeded(Resource::Nodes))
        } else {
            Ok(())
        }
    }
    pub(crate) fn visit(&mut self, depth: usize) -> ReadResult<()> {
        self.check()?;
        self.visits += 1;
        if depth > self.limits.depth {
            return Err(ReadFailure::LimitExceeded(Resource::Depth));
        }
        if self.visits > self.limits.visits {
            Err(ReadFailure::LimitExceeded(Resource::Visits))
        } else {
            Ok(())
        }
    }
    pub(crate) fn rule(&mut self) -> ReadResult<()> {
        self.check()?;
        self.rules += 1;
        if self.rules > self.limits.rules {
            Err(ReadFailure::LimitExceeded(Resource::Rules))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StlPurpose {
    Revision,
    Untracked,
    CheckoutOptions,
}
pub struct OwnedStlReadRequest {
    pub(crate) tenant: String,
    pub(crate) source_id: i64,
    pub(crate) path: Option<String>,
    pub(crate) purpose: StlPurpose,
}
impl OwnedStlReadRequest {
    pub fn tenant(&self) -> &str {
        &self.tenant
    }
    pub fn source_id(&self) -> i64 {
        self.source_id
    }
    pub fn stored_path(&self) -> Option<&str> {
        self.path.as_deref()
    }
    pub fn purpose(&self) -> StlPurpose {
        self.purpose
    }
}
pub struct OwnedCheckoutReadRequest {
    pub(crate) tenant: String,
    pub(crate) source_id: i64,
    pub(crate) path: String,
}
impl OwnedCheckoutReadRequest {
    pub fn tenant(&self) -> &str {
        &self.tenant
    }
    pub fn source_id(&self) -> i64 {
        self.source_id
    }
    pub fn stored_path(&self) -> &str {
        &self.path
    }
}
#[derive(Clone, Copy)]
pub enum CheckoutManifestUse {
    OptionGroups,
    PartRulesAndDefaults,
}
#[derive(Clone)]
pub enum CatalogPurpose {
    Community(String),
    ShippedHintsFirst,
    ShippedHintsSecond,
    CustomHints,
}
pub struct OwnedCatalogReadRequest {
    pub(crate) purpose: CatalogPurpose,
}
impl OwnedCatalogReadRequest {
    pub fn purpose(&self) -> &CatalogPurpose {
        &self.purpose
    }
}
pub enum DocumentRead {
    Missing,
    Skipped(std::io::ErrorKind),
    Bytes(Vec<u8>),
}
pub struct ArtifactRead {
    pub byte_count: u64,
    pub byte_sha256: String,
}
pub struct InventoryPath {
    pub physical_relative_path: String,
    pub traversal_ordinal: usize,
}
pub trait DraftReads: Send + Sync {
    fn resolve_stl_root(
        &self,
        request: &OwnedStlReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>>;
    fn read_checkout_manifest(
        &self,
        request: &OwnedCheckoutReadRequest,
        occurrence: CheckoutManifestUse,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead>;
    fn read_catalog_document(
        &self,
        request: &OwnedCatalogReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead>;
}
pub trait StlRootRead: Send {
    fn logical_resolved_path(&self) -> Option<&str>;
    fn scan_stls(
        &mut self,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlInventory>>;
}
pub trait StlInventory: Send {
    fn entries(&self) -> &[InventoryPath];
    fn hash_tracked_winner(
        &mut self,
        index: usize,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<ArtifactRead>;
}
