use crate::{
    Envelope, Shared, WriterOwner, auth,
    manifest_text::{DraftPart, JsText},
    read_model::Credential,
    required_units::{
        self, Outcome as WorkspaceOutcome, ReconciliationCommand, model,
        storage::{Draft, draft, num, one, rows, text},
        view::workspace,
    },
    writer_admission,
};
use anyhow::{Result, anyhow, ensure};
pub use pp_domain::{Digest, DraftState, PositiveId, Quantity, Version};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

mod diff;
pub mod observation;
mod preparation;
#[cfg(test)]
mod preparation_tests;

mod manifest;
#[cfg(test)]
mod manifest_tests;
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

/// What Node's draft recompute route passes to `recomputePlanDraft`: the
/// trimmed `Idempotency-Key` header and the body's `apply_manifest` flag.
#[derive(Debug, Clone)]
pub struct RecomputeRequest {
    idempotency_key: String,
    apply_manifest: bool,
}
impl RecomputeRequest {
    pub fn new(idempotency_key: &str, apply_manifest: bool) -> Result<Self> {
        let key = JsText::scalar(idempotency_key).trim_ecmascript();
        ensure!(!key.is_empty(), "Plan draft idempotency key is required");
        ensure!(key.units().len() <= 160, "Invalid idempotency key");
        Ok(Self {
            idempotency_key: key
                .as_scalar()
                .ok_or_else(|| anyhow!("Invalid idempotency key"))?,
            apply_manifest,
        })
    }
    fn options(&self) -> preparation::PreparationOptions {
        preparation::PreparationOptions {
            apply_manifest: self.apply_manifest,
            prefer_accepted: !self.apply_manifest,
            ..Default::default()
        }
    }
}

/// Node's `recomputePlanDraft` result, after the service's Plan check.
#[derive(Debug)]
pub enum RecomputeOutcome {
    Created { draft: DraftDocument },
    Existing { draft: DraftDocument },
    ProfileNotFound,
    AcceptedBaselineRequired,
    BaseChanged,
    InputsChanged,
    IdempotencyConflict,
    NoLayers,
    NoStls,
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
    ProfileNotFound,
    DraftNotFound,
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
    observations: Option<Observations>,
}
#[derive(Clone)]
struct Observations {
    reads: Arc<dyn observation::DraftReads>,
    limits: observation::PreparationLimits,
    repos: PathBuf,
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
    policy: auth::AuthPolicy,
    cancelled: Arc<AtomicBool>,
    operation: Operation,
}
enum Operation {
    Edit {
        draft_id: PositiveId,
        request: EditRequest,
        reply: mpsc::Sender<Result<WorkspaceOutcome>>,
    },
    Abandon {
        draft_id: PositiveId,
        request: AbandonRequest,
        reply: mpsc::Sender<Result<AbandonOutcome>>,
    },
    Recompute {
        request: RecomputeRequest,
        observations: Observations,
        reply: mpsc::Sender<Result<RecomputeOutcome>>,
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
            observations: None,
        })
    }
    /// A client that can also recompute, reading Sources through `reads`.
    pub fn working_drafts_with_observations(
        &self,
        policy: auth::AuthPolicy,
        reads: Arc<dyn observation::DraftReads>,
        limits: observation::PreparationLimits,
    ) -> Result<WorkingDraftClient> {
        limits.validate()?;
        let mut client = self.working_drafts_with_policy(policy)?;
        client.observations = Some(Observations {
            reads,
            limits,
            repos: self
                .lease
                .as_ref()
                .ok_or_else(|| anyhow!("Storage owner is closed"))?
                .data_dir()
                .join("repos"),
        });
        Ok(client)
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
                    policy: self.policy,
                    cancelled,
                    operation: Operation::Edit {
                        draft_id,
                        request,
                        reply,
                    },
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
                    policy: self.policy,
                    cancelled,
                    operation: Operation::Abandon {
                        draft_id,
                        request,
                        reply,
                    },
                },
            }
        })
    }
    /// Creates an open draft from a fresh preparation as Node's
    /// `recomputePlanDraft` does, abandoning every other open draft. Node's
    /// service then selects Required units; this method does not.
    pub fn recompute(
        &self,
        credential: Credential,
        profile: PositiveId,
        request: RecomputeRequest,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<RecomputeOutcome> {
        let observations = self
            .observations
            .clone()
            .ok_or_else(|| anyhow!("Working-draft observations are not configured"))?;
        self.enqueue(cancelled, wait, |reply, cancelled| {
            Envelope::WorkingDraftWrite {
                command: Write {
                    credential,
                    profile,
                    policy: self.policy,
                    cancelled,
                    operation: Operation::Recompute {
                        request,
                        observations,
                        reply,
                    },
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
        return Ok(Outcome::ProfileNotFound);
    };
    let load = |draft_id: PositiveId| -> Result<Option<Draft>> {
        draft(&tx, &tenant, profile, i64::try_from(draft_id.get())?)
    };
    let outcome = match command.request {
        Request::List => Outcome::Listed { drafts: DraftList(rows(&tx, "SELECT id,state,lifecycle_version,snapshot_digest,base_revision_id,base_plan_version FROM plan_drafts WHERE tenant_id=? AND profile_id=? ORDER BY created_at,id", &[&tenant, &profile])?.iter().map(DraftIdentity::from_header).collect::<Result<_>>()?) },
        Request::Read { draft_id } => {
            let Some(draft) = load(draft_id)? else { return Ok(Outcome::DraftNotFound); };
            Outcome::Read { draft: snapshot(&draft)? }
        }
        Request::Diff { draft_id } => {
            let Some(draft) = load(draft_id)? else { return Ok(Outcome::DraftNotFound); };
            Outcome::Diff { diff: diff::read(&tx, &tenant, &profile_row, &draft)? }
        }
        Request::Workspace { draft_id } => {
            let Some(draft) = load(draft_id)? else { return Ok(Outcome::DraftNotFound); };
            draft_origin(&draft.header)?;
            Outcome::Workspace { workspace: required_units::view::workspace(&tx, &tenant, &profile_row, &draft)? }
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
        policy,
        cancelled,
        operation,
    } = command;
    match operation {
        Operation::Edit {
            draft_id,
            request,
            reply,
        } => {
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
        Operation::Abandon {
            draft_id,
            request,
            reply,
        } => {
            let _ = reply.send(transact(connection, admission, &cancelled, |tx| {
                abandon(tx, &credential, policy, profile, draft_id, &request)
            }));
        }
        Operation::Recompute {
            request,
            observations,
            reply,
        } => {
            let _ = reply.send(recompute(
                connection,
                &credential,
                policy,
                profile,
                &request,
                &observations,
                &cancelled,
            ));
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

fn recompute(
    connection: &mut Connection,
    credential: &Credential,
    policy: auth::AuthPolicy,
    profile_id: PositiveId,
    request: &RecomputeRequest,
    observations: &Observations,
    cancelled: &AtomicBool,
) -> Result<RecomputeOutcome> {
    ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
    let key = request.idempotency_key.as_str();
    let profile = i64::try_from(profile_id.get())?;
    let tx = connection.transaction()?;
    let (tenant, actor) =
        auth::authority::queries::observe_reconciliation_actor(&tx, credential, policy)?;
    let Some(profile_row) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(RecomputeOutcome::ProfileNotFound);
    };
    if let Some(winner) = winner(&tx, &tenant, &actor, profile, key)? {
        return Ok(winner);
    }
    if baseline_required(&tx, &tenant, &profile_row)? {
        return Ok(RecomputeOutcome::AcceptedBaselineRequired);
    }
    let base = json!({"baseRevisionId":profile_row["acceptedPlanRevisionId"], "basePlanVersion":profile_row["acceptedPlanVersion"]});
    tx.commit()?;
    let mut budget = observation::PreparationBudget::new(cancelled, observations.limits)?;
    let options = request.options();
    let prepared = preparation::prepare(
        connection,
        &tenant,
        profile,
        base.clone(),
        preparation::PreparationContext {
            options: &options,
            repos: &observations.repos,
        },
        observations.reads.as_ref(),
        &mut budget,
    );
    let mut prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            return match error.downcast_ref() {
                Some(preparation::Failure::NoLayers) => Ok(RecomputeOutcome::NoLayers),
                Some(preparation::Failure::NoStls) => Ok(RecomputeOutcome::NoStls),
                None => Err(error),
            };
        }
    };
    // Node's write transaction waits for the writer lock on its own.
    let admission = writer_admission::Deadline::at_dequeue();
    transact(connection, admission, cancelled, |tx| {
        let principal = auth::authority::queries::reconciliation_actor_ref(tx, credential, policy)?;
        ensure!(
            principal == (tenant.clone(), actor.clone()),
            "Authentication principal changed"
        );
        if let Some(winner) = winner(tx, &tenant, &actor, profile, key)? {
            return Ok(winner);
        }
        let Some(profile_row) = one(
            tx,
            "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
            &[&tenant, &profile],
        )?
        else {
            return Ok(RecomputeOutcome::BaseChanged);
        };
        if baseline_required(tx, &tenant, &profile_row)? {
            return Ok(RecomputeOutcome::AcceptedBaselineRequired);
        }
        if profile_row["acceptedPlanRevisionId"] != base["baseRevisionId"]
            || profile_row["acceptedPlanVersion"] != base["basePlanVersion"]
        {
            return Ok(RecomputeOutcome::BaseChanged);
        }
        let current = preparation::capture(
            tx,
            &tenant,
            profile,
            observations.reads.as_ref(),
            &mut budget,
        )?;
        if current.fingerprint != prepared.capture.fingerprint {
            return Ok(RecomputeOutcome::InputsChanged);
        }
        if carry_open_edits(
            tx,
            &tenant,
            profile,
            &mut prepared.parts,
            !request.apply_manifest,
            &mut budget,
        )? {
            prepared.digest =
                model::planning(&prepared.base, &prepared.capture.inputs, &prepared.parts)?;
        }
        tx.execute(
            "UPDATE plan_drafts SET state='abandoned',lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND state='open'",
            params![tenant, profile],
        )?;
        let id = insert_snapshot(tx, &tenant, &actor, profile, key, &prepared)?;
        let created = draft(tx, &tenant, profile, id)?
            .ok_or_else(|| anyhow!("Created Plan draft is missing"))?;
        Ok(RecomputeOutcome::Created {
            draft: snapshot(&created)?,
        })
    })
}

fn winner(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    profile: i64,
    key: &str,
) -> Result<Option<RecomputeOutcome>> {
    let Some(row) = one(
        tx,
        "SELECT id FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND created_by=? AND idempotency_key=?",
        &[&tenant, &profile, &actor, &key],
    )?
    else {
        return Ok(None);
    };
    let saved = draft(tx, tenant, profile, num(&row, "id")?)?
        .ok_or_else(|| anyhow!("Saved Plan draft is missing"))?;
    Ok(Some(
        if draft_origin(&saved.header)? == json!({"kind":"recompute"}) {
            RecomputeOutcome::Existing {
                draft: snapshot(&saved)?,
            }
        } else {
            RecomputeOutcome::IdempotencyConflict
        },
    ))
}

/// Node's `carryOpenDraftEdits`. A Part edit can commit after preparation
/// read the open draft, so its quantity override, and its inclusion when the
/// caller keeps the current draft, replace the prepared values. Returns
/// whether any Part changed.
///
/// This runs under the writer lock, so each open draft, each of its Parts
/// and the Part text that loading it hashes are charged to the recompute's
/// budget before the draft is loaded.
fn carry_open_edits(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    parts: &mut [DraftPart],
    keep_inclusion: bool,
    budget: &mut observation::PreparationBudget<'_>,
) -> Result<bool> {
    let mut edits = HashMap::new();
    for open in rows(
        tx,
        "SELECT d.id,COUNT(p.id) AS parts,COALESCE(SUM(LENGTH(CAST(concat(p.part_key,p.relative_path,p.filename,p.source_layer,p.status,p.role_inferred,p.role_override,p.filament_color_id,p.filament_custom_hex,p.notes,p.github_blob_url,p.requirement,p.option_group_id,p.manifest_source,p.artifact_digest) AS BLOB))),0) AS bytes FROM plan_drafts d LEFT JOIN plan_draft_parts p ON p.tenant_id=d.tenant_id AND p.draft_id=d.id WHERE d.tenant_id=? AND d.profile_id=? AND d.state='open' GROUP BY d.id ORDER BY d.created_at,d.id",
        &[&tenant, &profile],
    )? {
        budget.visit(0)?;
        for _ in 0..num(&open, "parts")? {
            budget.visit(0)?;
        }
        budget.comparison(usize::try_from(num(&open, "bytes")?)?)?;
        let Some(open) = draft(tx, tenant, profile, num(&open, "id")?)? else {
            continue;
        };
        for part in open.parts {
            budget.check()?;
            let key = (
                text(&part, "sourceLayer")?.to_owned(),
                text(&part, "partKey")?.to_owned(),
            );
            edits.insert(
                key,
                (part["included"].clone(), part["quantityOverride"].clone()),
            );
        }
    }
    let mut changed = false;
    for part in parts {
        budget.check()?;
        let key = (
            text(part, "sourceLayer")?.to_owned(),
            text(part, "partKey")?.to_owned(),
        );
        let Some((included, quantity)) = edits.get(&key) else {
            continue;
        };
        let before = part.clone();
        if keep_inclusion {
            part["included"] = included.clone();
        }
        if !quantity.is_null() {
            part["quantityOverride"] = quantity.clone();
            part["quantityEffective"] = quantity.clone();
        }
        changed |= *part != before;
    }
    Ok(changed)
}

fn insert_snapshot(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    profile: i64,
    key: &str,
    prepared: &preparation::PreparedDraftSnapshot,
) -> Result<i64> {
    tx.execute(
        "INSERT INTO plan_drafts (tenant_id,profile_id,base_revision_id,base_plan_version,state,digest_format,snapshot_digest,created_by,idempotency_key,created_at) VALUES (?,?,?,?,'open','plan-draft-v1',?,?,?,?)",
        params![
            tenant,
            profile,
            sql_scalar(&prepared.base["baseRevisionId"])?,
            num(&prepared.base, "basePlanVersion")?,
            prepared.digest,
            actor,
            key,
            auth::catalog_timestamp(),
        ],
    )?;
    let id = tx.last_insert_rowid();
    for input in &prepared.capture.inputs {
        let mut values = vec![tenant.to_owned().into(), id.into()];
        for field in model::INPUT_FIELDS {
            values.push(sql_scalar(&input[*field])?);
        }
        tx.execute(
            "INSERT INTO plan_draft_inputs (tenant_id,draft_id,source_id,source_layer,layer_order,tracking_kind,source_revision_id,manifest_digest,effective_naming_digest) VALUES (?,?,?,?,?,?,?,?,?)",
            rusqlite::params_from_iter(values),
        )?;
    }
    let fields = [vec!["baseRevisionPartId"], model::PART_FIELDS.to_vec()].concat();
    for part in &prepared.parts {
        let mut values = vec![tenant.to_owned().into(), id.into()];
        values.extend(
            part.sql_fields(&fields)?
                .into_iter()
                .map(|(_, value)| value),
        );
        tx.execute(
            "INSERT INTO plan_draft_parts (tenant_id,draft_id,base_revision_part_id,part_key,relative_path,filename,source_layer,status,role_inferred,role_override,filament_color_id,filament_custom_hex,spoolman_spool_id,quantity_inferred,quantity_override,quantity_effective,included,notes,github_blob_url,geometry_same,requirement,option_group_id,manifest_source,artifact_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params_from_iter(values),
        )?;
    }
    Ok(id)
}

fn sql_scalar(value: &Value) -> Result<rusqlite::types::Value> {
    Ok(match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Number(number) => number
            .as_i64()
            .ok_or_else(|| anyhow!("Invalid Plan draft integer"))?
            .into(),
        Value::String(text) => text.clone().into(),
        _ => return Err(anyhow!("Invalid Plan draft scalar")),
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
            Self::ProfileNotFound => ("profile_not_found", None, Vec::new()),
            Self::DraftNotFound => ("draft_not_found", None, Vec::new()),
        };
        Ok(outcome_json_body(kind, field, &body))
    }
}

impl RecomputeOutcome {
    pub fn into_json_body(self) -> DraftOutcomeJsonBody {
        let kind = match self {
            Self::Created { draft } => {
                return outcome_json_body("created", Some("draft"), &draft.into_json_body().0);
            }
            Self::Existing { draft } => {
                return outcome_json_body("existing", Some("draft"), &draft.into_json_body().0);
            }
            Self::ProfileNotFound => "profile_not_found",
            Self::AcceptedBaselineRequired => "accepted_baseline_required",
            Self::BaseChanged => "base_changed",
            Self::InputsChanged => "inputs_changed",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::NoLayers => "no_layers",
            Self::NoStls => "no_stls",
        };
        outcome_json_body(kind, None, &[])
    }
}

fn outcome_json_body(kind: &str, field: Option<&str>, body: &[u8]) -> DraftOutcomeJsonBody {
    let mut output = b"{\"kind\":".to_vec();
    JsText::scalar(kind).write_json(&mut output);
    if let Some(field) = field {
        output.push(b',');
        JsText::scalar(field).write_json(&mut output);
        output.push(b':');
        output.extend_from_slice(body);
    }
    output.push(b'}');
    DraftOutcomeJsonBody(output)
}

#[cfg(test)]
mod carry_tests {
    use super::*;

    #[test]
    fn cancellation_stops_carrying_open_draft_edits() {
        let path = std::env::temp_dir().join(format!("pp-carry-{}.db", rand::random::<u64>()));
        std::fs::write(
            &path,
            include_bytes!("../tests/fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        let mut connection = Connection::open(&path).unwrap();
        let tx = connection.transaction().unwrap();
        let carry = |cancel_after: Option<usize>| {
            let cancelled = AtomicBool::new(false);
            let mut budget = observation::PreparationBudget::new(
                &cancelled,
                observation::PreparationLimits::default(),
            )
            .unwrap();
            if let Some(checks) = cancel_after {
                budget.cancel_after_checks(checks);
            }
            carry_open_edits(&tx, "default", 1, &mut [], true, &mut budget)
        };
        let uncancelled = carry(None);
        let cancelled = carry(Some(1));
        drop(tx);
        drop(connection);
        std::fs::remove_file(&path).unwrap();
        assert!(!uncancelled.unwrap());
        let error = cancelled.unwrap_err();
        assert!(
            matches!(
                error.downcast_ref(),
                Some(observation::ReadFailure::Cancelled)
            ),
            "{error:?}"
        );
    }
}
