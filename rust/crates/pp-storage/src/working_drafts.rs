use crate::{
    Envelope, Shared, WriterOwner, auth,
    manifest_text::{DraftPart, JsText},
    read_model::Credential,
    required_units::{
        self, Outcome as WorkspaceOutcome, ReconciliationCommand, model,
        storage::{Draft, draft, num, one, rows},
        view::workspace,
    },
    writer_admission,
};
use anyhow::{Result, anyhow, ensure};
pub use pp_domain::{Digest, PositiveId, Quantity, Version};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
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

/// The JSON body of Node's draft Part edit route. It accepts what
/// `parseEditPlanDraftPartsRequest` accepts: one `decision` or a batch of 1 to
/// 10,000 `decisions`, each Part field edited at most once.
#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "EditWire")]
pub struct EditRequest {
    expected_snapshot_digest: Digest,
    decisions: Vec<PartDecision>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PartDecision {
    SetIncluded {
        draft_part_ids: Vec<PositiveId>,
        value: bool,
    },
    SetQuantityOverride {
        draft_part_ids: Vec<PositiveId>,
        #[serde(deserialize_with = "Option::deserialize")]
        value: Option<Quantity>,
    },
}
impl PartDecision {
    fn ids(&self) -> &[PositiveId] {
        match self {
            Self::SetIncluded { draft_part_ids, .. }
            | Self::SetQuantityOverride { draft_part_ids, .. } => draft_part_ids,
        }
    }
    fn apply(&self, part: &mut DraftPart) {
        match self {
            Self::SetIncluded { value, .. } => part["included"] = json!(value),
            Self::SetQuantityOverride { value, .. } => {
                part["quantityOverride"] = json!(value);
                part["quantityEffective"] = match value {
                    Some(value) => json!(value),
                    None => part["quantityInferred"].clone(),
                };
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum EditWire {
    One(OneEdit),
    Batch(BatchEdit),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OneEdit {
    expected_snapshot_digest: Digest,
    decision: PartDecision,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchEdit {
    expected_snapshot_digest: Digest,
    decisions: Vec<PartDecision>,
}
impl TryFrom<EditWire> for EditRequest {
    type Error = &'static str;
    fn try_from(wire: EditWire) -> Result<Self, Self::Error> {
        let (expected_snapshot_digest, decisions) = match wire {
            EditWire::One(one) => (one.expected_snapshot_digest, vec![one.decision]),
            EditWire::Batch(batch) if (1..=10_000).contains(&batch.decisions.len()) => {
                (batch.expected_snapshot_digest, batch.decisions)
            }
            EditWire::Batch(_) => return Err("A Plan draft edit allows 1 to 10000 decisions"),
        };
        let mut targets = HashSet::new();
        for decision in &decisions {
            let field = std::mem::discriminant(decision);
            if decision.ids().is_empty()
                || !decision
                    .ids()
                    .iter()
                    .all(|id| targets.insert((field, id.get())))
            {
                return Err("A Plan draft Part field may be edited only once per batch");
            }
        }
        Ok(Self {
            expected_snapshot_digest,
            decisions,
        })
    }
}

/// The JSON body of Node's draft abandon route.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AbandonRequest {
    expected_lifecycle_version: Version,
}

/// Node's `PlanDraftWorkspaceService.abandon` result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AbandonOutcome {
    Ready {
        draft: required_units::DraftIdentity,
    },
    ProfileNotFound,
    DraftNotFound,
    DraftChanged {
        workspace: Box<required_units::Workspace>,
    },
    NotOpen {
        workspace: Box<required_units::Workspace>,
    },
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
    fn workspace_identity(&self) -> Result<required_units::DraftIdentity> {
        Ok(required_units::DraftIdentity {
            draft_id: i64::try_from(self.draft_id.get())?,
            state: self.state.as_str().into(),
            lifecycle_version: self.lifecycle_version.into(),
            snapshot_digest: self.snapshot_digest.as_str().into(),
            base: required_units::DraftBase {
                revision_id: self
                    .base_revision_id
                    .map(|id| i64::try_from(id.get()))
                    .transpose()?,
                plan_version: i64::try_from(self.base_plan_version.get())?,
            },
        })
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
pub(super) struct Write {
    credential: Credential,
    profile: PositiveId,
    draft_id: PositiveId,
    policy: auth::AuthPolicy,
    cancelled: Arc<AtomicBool>,
    operation: Operation,
}
enum Operation {
    Edit {
        request: EditRequest,
        reply: mpsc::Sender<Result<WorkspaceOutcome>>,
    },
    Abandon {
        request: AbandonRequest,
        reply: mpsc::Sender<Result<AbandonOutcome>>,
    },
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
        self.enqueue(cancelled, wait, |reply, cancelled| Envelope::WorkingDraft {
            command: Command {
                credential,
                profile,
                request,
                policy: self.policy,
                cancelled,
            },
            reply,
        })
    }
    /// Edits draft Parts as Node's `PlanDraftWorkspaceService.editParts` does,
    /// including its automatic Required-unit selection. The edit commits before
    /// the selection starts, so a selection error or cancellation keeps it.
    pub fn edit(
        &self,
        credential: Credential,
        profile: PositiveId,
        draft_id: PositiveId,
        request: EditRequest,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<WorkspaceOutcome> {
        self.enqueue(cancelled, wait, |reply, cancelled| {
            Envelope::WorkingDraftWrite {
                command: Write {
                    credential,
                    profile,
                    draft_id,
                    policy: self.policy,
                    cancelled,
                    operation: Operation::Edit { request, reply },
                },
            }
        })
    }
    /// Abandons an open draft as Node's `PlanDraftWorkspaceService.abandon`
    /// does.
    pub fn abandon(
        &self,
        credential: Credential,
        profile: PositiveId,
        draft_id: PositiveId,
        request: AbandonRequest,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<AbandonOutcome> {
        self.enqueue(cancelled, wait, |reply, cancelled| {
            Envelope::WorkingDraftWrite {
                command: Write {
                    credential,
                    profile,
                    draft_id,
                    policy: self.policy,
                    cancelled,
                    operation: Operation::Abandon { request, reply },
                },
            }
        })
    }
    fn enqueue<T>(
        &self,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
        envelope: impl FnOnce(mpsc::Sender<Result<T>>, Arc<AtomicBool>) -> Envelope,
    ) -> Result<T> {
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
        queue.pending.push_back(envelope(reply, cancelled));
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

pub(super) fn write(
    connection: &mut Connection,
    command: Write,
    admission: writer_admission::Deadline,
) {
    let Write {
        credential,
        profile,
        draft_id,
        policy,
        cancelled,
        operation,
    } = command;
    match operation {
        Operation::Edit { request, reply } => {
            let edited = transact(connection, admission, &cancelled, |tx| {
                edit(tx, &credential, policy, profile, draft_id, &request)
            });
            let _ = reply.send(edited.and_then(|edited| match edited {
                Edited::Done(outcome) => Ok(outcome),
                Edited::Unselected(digest) => {
                    let command = ReconciliationCommand::new(
                        profile,
                        draft_id,
                        serde_json::from_value(
                            json!({"expected_snapshot_digest":digest, "decisions":[]}),
                        )?,
                        &format!("auto-{}", digest.as_str()),
                        credential,
                    )?;
                    // Node's selection is a separate transaction with its own busy wait.
                    let admission = writer_admission::Deadline::at_dequeue();
                    transact(connection, admission, &cancelled, |tx| {
                        required_units::reconcile::run(tx, &command, policy)
                    })
                }
            }));
        }
        Operation::Abandon { request, reply } => {
            let _ = reply.send(transact(connection, admission, &cancelled, |tx| {
                abandon(tx, &credential, policy, profile, draft_id, &request)
            }));
        }
    }
}
fn transact<T>(
    connection: &mut Connection,
    admission: writer_admission::Deadline,
    cancelled: &AtomicBool,
    body: impl FnOnce(&Transaction<'_>) -> Result<T>,
) -> Result<T> {
    ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
    let tx = writer_admission::begin_immediate(connection, admission)?;
    let outcome = body(&tx)?;
    ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
    tx.commit()?;
    Ok(outcome)
}

fn baseline_required(tx: &Transaction<'_>, tenant: &str, profile: &Value) -> Result<bool> {
    let version = num(profile, "acceptedPlanVersion")?;
    Ok(if profile["acceptedPlanRevisionId"].is_null() {
        version != 0
            || one(
                tx,
                "SELECT id FROM parts WHERE tenant_id=? AND profile_id=? LIMIT 1",
                &[&tenant, &num(profile, "id")?],
            )?
            .is_some()
    } else {
        version <= 0
    })
}

enum Edited {
    Done(WorkspaceOutcome),
    Unselected(Digest),
}

fn edit(
    tx: &Transaction<'_>,
    credential: &Credential,
    policy: auth::AuthPolicy,
    profile_id: PositiveId,
    draft_id: PositiveId,
    request: &EditRequest,
) -> Result<Edited> {
    let (tenant, _) = auth::authority::queries::reconciliation_actor_ref(tx, credential, policy)?;
    let profile = i64::try_from(profile_id.get())?;
    let Some(profile_row) = one(
        tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Edited::Done(WorkspaceOutcome::ProfileNotFound));
    };
    let id = i64::try_from(draft_id.get())?;
    let Some(current) = draft(tx, &tenant, profile, id)? else {
        return Ok(Edited::Done(WorkspaceOutcome::DraftNotFound));
    };
    let current_view = || workspace(tx, &tenant, &profile_row, &current);
    if current.header["state"] != "open" {
        return Ok(Edited::Done(WorkspaceOutcome::NotOpen {
            workspace: current_view()?,
        }));
    }
    if baseline_required(tx, &tenant, &profile_row)? {
        return Ok(Edited::Done(WorkspaceOutcome::AcceptedBaselineRequired));
    }
    if profile_row["acceptedPlanRevisionId"] != current.header["baseRevisionId"]
        || profile_row["acceptedPlanVersion"] != current.header["basePlanVersion"]
    {
        return Ok(Edited::Done(WorkspaceOutcome::BaseChanged {
            workspace: current_view()?,
        }));
    }
    let mut parts = current.parts.clone();
    let mut by_id = HashMap::new();
    for part in &mut parts {
        by_id.insert(num(part, "id")?, part);
    }
    for decision in &request.decisions {
        for part_id in decision.ids() {
            let Some(part) = by_id.get_mut(&i64::try_from(part_id.get())?) else {
                return Ok(Edited::Done(WorkspaceOutcome::DraftNotFound));
            };
            decision.apply(part);
        }
    }
    let selected = if parts == current.parts {
        current
    } else {
        let expected = request.expected_snapshot_digest.as_str();
        if current.header["snapshotDigest"] != expected {
            return Ok(Edited::Done(WorkspaceOutcome::DraftChanged {
                workspace: Some(current_view()?),
            }));
        }
        let planning = model::planning(&current.header, &current.inputs, &parts)?;
        let next = if current.header["digestFormat"] == "plan-draft-v2" {
            model::selection(&planning, None)
        } else {
            planning
        };
        ensure!(
            tx.execute(
                "UPDATE plan_drafts SET current_required_unit_reconciliation_id=NULL,snapshot_digest=? WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND snapshot_digest=?",
                params![next, tenant, profile, id, expected],
            )? == 1,
            "Plan draft edit lost its draft"
        );
        for decision in &request.decisions {
            for part_id in decision.ids() {
                let part_id = i64::try_from(part_id.get())?;
                let changed = match decision {
                    PartDecision::SetIncluded { value, .. } => tx.execute(
                        "UPDATE plan_draft_parts SET included=? WHERE tenant_id=? AND draft_id=? AND id=?",
                        params![value, tenant, id, part_id],
                    )?,
                    PartDecision::SetQuantityOverride { value, .. } => tx.execute(
                        "UPDATE plan_draft_parts SET quantity_override=?1,quantity_effective=COALESCE(?1,quantity_inferred) WHERE tenant_id=?2 AND draft_id=?3 AND id=?4",
                        params![value.map(|value| i64::try_from(value.get())).transpose()?, tenant, id, part_id],
                    )?,
                };
                ensure!(
                    changed == 1,
                    "Plan draft Part edit did not update every selected row"
                );
            }
        }
        draft(tx, &tenant, profile, id)?
            .filter(|d| d.header["snapshotDigest"] == next.as_str() && d.selected.is_none())
            .ok_or_else(|| anyhow!("Edited Plan draft could not be verified"))?
    };
    if selected.selected.is_some() {
        return Ok(Edited::Done(WorkspaceOutcome::Ready {
            workspace: workspace(tx, &tenant, &profile_row, &selected)?,
        }));
    }
    Ok(Edited::Unselected(
        DraftIdentity::from_header(&selected.header)?.snapshot_digest,
    ))
}

fn abandon(
    tx: &Transaction<'_>,
    credential: &Credential,
    policy: auth::AuthPolicy,
    profile_id: PositiveId,
    draft_id: PositiveId,
    request: &AbandonRequest,
) -> Result<AbandonOutcome> {
    let (tenant, _) = auth::authority::queries::reconciliation_actor_ref(tx, credential, policy)?;
    let profile = i64::try_from(profile_id.get())?;
    let Some(profile_row) = one(
        tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(AbandonOutcome::ProfileNotFound);
    };
    let expected = u32::try_from(request.expected_lifecycle_version.get())
        .ok()
        .filter(|version| *version < 2_147_483_647)
        .ok_or_else(|| anyhow!("Expected Plan draft lifecycle version must be a nonnegative safe integer below 2147483647"))?;
    let id = i64::try_from(draft_id.get())?;
    let Some(current) = draft(tx, &tenant, profile, id)? else {
        return Ok(AbandonOutcome::DraftNotFound);
    };
    let identity = DraftIdentity::from_header(&current.header)?;
    let current_view = || workspace(tx, &tenant, &profile_row, &current);
    match identity.state {
        DraftState::Consumed => {
            return Ok(AbandonOutcome::NotOpen {
                workspace: current_view()?,
            });
        }
        DraftState::Abandoned if identity.lifecycle_version == expected + 1 => {
            return Ok(AbandonOutcome::Ready {
                draft: identity.workspace_identity()?,
            });
        }
        _ if identity.lifecycle_version != expected => {
            return Ok(AbandonOutcome::DraftChanged {
                workspace: current_view()?,
            });
        }
        DraftState::Abandoned => {
            return Ok(AbandonOutcome::NotOpen {
                workspace: current_view()?,
            });
        }
        DraftState::Open => {}
    }
    ensure!(
        tx.execute(
            "UPDATE plan_drafts SET state='abandoned',lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND lifecycle_version=?",
            params![tenant, profile, id, expected],
        )? == 1,
        "Plan draft transition lost its draft"
    );
    let after = draft(tx, &tenant, profile, id)?
        .ok_or_else(|| anyhow!("Transitioned Plan draft is missing"))?;
    let after = DraftIdentity::from_header(&after.header)?;
    ensure!(
        after.state == DraftState::Abandoned
            && after.lifecycle_version == expected + 1
            && after.snapshot_digest == identity.snapshot_digest,
        "Transitioned Plan draft is invalid"
    );
    Ok(AbandonOutcome::Ready {
        draft: after.workspace_identity()?,
    })
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
