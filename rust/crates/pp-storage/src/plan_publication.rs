mod model;
use crate::{
    Envelope, Shared, WriterOwner, auth,
    read_model::Credential,
    required_units::{self as ru, normalize_parts, num, one, rows, text},
};
use anyhow::{Result, anyhow, ensure};
use model::{Assignment, Prepared};
use pp_contracts::{
    autosave::{ApplyPlanDraftReceipt, PositiveId},
    publication::{ApplyRequest, Outcome, ReconciliationReason, UnmappableLink},
};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub trait RequiredUnitTokenAllocator: Send {
    fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure>;
}
#[derive(Debug)]
pub struct TokenAllocationFailure;
struct RandomTokens;
impl RequiredUnitTokenAllocator for RandomTokens {
    fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure> {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|_| TokenAllocationFailure)?;
        Ok(bytes)
    }
}
pub(crate) fn random_tokens() -> Box<dyn RequiredUnitTokenAllocator> {
    Box::new(RandomTokens)
}
#[derive(Clone)]
pub struct PublicationClient {
    shared: Arc<Shared>,
    policy: auth::AuthPolicy,
}
pub struct PublicationCommand {
    profile: PositiveId,
    draft: PositiveId,
    request: ApplyRequest,
    key: String,
    credential: Credential,
}
impl PublicationCommand {
    pub fn new(
        profile: PositiveId,
        draft: PositiveId,
        request: ApplyRequest,
        key: String,
        credential: Credential,
    ) -> Result<Self> {
        let key=key.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')).to_owned();
        ensure!(
            !key.is_empty() && key.encode_utf16().count() <= 160,
            "Invalid idempotency key"
        );
        Ok(Self {
            profile,
            draft,
            request,
            key,
            credential,
        })
    }
}
pub(crate) struct Command {
    input: PublicationCommand,
    policy: auth::AuthPolicy,
}
impl WriterOwner {
    pub fn publication(&self) -> PublicationClient {
        self.publication_with_policy(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
            first_user: auth::FirstUserTenant::NewUser,
        })
        .expect("neutral policy")
    }
    pub fn publication_with_policy(&self, policy: auth::AuthPolicy) -> Result<PublicationClient> {
        auth::validate_policy(policy)?;
        Ok(PublicationClient {
            shared: self.client.shared.clone(),
            policy,
        })
    }
}
impl PublicationClient {
    pub fn apply(
        &self,
        input: PublicationCommand,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<Outcome> {
        use ru::AdmissionFailure;
        let deadline = Instant::now() + wait;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!(AdmissionFailure::Stopped))?;
        loop {
            ensure!(!queue.closed, AdmissionFailure::Stopped);
            ensure!(
                !cancelled.load(Ordering::Acquire),
                AdmissionFailure::Cancelled
            );
            if queue.pending.len() < self.shared.capacity {
                break;
            }
            ensure!(Instant::now() < deadline, AdmissionFailure::QueueFull);
            queue = self
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!(AdmissionFailure::Stopped))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::Publication {
            command: Command {
                input,
                policy: self.policy,
            },
            reply,
        });
        self.shared.changed.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|_| anyhow!(AdmissionFailure::OutcomeUnknown))?
    }
}
pub(crate) struct AuthenticatedPublicationContext {
    tenant: String,
    actor: String,
}
impl AuthenticatedPublicationContext {
    pub(crate) fn resolve_ref(
        tx: &Transaction<'_>,
        credential: &Credential,
        policy: auth::AuthPolicy,
    ) -> Result<Self> {
        let (tenant, actor) = auth::reconciliation_actor_ref(tx, credential, policy)?;
        Ok(Self { tenant, actor })
    }
    pub(crate) fn tenant(&self) -> &str {
        &self.tenant
    }
    pub(crate) fn actor(&self) -> &str {
        &self.actor
    }
    pub(crate) fn resolve(
        tx: &Transaction<'_>,
        credential: Credential,
        policy: auth::AuthPolicy,
    ) -> Result<Self> {
        let (tenant, actor) = auth::reconciliation_actor(tx, credential, policy)?;
        Ok(Self { tenant, actor })
    }
}
pub(crate) fn execute(
    connection: &mut Connection,
    command: Command,
    tokens: &mut dyn RequiredUnitTokenAllocator,
) -> Result<Outcome> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let c = command.input;
    let context = AuthenticatedPublicationContext::resolve(&tx, c.credential, command.policy)?;
    let result = publish_in_transaction(
        &tx, &context, c.profile, c.draft, &c.request, &c.key, tokens,
    )?;
    if matches!(
        result,
        Outcome::Applied { .. } | Outcome::Existing { .. } | Outcome::AlreadyApplied { .. }
    ) {
        tx.commit()?
    }
    Ok(result)
}
fn request_digest(profile: i64, draft: i64, request: &ApplyRequest) -> String {
    ru::model::digest(
        &json!({"format":model::REQUEST_FORMAT,"profile_id":profile,"draft_id":draft,"expected_snapshot_digest":request.expected_snapshot_digest,"expected_lifecycle_version":request.expected_lifecycle_version,"expected_base_revision_id":request.expected_base.revision_id(),"expected_base_plan_version":request.expected_base.plan_version()}),
    )
}
fn validate_text(row: &Value) -> Result<()> {
    ensure!(
        row.as_object()
            .ok_or_else(|| anyhow!("Invalid publication row"))?
            .values()
            .filter_map(Value::as_str)
            .map(str::len)
            .sum::<usize>()
            <= 65536,
        "Accepted operational row text limit"
    );
    Ok(())
}
fn sql_value(value: &Value) -> Result<rusqlite::types::Value> {
    Ok(match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(v) => rusqlite::types::Value::Integer(i64::from(*v)),
        Value::Number(n) => rusqlite::types::Value::Integer(
            n.as_i64()
                .ok_or_else(|| anyhow!("Invalid publication integer"))?,
        ),
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        _ => return Err(anyhow!("Invalid publication field")),
    })
}
fn insert(tx: &Transaction<'_>, table: &str, row: &Value, ignore: bool) -> Result<i64> {
    validate_text(row)?;
    let fields = row.as_object().ok_or_else(|| anyhow!("Invalid row"))?;
    let names: Vec<_> = fields.keys().map(|k| model::snake(k)).collect();
    let values = fields.values().map(sql_value).collect::<Result<Vec<_>>>()?;
    let sql = format!(
        "INSERT INTO {}({}) VALUES({}){}",
        table,
        names.join(","),
        vec!["?"; names.len()].join(","),
        if ignore {
            " ON CONFLICT DO NOTHING"
        } else {
            ""
        }
    );
    tx.prepare_cached(&sql)?
        .execute(rusqlite::params_from_iter(values))?;
    Ok(tx.last_insert_rowid())
}
fn historical_mapping(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    revision: i64,
) -> Result<String> {
    let set=one(tx,"SELECT * FROM plan_revision_required_unit_sets WHERE tenant_id=? AND profile_id=? AND revision_id=?",&[&tenant,&profile,&revision])?.ok_or_else(||anyhow!("Missing historical mapping"))?;
    let parts = rows(
        tx,
        "SELECT id,quantity_effective FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
        &[&tenant, &revision],
    )?;
    let mapped = rows(
        tx,
        "SELECT m.revision_part_id,m.unit_index,u.token,u.object_name FROM plan_revision_required_units m JOIN required_units u ON u.token=m.required_unit_token AND u.tenant_id=?1 AND u.profile_id=?2 WHERE m.tenant_id=?1 AND m.revision_id=?3 ORDER BY m.revision_part_id,m.unit_index",
        &[&tenant, &profile, &revision],
    )?;
    let mut expected = 0;
    let mut tokens = HashSet::new();
    for p in &parts {
        let q = num(p, "quantityEffective")?;
        ensure!((1..=10000).contains(&q), "Invalid historical quantity");
        let units: Vec<_> = mapped
            .iter()
            .filter(|u| u["revisionPartId"] == p["id"])
            .collect();
        ensure!(units.len() as i64 == q, "Incomplete historical mapping");
        for (i, u) in units.iter().enumerate() {
            ensure!(
                num(u, "unitIndex")? == i as i64 && tokens.insert(text(u, "token")?),
                "Invalid historical coordinate"
            );
            ru::model::validate_token(text(u, "token")?)?;
        }
        expected += q;
    }
    ensure!(
        set["format"] == "required-unit-map-v1"
            && num(&set, "expectedUnitCount")? == expected
            && mapped.len() as i64 == expected,
        "Invalid historical set"
    );
    let mapped: Vec<_> = mapped
        .iter()
        .map(|r| model::canonical(r, &["revisionPartId", "unitIndex", "token", "objectName"]))
        .collect();
    let digest = ru::model::digest(
        &json!({"format":"required-unit-map-v1","revision_id":revision,"expected_unit_count":expected,"rows":mapped}),
    );
    ensure!(
        set["mappingDigest"] == digest,
        "Historical mapping digest mismatch"
    );
    Ok(digest)
}
pub(crate) fn receipt(
    tx: &Transaction<'_>,
    tenant: &str,
    row: &Value,
) -> Result<ApplyPlanDraftReceipt> {
    let profile = num(row, "profileId")?;
    let draft = num(row, "draftId")?;
    let revision = num(row, "revisionId")?;
    let request: ApplyRequest = serde_json::from_value(
        json!({"expected_snapshot_digest":row["expectedSnapshotDigest"],"expected_lifecycle_version":row["expectedLifecycleVersion"],"expected_base":{"revision_id":row["expectedBaseRevisionId"],"plan_version":row["expectedBasePlanVersion"]}}),
    )?;
    ensure!(
        row["requestFormat"] == model::REQUEST_FORMAT
            && row["requestDigest"] == request_digest(profile, draft, &request)
            && num(row, "planVersion")? == num(row, "expectedBasePlanVersion")? + 1
            && num(row, "draftLifecycleVersion")? == num(row, "expectedLifecycleVersion")? + 1,
        "Invalid publication receipt"
    );
    let d =
        ru::draft(tx, tenant, profile, draft)?.ok_or_else(|| anyhow!("Missing receipt draft"))?;
    let selected = d
        .selected
        .as_ref()
        .ok_or_else(|| anyhow!("Missing receipt reconciliation"))?;
    let rev = one(
        tx,
        "SELECT * FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
        &[&tenant, &profile, &revision],
    )?
    .ok_or_else(|| anyhow!("Missing receipt revision"))?;
    ensure!(
        d.header["state"] == "consumed"
            && d.header["lifecycleVersion"] == row["draftLifecycleVersion"]
            && d.header["snapshotDigest"] == row["expectedSnapshotDigest"]
            && d.header["baseRevisionId"] == row["expectedBaseRevisionId"]
            && d.header["basePlanVersion"] == row["expectedBasePlanVersion"]
            && d.header["consumedRevisionId"] == revision
            && d.header["consumedAt"] == row["appliedAt"]
            && selected.header["id"] == row["reconciliationId"]
            && selected.header["reconciliationDigest"] == row["reconciliationDigest"]
            && rev["parentRevisionId"] == row["expectedBaseRevisionId"]
            && rev["snapshotDigest"] == row["revisionDigest"]
            && historical_mapping(tx, tenant, profile, revision)?
                == row["requiredUnitMappingDigest"],
        "Publication receipt linkage mismatch"
    );
    serde_json::from_value(json!({"profile_id":profile,"draft_id":draft,"revision_id":revision,"plan_version":row["planVersion"],"draft_lifecycle_version":row["draftLifecycleVersion"],"revision_digest":row["revisionDigest"],"required_unit_mapping_digest":row["requiredUnitMappingDigest"],"applied_at":row["appliedAt"]})).map_err(Into::into)
}
fn validate_inputs(tx: &Transaction<'_>, tenant: &str, inputs: &[Value]) -> Result<()> {
    let mut seen = HashSet::new();
    for i in inputs {
        validate_text(i)?;
        let source = num(i, "sourceId")?;
        ensure!(seen.insert(source), "Duplicate input Source");
        ensure!(
            one(
                tx,
                "SELECT id FROM projects WHERE tenant_id=? AND id=?",
                &[&tenant, &source]
            )?
            .is_some(),
            "Missing input Source"
        );
        pp_contracts::autosave::Digest::new(text(i, "effectiveNamingDigest")?.into())
            .map_err(anyhow::Error::msg)?;
        if i["trackingKind"] == "revision" {
            let revision = num(i, "sourceRevisionId")?;
            let stored = one(
                tx,
                "SELECT * FROM source_revisions WHERE tenant_id=? AND project_id=? AND id=?",
                &[&tenant, &source, &revision],
            )?
            .ok_or_else(|| anyhow!("Missing pinned Source revision"))?;
            validate_text(&stored)?;
            ensure!(
                stored["manifestDigest"] == i["manifestDigest"],
                "Pinned manifest mismatch"
            );
        } else {
            ensure!(
                i["trackingKind"] == "untracked"
                    && i["sourceRevisionId"].is_null()
                    && i["manifestDigest"].is_null(),
                "Invalid untracked input"
            );
        }
    }
    Ok(())
}
fn publish_inputs(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    inputs: &[Value],
    at: &str,
) -> Result<i64> {
    let canonical = model::inputs(inputs);
    let digest = ru::model::digest(&json!({"version":2,"inputs":canonical}));
    insert(
        tx,
        "plan_revision_input_sets",
        &json!({"tenantId":tenant,"profileId":profile,"inputSetDigest":digest,"expectedInputCount":inputs.len(),"formatVersion":2,"recordedAt":at}),
        true,
    )?;
    let set=one(tx,"SELECT * FROM plan_revision_input_sets WHERE tenant_id=? AND profile_id=? AND input_set_digest=?",&[&tenant,&profile,&digest])?.ok_or_else(||anyhow!("Missing input set"))?;
    let id = num(&set, "id")?;
    ensure!(
        num(&set, "expectedInputCount")? == inputs.len() as i64 && set["formatVersion"] == 2,
        "Input set content conflict"
    );
    for input in &canonical {
        let mut row = input.clone();
        row["tenant_id"] = json!(tenant);
        row["input_set_id"] = json!(id);
        insert(tx, "plan_revision_inputs", &row, true)?;
    }
    let stored = rows(
        tx,
        "SELECT * FROM plan_revision_inputs WHERE tenant_id=? AND input_set_id=? ORDER BY source_id",
        &[&tenant, &id],
    )?;
    ensure!(model::inputs(&stored) == canonical, "Stored input mismatch");
    tx.execute("UPDATE plan_revision_input_sets SET published_at=? WHERE tenant_id=? AND id=? AND published_at IS NULL",params![at,tenant,id])?;
    Ok(id)
}
fn projection(p: &Value) -> Value {
    let mut row = ru::model::project(p, ru::model::PART_FIELDS);
    let o = row.as_object_mut().expect("project object");
    o.remove("artifactDigest");
    o.remove("roleInferred");
    o.remove("roleOverride");
    o.remove("partKey");
    o.remove("quantityInferred");
    row["matchKey"] = p["partKey"].clone();
    row["quantityAuto"] = p["quantityInferred"].clone();
    row["role"] = json!(ru::model::role(p));
    row
}
fn validate_projection(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    revision: i64,
) -> Result<Vec<Value>> {
    let header = one(
        tx,
        "SELECT * FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
        &[&tenant, &profile, &revision],
    )?
    .ok_or_else(|| anyhow!("Missing accepted revision"))?;
    let mut immutable = rows(
        tx,
        "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
        &[&tenant, &revision],
    )?;
    normalize_parts(&mut immutable)?;
    ensure!(
        header["digestFormat"] == model::REVISION_FORMAT
            && model::revision_digest(&immutable) == header["snapshotDigest"],
        "Accepted revision digest mismatch"
    );
    let mut current = rows(
        tx,
        "SELECT * FROM parts WHERE tenant_id=? AND profile_id=? ORDER BY id",
        &[&tenant, &profile],
    )?;
    normalize_parts(&mut current)?;
    ensure!(
        immutable.len() == current.len(),
        "Accepted projection count mismatch"
    );
    for part in &immutable {
        let actual = current
            .iter()
            .find(|p| p["id"] == part["projectionPartId"])
            .ok_or_else(|| anyhow!("Missing accepted projection"))?;
        for (key, value) in projection(part).as_object().expect("object") {
            if !["filamentColorId", "filamentCustomHex", "spoolmanSpoolId"].contains(&key.as_str())
            {
                ensure!(actual[key] == *value, "Accepted projection mismatch {key}");
            }
        }
        let progress = rows(
            tx,
            "SELECT unit_index,completed,assembled FROM print_progress WHERE tenant_id=? AND part_id=? ORDER BY unit_index",
            &[&tenant, &num(actual, "id")?],
        )?;
        let quantity = num(part, "quantityEffective")?;
        for index in 0..quantity {
            let u = progress
                .iter()
                .find(|u| u["unitIndex"] == index)
                .ok_or_else(|| anyhow!("Incomplete accepted progress"))?;
            let c = num(u, "completed")?;
            let a = num(u, "assembled")?;
            ensure!(
                (0..=1).contains(&c) && (0..=c).contains(&a),
                "Invalid accepted progress"
            );
        }
    }
    for part in &mut immutable {
        let actual = current
            .iter()
            .find(|p| p["id"] == part["projectionPartId"])
            .expect("validated");
        for field in ["filamentColorId", "filamentCustomHex", "spoolmanSpoolId"] {
            part[field] = actual[field].clone();
        }
    }
    Ok(immutable)
}
struct Production {
    links: Option<Value>,
    queue: Option<Value>,
    link_count: usize,
    queue_count: usize,
    owners: HashMap<i64, i64>,
}
fn setting(tx: &Transaction<'_>, tenant: &str, key: &str) -> Result<Option<Value>> {
    let Some(row) = one(
        tx,
        "SELECT value FROM app_settings WHERE tenant_id=? AND key=?",
        &[&tenant, &key],
    )?
    else {
        return Ok(None);
    };
    let raw = text(&row, "value")?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(raw)?;
    ensure!(value.is_array(), "Invalid production setting");
    Ok(Some(value))
}
fn coordinate(unit: &Value) -> Result<(i64, i64)> {
    let part = num(unit, "part_id")?;
    let index = num(unit, "unit_index")?;
    ensure!(part > 0 && index >= 0, "Invalid production coordinate");
    Ok((part, index))
}
fn production(tx: &Transaction<'_>, tenant: &str, profile: i64) -> Result<Production> {
    let links = setting(tx, tenant, "printer.checkoff_links")?;
    let queue = setting(tx, tenant, "printer.send_queue")?;
    let owners: HashMap<_, _> = rows(
        tx,
        "SELECT id,profile_id FROM parts WHERE tenant_id=?",
        &[&tenant],
    )?
    .iter()
    .map(|p| Ok((num(p, "id")?, num(p, "profileId")?)))
    .collect::<Result<_>>()?;
    let mut link_count = 0;
    let mut queue_count = 0;
    if let Some(v) = &links {
        for row in v.as_array().expect("array") {
            let state = text(row, "state")?;
            ensure!(
                [
                    "watching",
                    "awaiting_verify",
                    "host_failed",
                    "dismissed",
                    "verified",
                    "applied"
                ]
                .contains(&state)
                    && num(row, "profile_id")? > 0,
                "Invalid Checkoff link"
            );
            for unit in row["units"]
                .as_array()
                .ok_or_else(|| anyhow!("Invalid Checkoff units"))?
            {
                let (part, _) = coordinate(unit)?;
                ensure!(
                    owners
                        .get(&part)
                        .is_none_or(|owner| Some(*owner) == row["profile_id"].as_i64()),
                    "Checkoff coordinate ownership mismatch"
                );
            }
            if row["profile_id"] == profile && ["watching", "awaiting_verify"].contains(&state) {
                link_count += 1;
            }
        }
    }
    if let Some(v) = &queue {
        for row in v.as_array().expect("array") {
            let state = text(row, "state")?;
            ensure!(
                ["queued", "sending", "done", "error", "cancelled"].contains(&state),
                "Invalid queue state"
            );
            let explicit = row["profile_id"].as_i64();
            ensure!(
                row["profile_id"].is_null() || explicit.is_some_and(|n| n > 0),
                "Invalid queue owner"
            );
            let mut unit_owners = HashSet::new();
            if !row["checkoff_units"].is_null() {
                for u in row["checkoff_units"]
                    .as_array()
                    .ok_or_else(|| anyhow!("Invalid queue units"))?
                {
                    let (p, _) = coordinate(u)?;
                    if let Some(owner) = owners.get(&p) {
                        unit_owners.insert(*owner);
                    }
                }
            }
            ensure!(
                unit_owners.len() <= 1
                    && explicit.is_none_or(|p| unit_owners.iter().all(|o| *o == p)),
                "Queue owner mismatch"
            );
            let owner = explicit.or_else(|| unit_owners.into_iter().next());
            if owner == Some(profile) && ["queued", "sending", "error"].contains(&state) {
                queue_count += 1;
            }
        }
    }
    Ok(Production {
        links,
        queue,
        link_count,
        queue_count,
        owners,
    })
}
enum Remap {
    Mapped(HashMap<(i64, i64), (i64, i64)>),
    Unmappable(Vec<UnmappableLink>),
}
fn remap(
    production: &Production,
    profile: i64,
    old_tokens: &HashMap<(i64, i64), String>,
    prepared: &Prepared,
) -> Result<Remap> {
    let mut targets = HashMap::new();
    for a in &prepared.assignments {
        if let Assignment::Reuse { token, .. } = a {
            let (part, index) = a.slot();
            let p = prepared
                .parts
                .iter()
                .find(|p| p["id"] == part)
                .expect("validated Part");
            if p["included"] == true {
                targets.insert(token.clone(), (part, index));
            }
        }
    }
    let mut mapped = HashMap::new();
    let mut missing = Vec::new();
    let mut seen = HashSet::new();
    let mut resolve = |row: &Value, units: &Value| -> Result<()> {
        if units.is_null() {
            return Ok(());
        }
        for u in units
            .as_array()
            .ok_or_else(|| anyhow!("Invalid production coordinates"))?
        {
            let slot = coordinate(u)?;
            if !seen.insert(slot) {
                continue;
            }
            if let Some(target) = old_tokens.get(&slot).and_then(|t| targets.get(t)) {
                mapped.insert(slot, *target);
            } else {
                missing.push(UnmappableLink{link_id:row["id"].as_str().unwrap_or("unknown").into(),filename:row["filename"].as_str().unwrap_or("unknown file").into(),reason:format!("Required unit at Part {} index {} is absent or excluded in the selected Plan",slot.0,slot.1)});
            }
        }
        Ok(())
    };
    if let Some(v) = &production.links {
        for row in v.as_array().expect("array") {
            if row["profile_id"] == profile {
                resolve(row, &row["units"])?;
                resolve(row, &row["resolved_units"])?;
            }
        }
    }
    if let Some(v) = &production.queue {
        for row in v.as_array().expect("array") {
            let units = row["checkoff_units"].as_array();
            let related = row["profile_id"] == profile
                || (row["profile_id"].is_null()
                    && units.is_some_and(|u| {
                        u.iter().any(|u| {
                            u["part_id"]
                                .as_i64()
                                .and_then(|id| production.owners.get(&id))
                                .copied()
                                == Some(profile)
                        })
                    }));
            if related {
                resolve(row, &row["checkoff_units"])?;
            }
        }
    }
    Ok(if missing.is_empty() {
        Remap::Mapped(mapped)
    } else {
        Remap::Unmappable(missing)
    })
}
fn write_remap(
    tx: &Transaction<'_>,
    tenant: &str,
    production: Production,
    mapping: &HashMap<(i64, i64), (i64, i64)>,
    projection: &HashMap<i64, i64>,
) -> Result<()> {
    if mapping.is_empty() {
        return Ok(());
    }
    for (key, value, fields) in [
        (
            "printer.checkoff_links",
            production.links,
            vec!["units", "resolved_units"],
        ),
        (
            "printer.send_queue",
            production.queue,
            vec!["checkoff_units"],
        ),
    ] {
        if let Some(mut value) = value {
            for row in value.as_array_mut().expect("array") {
                for field in &fields {
                    if let Some(units) = row[*field].as_array_mut() {
                        for unit in units {
                            let slot = coordinate(unit)?;
                            if let Some((part, index)) = mapping.get(&slot) {
                                unit["part_id"] = json!(
                                    projection
                                        .get(part)
                                        .ok_or_else(|| anyhow!("Missing remap projection"))?
                                );
                                unit["unit_index"] = json!(index);
                            }
                        }
                    }
                }
            }
            tx.execute(
                "UPDATE app_settings SET value=? WHERE tenant_id=? AND key=?",
                params![value.to_string(), tenant, key],
            )?;
        }
    }
    Ok(())
}
pub(crate) fn publish_in_transaction(
    tx: &Transaction<'_>,
    context: &AuthenticatedPublicationContext,
    profile: PositiveId,
    draft_id: PositiveId,
    request: &ApplyRequest,
    key: &str,
    tokens: &mut dyn RequiredUnitTokenAllocator,
) -> Result<Outcome> {
    let tenant = context.tenant.as_str();
    let actor = context.actor.as_str();
    let profile = profile.get() as i64;
    let draft_id = draft_id.get() as i64;
    let request_hash = request_digest(profile, draft_id, request);
    if let Some(row) = one(
        tx,
        "SELECT * FROM plan_apply_requests WHERE tenant_id=? AND actor_id=? AND profile_id=? AND idempotency_key=?",
        &[&tenant, &actor, &profile, &key],
    )? {
        return Ok(if row["requestDigest"] == request_hash {
            Outcome::Existing {
                receipt: receipt(tx, tenant, &row)?,
            }
        } else {
            Outcome::IdempotencyConflict
        });
    }
    if let Some(row) = one(
        tx,
        "SELECT * FROM plan_apply_requests WHERE tenant_id=? AND profile_id=? AND draft_id=?",
        &[&tenant, &profile, &draft_id],
    )? {
        return Ok(Outcome::AlreadyApplied {
            receipt: receipt(tx, tenant, &row)?,
        });
    }
    let Some(profile_row) = one(
        tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    validate_text(&profile_row)?;
    if !profile_row["archivedAt"].is_null() {
        return Ok(Outcome::BuildArchived);
    }
    let Some(h) = one(
        tx,
        "SELECT * FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND id=?",
        &[&tenant, &profile, &draft_id],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    if h["state"] != "open" {
        return Ok(Outcome::NotOpen {
            state: serde_json::from_value(h["state"].clone())?,
        });
    }
    if h["lifecycleVersion"].as_u64() != Some(request.expected_lifecycle_version.get())
        || h["snapshotDigest"] != request.expected_snapshot_digest.as_str()
        || !["plan-draft-v1", "plan-draft-v2"].contains(&text(&h, "digestFormat")?)
    {
        return Ok(Outcome::DraftChanged);
    }
    let previous = request
        .expected_base
        .revision_id()
        .map(|id| id.get() as i64);
    let version = request.expected_base.plan_version().get() as i64;
    if profile_row["acceptedPlanRevisionId"].is_null()
        && (num(&profile_row, "acceptedPlanVersion")? != 0
            || one(
                tx,
                "SELECT id FROM parts WHERE tenant_id=? AND profile_id=? LIMIT 1",
                &[&tenant, &profile],
            )?
            .is_some())
    {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    if profile_row["acceptedPlanRevisionId"] != json!(previous)
        || profile_row["acceptedPlanVersion"] != version
        || h["baseRevisionId"] != json!(previous)
        || h["basePlanVersion"] != version
    {
        return Ok(Outcome::BaseChanged);
    }
    let mut d =
        ru::draft(tx, tenant, profile, draft_id)?.ok_or_else(|| anyhow!("Missing draft"))?;
    let attached = rows(
        tx,
        "SELECT p.id AS source_id,l.layer_type||':'||p.name AS source_layer,l.layer_order FROM profile_layers l JOIN projects p ON p.id=l.project_id AND p.tenant_id=l.tenant_id WHERE l.tenant_id=? AND l.profile_id=? AND l.project_id IS NOT NULL ORDER BY l.layer_order,p.id",
        &[&tenant, &profile],
    )?;
    let identities: Vec<_> = d
        .inputs
        .iter()
        .map(|r| ru::model::project(r, &["sourceId", "sourceLayer", "layerOrder"]))
        .collect();
    if attached != identities {
        return Ok(Outcome::InputsChanged);
    }
    validate_inputs(tx, tenant, &d.inputs)?;
    let predecessors = previous
        .map(|id| validate_projection(tx, tenant, profile, id))
        .transpose()?
        .unwrap_or_default();
    let Some(selected) = &d.selected else {
        return Ok(Outcome::ReconciliationRequired {
            reason: ReconciliationReason::Missing,
        });
    };
    if selected.result.result["kind"] != "ready" {
        return Ok(Outcome::ReconciliationRequired {
            reason: ReconciliationReason::Unresolved,
        });
    }
    ensure!(
        selected.header["planningDigest"] == d.planning
            && selected.header["baseRevisionId"] == json!(previous),
        "Invalid selected reconciliation"
    );
    let Some((mapping, base_parts)) = ru::base(tx, tenant, profile, &d)? else {
        return Ok(Outcome::ReconciliationRequired {
            reason: ReconciliationReason::Stale,
        });
    };
    if mapping != selected.header["baseMappingDigest"] {
        return Ok(Outcome::ReconciliationRequired {
            reason: ReconciliationReason::Stale,
        });
    }
    let mut base = HashMap::new();
    let mut base_identity = HashMap::new();
    let mut old_tokens = HashMap::new();
    for p in &base_parts {
        let projection = predecessors
            .iter()
            .find(|r| r["id"] == p.id)
            .ok_or_else(|| anyhow!("Missing predecessor"))?;
        for u in &p.units {
            let stored = one(
                tx,
                "SELECT * FROM required_units WHERE tenant_id=? AND profile_id=? AND token=?",
                &[&tenant, &profile, &u.token],
            )?
            .ok_or_else(|| anyhow!("Missing Required unit"))?;
            ensure!(
                stored["createdAt"] == u.created_at && num(&stored, "createdInRevisionId")? > 0,
                "Invalid Required-unit origin"
            );
            base.insert(u.token.clone(), (stored, u.completed, u.assembled));
            base_identity.insert(u.token.clone(), (p.id, u));
            old_tokens.insert(
                (num(projection, "projectionPartId")?, u.prior_index),
                u.token.clone(),
            );
        }
    }
    let mut live_basis = selected.result.basis.clone();
    for row in live_basis
        .as_array_mut()
        .ok_or_else(|| anyhow!("Invalid basis"))?
    {
        let (id, u) = base_identity
            .get(text(row, "token")?)
            .ok_or_else(|| anyhow!("Missing basis token"))?;
        ensure!(
            row["revisionPartId"] == *id
                && row["priorIndex"] == u.prior_index
                && row["createdAt"] == u.created_at,
            "Changed basis identity"
        );
        row["completed"] = json!(u.completed);
        row["assembled"] = json!(u.assembled);
    }
    if ru::selection_basis_digest(&mapping, &live_basis) != selected.header["selectionBasisDigest"]
    {
        return Ok(Outcome::ReconciliationRequired {
            reason: ReconciliationReason::Stale,
        });
    }
    for p in &mut d.parts {
        if let Some(old) = predecessors
            .iter()
            .find(|r| r["id"] == p["baseRevisionPartId"])
        {
            for key in ["filamentColorId", "filamentCustomHex", "spoolmanSpoolId"] {
                p[key] = old[key].clone();
            }
        }
    }
    let production = production(tx, tenant, profile)?;
    let prepared = model::prepare(d.parts, &selected.result.result["assignments"], &base)?;
    let remapping = if production.link_count > 0 || production.queue_count > 0 {
        if !request.remap_checkoff_links {
            return Ok(Outcome::ProductionActive {
                checkoff_link_count: production.link_count,
                send_queue_item_count: production.queue_count,
            });
        }
        match remap(&production, profile, &old_tokens, &prepared)? {
            Remap::Mapped(m) => m,
            Remap::Unmappable(unmappable) => {
                return Ok(Outcome::CheckoffRemapUnsafe { unmappable });
            }
        }
    } else {
        HashMap::new()
    };
    let conflicts = crate::jobs::publication_conflicts(tx, tenant, profile)?;
    if !conflicts.is_empty() {
        return Ok(Outcome::ExecutionConflict {
            operations: conflicts,
        });
    }
    let existing = rows(tx, "SELECT token,object_name FROM required_units", &[])?;
    let mut existing_tokens: HashSet<String> = existing
        .iter()
        .map(|u| text(u, "token").map(str::to_owned))
        .collect::<Result<_>>()?;
    let mut names: HashSet<String> = existing
        .iter()
        .map(|u| text(u, "objectName").map(str::to_lowercase))
        .collect::<Result<_>>()?;
    let mut allocated = HashMap::new();
    for a in &prepared.assignments {
        if let Assignment::Create { part, index } = a {
            let p = prepared
                .parts
                .iter()
                .find(|p| p["id"] == *part)
                .expect("validated");
            let mut chosen = None;
            for _ in 0..32 {
                if let Ok(bytes) = tokens.allocate() {
                    let token = format!("ppu_{}", hex::encode(bytes));
                    let name = model::object_name(text(p, "filename")?, &token);
                    if !existing_tokens.contains(&token) && !names.contains(&name.to_lowercase()) {
                        existing_tokens.insert(token.clone());
                        names.insert(name.to_lowercase());
                        chosen = Some((token, name));
                        break;
                    }
                }
            }
            let Some(chosen) = chosen else {
                return Ok(Outcome::TokenAllocationFailed);
            };
            allocated.insert((*part, *index), chosen);
        }
    }
    let now = time::OffsetDateTime::now_utc();
    let at = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    );
    tx.execute(
        "DELETE FROM accepted_plate_heads WHERE tenant_id=? AND profile_id=?",
        params![tenant, profile],
    )?;
    ensure!(tx.execute("UPDATE build_profiles SET accepted_plan_revision_id=NULL WHERE tenant_id=? AND id=? AND accepted_plan_revision_id IS ? AND accepted_plan_version=?",params![tenant,profile,previous,version])?==1,"Accepted pointer detach failed");
    let input_set = publish_inputs(tx, tenant, profile, &d.inputs, &at)?;
    let number:i64=tx.query_row("SELECT COALESCE(MAX(revision_number),0)+1 FROM plan_revisions WHERE tenant_id=? AND profile_id=?",params![tenant,profile],|r|r.get(0))?;
    let revision = insert(
        tx,
        "plan_revisions",
        &json!({"tenantId":tenant,"profileId":profile,"revisionNumber":number,"parentRevisionId":previous,"inputSetId":input_set,"provenanceKind":"tracked","digestFormat":model::REVISION_FORMAT,"snapshotDigest":prepared.digest,"createdBy":actor,"acceptedBy":actor,"createdAt":at,"acceptedAt":at}),
        false,
    )?;
    let old_ids: HashSet<i64> = rows(
        tx,
        "SELECT id FROM parts WHERE tenant_id=? AND profile_id=?",
        &[&tenant, &profile],
    )?
    .iter()
    .map(|p| num(p, "id"))
    .collect::<Result<_>>()?;
    tx.execute(
        "DELETE FROM parts WHERE tenant_id=? AND profile_id=?",
        params![tenant, profile],
    )?;
    let mut projection_ids = HashMap::new();
    let mut revision_ids = HashMap::new();
    for p in &prepared.parts {
        let id = num(p, "id")?;
        let mut projected = projection(p);
        projected["tenantId"] = json!(tenant);
        projected["profileId"] = json!(profile);
        let new_id = insert(tx, "parts", &projected, false)?;
        ensure!(!old_ids.contains(&new_id), "Projection identifier reused");
        projection_ids.insert(id, new_id);
        let mut immutable = ru::model::project(p, ru::model::PART_FIELDS);
        immutable["tenantId"] = json!(tenant);
        immutable["revisionId"] = json!(revision);
        immutable["projectionPartId"] = json!(new_id);
        revision_ids.insert(id, insert(tx, "plan_revision_parts", &immutable, false)?);
    }
    write_remap(tx, tenant, production, &remapping, &projection_ids)?;
    for a in &prepared.assignments {
        if let Assignment::Create { .. } = a {
            let (token, name) = allocated.get(&a.slot()).expect("allocated");
            insert(
                tx,
                "required_units",
                &json!({"tenantId":tenant,"profileId":profile,"createdInRevisionId":revision,"createdAt":at,"token":token,"objectName":name}),
                false,
            )?;
        }
    }
    let mut mappings = Vec::new();
    let mut expected_progress = Vec::new();
    for (i, a) in prepared.assignments.iter().enumerate() {
        let (part, index) = a.slot();
        let (token, name) = match a {
            Assignment::Create { .. } => {
                let (t, n) = allocated.get(&a.slot()).expect("allocated");
                (t.as_str(), n.as_str())
            }
            Assignment::Reuse { token, .. } => (
                token.as_str(),
                text(&base.get(token).expect("validated").0, "objectName")?,
            ),
        };
        let revision_part = revision_ids[&part];
        insert(
            tx,
            "plan_revision_required_units",
            &json!({"tenantId":tenant,"revisionId":revision,"revisionPartId":revision_part,"unitIndex":index,"requiredUnitToken":token}),
            false,
        )?;
        mappings.push(json!({"revision_part_id":revision_part,"unit_index":index,"token":token,"object_name":name}));
        let (completed, assembled) = prepared.progress[i];
        expected_progress.push(json!({"partId":projection_ids[&part],"unitIndex":index,"completed":i64::from(completed),"assembled":i64::from(assembled)}));
    }
    let mapping_digest = ru::model::digest(
        &json!({"format":"required-unit-map-v1","revision_id":revision,"expected_unit_count":mappings.len(),"rows":mappings}),
    );
    insert(
        tx,
        "plan_revision_required_unit_sets",
        &json!({"revisionId":revision,"tenantId":tenant,"profileId":profile,"format":"required-unit-map-v1","expectedUnitCount":mappings.len(),"mappingDigest":mapping_digest,"createdAt":at}),
        false,
    )?;
    for p in &expected_progress {
        let mut row = p.clone();
        row["tenantId"] = json!(tenant);
        insert(tx, "print_progress", &row, false)?;
    }
    tx.execute("INSERT INTO plan_accepted_input_sets(tenant_id,profile_id,input_set_id,accepted_at) VALUES(?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET input_set_id=excluded.input_set_id,accepted_at=excluded.accepted_at",params![tenant,profile,input_set,at])?;
    ensure!(tx.execute("UPDATE build_profiles SET accepted_plan_revision_id=?,accepted_plan_version=?,last_recomputed_at=? WHERE tenant_id=? AND id=? AND accepted_plan_revision_id IS NULL AND accepted_plan_version=?",params![revision,version+1,at,tenant,profile,version])?==1,"Accepted pointer publication failed");
    let life = request.expected_lifecycle_version.get() as i64;
    let reconciliation = num(&selected.header, "id")?;
    ensure!(tx.execute("UPDATE plan_drafts SET state='consumed',lifecycle_version=?,consumed_revision_id=?,consumed_at=? WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND lifecycle_version=? AND snapshot_digest=? AND current_required_unit_reconciliation_id=?",params![life+1,revision,at,tenant,profile,draft_id,life,request.expected_snapshot_digest.as_str(),reconciliation])?==1,"Draft consumption failed");
    let receipt_row = json!({"tenantId":tenant,"profileId":profile,"draftId":draft_id,"actorId":actor,"idempotencyKey":key,"requestFormat":model::REQUEST_FORMAT,"requestDigest":request_hash,"expectedSnapshotDigest":request.expected_snapshot_digest,"expectedLifecycleVersion":life,"expectedBaseRevisionId":previous,"expectedBasePlanVersion":version,"reconciliationId":reconciliation,"reconciliationDigest":selected.header["reconciliationDigest"],"revisionId":revision,"planVersion":version+1,"revisionDigest":prepared.digest,"requiredUnitMappingDigest":mapping_digest,"draftLifecycleVersion":life+1,"appliedAt":at});
    insert(tx, "plan_apply_requests", &receipt_row, false)?;
    let stored = one(
        tx,
        "SELECT * FROM plan_apply_requests WHERE tenant_id=? AND profile_id=? AND draft_id=?",
        &[&tenant, &profile, &draft_id],
    )?
    .ok_or_else(|| anyhow!("Missing published receipt"))?;
    let receipt = receipt(tx, tenant, &stored)?;
    let accepted = validate_projection(tx, tenant, profile, revision)?;
    ensure!(
        accepted.len() == prepared.parts.len(),
        "Published Part count mismatch"
    );
    for p in &prepared.parts {
        let id = num(p, "id")?;
        let actual = accepted
            .iter()
            .find(|r| r["id"] == revision_ids[&id])
            .ok_or_else(|| anyhow!("Missing published Part"))?;
        ensure!(
            actual["projectionPartId"] == projection_ids[&id]
                && ru::model::project(actual, ru::model::PART_FIELDS)
                    == ru::model::project(p, ru::model::PART_FIELDS),
            "Published Part mismatch"
        );
    }
    let actual_progress = rows(
        tx,
        "SELECT p.part_id,p.unit_index,p.completed,p.assembled FROM print_progress p JOIN parts r ON r.id=p.part_id AND r.tenant_id=p.tenant_id WHERE r.tenant_id=? AND r.profile_id=? ORDER BY p.part_id,p.unit_index",
        &[&tenant, &profile],
    )?;
    ensure!(
        actual_progress == expected_progress,
        "Published progress mismatch"
    );
    let accepted_input=one(tx,"SELECT input_set_id,accepted_at FROM plan_accepted_input_sets WHERE tenant_id=? AND profile_id=?",&[&tenant,&profile])?.ok_or_else(||anyhow!("Missing accepted input"))?;
    ensure!(
        accepted_input["inputSetId"] == input_set && accepted_input["acceptedAt"] == at,
        "Accepted input mismatch"
    );
    let final_profile=one(tx,"SELECT accepted_plan_revision_id,accepted_plan_version,last_recomputed_at FROM build_profiles WHERE tenant_id=? AND id=?",&[&tenant,&profile])?.ok_or_else(||anyhow!("Missing accepted Build"))?;
    ensure!(
        final_profile["acceptedPlanRevisionId"] == revision
            && final_profile["acceptedPlanVersion"] == version + 1
            && final_profile["lastRecomputedAt"] == at,
        "Accepted Build mismatch"
    );
    Ok(Outcome::Applied { receipt })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enclosing_transaction_owns_complete_publication_and_rollback() {
        let directory = std::env::temp_dir().join(format!(
            "pp-publication-nested-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("print-partner.db"),
            include_bytes!("../tests/fixtures/plan-publication/first.db"),
        )
        .unwrap();
        let (owner, _) = WriterOwner::open(&directory, crate::Limits::default()).unwrap();
        owner.shutdown().unwrap();
        let mut db = Connection::open(directory.join("print-partner.db")).unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        let before: i64 = db
            .query_row("SELECT COUNT(*) FROM plan_revisions", [], |r| r.get(0))
            .unwrap();
        {
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let context = AuthenticatedPublicationContext::resolve(
                &tx,
                Credential::Session(auth::Secret::new("publication-fixture-secret".into())),
                auth::AuthPolicy {
                    registration: auth::RegistrationPolicy::Open,
                    session_tenant: auth::SessionTenantPolicy::AccountTenant,
                    first_user: auth::FirstUserTenant::NewUser,
                },
            )
            .unwrap();
            tx.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES('default','outer-save-fixture','uncommitted')",[]).unwrap();
            let request: ApplyRequest = serde_json::from_str(include_str!(
                "../tests/fixtures/plan-publication/first.json"
            ))
            .unwrap();
            let result = publish_in_transaction(
                &tx,
                &context,
                PositiveId::new(1).unwrap(),
                PositiveId::new(1).unwrap(),
                &request,
                "nested",
                random_tokens().as_mut(),
            )
            .unwrap();
            assert!(matches!(result, Outcome::Applied { .. }));
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM plan_apply_requests", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM plan_revisions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            before
        );
        for table in [
            "plan_apply_requests",
            "required_units",
            "plan_revision_required_units",
            "plan_revision_required_unit_sets",
            "parts",
            "print_progress",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key='outer-save-fixture'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT state FROM plan_drafts WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "open"
        );
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
