use super::*;
use crate::plan_publication::{
    self as publication, AuthenticatedPublicationContext, PublicationRequests,
    RequiredUnitTokenAllocator,
};
use pp_contracts::{
    autosave::{ApplyPlanDraftReceipt, PlanChoice, SavePlanChoicesRequest},
    publication::ApplyRequest,
    reconciliation,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub struct SaveCommand {
    credential: Credential,
    profile: PositiveId,
    request: SavePlanChoicesRequest,
    key: String,
}
impl SaveCommand {
    pub fn new(
        credential: Credential,
        profile: PositiveId,
        request: SavePlanChoicesRequest,
        key: String,
    ) -> Result<Self> {
        let key = js_trim(&key).to_owned();
        ensure!(
            !key.is_empty() && key.encode_utf16().count() <= 200,
            "Invalid Save idempotency key"
        );
        Ok(Self {
            credential,
            profile,
            request,
            key,
        })
    }
}
#[derive(Clone)]
pub struct PlanSaveClient {
    drafts: WorkingDraftClient,
}
impl WorkingDraftClient {
    pub fn plan_save(&self) -> PlanSaveClient {
        PlanSaveClient {
            drafts: self.clone(),
        }
    }
}
pub(crate) struct Command {
    input: SaveCommand,
    policy: auth::AuthPolicy,
    reads: Arc<dyn observation::DraftReads>,
    limits: observation::PreparationLimits,
    repos: std::path::PathBuf,
    cancelled: Arc<AtomicBool>,
}
#[derive(Debug, Serialize)]
pub struct SavedAuthority {
    pub snapshot: Box<crate::read_model::Snapshot>,
    pub context: crate::read_model::CapturedContext,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    NotFound,
    BuildArchived,
    AcceptedBaselineRequired,
    BaseChanged,
    DraftChanged,
    InputsChanged,
    IdempotencyConflict,
    PartNotFound,
    PartAmbiguous,
    NoLayers,
    NoStls,
    WouldWipe,
    Reconciliation {
        outcome: reconciliation::Outcome,
    },
    Publication {
        outcome: pp_contracts::publication::Outcome,
    },
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Saved {
        receipt: ApplyPlanDraftReceipt,
        closed_draft_ids: Vec<PositiveId>,
        authority: Box<SavedAuthority>,
    },
    Refused {
        reason: Refusal,
    },
}
#[derive(Debug)]
pub struct CommittedSaveCaptureFailure {
    pub receipt: ApplyPlanDraftReceipt,
    pub closed_draft_ids: Vec<PositiveId>,
    pub capture_failure: anyhow::Error,
}
impl std::fmt::Display for CommittedSaveCaptureFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Save committed; accepted capture failed: {}",
            self.capture_failure
        )
    }
}
impl std::error::Error for CommittedSaveCaptureFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.capture_failure.as_ref())
    }
}
impl PlanSaveClient {
    pub fn save(
        &self,
        input: SaveCommand,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<Outcome> {
        let deadline = Instant::now() + wait;
        let mut queue = self
            .drafts
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!(Failure::Stopped))?;
        loop {
            ensure!(!queue.closed, Failure::Stopped);
            ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
            if queue.pending.len() < self.drafts.shared.capacity {
                break;
            }
            ensure!(Instant::now() < deadline, Failure::QueueFull);
            queue = self
                .drafts
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!(Failure::Stopped))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::PlanSave {
            command: Command {
                input,
                policy: self.drafts.policy,
                reads: self.drafts.reads.clone(),
                limits: self.drafts.limits,
                repos: self.drafts.repos.clone(),
                cancelled,
            },
            reply,
        });
        self.drafts.shared.changed.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|_| anyhow!(Failure::OutcomeUnknown))?
    }
}
enum TransactionResult {
    Saved(ApplyPlanDraftReceipt),
    Refused(Refusal),
}
pub(crate) fn execute(
    connection: &mut Connection,
    command: Command,
    tokens: &mut dyn RequiredUnitTokenAllocator,
) -> Result<Outcome> {
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    let mut tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = transact(&mut tx, &command, tokens)?;
    let TransactionResult::Saved(receipt) = result else {
        let TransactionResult::Refused(reason) = result else {
            unreachable!()
        };
        return Ok(Outcome::Refused { reason });
    };
    tx.commit()?;
    let closed_draft_ids = command
        .input
        .request
        .expected_draft()
        .map(|d| vec![d.draft_id()])
        .unwrap_or_default();
    let captured = (|| {
        let tx = connection.transaction()?;
        let (tenant, _) =
            auth::observe_reconciliation_actor(&tx, &command.input.credential, command.policy)?;
        let (snapshot, context) = crate::read_model::capture_published(
            &tx,
            &tenant,
            command.input.profile.get() as i64,
            &command.repos,
            receipt.plan_version().get(),
        )?;
        tx.commit()?;
        Ok::<_, anyhow::Error>(SavedAuthority { snapshot, context })
    })();
    match captured {
        Ok(authority) => Ok(Outcome::Saved {
            receipt,
            closed_draft_ids,
            authority: Box::new(authority),
        }),
        Err(capture_failure) => Err(CommittedSaveCaptureFailure {
            receipt,
            closed_draft_ids,
            capture_failure,
        }
        .into()),
    }
}
fn keys(c: &SaveCommand, actor: &str) -> (String, String) {
    use sha2::{Digest, Sha256};
    let key = format!(
        "autosave-v1:{}",
        hex::encode(Sha256::digest(c.key.as_bytes()))
    );
    let base = c.request.expected_base();
    let expected_base = match base.revision_id() {
        Some(id) => json!({"kind":"revision","revisionId":id,"planVersion":base.plan_version()}),
        None => json!({"kind":"empty","planVersion":base.plan_version()}),
    };
    let expected_draft = c.request.expected_draft().map(|d| json!({"id":d.draft_id(),"snapshotDigest":d.snapshot_digest(),"lifecycleVersion":d.lifecycle_version()}));
    let changes: Vec<_> = c.request.decisions().iter().map(|choice| {
        let t = choice.target();
        let (kind, value) = match choice {
            PlanChoice::SetIncluded { value, .. } => ("set_included",json!(value)),
            PlanChoice::SetQuantityOverride { value, .. } => ("set_quantity_override",json!(value)),
        };
        json!({"target":{"partKey":t.part_key(),"relativePath":t.relative_path(),"sourceLayer":t.source_layer()},"kind":kind,"value":value})
    }).collect();
    let payload = json!({"profileId":c.profile,"actorId":actor,"idempotencyKey":c.key,"expectedBase":expected_base,"expectedDraft":expected_draft,"remapCheckoffLinks":c.request.remap_checkoff_links(),"changes":changes});
    (
        key,
        format!(
            "autosave-payload-v1:{}",
            required_units::model::digest(&payload)
        ),
    )
}
fn normalized(value: &str) -> String {
    value
        .replace('\\', "/")
        .to_lowercase()
        .trim_matches('/')
        .into()
}
fn choices(parts: &mut [Value], changes: &[PlanChoice]) -> Result<Option<Refusal>> {
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_layer: HashMap<(Option<String>, String), Vec<usize>> = HashMap::new();
    let mut by_path: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_normalized: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in parts.iter().enumerate() {
        let key = text(p, "partKey")?;
        let path = normalized(text(p, "relativePath")?);
        by_key.entry(key.into()).or_default().push(i);
        by_layer
            .entry((p["sourceLayer"].as_str().map(str::to_owned), path.clone()))
            .or_default()
            .push(i);
        by_path.entry(path).or_default().push(i);
        by_normalized.entry(normalized(key)).or_default().push(i);
    }
    let mut touched = HashSet::new();
    for change in changes {
        let t = change.target();
        let exact = by_key.get(t.part_key()).cloned().unwrap_or_default();
        let path = normalized(t.relative_path());
        let restrict = |matches: Option<&Vec<usize>>| {
            matches
                .into_iter()
                .flatten()
                .copied()
                .filter(|i| exact.is_empty() || exact.contains(i))
                .collect::<Vec<_>>()
        };
        let candidates = [
            exact.clone(),
            restrict(by_layer.get(&(Some(t.source_layer().unwrap_or("").into()), path.clone()))),
            restrict(by_path.get(&path)),
            restrict(by_normalized.get(&normalized(t.part_key()))),
        ];
        let Some(position) = candidates.iter().find(|v| v.len() == 1).map(|v| v[0]) else {
            return Ok(Some(if exact.len() > 1 {
                Refusal::PartAmbiguous
            } else {
                Refusal::PartNotFound
            }));
        };
        let included = matches!(change, PlanChoice::SetIncluded { .. });
        if !touched.insert((position, included)) {
            return Ok(Some(Refusal::PartAmbiguous));
        }
        match change {
            PlanChoice::SetIncluded { value, .. } => parts[position]["included"] = json!(value),
            PlanChoice::SetQuantityOverride { value, .. } => {
                parts[position]["quantityOverride"] = json!(value);
                parts[position]["quantityEffective"] = value
                    .map(|v| json!(v))
                    .unwrap_or_else(|| parts[position]["quantityInferred"].clone());
            }
        }
    }
    Ok(None)
}
fn transact(
    tx: &mut Transaction<'_>,
    c: &Command,
    tokens: &mut dyn RequiredUnitTokenAllocator,
) -> Result<TransactionResult> {
    let context = AuthenticatedPublicationContext::resolve_ref(tx, &c.input.credential, c.policy)?;
    let tenant = context.tenant();
    let actor = js_trim(context.actor());
    ensure!(
        !actor.is_empty() && actor.encode_utf16().count() <= 200,
        "Invalid Save actor"
    );
    let profile = c.input.profile.get() as i64;
    let request = &c.input.request;
    let Some(p) = one(
        tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(TransactionResult::Refused(Refusal::NotFound));
    };
    let (key, payload) = keys(&c.input, actor);
    if let Some(prior) = one(
        tx,
        "SELECT * FROM plan_apply_requests WHERE tenant_id=? AND profile_id=? AND actor_id=? AND idempotency_key=?",
        &[&tenant, &profile, &actor, &key],
    )? {
        let draft = one(
            tx,
            "SELECT idempotency_key FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND id=?",
            &[&tenant, &profile, &num(&prior, "draftId")?],
        )?;
        if draft
            .as_ref()
            .is_none_or(|d| d["idempotencyKey"] != payload)
        {
            return Ok(TransactionResult::Refused(Refusal::IdempotencyConflict));
        }
        return Ok(TransactionResult::Saved(publication::receipt(
            tx, tenant, &prior,
        )?));
    }
    if !p["archivedAt"].is_null() {
        return Ok(TransactionResult::Refused(Refusal::BuildArchived));
    }
    if baseline_required(tx, tenant, &p)? {
        return Ok(TransactionResult::Refused(
            Refusal::AcceptedBaselineRequired,
        ));
    }
    let base = json!({"baseRevisionId":p["acceptedPlanRevisionId"],"basePlanVersion":p["acceptedPlanVersion"]});
    if base["baseRevisionId"] != json!(request.expected_base().revision_id())
        || base["basePlanVersion"] != json!(request.expected_base().plan_version())
    {
        return Ok(TransactionResult::Refused(Refusal::BaseChanged));
    }
    let source = if let Some(expected) = request.expected_draft() {
        let Some(d) = required_units::draft(tx, tenant, profile, expected.draft_id().get() as i64)?
        else {
            return Ok(TransactionResult::Refused(Refusal::DraftChanged));
        };
        if d.header["state"] != "open"
            || d.header["snapshotDigest"] != expected.snapshot_digest().as_str()
            || d.header["lifecycleVersion"] != expected.lifecycle_version().get()
        {
            return Ok(TransactionResult::Refused(Refusal::DraftChanged));
        }
        if d.header["baseRevisionId"] != base["baseRevisionId"]
            || d.header["basePlanVersion"] != base["basePlanVersion"]
        {
            return Ok(TransactionResult::Refused(Refusal::BaseChanged));
        }
        Some(d)
    } else {
        if one(tx,"SELECT id FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND state='open' LIMIT 1",&[&tenant,&profile])?.is_some(){return Ok(TransactionResult::Refused(Refusal::DraftChanged));}
        None
    };
    let mut budget = observation::PreparationBudget::new(&c.cancelled, c.limits);
    let (inputs, mut parts) = if let Some(d) = &source {
        let current = preparation::capture(tx, tenant, profile, c.reads.as_ref(), &mut budget)?;
        if !rebase::inputs_equal(&current.inputs, &d.inputs) {
            return Ok(TransactionResult::Refused(Refusal::InputsChanged));
        }
        (d.inputs.clone(), d.parts.clone())
    } else {
        let options = pp_contracts::working_drafts::RecomputeOptions {
            apply_manifest: false,
            prefer_accepted: true,
            ..Default::default()
        };
        let prepared = match preparation::prepare(
            tx,
            tenant,
            profile,
            base.clone(),
            preparation::PreparationContext {
                options: &options,
                repos: &c.repos,
            },
            c.reads.as_ref(),
            &mut budget,
        ) {
            Ok(p) => p,
            Err(e) => {
                return match e.downcast_ref::<Failure>() {
                    Some(Failure::NoLayers) => Ok(TransactionResult::Refused(Refusal::NoLayers)),
                    Some(Failure::NoStls) => Ok(TransactionResult::Refused(Refusal::NoStls)),
                    _ => Err(e),
                };
            }
        };
        (prepared.capture.inputs, prepared.parts)
    };
    if let Some(reason) = choices(&mut parts, request.decisions())? {
        return Ok(TransactionResult::Refused(reason));
    }
    let digest = required_units::model::planning(&base, &inputs, &parts);
    budget.check()?;
    let id = insert_snapshot(
        tx,
        tenant,
        actor,
        profile,
        &payload,
        SnapshotContent {
            base: &base,
            inputs: &inputs,
            parts: &parts,
            digest: &digest,
        },
        None,
    )?;
    let inserted = required_units::draft(tx, tenant, profile, id)?
        .ok_or_else(|| anyhow!("Inserted Save draft missing"))?;
    let mut decisions = Vec::new();
    if let Some(d) = &source
        && let Some(selected) = &d.selected
    {
        ensure!(
            d.parts.len() == inserted.parts.len(),
            "Copied Save Parts differ"
        );
        let ids: HashMap<_, _> = d
            .parts
            .iter()
            .zip(&inserted.parts)
            .map(|(a, b)| Ok((num(a, "id")?, num(b, "id")?)))
            .collect::<Result<_>>()?;
        for row in rows(
            tx,
            "SELECT * FROM plan_draft_required_unit_decisions WHERE tenant_id=? AND reconciliation_id=? ORDER BY target_draft_part_id",
            &[&tenant, &num(&selected.header, "id")?],
        )? {
            let target = *ids
                .get(&num(&row, "targetDraftPartId")?)
                .ok_or_else(|| anyhow!("Copied decision target missing"))?;
            let mut decision = json!({"kind":row["kind"],"target_draft_part_id":target});
            if row["kind"] != "replace" {
                decision["predecessor_revision_part_id"] = row["predecessorRevisionPartId"].clone();
            }
            decisions.push(decision);
        }
    }
    let reconcile =
        serde_json::from_value(json!({"expected_snapshot_digest":digest,"decisions":decisions}))?;
    let draft_id = PositiveId::new(id as u64).map_err(anyhow::Error::msg)?;
    let selection = required_units::reconcile_in_transaction(
        tx,
        required_units::BorrowedCommand {
            credential: &c.input.credential,
            policy: c.policy,
            profile_id: c.input.profile,
            draft_id,
            request: &reconcile,
            idempotency_key: &key,
        },
    )?;
    let reconciliation::Outcome::Ready { workspace } = selection else {
        return Ok(TransactionResult::Refused(match selection {
            reconciliation::Outcome::DraftChanged { .. } => Refusal::DraftChanged,
            other => Refusal::Reconciliation { outcome: other },
        }));
    };
    let apply = ApplyRequest {
        expected_snapshot_digest: workspace.draft.snapshot_digest().clone(),
        expected_lifecycle_version: pp_contracts::autosave::WireInteger::new(
            workspace.draft.lifecycle_version().get(),
        )
        .map_err(anyhow::Error::msg)?,
        expected_base: request.expected_base().clone(),
        remap_checkoff_links: request.remap_checkoff_links(),
    };
    let applied = publication::publish_in_transaction(
        tx,
        &context,
        c.input.profile,
        draft_id,
        PublicationRequests::direct(&apply),
        &key,
        tokens,
    )?;
    let receipt = match applied {
        pp_contracts::publication::Outcome::Applied { receipt }
        | pp_contracts::publication::Outcome::Existing { receipt }
        | pp_contracts::publication::Outcome::AlreadyApplied { receipt } => receipt,
        other => {
            return Ok(TransactionResult::Refused(Refusal::Publication {
                outcome: other,
            }));
        }
    };
    if let Some(d) = source {
        ensure!(
            num(&d.header, "lifecycleVersion")? < i64::from(i32::MAX),
            "Draft lifecycle exhausted"
        );
        let changed=tx.execute("UPDATE plan_drafts SET state='abandoned',lifecycle_version=lifecycle_version+1 WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND lifecycle_version=? AND snapshot_digest=?",params![tenant,profile,num(&d.header,"id")?,num(&d.header,"lifecycleVersion")?,text(&d.header,"snapshotDigest")?])?;
        if changed != 1 {
            return Ok(TransactionResult::Refused(Refusal::DraftChanged));
        }
        let after = required_units::draft(tx, tenant, profile, num(&d.header, "id")?)?
            .ok_or_else(|| anyhow!("Closed Save draft missing"))?;
        ensure!(
            after.header["snapshotDigest"] == d.header["snapshotDigest"]
                && after.header["lifecycleVersion"].as_i64()
                    == Some(num(&d.header, "lifecycleVersion")? + 1)
                && after.header["state"] == "abandoned",
            "Observed Save closure mismatch"
        );
    }
    Ok(TransactionResult::Saved(receipt))
}
