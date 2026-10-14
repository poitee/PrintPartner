use crate::autosave::{PositiveId, WireInteger};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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
        decisions: EditDecisions,
    },
    Rebase {
        idempotency_key: IdempotencyKey,
        request: RebaseRequest,
    },
    List {},
    Recompute {
        idempotency_key: IdempotencyKey,
        options: RecomputeOptions,
    },
    PrepareApply {
        draft_id: PositiveId,
        expected: Option<ExpectedDraft>,
    },
    Select {
        draft_id: PositiveId,
        idempotency_key: IdempotencyKey,
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
        expected_lifecycle_version: WireInteger<0, 2_147_483_646>,
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
    pub lifecycle_version: WireInteger<0, 2_147_483_647>,
    pub base: crate::autosave::PlanDraftBasis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EditDecision {
    SetIncluded {
        draft_part_ids: DraftPartIds,
        value: bool,
    },
    SetQuantityOverride {
        draft_part_ids: DraftPartIds,
        #[serde(deserialize_with = "crate::reconciliation::required_nullable")]
        value: Option<crate::autosave::Quantity>,
    },
}
impl EditDecision {
    pub fn ids(&self) -> &[PositiveId] {
        match self {
            Self::SetIncluded { draft_part_ids, .. }
            | Self::SetQuantityOverride { draft_part_ids, .. } => draft_part_ids.as_slice(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "Vec<PositiveId>")]
pub struct DraftPartIds(Vec<PositiveId>);

impl DraftPartIds {
    pub fn new(ids: Vec<PositiveId>) -> Result<Self, &'static str> {
        let mut unique = HashSet::new();
        if ids.is_empty() || !ids.iter().all(|id| unique.insert(id.get())) {
            return Err("part targets must be nonempty and unique");
        }
        Ok(Self(ids))
    }

    pub fn as_slice(&self) -> &[PositiveId] {
        &self.0
    }
}

impl TryFrom<Vec<PositiveId>> for DraftPartIds {
    type Error = &'static str;

    fn try_from(ids: Vec<PositiveId>) -> Result<Self, Self::Error> {
        Self::new(ids)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "Vec<EditDecision>")]
pub struct EditDecisions(Vec<EditDecision>);

impl EditDecisions {
    pub fn new(decisions: Vec<EditDecision>) -> Result<Self, &'static str> {
        if !(1..=10_000).contains(&decisions.len()) {
            return Err("edit batch must contain 1 to 10000 decisions");
        }
        let mut targets = HashSet::new();
        for decision in &decisions {
            for id in decision.ids() {
                if !targets.insert((std::mem::discriminant(decision), id.get())) {
                    return Err("a part field may be edited only once per batch");
                }
            }
        }
        Ok(Self(decisions))
    }

    pub fn as_slice(&self) -> &[EditDecision] {
        &self.0
    }
}

impl TryFrom<Vec<EditDecision>> for EditDecisions {
    type Error = &'static str;

    fn try_from(decisions: Vec<EditDecision>) -> Result<Self, Self::Error> {
        Self::new(decisions)
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
#[serde(try_from = "RebaseRequestWire")]
pub struct RebaseRequest {
    source_draft_id: PositiveId,
    expected_source_state: SourceState,
    expected_source_lifecycle_version: WireInteger<0, 2_147_483_647>,
    expected_source_snapshot_digest: crate::autosave::Digest,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RebaseRequestWire {
    source_draft_id: PositiveId,
    #[serde(default)]
    expected_source_state: SourceState,
    expected_source_lifecycle_version: WireInteger<0, 2_147_483_647>,
    expected_source_snapshot_digest: crate::autosave::Digest,
}

impl RebaseRequest {
    pub fn new(
        source_draft_id: PositiveId,
        expected_source_state: SourceState,
        expected_source_lifecycle_version: WireInteger<0, 2_147_483_647>,
        expected_source_snapshot_digest: crate::autosave::Digest,
    ) -> Result<Self, &'static str> {
        if matches!(expected_source_state, SourceState::Open)
            && expected_source_lifecycle_version.get() == 2_147_483_647
        {
            return Err("open source lifecycle version must reserve an increment");
        }
        Ok(Self {
            source_draft_id,
            expected_source_state,
            expected_source_lifecycle_version,
            expected_source_snapshot_digest,
        })
    }

    pub fn source_draft_id(&self) -> PositiveId {
        self.source_draft_id
    }

    pub fn expected_source_state(&self) -> SourceState {
        self.expected_source_state
    }

    pub fn expected_source_lifecycle_version(&self) -> WireInteger<0, 2_147_483_647> {
        self.expected_source_lifecycle_version
    }

    pub fn expected_source_snapshot_digest(&self) -> &crate::autosave::Digest {
        &self.expected_source_snapshot_digest
    }
}

impl TryFrom<RebaseRequestWire> for RebaseRequest {
    type Error = &'static str;

    fn try_from(value: RebaseRequestWire) -> Result<Self, Self::Error> {
        Self::new(
            value.source_draft_id,
            value.expected_source_state,
            value.expected_source_lifecycle_version,
            value.expected_source_snapshot_digest,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartChoice {
    pub quantity: crate::autosave::Quantity,
    pub role: Role,
    #[serde(deserialize_with = "crate::reconciliation::required_nullable")]
    pub color: Option<HexColor>,
}

fn source_map<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<std::collections::BTreeMap<i64, T>>, D::Error> {
    let value = Option::<std::collections::BTreeMap<String, T>>::deserialize(deserializer)?;
    value
        .map(|entries| {
            let mut sources = std::collections::BTreeMap::new();
            for (key, value) in entries {
                let id = key.parse::<i64>().map_err(serde::de::Error::custom)?;
                PositiveId::new(u64::try_from(id).map_err(serde::de::Error::custom)?)
                    .map_err(serde::de::Error::custom)?;
                if key != id.to_string() {
                    return Err(serde::de::Error::custom(
                        "source id must be a canonical positive integer",
                    ));
                }
                sources.insert(id, value);
            }
            Ok(sources)
        })
        .transpose()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct IdempotencyKey(String);

impl TryFrom<String> for IdempotencyKey {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let value = value.trim().to_owned();
        if !(1..=160).contains(&value.encode_utf16().count()) {
            return Err("idempotency key must contain 1 to 160 characters");
        }
        Ok(Self(value))
    }
}

impl IdempotencyKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct Role(String);

impl TryFrom<String> for Role {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.trim().is_empty() || value.encode_utf16().count() > 200 {
            return Err("role must be nonblank and at most 200 characters");
        }
        Ok(Self(value))
    }
}

impl Role {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct HexColor(String);

impl TryFrom<String> for HexColor {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 7
            || !value.starts_with('#')
            || !value.bytes().skip(1).all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("color must be a six-digit hex value prefixed with #");
        }
        Ok(Self(value))
    }
}

impl HexColor {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
