use pp_source::observation::{self as source, ReadBudget};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    working_drafts::{WorkingDraftClient, observation::*},
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

pub enum FilesystemPolicy {
    TrustedSingleUser,
    Isolated,
}
pub struct DraftReadConfiguration {
    pub repos: PathBuf,
    pub limits: PreparationLimits,
    pub relative_base: PathBuf,
    pub policy: FilesystemPolicy,
    pub shipped_hints: [PathBuf; 2],
    pub custom_hints: Option<PathBuf>,
    pub community_manifests: BTreeMap<String, PathBuf>,
}
pub fn issue_working_drafts(
    owner: &WriterOwner,
    policy: AuthPolicy,
    configuration: DraftReadConfiguration,
) -> anyhow::Result<WorkingDraftClient> {
    anyhow::ensure!(
        configuration.repos.is_absolute() && configuration.relative_base.is_absolute(),
        "Draft roots must be absolute"
    );
    let limits = configuration.limits;
    let repos = configuration.repos.clone();
    owner.working_drafts_with_policy(policy, Arc::new(Reader { configuration }), limits, repos)
}
struct Reader {
    configuration: DraftReadConfiguration,
}
struct Budget<'a, 'b>(&'a mut PreparationBudget<'b>);
impl ReadBudget for Budget<'_, '_> {
    type Error = ReadFailure;
    fn entry(&mut self, d: usize, n: usize) -> ReadResult<()> {
        self.0.entry(d, n)
    }
    fn artifact(&mut self, t: u64, n: usize) -> ReadResult<()> {
        self.0.artifact(t, n)
    }
    fn document(&mut self, t: usize, n: usize) -> ReadResult<()> {
        self.0.document(t, n)
    }
}
fn failure(e: source::Failure<ReadFailure>) -> ReadFailure {
    match e {
        source::Failure::Budget(e) => e,
        source::Failure::Io(e) => ReadFailure::Io(e),
        source::Failure::UnsafePath => ReadFailure::InvalidGrant,
    }
}
impl Reader {
    fn resolve(&self, source_id: i64, path: Option<&str>) -> Option<PathBuf> {
        let path = path.filter(|p| !p.is_empty())?;
        let candidate = source::resolve_logical(&self.configuration.relative_base, path);
        match self.configuration.policy {
            FilesystemPolicy::TrustedSingleUser => Some(candidate),
            FilesystemPolicy::Isolated => {
                let workspace = self.configuration.repos.join(source_id.to_string());
                let canonical_configured = self
                    .configuration
                    .repos
                    .canonicalize()
                    .ok()?
                    .join(source_id.to_string());
                if !candidate.starts_with(&workspace)
                    && !candidate.starts_with(&canonical_configured)
                {
                    return None;
                }
                if !std::fs::symlink_metadata(&workspace).ok()?.is_dir() {
                    return None;
                }
                let canonical_workspace = workspace.canonicalize().ok()?;
                let canonical = candidate.canonicalize().ok()?;
                if !canonical.starts_with(canonical_workspace) || !canonical.is_dir() {
                    return None;
                }
                Some(canonical)
            }
        }
    }
    fn document(
        &self,
        grant: &Path,
        path: &Path,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        budget.check()?;
        match source::confined_document(grant, path, &mut Budget(budget)) {
            Ok(Some(b)) => Ok(DocumentRead::Bytes(b)),
            Ok(None) => Ok(DocumentRead::Missing),
            Err(source::Failure::Io(
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory,
            )) => Ok(DocumentRead::Missing),
            Err(source::Failure::Io(e)) => Ok(DocumentRead::Skipped(e)),
            Err(source::Failure::UnsafePath) => {
                Ok(DocumentRead::Skipped(std::io::ErrorKind::PermissionDenied))
            }
            Err(e) => Err(failure(e)),
        }
    }
}
struct Root {
    logical: Option<String>,
    tracked: bool,
}
struct Inventory {
    source: source::Inventory,
    entries: Vec<InventoryPath>,
    tracked: bool,
}
impl StlRootRead for Root {
    fn logical_resolved_path(&self) -> Option<&str> {
        self.logical.as_deref()
    }
    fn scan_stls(
        &mut self,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlInventory>> {
        budget.check()?;
        let source = source::Inventory::scan(
            Path::new(self.logical.as_deref().unwrap_or("")),
            &mut Budget(budget),
        )
        .map_err(failure)?;
        let entries = source
            .paths()
            .iter()
            .enumerate()
            .map(|(i, p)| InventoryPath {
                physical_relative_path: p.clone(),
                traversal_ordinal: i,
            })
            .collect();
        Ok(Box::new(Inventory {
            source,
            entries,
            tracked: self.tracked,
        }))
    }
}
impl StlInventory for Inventory {
    fn entries(&self) -> &[InventoryPath] {
        &self.entries
    }
    fn hash_tracked_winner(
        &mut self,
        index: usize,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<ArtifactRead> {
        if !self.tracked {
            return Err(ReadFailure::InvalidGrant);
        }
        let (byte_count, byte_sha256) = self
            .source
            .hash(index, &mut Budget(budget))
            .map_err(failure)?;
        Ok(ArtifactRead {
            byte_count,
            byte_sha256,
        })
    }
}
impl DraftReads for Reader {
    fn resolve_stl_root(
        &self,
        request: &OwnedStlReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        budget.check()?;
        let tracked = request.purpose() == StlPurpose::Revision;
        let stored = if tracked {
            let locator = request.stored_path().ok_or(ReadFailure::UnsafeLocator)?;
            if Path::new(locator).is_absolute()
                || locator.contains('\\')
                || locator
                    .split('/')
                    .any(|s| s.is_empty() || s == "." || s == "..")
            {
                return Err(ReadFailure::UnsafeLocator);
            }
            Some(
                self.configuration
                    .repos
                    .join(locator)
                    .to_string_lossy()
                    .into_owned(),
            )
        } else {
            request.stored_path().map(str::to_owned)
        };
        let path = self.resolve(request.source_id(), stored.as_deref());
        if tracked && path.is_none() {
            return Err(ReadFailure::UnsafeLocator);
        }
        Ok(Box::new(Root {
            logical: path.map(|p| p.to_string_lossy().into_owned()),
            tracked,
        }))
    }
    fn read_checkout_manifest(
        &self,
        request: &OwnedCheckoutReadRequest,
        _occurrence: CheckoutManifestUse,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        let Some(root) = self.resolve(request.source_id(), Some(request.stored_path())) else {
            return Ok(DocumentRead::Missing);
        };
        self.document(&root, &root.join("print-partner.manifest.yaml"), budget)
    }
    fn read_catalog_document(
        &self,
        request: &OwnedCatalogReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        let path = match request.purpose() {
            CatalogPurpose::Community(slug) => self.configuration.community_manifests.get(slug),
            CatalogPurpose::ShippedHintsFirst => Some(&self.configuration.shipped_hints[0]),
            CatalogPurpose::ShippedHintsSecond => Some(&self.configuration.shipped_hints[1]),
            CatalogPurpose::CustomHints => self.configuration.custom_hints.as_ref(),
        };
        let Some(path) = path else {
            return Ok(DocumentRead::Missing);
        };
        let parent = path.parent().ok_or(ReadFailure::InvalidGrant)?;
        self.document(parent, path, budget)
    }
}
