//! Reviewed resource unions for desktop operations. Unresolved is not resource-free.
use super::manifest::{Claim, Disposition};
use super::{AdmissionError, AdmittedOperation, Owner, expected_resources};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TableId {
    Projects,
    SourceRevisions,
    SourceDocs,
    AppSettings,
    AppEvents,
    BuildProfiles,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FileFamily {
    SourceWorkspace,
    SourceCovers,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(
    tag = "kind",
    content = "name",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ResourceId {
    Table(TableId),
    File(FileFamily),
}

pub type ResourceSet = BTreeSet<ResourceId>;

#[derive(Debug)]
pub(super) enum Coverage {
    Reviewed(ResourceSet),
    Unresolved,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Declarations {
    reviewed: Vec<ReviewedEntry>,
    unresolved: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
enum ReviewedEntry {
    #[serde(rename = "source.sync")]
    SourceSync { import: SourceSyncImport },
    #[serde(rename = "tool.get_workflow_help")]
    GetWorkflowHelp { resources: Vec<ResourceId> },
    #[serde(rename = "tool.read_source_file")]
    ReadSourceFile { resources: Vec<ResourceId> },
    #[serde(rename = "tool.search_source_files")]
    SearchSourceFiles { resources: Vec<ResourceId> },
    #[serde(rename = "tool.preview_source_naming")]
    PreviewSourceNaming { resources: Vec<ResourceId> },
    #[serde(rename = "tool.list_sources")]
    ListSources { resources: Vec<ResourceId> },
    #[serde(rename = "tool.list_source_categories")]
    ListSourceCategories { resources: Vec<ResourceId> },
}

#[derive(Deserialize)]
enum SourceSyncImport {
    #[serde(rename = "source.sync")]
    Admitted,
}

impl ReviewedEntry {
    fn admit(
        self,
        source_sync: &AdmittedOperation,
    ) -> Result<(&'static str, ResourceSet), AdmissionError> {
        use ResourceId::{File, Table};
        use TableId::{AppSettings, Projects, SourceDocs};
        let (id, resources, expected) = match self {
            Self::SourceSync {
                import: SourceSyncImport::Admitted,
            } => {
                let resources = source_sync
                    .participant_ids
                    .iter()
                    .flat_map(|id| expected_resources(id))
                    .map(|name| {
                        let (kind, name) = name
                            .split_once(':')
                            .ok_or_else(|| AdmissionError::Malformed(name.to_string()))?;
                        serde_json::from_value(serde_json::json!({"kind": kind, "name": name}))
                            .map_err(|error| AdmissionError::Malformed(error.to_string()))
                    })
                    .collect::<Result<ResourceSet, _>>()?;
                return Ok(("source.sync", resources));
            }
            Self::GetWorkflowHelp { resources } => {
                ("tool.get_workflow_help", resources, BTreeSet::new())
            }
            Self::ReadSourceFile { resources } => (
                "tool.read_source_file",
                resources,
                BTreeSet::from([
                    Table(Projects),
                    Table(SourceDocs),
                    File(FileFamily::SourceWorkspace),
                ]),
            ),
            Self::SearchSourceFiles { resources } => (
                "tool.search_source_files",
                resources,
                BTreeSet::from([
                    Table(Projects),
                    Table(SourceDocs),
                    File(FileFamily::SourceWorkspace),
                ]),
            ),
            Self::PreviewSourceNaming { resources } => (
                "tool.preview_source_naming",
                resources,
                BTreeSet::from([Table(Projects), Table(AppSettings)]),
            ),
            Self::ListSources { resources } => (
                "tool.list_sources",
                resources,
                BTreeSet::from([Table(Projects), Table(SourceDocs), Table(AppSettings)]),
            ),
            Self::ListSourceCategories { resources } => (
                "tool.list_source_categories",
                resources,
                BTreeSet::from([Table(Projects), Table(SourceDocs), Table(AppSettings)]),
            ),
        };
        let count = resources.len();
        let resources: ResourceSet = resources.into_iter().collect();
        if count != resources.len() || resources != expected {
            return Err(AdmissionError::ResourceSetMismatch { id: id.to_string() });
        }
        Ok((id, resources))
    }
}

impl Declarations {
    pub(super) fn admit(
        self,
        claims: &BTreeMap<String, Claim>,
        source_sync: &AdmittedOperation,
    ) -> Result<BTreeMap<String, Coverage>, AdmissionError> {
        let mut dispositions = BTreeMap::new();
        for claim in claims.values() {
            if let Some(previous) = dispositions.insert(claim.operation.as_str(), claim.disposition)
                && previous != claim.disposition
            {
                return Err(AdmissionError::Malformed(format!(
                    "mixed dispositions for {}",
                    claim.operation
                )));
            }
        }
        let mut states = BTreeMap::new();
        for entry in self.reviewed {
            let (id, resources) = entry.admit(source_sync)?;
            if dispositions.get(id) != Some(&Disposition::Owned(Owner::Node)) {
                return Err(AdmissionError::Malformed(format!(
                    "reviewed operation {id} is not Node-owned"
                )));
            }
            if states
                .insert(id.to_string(), Coverage::Reviewed(resources))
                .is_some()
            {
                return Err(AdmissionError::Malformed(format!(
                    "duplicate resource state for {id}"
                )));
            }
        }
        for id in [
            "source.sync",
            "tool.get_workflow_help",
            "tool.read_source_file",
            "tool.search_source_files",
            "tool.preview_source_naming",
            "tool.list_sources",
            "tool.list_source_categories",
        ] {
            if !states.contains_key(id) {
                return Err(AdmissionError::Malformed(format!(
                    "missing reviewed resources for {id}"
                )));
            }
            if id != "source.sync"
                && claims.get(id).map(|claim| claim.operation.as_str()) != Some(id)
            {
                return Err(AdmissionError::Malformed(format!(
                    "reviewed participant {id} must belong to operation {id}"
                )));
            }
        }
        for id in self.unresolved {
            if states.insert(id.clone(), Coverage::Unresolved).is_some() {
                return Err(AdmissionError::Malformed(format!(
                    "duplicate resource state for {id}"
                )));
            }
        }
        for id in states.keys() {
            if !dispositions.contains_key(id.as_str()) {
                return Err(AdmissionError::UnknownOperation { value: id.clone() });
            }
        }
        for id in dispositions.keys() {
            if !states.contains_key(*id) {
                return Err(AdmissionError::Malformed(format!(
                    "missing resource state for {id}"
                )));
            }
        }
        Ok(states)
    }
}
