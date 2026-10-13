use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildName(String);

impl BuildName {
    pub fn parse(value: String) -> Result<Self, &'static str> {
        let value = value.trim().to_owned();
        if value.is_empty() {
            return Err("Profile name is required");
        }
        if value.chars().count() > 4096 {
            return Err("Profile name is too long");
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBuildRequest {
    pub name: String,
    pub base_project_id: Option<crate::autosave::PositiveId>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAttachmentRequest {
    pub project_id: crate::autosave::PositiveId,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileSummary {
    pub id: i64,
    pub name: String,
    pub order_number: Option<String>,
    pub special_request: Option<String>,
    pub part_count: i64,
    pub accepted_progress: AcceptedProgressSummary,
    pub build_stale: bool,
    pub freshness: PlanFreshness,
    pub archived_at: Option<String>,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcceptedProgressSummary {
    Ready {
        total_units: i64,
        remaining_units: i64,
    },
    Empty,
    Unavailable {
        reason: AcceptedProgressUnavailableReason,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedProgressUnavailableReason {
    CompatibilityDirty,
    Uninitialized,
    Integrity,
    ConcurrentUpdate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PlanFreshness {
    Current {
        accepted_input_set_id: i64,
        accepted_at: String,
    },
    Stale {
        accepted_input_set_id: i64,
        accepted_at: String,
        reasons: Vec<PlanStaleReason>,
        untracked_sources: Vec<PlanUntrackedReason>,
    },
    Untracked {
        accepted_input_set_id: Option<i64>,
        accepted_at: Option<String>,
        reasons: Vec<PlanUntrackedReason>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanStaleReason {
    SourceRevisionChanged {
        source_id: i64,
        source_name: String,
        accepted_revision_id: i64,
        current_revision_id: i64,
    },
    SourceRevisionUnavailable {
        source_id: i64,
        source_name: String,
        accepted_revision_id: i64,
    },
    NamingRulesChanged {
        source_id: i64,
        source_name: String,
        accepted_digest: String,
        current_digest: String,
    },
    PlanInputsInvalid,
    PlanConfigurationChanged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanUntrackedReason {
    NoAcceptedInputs,
    SourceRevisionUntracked { source_id: i64, source_name: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileLayer {
    pub id: i64,
    pub layer_order: i64,
    pub layer_type: String,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
}
