use crate::autosave::PositiveId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transition {
    Abandon,
    Resume,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Edit {
        draft_id: PositiveId,
        expected_snapshot_digest: crate::autosave::Digest,
        decisions: Vec<EditDecision>,
    },
    Rebase {
        idempotency_key: String,
        request: RebaseRequest,
    },
    List,
    Recompute {
        idempotency_key: String,
        options: RecomputeOptions,
    },
    PrepareApply {
        draft_id: PositiveId,
        expected: Option<ExpectedDraft>,
    },
    Select {
        draft_id: PositiveId,
        idempotency_key: String,
        request: crate::reconciliation::ReconciliationRequest,
    },
    Read {
        draft_id: PositiveId,
    },
    Workspace {
        draft_id: PositiveId,
    },
    Diff {
        draft_id: PositiveId,
    },
    Transition {
        draft_id: PositiveId,
        transition: Transition,
        expected_lifecycle_version: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RecomputeOptions {
    #[serde(default, deserialize_with = "source_map")]
    pub part_choices_by_source_id:
        Option<std::collections::BTreeMap<i64, std::collections::BTreeMap<String, PartChoice>>>,
    pub apply_manifest: bool,
    pub prefer_accepted: bool,
    #[serde(default, deserialize_with = "source_map")]
    pub excluded_paths_by_source_id: Option<std::collections::BTreeMap<i64, Vec<String>>>,
    #[serde(default, deserialize_with = "source_map")]
    pub included_paths_by_source_id: Option<std::collections::BTreeMap<i64, Vec<String>>>,
}
impl Default for RecomputeOptions {
    fn default() -> Self {
        Self {
            part_choices_by_source_id: None,
            apply_manifest: true,
            prefer_accepted: false,
            excluded_paths_by_source_id: None,
            included_paths_by_source_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedDraft {
    pub snapshot_digest: crate::autosave::Digest,
    pub lifecycle_version: u32,
    pub base: crate::autosave::PlanDraftBasis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EditDecision {
    SetIncluded {
        draft_part_ids: Vec<PositiveId>,
        value: bool,
    },
    SetQuantityOverride {
        draft_part_ids: Vec<PositiveId>,
        value: Option<crate::autosave::Quantity>,
    },
}
impl EditDecision {
    pub fn ids(&self) -> &[PositiveId] {
        match self {
            Self::SetIncluded { draft_part_ids, .. }
            | Self::SetQuantityOverride { draft_part_ids, .. } => draft_part_ids,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Open,
    #[default]
    Abandoned,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RebaseRequest {
    pub source_draft_id: PositiveId,
    #[serde(default)]
    pub expected_source_state: SourceState,
    pub expected_source_lifecycle_version: u32,
    pub expected_source_snapshot_digest: crate::autosave::Digest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartChoice {
    pub quantity: crate::autosave::Quantity,
    pub role: String,
    #[serde(deserialize_with = "crate::autosave::required_nullable")]
    pub color: Option<String>,
}

fn source_map<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<std::collections::BTreeMap<i64, T>>, D::Error> {
    let value = Option::<std::collections::BTreeMap<String, T>>::deserialize(deserializer)?;
    value
        .map(|entries| {
            entries
                .into_iter()
                .map(|(key, value)| {
                    let id = key.parse::<i64>().map_err(serde::de::Error::custom)?;
                    Ok((id, value))
                })
                .collect()
        })
        .transpose()
}
