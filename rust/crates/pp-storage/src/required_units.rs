pub(crate) mod model;
use crate::{Envelope, Shared, WriterOwner, auth, read_model::Credential};
use anyhow::{Result, anyhow, bail, ensure};
use model::{FORMAT, digest, planning, selection};
use pp_contracts::{
    autosave::PositiveId,
    reconciliation::{Outcome, ReconciliationRequest, Workspace},
};
use rusqlite::{Connection, Transaction, TransactionBehavior, params, types::ValueRef};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct ReconciliationClient {
    shared: Arc<Shared>,
    policy: auth::AuthPolicy,
}
pub struct ReconciliationCommand {
    profile_id: PositiveId,
    draft_id: PositiveId,
    request: ReconciliationRequest,
    idempotency_key: String,
    credential: Credential,
}
impl ReconciliationCommand {
    pub fn new(
        profile_id: PositiveId,
        draft_id: PositiveId,
        request: ReconciliationRequest,
        idempotency_key: String,
        credential: Credential,
    ) -> Result<Self> {
        let key = idempotency_key.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')).to_owned();
        ensure!(
            !key.is_empty() && key.encode_utf16().count() <= 160,
            "Invalid idempotency key"
        );
        Ok(Self {
            profile_id,
            draft_id,
            request,
            idempotency_key: key,
            credential,
        })
    }
}
#[derive(Debug)]
pub enum AdmissionFailure {
    Cancelled,
    QueueFull,
    Stopped,
    OutcomeUnknown,
}
impl std::fmt::Display for AdmissionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for AdmissionFailure {}
pub(super) struct Command {
    input: ReconciliationCommand,
    policy: auth::AuthPolicy,
}
impl WriterOwner {
    pub fn required_units(&self) -> ReconciliationClient {
        self.required_units_with_policy(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
            first_user: auth::FirstUserTenant::NewUser,
        })
        .expect("neutral policy")
    }
    pub fn required_units_with_policy(
        &self,
        policy: auth::AuthPolicy,
    ) -> Result<ReconciliationClient> {
        auth::validate_policy(policy)?;
        Ok(ReconciliationClient {
            shared: self.client.shared.clone(),
            policy,
        })
    }
}
impl ReconciliationClient {
    pub fn reconcile(
        &self,
        input: ReconciliationCommand,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<Outcome> {
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
        queue.pending.push_back(Envelope::RequiredUnits {
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
fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}
pub(crate) fn rows(
    tx: &Transaction<'_>,
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>> {
    let mut stmt = tx.prepare(sql)?;
    let columns: Vec<_> = stmt.column_names().iter().map(|n| camel(n)).collect();
    let mut query = stmt.query(args)?;
    let mut out = Vec::new();
    let mut bytes = 0;
    while let Some(row) = query.next()? {
        ensure!(out.len() < 200_000, "Reconciliation row limit exceeded");
        let mut object = serde_json::Map::new();
        for (i, c) in columns.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => {
                    ensure!(
                        n.unsigned_abs() <= 9_007_199_254_740_991,
                        "Invalid stored integer"
                    );
                    json!(n)
                }
                ValueRef::Real(_) | ValueRef::Blob(_) => {
                    bail!("Invalid stored reconciliation value")
                }
                ValueRef::Text(t) => {
                    bytes += t.len();
                    let limit = if matches!(c.as_str(), "selectionBasisJson" | "resultJson") {
                        64 * 1024 * 1024
                    } else {
                        65_536
                    };
                    ensure!(
                        t.len() <= limit && bytes <= 64 * 1024 * 1024,
                        "Reconciliation text limit exceeded"
                    );
                    json!(std::str::from_utf8(t)?)
                }
            };
            object.insert(c.clone(), value);
        }
        out.push(Value::Object(object));
    }
    Ok(out)
}
pub(crate) fn one(
    tx: &Transaction<'_>,
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Option<Value>> {
    Ok(rows(tx, sql, args)?.into_iter().next())
}
pub(crate) fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or_else(|| anyhow!("Invalid stored {k}"))
}
pub(crate) fn num(v: &Value, k: &str) -> Result<i64> {
    v[k].as_i64().ok_or_else(|| anyhow!("Invalid stored {k}"))
}
pub(crate) fn normalize_parts(rows: &mut [Value]) -> Result<()> {
    for p in rows {
        for k in ["included", "geometrySame"] {
            if !p[k].is_null() {
                let n = num(p, k)?;
                ensure!(n == 0 || n == 1, "Invalid stored Part boolean");
                p[k] = json!(n == 1);
            }
        }
    }
    Ok(())
}
pub(crate) struct Draft {
    pub(crate) header: Value,
    pub(crate) inputs: Vec<Value>,
    pub(crate) parts: Vec<Value>,
    pub(crate) planning: String,
    pub(crate) selected: Option<Saved>,
}
pub(crate) struct Saved {
    pub(crate) header: Value,
    pub(crate) result: model::Reconciled,
}
pub(crate) fn selection_basis_digest(mapping: &Value, basis: &Value) -> String {
    digest(&json!({"format":FORMAT,"base_mapping_digest":mapping,"rows":basis}))
}
fn reconciliation_digest(h: &Value) -> String {
    digest(
        &json!({"format":FORMAT,"base_revision_id":h["baseRevisionId"],"base_mapping_digest":h["baseMappingDigest"],"planning_digest":h["planningDigest"],"selection_basis_digest":h["selectionBasisDigest"],"decision_digest":h["decisionDigest"],"result_kind":h["resultKind"],"result_digest":h["resultDigest"]}),
    )
}
fn saved(tx: &Transaction<'_>, tenant: &str, profile: i64, draft: i64, id: i64) -> Result<Saved> {
    let h=one(tx,"SELECT * FROM plan_draft_required_unit_reconciliations WHERE tenant_id=? AND profile_id=? AND draft_id=? AND id=?",&[&tenant,&profile,&draft,&id])?.ok_or_else(||anyhow!("Selected reconciliation missing"))?;
    ensure!(
        h["finalizedAt"].is_string() && h["format"] == FORMAT,
        "Reconciliation not finalized"
    );
    let basis: Value = serde_json::from_str(text(&h, "selectionBasisJson")?)?;
    let result: Value = serde_json::from_str(text(&h, "resultJson")?)?;
    validate_saved_json(&basis, &result)?;
    let canonical_basis = json!(
        basis
            .as_array()
            .ok_or_else(|| anyhow!("Invalid basis"))?
            .iter()
            .map(|r| model::project(
                r,
                &[
                    "revisionPartId",
                    "token",
                    "priorIndex",
                    "createdAt",
                    "completed",
                    "assembled"
                ]
            ))
            .collect::<Vec<_>>()
    );
    let canonical_result = if result["kind"] == "ready" {
        let assignments: Vec<_> = result["assignments"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid assignments"))?
            .iter()
            .map(|a| {
                model::project(
                    a,
                    if a["kind"] == "reuse" {
                        &["kind", "draftPartId", "unitIndex", "token"]
                    } else {
                        &["kind", "draftPartId", "unitIndex"]
                    },
                )
            })
            .collect();
        json!({"kind":"ready", "assignments":assignments, "surplus":result["surplus"]})
    } else {
        let conflicts: Vec<_> = result["conflicts"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid conflicts"))?
            .iter()
            .map(|c| {
                model::project(
                    c,
                    if c["kind"] == "ambiguous_exact_match" {
                        &["kind", "targetDraftPartId", "candidateRevisionPartIds"]
                    } else {
                        &["kind", "targetDraftPartId", "predecessorRevisionPartId"]
                    },
                )
            })
            .collect();
        json!({"kind":"unresolved", "conflicts":conflicts})
    };
    let basis_json = canonical_basis.to_string();
    let result_json = canonical_result.to_string();
    ensure!(
        basis_json == text(&h, "selectionBasisJson")? && result_json == text(&h, "resultJson")?,
        "Noncanonical reconciliation JSON"
    );
    let result = model::Reconciled { result, basis };
    ensure!(
        result.result["kind"] == h["resultKind"]
            && selection_basis_digest(&h["baseMappingDigest"], &result.basis)
                == h["selectionBasisDigest"]
            && digest(&result.full()) == h["resultDigest"],
        "Reconciliation digest mismatch"
    );
    let decisions=rows(tx,"SELECT * FROM plan_draft_required_unit_decisions WHERE tenant_id=? AND reconciliation_id=? ORDER BY target_draft_part_id",&[&tenant,&id])?.into_iter().map(|r|{let mut d=json!({"kind":r["kind"],"targetDraftPartId":r["targetDraftPartId"]});if r["kind"]!="replace" {d["predecessorRevisionPartId"]=r["predecessorRevisionPartId"].clone();}else{ensure!(r["predecessorRevisionPartId"].is_null(),"Invalid replacement");}Ok(d)}).collect::<Result<Vec<_>>>()?;
    ensure!(
        digest(&json!(decisions)) == h["decisionDigest"],
        "Decision digest mismatch"
    );
    let assignments=rows(tx,"SELECT * FROM plan_draft_required_unit_assignments WHERE tenant_id=? AND reconciliation_id=? ORDER BY target_draft_part_id,unit_index",&[&tenant,&id])?.into_iter().map(|r|{let mut a=json!({"kind":r["kind"],"draftPartId":r["targetDraftPartId"],"unitIndex":r["unitIndex"]});if r["kind"]=="reuse"{a["token"]=r["requiredUnitToken"].clone();}else{ensure!(r["kind"]=="create" && r["requiredUnitToken"].is_null(),"Invalid assignment");}Ok(a)}).collect::<Result<Vec<_>>>()?;
    let expected = result.result["assignments"].as_array();
    ensure!(
        expected.map_or(assignments.is_empty(), |a| *a == assignments
            && Some(a.len() as i64) == h["expectedAssignmentCount"].as_i64()),
        "Assignment mismatch"
    );
    ensure!(
        reconciliation_digest(&h) == h["reconciliationDigest"],
        "Reconciliation identity mismatch"
    );
    Ok(Saved { header: h, result })
}
fn validate_saved_json(basis: &Value, result: &Value) -> Result<()> {
    let rows = basis
        .as_array()
        .ok_or_else(|| anyhow!("Invalid selection basis"))?;
    let mut seen = HashSet::new();
    let mut slots = HashSet::new();
    let mut previous = None;
    for r in rows {
        ensure!(
            r.as_object().is_some_and(|o| o.len() == 6),
            "Invalid basis fields"
        );
        let part = num(r, "revisionPartId")?;
        let index = num(r, "priorIndex")?;
        let key = (part, index);
        ensure!(
            part > 0
                && (0..10_000).contains(&index)
                && previous.is_none_or(|p| p < key)
                && slots.insert(key),
            "Invalid basis order"
        );
        previous = Some(key);
        let token = text(r, "token")?;
        model::validate_token(token)?;
        ensure!(
            seen.insert(token) && !text(r, "createdAt")?.is_empty(),
            "Invalid basis identity"
        );
        let completed = r["completed"]
            .as_bool()
            .ok_or_else(|| anyhow!("Invalid progress"))?;
        let assembled = r["assembled"]
            .as_bool()
            .ok_or_else(|| anyhow!("Invalid progress"))?;
        ensure!(!assembled || completed, "Invalid assembled progress");
    }
    if result["kind"] == "ready" {
        ensure!(
            result.as_object().is_some_and(|o| o.len() == 3),
            "Invalid ready fields"
        );
        let assignments = result["assignments"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid assignments"))?;
        let mut prior = None;
        let mut tokens = HashSet::new();
        for a in assignments {
            let key = (num(a, "draftPartId")?, num(a, "unitIndex")?);
            ensure!(
                key.0 > 0 && (0..10_000).contains(&key.1) && prior.is_none_or(|p| p < key),
                "Invalid assignment order"
            );
            prior = Some(key);
            let count = if a["kind"] == "reuse" {
                let t = text(a, "token")?;
                model::validate_token(t)?;
                ensure!(tokens.insert(t), "Duplicate reuse");
                4
            } else {
                ensure!(a["kind"] == "create", "Invalid assignment kind");
                3
            };
            ensure!(
                a.as_object().is_some_and(|o| o.len() == count),
                "Invalid assignment fields"
            );
        }
        let surplus = result["surplus"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid surplus"))?;
        let mut prior = None;
        for t in surplus {
            let t = t.as_str().ok_or_else(|| anyhow!("Invalid surplus token"))?;
            model::validate_token(t)?;
            ensure!(
                tokens.insert(t) && prior.is_none_or(|p| p < t),
                "Invalid surplus order"
            );
            prior = Some(t);
        }
    } else {
        ensure!(
            result["kind"] == "unresolved" && result.as_object().is_some_and(|o| o.len() == 2),
            "Invalid unresolved result"
        );
        let mut previous = 0;
        for c in result["conflicts"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid conflicts"))?
        {
            let id = num(c, "targetDraftPartId")?;
            ensure!(
                id > previous && c.as_object().is_some_and(|o| o.len() == 3),
                "Invalid conflict"
            );
            previous = id;
            if c["kind"] == "ambiguous_exact_match" {
                let mut prior = 0;
                for n in c["candidateRevisionPartIds"]
                    .as_array()
                    .ok_or_else(|| anyhow!("Invalid candidates"))?
                {
                    let n = n.as_i64().ok_or_else(|| anyhow!("Invalid candidate"))?;
                    ensure!(n > prior, "Invalid candidate order");
                    prior = n;
                }
                ensure!(prior > 0, "Empty candidates");
            } else {
                ensure!(
                    (c["kind"] == "unsafe_predecessor" || c["kind"] == "predecessor_claimed")
                        && num(c, "predecessorRevisionPartId")? > 0,
                    "Invalid predecessor conflict"
                );
            }
        }
    }
    Ok(())
}
pub(crate) fn draft(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    id: i64,
) -> Result<Option<Draft>> {
    let Some(header) = one(
        tx,
        "SELECT * FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND id=?",
        &[&tenant, &profile, &id],
    )?
    else {
        return Ok(None);
    };
    let inputs = rows(
        tx,
        "SELECT * FROM plan_draft_inputs WHERE tenant_id=? AND draft_id=? ORDER BY layer_order,source_id",
        &[&tenant, &id],
    )?;
    let mut parts = rows(
        tx,
        "SELECT * FROM plan_draft_parts WHERE tenant_id=? AND draft_id=? ORDER BY id",
        &[&tenant, &id],
    )?;
    normalize_parts(&mut parts)?;
    let planning = planning(&header, &inputs, &parts);
    let selected = header["currentRequiredUnitReconciliationId"]
        .as_i64()
        .map(|rid| saved(tx, tenant, profile, id, rid))
        .transpose()?;
    let expected = match text(&header, "digestFormat")? {
        "plan-draft-v1" => {
            ensure!(selected.is_none(), "v1 draft selected reconciliation");
            planning.clone()
        }
        "plan-draft-v2" => selection(
            &planning,
            selected
                .as_ref()
                .map(|s| text(&s.header, "reconciliationDigest"))
                .transpose()?,
        ),
        _ => bail!("Unsupported draft format"),
    };
    ensure!(
        expected == header["snapshotDigest"],
        "Plan draft snapshot digest mismatch"
    );
    Ok(Some(Draft {
        header,
        inputs,
        parts,
        planning,
        selected,
    }))
}
fn part_view(p: &Value) -> Value {
    json!({"draft_part_id":p["id"],"base_revision_part_id":p["baseRevisionPartId"],"part_key":p["partKey"],"filename":p["filename"],"relative_path":p["relativePath"],"source_layer":p["sourceLayer"],"role":model::role(p),"quantity_inferred":p["quantityInferred"],"quantity_override":p["quantityOverride"],"quantity_effective":p["quantityEffective"],"included":p["included"]})
}
fn reference(p: &Value) -> Value {
    json!({"revision_part_id":p["id"],"filename":p["filename"],"relative_path":p["relativePath"],"source_layer":p["sourceLayer"]})
}
pub(crate) fn workspace(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: &Value,
    d: &Draft,
) -> Result<Box<Workspace>> {
    let h = &d.header;
    let base = h["baseRevisionId"].as_i64();
    let mut previous = if let Some(id) = base {
        ensure!(
            one(
                tx,
                "SELECT id FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
                &[&tenant, &num(h, "profileId")?, &id]
            )?
            .is_some(),
            "Missing draft base revision"
        );
        rows(
            tx,
            "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=?",
            &[&tenant, &id],
        )?
    } else {
        Vec::new()
    };
    normalize_parts(&mut previous)?;
    let mut linked = HashSet::new();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for p in &d.parts {
        if let Some(before) = previous.iter().find(|b| {
            Some(&b["id"]) == p.get("baseRevisionPartId") && !p["baseRevisionPartId"].is_null()
        }) {
            linked.insert(num(before, "id")?);
            let fields: Vec<_> = model::PART_FIELDS
                .iter()
                .filter(|k| before[**k] != p[**k])
                .copied()
                .collect();
            if !fields.is_empty() {
                changed.push((
                    p,
                    json!({"before":reference(before),"after":part_view(p),"fields":fields}),
                ));
            }
        } else {
            added.push(p);
        }
    }
    added.sort_by(|a, b| model::js_cmp(&json!(a["id"]), &json!(b["id"])));
    changed.sort_by(|(a, _), (b, _)| model::js_cmp(&json!(a["id"]), &json!(b["id"])));
    let mut removed: Vec<_> = previous
        .iter()
        .filter(|p| !linked.contains(&p["id"].as_i64().unwrap_or(0)))
        .collect();
    removed.sort_by(|a, b| model::js_cmp(&json!(a["id"]), &json!(b["id"])));
    let rec = if let Some(s) = &d.selected {
        if s.result.result["kind"] == "ready" {
            let a = s.result.result["assignments"].as_array().unwrap();
            json!({"kind":"ready","reused_units":a.iter().filter(|a|a["kind"]=="reuse").count(),"new_units":a.iter().filter(|a|a["kind"]=="create").count(),"surplus_units":s.result.result["surplus"].as_array().unwrap().len()})
        } else {
            let conflicts: Vec<_> = s.result.result["conflicts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let mut v =
                        json!({"kind":c["kind"],"target_draft_part_id":c["targetDraftPartId"]});
                    if c["kind"] == "ambiguous_exact_match" {
                        v["candidate_revision_part_ids"] = c["candidateRevisionPartIds"].clone()
                    } else {
                        v["predecessor_revision_part_id"] = c["predecessorRevisionPartId"].clone()
                    }
                    v
                })
                .collect();
            json!({"kind":"unresolved","conflicts":conflicts})
        }
    } else {
        json!({"kind":"unresolved","conflicts":[]})
    };
    Ok(Box::new(serde_json::from_value(
        json!({"profile_id":h["profileId"],"draft":{"draft_id":h["id"],"state":h["state"],"lifecycle_version":h["lifecycleVersion"],"snapshot_digest":h["snapshotDigest"],"base":{"revision_id":h["baseRevisionId"],"plan_version":h["basePlanVersion"]}},"parts":d.parts.iter().map(part_view).collect::<Vec<_>>(),"diff":{"base_is_current":profile["acceptedPlanRevisionId"]==h["baseRevisionId"] && profile["acceptedPlanVersion"]==h["basePlanVersion"],"added":added.into_iter().map(part_view).collect::<Vec<_>>(),"removed":removed.into_iter().map(reference).collect::<Vec<_>>(),"changed":changed.into_iter().map(|(_,v)|v).collect::<Vec<_>>()},"reconciliation":rec}),
    )?))
}
pub(crate) fn base(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    d: &Draft,
) -> Result<Option<(Value, Vec<model::BasePart>)>> {
    let Some(revision) = d.header["baseRevisionId"].as_i64() else {
        return Ok(Some((Value::Null, Vec::new())));
    };
    let h = one(
        tx,
        "SELECT input_set_id FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
        &[&tenant, &profile, &revision],
    )?
    .ok_or_else(|| anyhow!("Missing base revision"))?;
    let set = one(
        tx,
        "SELECT * FROM plan_revision_required_unit_sets WHERE tenant_id=? AND profile_id=? AND revision_id=?",
        &[&tenant, &profile, &revision],
    )?;
    let created = rows(
        tx,
        "SELECT token FROM required_units WHERE tenant_id=? AND profile_id=? AND created_in_revision_id=?",
        &[&tenant, &profile, &revision],
    )?;
    let Some(set) = set else {
        ensure!(created.is_empty() && one(tx,"SELECT required_unit_token FROM plan_revision_required_units WHERE tenant_id=? AND revision_id=? LIMIT 1",&[&tenant,&revision])?.is_none(),"Required-unit set is partial");
        return Ok(None);
    };
    ensure!(
        set["format"] == "required-unit-map-v1",
        "Invalid Required-unit set format"
    );
    let inputs = if let Some(id) = h["inputSetId"].as_i64() {
        rows(
            tx,
            "SELECT source_id,source_layer FROM plan_revision_inputs WHERE tenant_id=? AND input_set_id=?",
            &[&tenant, &id],
        )?
    } else {
        Vec::new()
    };
    let mut sources = std::collections::HashMap::new();
    for input in inputs {
        let name = text(&input, "sourceLayer")?.to_owned();
        let id = if sources.contains_key(&name) {
            None
        } else {
            input["sourceId"].as_i64()
        };
        sources.insert(name, id);
    }
    let parts = rows(
        tx,
        "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
        &[&tenant, &revision],
    )?;
    let mappings = rows(
        tx,
        "SELECT m.revision_part_id,m.unit_index,u.token,u.object_name,u.created_at,COALESCE(p.completed,0) AS completed,COALESCE(p.assembled,0) AS assembled FROM plan_revision_required_units m JOIN required_units u ON u.token=m.required_unit_token AND u.tenant_id=?1 AND u.profile_id=?2 JOIN plan_revision_parts r ON r.id=m.revision_part_id AND r.revision_id=?3 AND r.tenant_id=?1 LEFT JOIN print_progress p ON p.tenant_id=?1 AND p.part_id=r.projection_part_id AND p.unit_index=m.unit_index WHERE m.tenant_id=?1 AND m.revision_id=?3 ORDER BY m.revision_part_id,m.unit_index",
        &[&tenant, &profile, &revision],
    )?;
    let mut result = Vec::new();
    let mut canonical = Vec::new();
    let mut tokens = HashSet::new();
    let mut count = 0;
    for p in parts {
        let id = num(&p, "id")?;
        let quantity = num(&p, "quantityEffective")?;
        ensure!(
            (1..=10_000).contains(&quantity) && p["projectionPartId"].as_i64().is_some(),
            "Invalid accepted Part quantity or projection"
        );
        count += quantity;
        let mut units = Vec::new();
        for u in mappings.iter().filter(|u| u["revisionPartId"] == id) {
            let index = num(u, "unitIndex")?;
            let token = text(u, "token")?;
            model::validate_token(token)?;
            let name = text(u, "objectName")?;
            ensure!(
                !name.is_empty()
                    && name.len() <= 200
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_ .()+-".contains(&b))
                    && name.ends_with(&format!("__{token}")),
                "Invalid Required-unit object name"
            );
            ensure!(
                index == units.len() as i64 && index < quantity && tokens.insert(token),
                "Invalid Required-unit coordinates"
            );
            let completed = num(u, "completed")?;
            let assembled = num(u, "assembled")?;
            ensure!(
                (0..=1).contains(&completed)
                    && (0..=1).contains(&assembled)
                    && assembled <= completed,
                "Invalid Required-unit progress"
            );
            let created = text(u, "createdAt")?;
            ensure!(!created.is_empty(), "Missing unit creation time");
            canonical.push(
                json!({"revision_part_id":id,"unit_index":index,"token":token,"object_name":name}),
            );
            units.push(model::Unit {
                token: token.into(),
                prior_index: index,
                created_at: created.into(),
                completed: completed == 1,
                assembled: assembled == 1,
            });
        }
        ensure!(
            units.len() as i64 == quantity,
            "Incomplete Required-unit coordinates"
        );
        result.push(model::BasePart {
            id,
            source_id: sources.get(text(&p, "sourceLayer")?).copied().flatten(),
            artifact: p["artifactDigest"].as_str().map(str::to_owned),
            role: model::role(&p).into(),
            units,
        });
    }
    ensure!(
        count == num(&set, "expectedUnitCount")?
            && mappings.len() as i64 == count
            && created
                .iter()
                .all(|u| u["token"].as_str().is_some_and(|t| tokens.contains(t))),
        "Incomplete Required-unit set"
    );
    let mapping = digest(
        &json!({"format":"required-unit-map-v1","revision_id":revision,"expected_unit_count":count,"rows":canonical}),
    );
    ensure!(
        mapping == set["mappingDigest"],
        "Required-unit mapping digest mismatch"
    );
    Ok(Some((json!(mapping), result)))
}
fn select(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    draft_id: i64,
    id: i64,
    expected: &str,
    next: &str,
) -> Result<()> {
    ensure!(tx.execute("UPDATE plan_drafts SET current_required_unit_reconciliation_id=?,digest_format='plan-draft-v2',snapshot_digest=? WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND snapshot_digest=?",params![id,next,tenant,profile,draft_id,expected])?==1,"Reconciliation selection failed");
    Ok(())
}
pub(super) fn execute(connection: &mut Connection, command: Command) -> Result<Outcome> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = transact(&tx, command)?;
    tx.commit()?;
    Ok(result)
}
fn transact(tx: &Transaction<'_>, command: Command) -> Result<Outcome> {
    let c = command.input;
    reconcile_in_transaction(
        tx,
        BorrowedCommand {
            credential: &c.credential,
            policy: command.policy,
            profile_id: c.profile_id,
            draft_id: c.draft_id,
            request: &c.request,
            idempotency_key: &c.idempotency_key,
        },
    )
}
pub(crate) struct BorrowedCommand<'a> {
    pub credential: &'a Credential,
    pub policy: auth::AuthPolicy,
    pub profile_id: PositiveId,
    pub draft_id: PositiveId,
    pub request: &'a ReconciliationRequest,
    pub idempotency_key: &'a str,
}
pub(crate) fn reconcile_in_transaction(
    tx: &Transaction<'_>,
    c: BorrowedCommand<'_>,
) -> Result<Outcome> {
    let (tenant, actor) = auth::reconciliation_actor_ref(tx, c.credential, c.policy)?;
    let profile = c.profile_id.get() as i64;
    let id = c.draft_id.get() as i64;
    let expected = c.request.expected_snapshot_digest().as_str();
    let Some(profile_row) = one(
        tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::ProfileNotFound);
    };
    let decisions = model::decisions(c.request.decisions())?;
    let decision_digest = digest(&json!(decisions));
    let payload = digest(
        &json!({"profile_id":profile,"draft_id":id,"expected_snapshot_digest":expected,"decision_digest":decision_digest}),
    );
    let existing = one(
        tx,
        "SELECT id,payload_digest FROM plan_draft_required_unit_reconciliations WHERE tenant_id=? AND profile_id=? AND draft_id=? AND actor_id=? AND idempotency_key=?",
        &[&tenant, &profile, &id, &actor, &c.idempotency_key],
    )?;
    if let Some(existing) = existing {
        if existing["payloadDigest"] != payload {
            return Ok(Outcome::IdempotencyConflict);
        }
        let Some(d) = draft(tx, &tenant, profile, id)? else {
            return Ok(Outcome::DraftNotFound);
        };
        let rid = num(&existing, "id")?;
        if d.header["currentRequiredUnitReconciliationId"] != rid {
            if d.header["currentRequiredUnitReconciliationId"].is_null()
                && d.header["state"] == "open"
                && d.header["digestFormat"] == "plan-draft-v1"
                && d.header["snapshotDigest"] == expected
            {
                let prior = saved(tx, &tenant, profile, id, rid)?;
                if prior.header["planningDigest"] == d.planning
                    && d.planning == expected
                    && prior.header["baseRevisionId"] == d.header["baseRevisionId"]
                {
                    let next = selection(
                        &d.planning,
                        Some(text(&prior.header, "reconciliationDigest")?),
                    );
                    select(tx, &tenant, profile, id, rid, expected, &next)?;
                    let d = draft(tx, &tenant, profile, id)?
                        .ok_or_else(|| anyhow!("Missing repaired draft"))?;
                    ensure!(
                        d.header["snapshotDigest"] == next
                            && d.header["currentRequiredUnitReconciliationId"] == rid,
                        "Repair mismatch"
                    );
                    return Ok(Outcome::Ready {
                        workspace: workspace(tx, &tenant, &profile_row, &d)?,
                    });
                }
            }
            return Ok(Outcome::DraftChanged { workspace: None });
        }
        return Ok(Outcome::Ready {
            workspace: workspace(tx, &tenant, &profile_row, &d)?,
        });
    }
    let Some(d) = draft(tx, &tenant, profile, id)? else {
        return Ok(Outcome::DraftNotFound);
    };
    if d.header["state"] != "open" {
        return Ok(Outcome::NotOpen {
            workspace: workspace(tx, &tenant, &profile_row, &d)?,
        });
    }
    if d.header["snapshotDigest"] != expected {
        return Ok(Outcome::DraftChanged {
            workspace: Some(workspace(tx, &tenant, &profile_row, &d)?),
        });
    }
    let revision = profile_row["acceptedPlanRevisionId"].as_i64();
    let version = num(&profile_row, "acceptedPlanVersion")?;
    if (revision.is_none()
        && (version != 0
            || one(
                tx,
                "SELECT id FROM parts WHERE tenant_id=? AND profile_id=? LIMIT 1",
                &[&tenant, &profile],
            )?
            .is_some()))
        || (revision.is_some() && version <= 0)
    {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    if profile_row["acceptedPlanRevisionId"] != d.header["baseRevisionId"]
        || profile_row["acceptedPlanVersion"] != d.header["basePlanVersion"]
    {
        return Ok(Outcome::BaseChanged {
            workspace: workspace(tx, &tenant, &profile_row, &d)?,
        });
    }
    let Some((mapping, base)) = base(tx, &tenant, profile, &d)? else {
        return Ok(Outcome::DomainError {
            code: "required_unit_set_unavailable".into(),
        });
    };
    let result = model::reconcile(&d.parts, &d.inputs, &base, c.request.decisions())?;
    let basis_digest = selection_basis_digest(&mapping, &result.basis);
    let result_digest = digest(&result.full());
    let reconciliation_digest = reconciliation_digest(
        &json!({"baseRevisionId":revision,"baseMappingDigest":mapping,"planningDigest":d.planning,"selectionBasisDigest":basis_digest,"decisionDigest":decision_digest,"resultKind":result.result["kind"],"resultDigest":result_digest}),
    );
    let expected_count = d
        .parts
        .iter()
        .map(|p| num(p, "quantityEffective"))
        .collect::<Result<Vec<_>>>()?
        .iter()
        .sum::<i64>();
    let now = auth::catalog_timestamp();
    tx.execute("INSERT INTO plan_draft_required_unit_reconciliations (tenant_id,profile_id,draft_id,format,planning_digest,base_revision_id,base_mapping_digest,selection_basis_digest,selection_basis_json,decision_digest,result_kind,result_digest,result_json,reconciliation_digest,expected_assignment_count,actor_id,idempotency_key,payload_digest,created_at,finalized_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",params![tenant,profile,id,FORMAT,d.planning,revision,mapping.as_str(),basis_digest,result.basis.to_string(),decision_digest,text(&result.result,"kind")?,result_digest,result.result.to_string(),reconciliation_digest,expected_count,actor,c.idempotency_key,payload,now])?;
    let rid = tx.last_insert_rowid();
    for decision in decisions {
        tx.execute("INSERT INTO plan_draft_required_unit_decisions (tenant_id,reconciliation_id,target_draft_part_id,kind,predecessor_revision_part_id) VALUES (?,?,?,?,?)",params![tenant,rid,num(&decision,"targetDraftPartId")?,text(&decision,"kind")?,decision["predecessorRevisionPartId"].as_i64()])?;
    }
    if let Some(assignments) = result.result["assignments"].as_array() {
        for a in assignments {
            tx.execute("INSERT INTO plan_draft_required_unit_assignments (tenant_id,reconciliation_id,target_draft_part_id,unit_index,kind,required_unit_token) VALUES (?,?,?,?,?,?)",params![tenant,rid,num(a,"draftPartId")?,num(a,"unitIndex")?,text(a,"kind")?,a["token"].as_str()])?;
        }
    }
    ensure!(tx.execute("UPDATE plan_draft_required_unit_reconciliations SET finalized_at=? WHERE tenant_id=? AND id=? AND finalized_at IS NULL",params![now,tenant,rid])?==1,"Finalization failed");
    let stored = saved(tx, &tenant, profile, id, rid)?;
    ensure!(
        stored.result.full() == result.full()
            && stored.header["reconciliationDigest"] == reconciliation_digest,
        "Persisted reconciliation mismatch"
    );
    let next = selection(&d.planning, Some(&reconciliation_digest));
    select(tx, &tenant, profile, id, rid, expected, &next)?;
    let selected =
        draft(tx, &tenant, profile, id)?.ok_or_else(|| anyhow!("Missing selected draft"))?;
    ensure!(
        selected.header["snapshotDigest"] == next
            && selected.header["currentRequiredUnitReconciliationId"] == rid,
        "Selection mismatch"
    );
    Ok(Outcome::Ready {
        workspace: workspace(tx, &tenant, &profile_row, &selected)?,
    })
}
