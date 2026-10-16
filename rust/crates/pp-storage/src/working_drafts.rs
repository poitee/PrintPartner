use crate::{
    Envelope, Shared, WriterOwner, auth,
    manifest_text::{DraftPart, JsText},
    read_model::Credential,
    required_units::{
        self, model,
        storage::{Draft, draft, one, rows},
    },
};
use anyhow::{Result, anyhow, ensure};
pub use pp_domain::{Digest, PositiveId, Version};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

mod diff;
pub mod observation;

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "D13 manifest consumers land in a later slice")
)]
mod manifest;
#[cfg(test)]
mod manifest_tests;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "D13 manifest consumers land in a later slice")
)]
mod siblings;
#[cfg(test)]
mod siblings_tests;
mod yaml;

#[derive(Clone, Debug)]
pub enum Request {
    List,
    Read { draft_id: PositiveId },
    Diff { draft_id: PositiveId },
    Workspace { draft_id: PositiveId },
}

#[derive(Debug)]
pub enum Outcome {
    Listed {
        drafts: DraftList,
    },
    Read {
        draft: DraftDocument,
    },
    Diff {
        diff: DraftDiff,
    },
    Workspace {
        workspace: Box<required_units::Workspace>,
    },
    NotFound,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftState {
    Open,
    Abandoned,
    Consumed,
}
impl DraftState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Abandoned => "abandoned",
            Self::Consumed => "consumed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftIdentity {
    #[serde(rename = "id")]
    draft_id: PositiveId,
    state: DraftState,
    lifecycle_version: u32,
    snapshot_digest: Digest,
    base_revision_id: Option<PositiveId>,
    base_plan_version: Version,
}
impl DraftIdentity {
    fn from_header(header: &Value) -> Result<Self> {
        let identity = Self {
            draft_id: serde_json::from_value(header["id"].clone())?,
            state: serde_json::from_value(header["state"].clone())?,
            lifecycle_version: serde_json::from_value(header["lifecycleVersion"].clone())?,
            snapshot_digest: serde_json::from_value(header["snapshotDigest"].clone())?,
            base_revision_id: serde_json::from_value(header["baseRevisionId"].clone())?,
            base_plan_version: serde_json::from_value(header["basePlanVersion"].clone())?,
        };
        ensure!(
            identity.lifecycle_version <= 2_147_483_647,
            "Invalid draft lifecycle version"
        );
        ensure!(
            identity.base_revision_id.is_some() == (identity.base_plan_version.get() > 0),
            "Invalid draft base"
        );
        Ok(identity)
    }
    pub fn draft_id(&self) -> PositiveId {
        self.draft_id
    }
    pub fn state(&self) -> DraftState {
        self.state
    }
    pub fn lifecycle_version(&self) -> u32 {
        self.lifecycle_version
    }
    pub fn snapshot_digest(&self) -> &Digest {
        &self.snapshot_digest
    }
    pub fn base_revision_id(&self) -> Option<PositiveId> {
        self.base_revision_id
    }
    pub fn base_plan_version(&self) -> Version {
        self.base_plan_version
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DraftDocument {
    identity: DraftIdentity,
    ordinary: Map<String, Value>,
    parts: Vec<DraftPart>,
}
impl DraftDocument {
    pub fn identity(&self) -> &DraftIdentity {
        &self.identity
    }
    pub fn into_json_body(self) -> DraftJsonBody {
        let mut output = Value::Object(self.ordinary).to_string().into_bytes();
        output.pop();
        output.extend_from_slice(b",\"parts\":[");
        for (index, part) in self.parts.iter().enumerate() {
            if index > 0 {
                output.push(b',');
            }
            output.extend_from_slice(&part.json_fields(&snapshot_part_fields(), false));
        }
        output.extend_from_slice(b"]}");
        DraftJsonBody(output)
    }
}

#[derive(Debug)]
pub struct DraftList(Vec<DraftIdentity>);
impl DraftList {
    pub fn iter(&self) -> impl ExactSizeIterator<Item = &DraftIdentity> {
        self.0.iter()
    }
}
#[derive(Debug)]
pub struct DraftDiff(diff::DraftDiffModel);
impl DraftDiff {
    pub fn into_json_body(self) -> DraftDiffJsonBody {
        DraftDiffJsonBody(self.0.write_json())
    }
}
pub struct DraftJsonBody(Vec<u8>);
pub struct DraftDiffJsonBody(Vec<u8>);
pub struct DraftOutcomeJsonBody(Vec<u8>);
impl DraftJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}
impl DraftDiffJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}
impl DraftOutcomeJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

fn snapshot_part_fields() -> Vec<&'static str> {
    [
        vec!["id", "draftId", "baseRevisionPartId"],
        model::PART_FIELDS.to_vec(),
    ]
    .concat()
}
fn draft_origin(header: &Value) -> Result<Value> {
    let origin_fields = [
        "rebasedFromDraftId",
        "rebasedFromLifecycleVersion",
        "rebasedFromSnapshotDigest",
    ];
    let origin = if origin_fields.iter().all(|key| header[*key].is_null()) {
        json!({"kind":"recompute"})
    } else if origin_fields.iter().all(|key| !header[*key].is_null()) {
        json!({"kind":"rebase", "sourceDraftId":header["rebasedFromDraftId"], "sourceLifecycleVersion":header["rebasedFromLifecycleVersion"], "sourceSnapshotDigest":header["rebasedFromSnapshotDigest"]})
    } else {
        return Err(Failure::CorruptOrigin.into());
    };
    Ok(origin)
}

fn snapshot(draft: &Draft) -> Result<DraftDocument> {
    let header = &draft.header;
    let origin = draft_origin(header)?;
    let mut ordinary = Map::new();
    for key in [
        "id",
        "profileId",
        "baseRevisionId",
        "basePlanVersion",
        "state",
        "lifecycleVersion",
        "consumedRevisionId",
        "consumedAt",
        "origin",
        "digestFormat",
        "snapshotDigest",
        "createdBy",
        "idempotencyKey",
        "createdAt",
    ] {
        ordinary.insert(
            key.into(),
            if key == "origin" {
                origin.clone()
            } else {
                header[key].clone()
            },
        );
    }
    ordinary.insert("requiredUnitReconciliation".into(), draft.selected.as_ref().map(|saved| json!({"id":saved.header["id"], "format":saved.header["format"], "digest":saved.header["reconciliationDigest"]})).unwrap_or(Value::Null));
    let fields = [vec!["id", "draftId"], model::INPUT_FIELDS.to_vec()].concat();
    ordinary.insert(
        "inputs".into(),
        Value::from_iter(
            draft
                .inputs
                .iter()
                .map(|input| model::project(input, &fields)),
        ),
    );
    Ok(DraftDocument {
        identity: DraftIdentity::from_header(header)?,
        ordinary,
        parts: draft
            .parts
            .iter()
            .map(|part| part.projected(&snapshot_part_fields()))
            .collect(),
    })
}

#[derive(Debug)]
pub enum Failure {
    Cancelled,
    QueueFull,
    Stopped,
    OutcomeUnknown,
    CorruptOrigin,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for Failure {}

#[derive(Clone)]
pub struct WorkingDraftClient {
    shared: Arc<Shared>,
    policy: auth::AuthPolicy,
}
pub(super) struct Command {
    credential: Credential,
    profile: PositiveId,
    request: Request,
    policy: auth::AuthPolicy,
    cancelled: Arc<AtomicBool>,
}
impl WriterOwner {
    pub fn working_drafts_with_policy(
        &self,
        policy: auth::AuthPolicy,
    ) -> Result<WorkingDraftClient> {
        auth::validate_policy(policy)?;
        Ok(WorkingDraftClient {
            shared: self.client.shared.clone(),
            policy,
        })
    }
}
impl WorkingDraftClient {
    pub fn execute(
        &self,
        credential: Credential,
        profile: PositiveId,
        request: Request,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<Outcome> {
        let deadline = Instant::now()
            .checked_add(wait)
            .ok_or_else(|| anyhow!("Invalid queue wait"))?;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!(Failure::Stopped))?;
        loop {
            ensure!(!queue.closed, Failure::Stopped);
            ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
            if queue.pending.len() < self.shared.capacity {
                break;
            }
            ensure!(Instant::now() < deadline, Failure::QueueFull);
            queue = self
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!(Failure::Stopped))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::WorkingDraft {
            command: Command {
                credential,
                profile,
                request,
                policy: self.policy,
                cancelled,
            },
            reply,
        });
        self.shared.changed.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|_| anyhow!(Failure::OutcomeUnknown))?
    }
}

pub(super) fn execute(connection: &mut Connection, command: Command) -> Result<Outcome> {
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let (tenant, _) = auth::authority::queries::observe_reconciliation_actor(
        &tx,
        &command.credential,
        command.policy,
    )?;
    let profile = i64::try_from(command.profile.get())?;
    let Some(profile_row) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    let outcome = match command.request {
        Request::List => Outcome::Listed { drafts: DraftList(rows(&tx, "SELECT id,state,lifecycle_version,snapshot_digest,base_revision_id,base_plan_version FROM plan_drafts WHERE tenant_id=? AND profile_id=? ORDER BY created_at,id", &[&tenant, &profile])?.iter().map(DraftIdentity::from_header).collect::<Result<_>>()?) },
        request => {
            let id = match request {
                Request::Read { draft_id } | Request::Diff { draft_id } | Request::Workspace { draft_id } => i64::try_from(draft_id.get())?,
                Request::List => return Err(anyhow!("Invalid draft read request")),
            };
            let Some(draft) = draft(&tx, &tenant, profile, id)? else { return Ok(Outcome::NotFound); };
            match request {
                Request::Read { .. } => Outcome::Read { draft: snapshot(&draft)? },
                Request::Diff { .. } => Outcome::Diff { diff: diff::read(&tx, &tenant, &profile_row, &draft)? },
                Request::Workspace { .. } => {
                    draft_origin(&draft.header)?;
                    Outcome::Workspace { workspace: required_units::view::workspace(&tx, &tenant, &profile_row, &draft)? }
                },
                Request::List => return Err(anyhow!("Invalid draft read request")),
            }
        }
    };
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    tx.commit()?;
    Ok(outcome)
}

impl Outcome {
    pub fn into_json_body(self) -> Result<DraftOutcomeJsonBody> {
        let (kind, field, body) = match self {
            Self::Read { draft } => ("read", Some("draft"), draft.into_json_body().into_bytes()),
            Self::Diff { diff } => ("diff", Some("diff"), diff.into_json_body().into_bytes()),
            Self::Listed { drafts } => ("listed", Some("drafts"), serde_json::to_vec(&drafts.0)?),
            Self::Workspace { workspace } => (
                "workspace",
                Some("workspace"),
                serde_json::to_vec(&workspace)?,
            ),
            Self::NotFound => ("not_found", None, Vec::new()),
        };
        let mut output = b"{\"kind\":".to_vec();
        JsText::scalar(kind).write_json(&mut output);
        if let Some(field) = field {
            output.push(b',');
            JsText::scalar(field).write_json(&mut output);
            output.push(b':');
            output.extend_from_slice(&body);
        }
        output.push(b'}');
        Ok(DraftOutcomeJsonBody(output))
    }
}
