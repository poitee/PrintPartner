use crate::autosave::{Digest, PlanDraftIdentity, PositiveId, Quantity, Version};
use serde::{Deserialize, Deserializer, Serialize, de};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct Text<const MIN: usize, const MAX: usize>(String);
impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for Text<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if !(MIN..=MAX).contains(&value.encode_utf16().count()) {
            return Err(de::Error::custom("text length out of bounds"));
        }
        Ok(Self(value))
    }
}
impl<const MIN: usize, const MAX: usize> Text<MIN, MAX> {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Decision {
    SelectExactPredecessor {
        target_draft_part_id: PositiveId,
        predecessor_revision_part_id: PositiveId,
    },
    AcceptPriorCompletion {
        target_draft_part_id: PositiveId,
        predecessor_revision_part_id: PositiveId,
    },
    Replace {
        target_draft_part_id: PositiveId,
    },
}
impl Decision {
    pub fn target(&self) -> PositiveId {
        match self {
            Self::SelectExactPredecessor {
                target_draft_part_id,
                ..
            }
            | Self::AcceptPriorCompletion {
                target_draft_part_id,
                ..
            }
            | Self::Replace {
                target_draft_part_id,
            } => *target_draft_part_id,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "RequestWire")]
pub struct ReconciliationRequest {
    expected_snapshot_digest: Digest,
    decisions: Vec<Decision>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestWire {
    expected_snapshot_digest: Digest,
    decisions: Vec<Decision>,
}
impl TryFrom<RequestWire> for ReconciliationRequest {
    type Error = &'static str;
    fn try_from(v: RequestWire) -> Result<Self, Self::Error> {
        let mut targets = HashSet::new();
        if v.decisions.len() > 10_000
            || !v.decisions.iter().all(|d| targets.insert(d.target().get()))
        {
            return Err("invalid reconciliation targets");
        }
        Ok(Self {
            expected_snapshot_digest: v.expected_snapshot_digest,
            decisions: v.decisions,
        })
    }
}
impl ReconciliationRequest {
    pub fn expected_snapshot_digest(&self) -> &Digest {
        &self.expected_snapshot_digest
    }
    pub fn decisions(&self) -> &[Decision] {
        &self.decisions
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartView {
    pub draft_part_id: PositiveId,
    #[serde(deserialize_with = "crate::autosave::required_nullable")]
    pub base_revision_part_id: Option<PositiveId>,
    pub part_key: Text<1, 4096>,
    pub filename: Text<1, 1000>,
    pub relative_path: Text<1, 4096>,
    pub source_layer: Text<0, 1000>,
    pub role: Text<0, 200>,
    pub quantity_inferred: Quantity,
    #[serde(deserialize_with = "crate::autosave::required_nullable")]
    pub quantity_override: Option<Quantity>,
    pub quantity_effective: Quantity,
    pub included: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedReference {
    pub revision_part_id: PositiveId,
    pub filename: Text<1, 1000>,
    pub relative_path: Text<1, 4096>,
    pub source_layer: Text<0, 1000>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub before: AcceptedReference,
    pub after: PartView,
    pub fields: Vec<Text<1, 100>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Diff {
    pub base_is_current: bool,
    pub added: Vec<PartView>,
    pub removed: Vec<AcceptedReference>,
    pub changed: Vec<Change>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Conflict {
    AmbiguousExactMatch {
        target_draft_part_id: PositiveId,
        #[serde(deserialize_with = "nonempty_ids")]
        candidate_revision_part_ids: Vec<PositiveId>,
    },
    UnsafePredecessor {
        target_draft_part_id: PositiveId,
        predecessor_revision_part_id: PositiveId,
    },
    PredecessorClaimed {
        target_draft_part_id: PositiveId,
        predecessor_revision_part_id: PositiveId,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReconciliationView {
    Ready {
        reused_units: Version,
        new_units: Version,
        surplus_units: Version,
    },
    Unresolved {
        conflicts: Vec<Conflict>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub profile_id: PositiveId,
    pub draft: PlanDraftIdentity,
    pub parts: Vec<PartView>,
    pub diff: Diff,
    pub reconciliation: ReconciliationView,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Ready {
        workspace: Box<Workspace>,
    },
    ProfileNotFound,
    DraftNotFound,
    DraftChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace: Option<Box<Workspace>>,
    },
    BaseChanged {
        workspace: Box<Workspace>,
    },
    NotOpen {
        workspace: Box<Workspace>,
    },
    AcceptedBaselineRequired,
    IdempotencyConflict,
    DomainError {
        code: String,
    },
    TransactionUnavailable,
}

fn nonempty_ids<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<PositiveId>, D::Error> {
    let ids = Vec::<PositiveId>::deserialize(deserializer)?;
    if ids.is_empty() {
        return Err(de::Error::custom("empty predecessor candidates"));
    }
    Ok(ids)
}
