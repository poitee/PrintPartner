use crate::manifest_text::DraftPart;
mod diff;
mod manifest;
pub mod observation;
mod preparation;
mod rebase;
pub mod save;
mod siblings;
mod yaml;
use crate::{
    Envelope, Shared, WriterOwner, auth,
    read_model::Credential,
    required_units::{self, Draft, num, one, rows, text},
};
use anyhow::{Result, anyhow, ensure};
pub use pp_contracts::{
    autosave::PositiveId,
    reconciliation::Outcome as ReconciliationOutcome,
    working_drafts::{RebaseRequest, RecomputeOptions, Request, SourceState, Transition},
};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum Outcome {
    Service {
        outcome: ReconciliationOutcome,
        committed_draft: Option<DraftDocument>,
    },
    Rebased {
        draft: DraftDocument,
    },
    SourceConflict {
        draft: DraftDocument,
    },
    NotAbandoned {
        state: String,
    },
    BaseUnchanged,
    MergeConflicts {
        conflicts: MergeConflicts,
    },
    Updated {
        draft: DraftDocument,
    },
    Created {
        draft: DraftDocument,
    },
    Existing {
        draft: DraftDocument,
    },
    InputsChanged,
    AcceptedBaseChanged,
    IdempotencyConflict,
    NoLayers,
    NoStls,
    WouldWipe,
    Diff {
        diff: DraftDiff,
    },
    Listed {
        drafts: DraftList,
    },
    Read {
        draft: DraftDocument,
    },
    Workspace {
        workspace: Box<pp_contracts::reconciliation::Workspace>,
    },
    Transitioned {
        draft: DraftDocument,
    },
    Unchanged {
        draft: DraftDocument,
    },
    Conflict {
        draft: DraftDocument,
    },
    BaseChanged {
        draft: DraftDocument,
    },
    NotAllowed {
        state: String,
    },
    NotFound,
    AcceptedBaselineRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DraftIdentity {
    draft_id: PositiveId,
    state: DraftState,
    lifecycle_version: u32,
    snapshot_digest: pp_contracts::autosave::Digest,
    base: pp_contracts::autosave::PlanDraftBasis,
}
impl DraftIdentity {
    fn from_header(header: &Value) -> Result<Self> {
        let draft_id = PositiveId::new(
            header["id"]
                .as_u64()
                .ok_or_else(|| anyhow!("Invalid draft id"))?,
        )
        .map_err(|e| anyhow!(e))?;
        let state = match header["state"].as_str() {
            Some("open") => DraftState::Open,
            Some("abandoned") => DraftState::Abandoned,
            Some("consumed") => DraftState::Consumed,
            _ => return Err(anyhow!("Invalid draft state")),
        };
        let lifecycle_version = u32::try_from(num(header, "lifecycleVersion")?)?;
        let snapshot_digest =
            pp_contracts::autosave::Digest::new(text(header, "snapshotDigest")?.into())
                .map_err(|e| anyhow!(e))?;
        let revision_id = if header["baseRevisionId"].is_null() {
            None
        } else {
            Some(
                PositiveId::new(
                    header["baseRevisionId"]
                        .as_u64()
                        .ok_or_else(|| anyhow!("Invalid base revision"))?,
                )
                .map_err(|e| anyhow!(e))?,
            )
        };
        let version = pp_contracts::autosave::Version::new(
            header["basePlanVersion"]
                .as_u64()
                .ok_or_else(|| anyhow!("Invalid base version"))?,
        )
        .map_err(|e| anyhow!(e))?;
        let base = pp_contracts::autosave::PlanDraftBasis::new(revision_id, version)
            .map_err(|e| anyhow!(e))?;
        Ok(Self {
            draft_id,
            state,
            lifecycle_version,
            snapshot_digest,
            base,
        })
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
    pub fn snapshot_digest(&self) -> &pp_contracts::autosave::Digest {
        &self.snapshot_digest
    }
    pub fn base(&self) -> &pp_contracts::autosave::PlanDraftBasis {
        &self.base
    }
    fn list_fields(&self) -> Value {
        json!({"id":self.draft_id,"state":self.state.as_str(),"lifecycleVersion":self.lifecycle_version,"snapshotDigest":self.snapshot_digest,"baseRevisionId":self.base.revision_id(),"basePlanVersion":self.base.plan_version()})
    }
}
#[derive(Clone, Debug, PartialEq)]
struct DraftSnapshotModel {
    ordinary: Value,
    parts: Vec<DraftPart>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct DraftDocument {
    model: DraftSnapshotModel,
    identity: DraftIdentity,
}
impl DraftDocument {
    pub fn identity(&self) -> &DraftIdentity {
        &self.identity
    }
    pub fn into_json_body(self) -> DraftJsonBody {
        DraftJsonBody(self.write_json())
    }
    fn write_json(&self) -> Vec<u8> {
        write_snapshot(&self.model)
    }
    fn is_recompute(&self) -> bool {
        self.model.ordinary["origin"]["kind"] == "recompute"
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
#[derive(Debug)]
pub struct MergeConflicts(Vec<Value>);
impl MergeConflicts {
    pub fn into_json_body(self) -> MergeConflictsJsonBody {
        MergeConflictsJsonBody(serde_json::to_vec(&self.0).expect("scalar merge conflicts"))
    }
}
pub struct DraftJsonBody(Vec<u8>);
pub struct DraftDiffJsonBody(Vec<u8>);
pub struct MergeConflictsJsonBody(Vec<u8>);
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
impl MergeConflictsJsonBody {
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
        required_units::model::PART_FIELDS.to_vec(),
    ]
    .concat()
}
fn write_snapshot(model: &DraftSnapshotModel) -> Vec<u8> {
    let object = model.ordinary.as_object().expect("scalar snapshot fields");
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.push("parts");
    let mut output = vec![b'{'];
    for (i, key) in keys.iter().enumerate() {
        if i > 0 {
            output.push(b',');
        }
        crate::manifest_text::JsText::scalar(key).write_json(&mut output);
        output.push(b':');
        if *key == "parts" {
            output.push(b'[');
            for (i, part) in model.parts.iter().enumerate() {
                if i > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(&part.json_fields(&snapshot_part_fields(), false));
            }
            output.push(b']');
        } else {
            output.extend_from_slice(
                &serde_json::to_vec(&object[*key]).expect("scalar snapshot field"),
            );
        }
    }
    output.push(b'}');
    output
}

#[derive(Debug)]
pub enum Failure {
    Cancelled,
    QueueFull,
    Stopped,
    OutcomeUnknown,
    InvalidLifecycleVersion,
    CorruptOrigin,
    NoLayers,
    NoStls,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Failure {}
#[derive(Debug)]
pub struct CommittedDraftSelectionFailure {
    pub committed_draft: DraftDocument,
    pub selection_failure: anyhow::Error,
}
impl std::fmt::Display for CommittedDraftSelectionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Draft committed; Required selection failed: {}",
            self.selection_failure
        )
    }
}
impl std::error::Error for CommittedDraftSelectionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.selection_failure.as_ref())
    }
}
#[derive(Clone)]
pub struct WorkingDraftClient {
    shared: Arc<Shared>,
    policy: auth::AuthPolicy,
    reads: Arc<dyn observation::DraftReads>,
    limits: observation::PreparationLimits,
    repos: std::path::PathBuf,
}
pub(super) struct Command {
    credential: Credential,
    profile: PositiveId,
    request: Request,
    policy: auth::AuthPolicy,
    reads: Arc<dyn observation::DraftReads>,
    limits: observation::PreparationLimits,
    repos: std::path::PathBuf,
    cancelled: Arc<AtomicBool>,
    service: bool,
}
impl WriterOwner {
    pub fn working_drafts_with_policy(
        &self,
        policy: auth::AuthPolicy,
        reads: Arc<dyn observation::DraftReads>,
        limits: observation::PreparationLimits,
        repos: std::path::PathBuf,
    ) -> Result<WorkingDraftClient> {
        auth::validate_policy(policy)?;
        limits.validate()?;
        Ok(WorkingDraftClient {
            shared: self.client.shared.clone(),
            policy,
            reads,
            limits,
            repos,
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
        self.submit(credential, profile, request, cancelled, wait, false)
    }
    pub fn service(
        &self,
        credential: Credential,
        profile: PositiveId,
        request: Request,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<Outcome> {
        self.submit(credential, profile, request, cancelled, wait, true)
    }
    fn submit(
        &self,
        credential: Credential,
        profile: PositiveId,
        request: Request,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
        service: bool,
    ) -> Result<Outcome> {
        if let Request::Edit { decisions, .. } = &request {
            ensure!(
                !decisions.is_empty() && decisions.len() <= 10000,
                "Invalid edit batch"
            );
            let mut targets = std::collections::HashSet::new();
            for d in decisions {
                let field = matches!(
                    d,
                    pp_contracts::working_drafts::EditDecision::SetIncluded { .. }
                );
                let mut ids = std::collections::HashSet::new();
                ensure!(
                    !d.ids().is_empty()
                        && d.ids().len() <= 10000
                        && d.ids()
                            .iter()
                            .all(|i| ids.insert(i.get()) && targets.insert((field, i.get()))),
                    "Invalid draft Part identities"
                );
            }
        }
        if let Request::Transition {
            expected_lifecycle_version,
            ..
        } = &request
        {
            ensure!(
                *expected_lifecycle_version < 2147483647,
                Failure::InvalidLifecycleVersion
            );
        }
        let deadline = Instant::now() + wait;
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
                reads: self.reads.clone(),
                limits: self.limits,
                repos: self.repos.clone(),
                service,
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
fn snapshot(d: &Draft) -> Result<DraftDocument> {
    let h = &d.header;
    let origin = if [
        "rebasedFromDraftId",
        "rebasedFromLifecycleVersion",
        "rebasedFromSnapshotDigest",
    ]
    .iter()
    .all(|k| h[*k].is_null())
    {
        json!({"kind":"recompute"})
    } else if [
        "rebasedFromDraftId",
        "rebasedFromLifecycleVersion",
        "rebasedFromSnapshotDigest",
    ]
    .iter()
    .all(|k| !h[*k].is_null())
    {
        json!({"kind":"rebase","sourceDraftId":h["rebasedFromDraftId"],"sourceSnapshotDigest":h["rebasedFromSnapshotDigest"],"sourceLifecycleVersion":h["rebasedFromLifecycleVersion"]})
    } else {
        return Err(Failure::CorruptOrigin.into());
    };
    let mut result = required_units::model::project(
        h,
        &[
            "id",
            "profileId",
            "baseRevisionId",
            "basePlanVersion",
            "state",
            "lifecycleVersion",
            "consumedRevisionId",
            "consumedAt",
            "digestFormat",
            "snapshotDigest",
            "createdBy",
            "idempotencyKey",
            "createdAt",
        ],
    );
    result["origin"] = origin;
    result["requiredUnitReconciliation"] = d.selected.as_ref().map(|s| json!({"id":s.header["id"],"format":s.header["format"],"digest":s.header["reconciliationDigest"]})).unwrap_or(Value::Null);
    result["inputs"] = json!(
        d.inputs
            .iter()
            .map(|i| {
                let mut row = required_units::model::project(i, &["id", "draftId"]);
                for f in required_units::model::INPUT_FIELDS {
                    row[*f] = i[*f].clone();
                }
                row
            })
            .collect::<Vec<_>>()
    );
    let parts = d
        .parts
        .iter()
        .map(|part| part.projected(&snapshot_part_fields()))
        .collect();
    Ok(DraftDocument {
        identity: DraftIdentity::from_header(h)?,
        model: DraftSnapshotModel {
            ordinary: result,
            parts,
        },
    })
}
fn baseline_required(tx: &Transaction<'_>, tenant: &str, p: &Value) -> Result<bool> {
    let version = num(p, "acceptedPlanVersion")?;
    if p["acceptedPlanRevisionId"].is_null() {
        Ok(version != 0
            || one(
                tx,
                "SELECT id FROM parts WHERE tenant_id=? AND profile_id=? LIMIT 1",
                &[&tenant, &num(p, "id")?],
            )?
            .is_some())
    } else {
        Ok(version <= 0)
    }
}
pub(super) fn execute(connection: &mut Connection, command: Command) -> Result<Outcome> {
    let result = execute_domain(connection, &command)?;
    if command.service {
        let draft = match &result {
            Outcome::Rebased { draft }
            | Outcome::Created { draft }
            | Outcome::Existing { draft }
            | Outcome::Updated { draft }
            | Outcome::Unchanged { draft } => Some(draft),
            _ => None,
        };
        if let Some(draft) = draft {
            return auto_select(
                connection,
                &command,
                draft.identity().draft_id(),
                Some(draft.clone()),
                None,
            )
            .map_err(|selection_failure| {
                CommittedDraftSelectionFailure {
                    committed_draft: draft.clone(),
                    selection_failure,
                }
                .into()
            });
        }
    }
    Ok(result)
}
fn execute_domain(connection: &mut Connection, command: &Command) -> Result<Outcome> {
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    if let Request::Rebase {
        idempotency_key,
        request,
    } = &command.request
    {
        return rebase::run(connection, command, idempotency_key, request);
    }
    if let Request::PrepareApply { draft_id, expected } = &command.request {
        return auto_select(connection, command, *draft_id, None, expected.as_ref());
    }
    if let Request::Select {
        draft_id,
        idempotency_key,
        request,
    } = &command.request
    {
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = required_units::reconcile_in_transaction(
            &tx,
            required_units::BorrowedCommand {
                credential: &command.credential,
                policy: command.policy,
                profile_id: command.profile,
                draft_id: *draft_id,
                request,
                idempotency_key,
            },
        )?;
        tx.commit()?;
        return Ok(Outcome::Service {
            outcome: result,
            committed_draft: None,
        });
    }
    if let Request::Recompute {
        idempotency_key,
        options,
    } = &command.request
    {
        return recompute(connection, command, idempotency_key, options);
    }
    let read = matches!(
        command.request,
        Request::List | Request::Read { .. } | Request::Workspace { .. } | Request::Diff { .. }
    );
    let tx = connection.transaction_with_behavior(if read {
        TransactionBehavior::Deferred
    } else {
        TransactionBehavior::Immediate
    })?;
    let (tenant, _) = if read {
        auth::observe_reconciliation_actor(&tx, &command.credential, command.policy)?
    } else {
        auth::reconciliation_actor_ref(&tx, &command.credential, command.policy)?
    };
    let profile = command.profile.get() as i64;
    let Some(p) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    let result = match command.request.clone() {
        Request::List => Outcome::Listed {
            drafts: DraftList(rows(
                &tx,
                "SELECT id,state,lifecycle_version,snapshot_digest,base_revision_id,base_plan_version FROM plan_drafts WHERE tenant_id=? AND profile_id=? ORDER BY created_at,id",
                &[&tenant, &profile],
            )?.iter().map(DraftIdentity::from_header).collect::<Result<Vec<_>>>()?),
        },
        request => {
            let id = match request {
                Request::Read { draft_id }
                | Request::Edit { draft_id, .. }
                | Request::Workspace { draft_id }
                | Request::Diff { draft_id }
                | Request::Transition { draft_id, .. } => draft_id.get() as i64,
                Request::List
                | Request::Rebase { .. }
                | Request::Recompute { .. }
                | Request::PrepareApply { .. }
                | Request::Select { .. } => unreachable!(),
            };
            let Some(d) = required_units::draft(&tx, &tenant, profile, id)? else {
                return Ok(Outcome::NotFound);
            };
            match request {
                Request::Edit {
                    expected_snapshot_digest,
                    decisions,
                    ..
                } => edit(
                    &tx,
                    &tenant,
                    &p,
                    &d,
                    expected_snapshot_digest.as_str(),
                    &decisions,
                )?,
                Request::Read { .. } => Outcome::Read {
                    draft: snapshot(&d)?,
                },
                Request::Diff { .. } => Outcome::Diff {
                    diff: diff::read(&tx, &tenant, &p, &d)?,
                },
                Request::Workspace { .. } => Outcome::Workspace {
                    workspace: required_units::workspace(&tx, &tenant, &p, &d)?,
                },
                Request::Transition {
                    transition,
                    expected_lifecycle_version,
                    ..
                } => {
                    let state = text(&d.header, "state")?;
                    let generation = num(&d.header, "lifecycleVersion")?;
                    let expected = i64::from(expected_lifecycle_version);
                    let (source, target) = match transition {
                        Transition::Abandon => ("open", "abandoned"),
                        Transition::Resume => ("abandoned", "open"),
                    };
                    if state == "consumed" {
                        Outcome::NotAllowed {
                            state: state.into(),
                        }
                    } else if state == target && generation == expected + 1 {
                        Outcome::Unchanged {
                            draft: snapshot(&d)?,
                        }
                    } else if generation != expected {
                        Outcome::Conflict {
                            draft: snapshot(&d)?,
                        }
                    } else if state != source {
                        Outcome::NotAllowed {
                            state: state.into(),
                        }
                    } else if matches!(transition, Transition::Resume)
                        && baseline_required(&tx, &tenant, &p)?
                    {
                        Outcome::AcceptedBaselineRequired
                    } else if matches!(transition, Transition::Resume)
                        && (p["acceptedPlanRevisionId"] != d.header["baseRevisionId"]
                            || p["acceptedPlanVersion"] != d.header["basePlanVersion"])
                    {
                        Outcome::BaseChanged {
                            draft: snapshot(&d)?,
                        }
                    } else {
                        ensure!(
                            !command.cancelled.load(Ordering::Acquire),
                            Failure::Cancelled
                        );
                        let changed = tx.execute("UPDATE plan_drafts SET state=?,lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND id=? AND state=? AND lifecycle_version=?",params![target,tenant,profile,id,source,expected])?;
                        ensure!(changed == 1, "Draft transition lost owned row");
                        let after = required_units::draft(&tx, &tenant, profile, id)?
                            .ok_or_else(|| anyhow!("Transitioned draft missing"))?;
                        ensure!(
                            after.header["snapshotDigest"] == d.header["snapshotDigest"],
                            "Transition changed snapshot"
                        );
                        Outcome::Transitioned {
                            draft: snapshot(&after)?,
                        }
                    }
                }
                Request::List
                | Request::Rebase { .. }
                | Request::Recompute { .. }
                | Request::PrepareApply { .. }
                | Request::Select { .. } => unreachable!(),
            }
        }
    };
    tx.commit()?;
    Ok(result)
}

fn winner(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    profile: i64,
    key: &str,
) -> Result<Option<Outcome>> {
    let Some(h) = one(
        tx,
        "SELECT id FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND created_by=? AND idempotency_key=?",
        &[&tenant, &profile, &actor, &key],
    )?
    else {
        return Ok(None);
    };
    let d = required_units::draft(tx, tenant, profile, num(&h, "id")?)?
        .ok_or_else(|| anyhow!("Saved draft missing"))?;
    let draft = snapshot(&d)?;
    Ok(Some(if draft.is_recompute() {
        Outcome::Existing { draft }
    } else {
        Outcome::IdempotencyConflict
    }))
}
fn sql_value(v: &Value) -> Result<rusqlite::types::Value> {
    Ok(match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => i64::from(*b).into(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.into()
            } else {
                n.as_f64().ok_or_else(|| anyhow!("Invalid number"))?.into()
            }
        }
        Value::String(s) => s.clone().into(),
        _ => return Err(anyhow!("Invalid SQL scalar")),
    })
}
fn snake(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_uppercase() {
            out.push('_');
            out.extend(c.to_lowercase())
        } else {
            out.push(c)
        }
    }
    out
}
fn insert(tx: &Transaction<'_>, table: &str, row: Value) -> Result<i64> {
    let object = row.as_object().ok_or_else(|| anyhow!("Invalid insert"))?;
    let columns: Vec<_> = object.keys().map(|s| snake(s)).collect();
    let placeholders = vec!["?"; columns.len()].join(",");
    let values = object.values().map(sql_value).collect::<Result<Vec<_>>>()?;
    tx.execute(
        &format!(
            "INSERT INTO {table} ({}) VALUES ({placeholders})",
            columns.join(",")
        ),
        rusqlite::params_from_iter(values),
    )?;
    Ok(tx.last_insert_rowid())
}
fn insert_part(tx: &Transaction<'_>, table: &str, part: &DraftPart) -> Result<i64> {
    let mut fields = part
        .scalar
        .as_object()
        .ok_or_else(|| anyhow!("Invalid part insert"))?
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    fields.extend(["requirement", "optionGroupId", "manifestSource"]);
    fields.sort_unstable();
    let bound = part.sql_fields(&fields)?;
    let columns = fields.iter().map(|field| snake(field)).collect::<Vec<_>>();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        columns.join(","),
        vec!["?"; fields.len()].join(",")
    );
    tx.execute(
        &sql,
        rusqlite::params_from_iter(bound.into_iter().map(|(_, value)| value)),
    )?;
    Ok(tx.last_insert_rowid())
}
struct RebaseOrigin<'a> {
    source_id: i64,
    generation: i64,
    digest: &'a str,
}
fn insert_prepared(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    profile: i64,
    key: &str,
    p: &preparation::PreparedDraftSnapshot,
    origin: Option<RebaseOrigin<'_>>,
) -> Result<i64> {
    insert_snapshot(
        tx,
        tenant,
        actor,
        profile,
        key,
        SnapshotContent {
            base: &p.base,
            inputs: &p.capture.inputs,
            parts: &p.parts,
            digest: &p.digest,
        },
        origin,
    )
}
struct SnapshotContent<'a> {
    base: &'a Value,
    inputs: &'a [Value],
    parts: &'a [DraftPart],
    digest: &'a str,
}
fn insert_snapshot(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    profile: i64,
    key: &str,
    p: SnapshotContent<'_>,
    origin: Option<RebaseOrigin<'_>>,
) -> Result<i64> {
    let id = insert(
        tx,
        "plan_drafts",
        json!({"tenantId":tenant,"profileId":profile,"baseRevisionId":p.base["baseRevisionId"],"basePlanVersion":p.base["basePlanVersion"],"state":"open","digestFormat":"plan-draft-v1","snapshotDigest":p.digest,"createdBy":actor,"idempotencyKey":key,"createdAt":auth::catalog_timestamp(),"rebasedFromDraftId":origin.as_ref().map(|o|o.source_id),"rebasedFromLifecycleVersion":origin.as_ref().map(|o|o.generation),"rebasedFromSnapshotDigest":origin.as_ref().map(|o|o.digest)}),
    )?;
    for input in p.inputs {
        let mut row = json!({"tenantId":tenant,"draftId":id});
        for f in required_units::model::INPUT_FIELDS {
            row[*f] = input[*f].clone()
        }
        insert(tx, "plan_draft_inputs", row)?;
    }
    for part in p.parts {
        let mut row = part.projected(required_units::model::PART_FIELDS);
        row["tenantId"] = json!(tenant);
        row["draftId"] = json!(id);
        row["baseRevisionPartId"] = part["baseRevisionPartId"].clone();
        insert_part(tx, "plan_draft_parts", &row)?;
    }
    Ok(id)
}
fn recompute(
    connection: &mut Connection,
    command: &Command,
    key: &str,
    options: &pp_contracts::working_drafts::RecomputeOptions,
) -> Result<Outcome> {
    let key = js_trim(key);
    ensure!(!key.is_empty(), "Invalid idempotency key");
    let profile = command.profile.get() as i64;
    let tx = connection.transaction()?;
    let (tenant, actor) =
        auth::observe_reconciliation_actor(&tx, &command.credential, command.policy)?;
    let Some(p) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    if let Some(w) = winner(&tx, &tenant, &actor, profile, key)? {
        return Ok(w);
    }
    if baseline_required(&tx, &tenant, &p)? {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    let base = json!({"baseRevisionId":p["acceptedPlanRevisionId"],"basePlanVersion":p["acceptedPlanVersion"]});
    tx.commit()?;
    let mut budget = observation::PreparationBudget::new(&command.cancelled, command.limits);
    let prepared = match preparation::prepare(
        connection,
        &tenant,
        profile,
        base.clone(),
        preparation::PreparationContext {
            options,
            repos: &command.repos,
        },
        command.reads.as_ref(),
        &mut budget,
    ) {
        Ok(p) => p,
        Err(e) => {
            return match e.downcast_ref::<Failure>() {
                Some(Failure::NoLayers) => Ok(Outcome::NoLayers),
                Some(Failure::NoStls) => Ok(Outcome::NoStls),
                _ => Err(e),
            };
        }
    };
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (final_tenant, final_actor) =
        auth::reconciliation_actor_ref(&tx, &command.credential, command.policy)?;
    ensure!(
        final_tenant == tenant && final_actor == actor,
        "Authentication principal changed"
    );
    if let Some(w) = winner(&tx, &tenant, &actor, profile, key)? {
        tx.commit()?;
        return Ok(w);
    }
    let Some(p) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::AcceptedBaseChanged);
    };
    if baseline_required(&tx, &tenant, &p)? {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    if p["acceptedPlanRevisionId"] != base["baseRevisionId"]
        || p["acceptedPlanVersion"] != base["basePlanVersion"]
    {
        return Ok(Outcome::AcceptedBaseChanged);
    }
    if preparation::capture(&tx, &tenant, profile, command.reads.as_ref(), &mut budget)?.fingerprint
        != prepared.capture.fingerprint
    {
        return Ok(Outcome::InputsChanged);
    }
    budget.check()?;
    tx.execute("UPDATE plan_drafts SET state='abandoned',lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND state='open'",params![tenant,profile])?;
    let id = insert_prepared(&tx, &tenant, &actor, profile, key, &prepared, None)?;
    let saved = required_units::draft(&tx, &tenant, profile, id)?
        .ok_or_else(|| anyhow!("Created draft missing"))?;
    let result = Outcome::Created {
        draft: snapshot(&saved)?,
    };
    tx.commit()?;
    Ok(result)
}
fn auto_select(
    connection: &mut Connection,
    c: &Command,
    id: PositiveId,
    committed: Option<DraftDocument>,
    expected: Option<&pp_contracts::working_drafts::ExpectedDraft>,
) -> Result<Outcome> {
    let tx = connection.transaction()?;
    let (tenant, _) = auth::observe_reconciliation_actor(&tx, &c.credential, c.policy)?;
    let profile = c.profile.get() as i64;
    let Some(p) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::Service {
            outcome: pp_contracts::reconciliation::Outcome::ProfileNotFound,
            committed_draft: committed,
        });
    };
    let Some(d) = required_units::draft(&tx, &tenant, profile, id.get() as i64)? else {
        return Ok(Outcome::Service {
            outcome: pp_contracts::reconciliation::Outcome::DraftNotFound,
            committed_draft: committed,
        });
    };
    let refusal = if d.header["state"] != "open" {
        Some(pp_contracts::reconciliation::Outcome::NotOpen {
            workspace: required_units::workspace(&tx, &tenant, &p, &d)?,
        })
    } else if let Some(e) = expected {
        if d.header["snapshotDigest"] != e.snapshot_digest.as_str()
            || d.header["lifecycleVersion"] != e.lifecycle_version
        {
            Some(pp_contracts::reconciliation::Outcome::DraftChanged {
                workspace: Some(required_units::workspace(&tx, &tenant, &p, &d)?),
            })
        } else if serde_json::to_value(&e.base)?
            != json!({"revision_id":d.header["baseRevisionId"],"plan_version":d.header["basePlanVersion"]})
        {
            Some(pp_contracts::reconciliation::Outcome::BaseChanged {
                workspace: required_units::workspace(&tx, &tenant, &p, &d)?,
            })
        } else {
            None
        }
    } else {
        None
    };
    if let Some(outcome) = refusal {
        return Ok(Outcome::Service {
            outcome,
            committed_draft: committed,
        });
    }
    if d.selected.is_some() {
        return Ok(Outcome::Service {
            outcome: pp_contracts::reconciliation::Outcome::Ready {
                workspace: required_units::workspace(&tx, &tenant, &p, &d)?,
            },
            committed_draft: committed,
        });
    }
    let request = serde_json::from_value(
        json!({"expected_snapshot_digest":d.header["snapshotDigest"],"decisions":[]}),
    )?;
    let key = format!("auto-{}", text(&d.header, "snapshotDigest")?);
    tx.commit()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = required_units::reconcile_in_transaction(
        &tx,
        required_units::BorrowedCommand {
            credential: &c.credential,
            policy: c.policy,
            profile_id: c.profile,
            draft_id: id,
            request: &request,
            idempotency_key: &key,
        },
    )?;
    tx.commit()?;
    Ok(Outcome::Service {
        outcome: result,
        committed_draft: committed,
    })
}
fn edit(
    tx: &Transaction<'_>,
    tenant: &str,
    p: &Value,
    d: &Draft,
    expected: &str,
    decisions: &[pp_contracts::working_drafts::EditDecision],
) -> Result<Outcome> {
    if d.header["state"] != "open" {
        return Ok(Outcome::NotAllowed {
            state: text(&d.header, "state")?.into(),
        });
    }
    if baseline_required(tx, tenant, p)? {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    if p["acceptedPlanRevisionId"] != d.header["baseRevisionId"]
        || p["acceptedPlanVersion"] != d.header["basePlanVersion"]
    {
        return Ok(Outcome::BaseChanged {
            draft: snapshot(d)?,
        });
    }
    let mut parts = d.parts.clone();
    for decision in decisions {
        for id in decision.ids() {
            let Some(part) = parts.iter_mut().find(|p| p["id"] == id.get()) else {
                return Ok(Outcome::NotFound);
            };
            match decision {
                pp_contracts::working_drafts::EditDecision::SetIncluded { value, .. } => {
                    part["included"] = json!(value)
                }
                pp_contracts::working_drafts::EditDecision::SetQuantityOverride {
                    value, ..
                } => {
                    part["quantityOverride"] = json!(value);
                    part["quantityEffective"] = value
                        .map(|v| json!(v))
                        .unwrap_or_else(|| part["quantityInferred"].clone());
                }
            }
        }
    }
    if parts == d.parts {
        return Ok(Outcome::Unchanged {
            draft: snapshot(d)?,
        });
    }
    if d.header["snapshotDigest"] != expected {
        return Ok(Outcome::Conflict {
            draft: snapshot(d)?,
        });
    }
    let planning = required_units::model::planning(&d.header, &d.inputs, &parts);
    let digest = if d.header["digestFormat"] == "plan-draft-v2" {
        required_units::model::selection(&planning, None)
    } else {
        planning
    };
    let profile = num(&d.header, "profileId")?;
    let id = num(&d.header, "id")?;
    ensure!(tx.execute("UPDATE plan_drafts SET current_required_unit_reconciliation_id=NULL,snapshot_digest=? WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND snapshot_digest=?",params![digest,tenant,profile,id,expected])?==1,"Edit lost owned draft");
    for part in parts {
        if d.parts.contains(&part) {
            continue;
        }
        tx.execute("UPDATE plan_draft_parts SET included=?,quantity_override=?,quantity_effective=? WHERE tenant_id=? AND draft_id=? AND id=?",params![part["included"].as_bool().unwrap(),sql_value(&part["quantityOverride"])?,sql_value(&part["quantityEffective"])?,tenant,id,num(&part,"id")?])?;
    }
    let d = required_units::draft(tx, tenant, profile, id)?
        .ok_or_else(|| anyhow!("Edited draft missing"))?;
    Ok(Outcome::Updated {
        draft: snapshot(&d)?,
    })
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

impl Outcome {
    pub fn into_json_body(self) -> DraftOutcomeJsonBody {
        let (kind, field, body) = match self {
            Self::Rebased { draft } => (
                "rebased",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::SourceConflict { draft } => (
                "source_conflict",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Updated { draft } => (
                "updated",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Created { draft } => (
                "created",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Existing { draft } => (
                "existing",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Read { draft } => ("read", Some("draft"), draft.into_json_body().into_bytes()),
            Self::Transitioned { draft } => (
                "transitioned",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Unchanged { draft } => (
                "unchanged",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Conflict { draft } => (
                "conflict",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::BaseChanged { draft } => (
                "base_changed",
                Some("draft"),
                draft.into_json_body().into_bytes(),
            ),
            Self::Diff { diff } => ("diff", Some("diff"), diff.into_json_body().into_bytes()),
            Self::MergeConflicts { conflicts } => (
                "merge_conflicts",
                Some("conflicts"),
                conflicts.into_json_body().into_bytes(),
            ),
            Self::Listed { drafts } => (
                "listed",
                Some("drafts"),
                serde_json::to_vec(
                    &drafts
                        .iter()
                        .map(DraftIdentity::list_fields)
                        .collect::<Vec<_>>(),
                )
                .expect("scalar list"),
            ),
            Self::Workspace { workspace } => (
                "workspace",
                Some("workspace"),
                serde_json::to_vec(&workspace).expect("scalar workspace"),
            ),
            Self::NotAllowed { state } => (
                "not_allowed",
                Some("state"),
                serde_json::to_vec(&state).expect("state"),
            ),
            Self::NotAbandoned { state } => (
                "not_abandoned",
                Some("state"),
                serde_json::to_vec(&state).expect("state"),
            ),
            Self::Service {
                outcome,
                committed_draft,
            } => {
                let mut output = b"{\"kind\":\"service\",\"outcome\":".to_vec();
                output.extend_from_slice(
                    &serde_json::to_vec(&outcome).expect("scalar reconciliation"),
                );
                output.extend_from_slice(b",\"committed_draft\":");
                match committed_draft {
                    Some(draft) => output.extend_from_slice(&draft.into_json_body().into_bytes()),
                    None => output.extend_from_slice(b"null"),
                };
                output.push(b'}');
                return DraftOutcomeJsonBody(output);
            }
            Self::BaseUnchanged => ("base_unchanged", None, Vec::new()),
            Self::InputsChanged => ("inputs_changed", None, Vec::new()),
            Self::AcceptedBaseChanged => ("accepted_base_changed", None, Vec::new()),
            Self::IdempotencyConflict => ("idempotency_conflict", None, Vec::new()),
            Self::NoLayers => ("no_layers", None, Vec::new()),
            Self::NoStls => ("no_stls", None, Vec::new()),
            Self::WouldWipe => ("would_wipe", None, Vec::new()),
            Self::NotFound => ("not_found", None, Vec::new()),
            Self::AcceptedBaselineRequired => ("accepted_baseline_required", None, Vec::new()),
        };
        let mut output = b"{\"kind\":".to_vec();
        crate::manifest_text::JsText::scalar(kind).write_json(&mut output);
        if let Some(field) = field {
            output.push(b',');
            crate::manifest_text::JsText::scalar(field).write_json(&mut output);
            output.push(b':');
            output.extend_from_slice(&body);
        }
        output.push(b'}');
        DraftOutcomeJsonBody(output)
    }
}
