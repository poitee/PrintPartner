use super::*;
use pp_contracts::working_drafts::{RebaseRequest, SourceState};
use std::collections::{HashMap, HashSet};
fn base_parts(tx: &Transaction<'_>, tenant: &str, profile: i64, id: &Value) -> Result<Vec<Value>> {
    let Some(id) = id.as_i64() else {
        return Ok(Vec::new());
    };
    ensure!(
        one(
            tx,
            "SELECT id FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
            &[&tenant, &profile, &id]
        )?
        .is_some(),
        "Missing rebase accepted ancestor"
    );
    let mut p = rows(
        tx,
        "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
        &[&tenant, &id],
    )?;
    required_units::normalize_parts(&mut p)?;
    Ok(p)
}
fn source_identity(inputs: &[Value], layer: &Value) -> Option<i64> {
    let mut matches = inputs.iter().filter(|i| i["sourceLayer"] == *layer);
    let id = matches.next()?["sourceId"].as_i64()?;
    if matches.next().is_some() {
        None
    } else {
        Some(id)
    }
}
fn tracked(inputs: &[Value], source: i64) -> bool {
    inputs
        .iter()
        .any(|i| i["sourceId"] == source && i["trackingKind"] == "revision")
}
fn evidence(
    parts: &[Value],
    inputs: &[Value],
    source: i64,
    key: &str,
    value: &Value,
) -> Vec<usize> {
    parts
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            source_identity(inputs, &p["sourceLayer"]) == Some(source) && p[key] == *value
        })
        .map(|(i, _)| i)
        .collect()
}
fn sort(conflicts: &mut [Value]) {
    conflicts.sort_by(|a, b| {
        let id = |v: &Value| {
            v["sourcePartId"]
                .as_i64()
                .or_else(|| v["sourcePartIds"][0].as_i64())
                .unwrap_or(0)
        };
        id(a).cmp(&id(b)).then_with(|| {
            crate::read_model::views::folder_compare(
                a["kind"].as_str().unwrap(),
                b["kind"].as_str().unwrap(),
            )
        })
    });
}
fn merge(
    source: &Draft,
    old: &[Value],
    fresh: &mut preparation::PreparedDraftSnapshot,
    current: &[Value],
) -> Result<Vec<Value>> {
    let baseline = |part: &Value| -> Result<Value> {
        if part["baseRevisionPartId"].is_null() {
            Ok(json!({"included":true,"quantityOverride":null}))
        } else {
            old.iter()
                .find(|b| b["id"] == part["baseRevisionPartId"])
                .cloned()
                .ok_or_else(|| anyhow!("Rebase predecessor missing"))
        }
    };
    let mut decisions = Vec::new();
    for (i, p) in source.parts.iter().enumerate() {
        let b = baseline(p)?;
        if p["baseRevisionPartId"].is_null() || p["included"] != b["included"] {
            decisions.push((i, "included", p["included"].clone()));
        }
        if p["quantityOverride"] != b["quantityOverride"] {
            decisions.push((i, "quantityOverride", p["quantityOverride"].clone()));
        }
    }
    let mut ids: Vec<_> = decisions.iter().map(|(i, _, _)| *i).collect();
    ids.sort_by_key(|i| source.parts[*i]["id"].as_i64());
    ids.dedup();
    let mut targets = HashMap::new();
    let mut absent = HashSet::new();
    let mut conflicts = Vec::new();
    for i in ids {
        let p = &source.parts[i];
        let source_part = num(p, "id")?;
        let Some(sid) = source_identity(&source.inputs, &p["sourceLayer"]) else {
            conflicts.push(json!({"kind":"source_identity","sourcePartId":source_part,"sourceLayer":p["sourceLayer"]}));
            continue;
        };
        let mut candidates = Vec::new();
        let mut ambiguous = false;
        let projection = old
            .iter()
            .find(|b| b["id"] == p["baseRevisionPartId"])
            .and_then(|p| p["projectionPartId"].as_i64());
        if let Some(projection) = projection
            && old
                .iter()
                .filter(|p| p["projectionPartId"] == projection)
                .count()
                == 1
            && current
                .iter()
                .filter(|p| p["projectionPartId"] == projection)
                .count()
                == 1
        {
            candidates = fresh
                .parts
                .iter()
                .enumerate()
                .filter(|(_, p)| {
                    current.iter().any(|b| {
                        b["id"] == p["baseRevisionPartId"] && b["projectionPartId"] == projection
                    })
                })
                .map(|(i, _)| i)
                .collect();
        }
        if candidates.is_empty() {
            let count =
                evidence(&source.parts, &source.inputs, sid, "partKey", &p["partKey"]).len();
            let found = evidence(
                &fresh.parts,
                &fresh.capture.inputs,
                sid,
                "partKey",
                &p["partKey"],
            );
            if count == 1 && found.len() == 1 {
                candidates = found
            } else if !found.is_empty() {
                candidates = found;
                ambiguous = true
            }
        }
        if !ambiguous && candidates.is_empty() && !p["artifactDigest"].is_null() {
            let count = evidence(
                &source.parts,
                &source.inputs,
                sid,
                "artifactDigest",
                &p["artifactDigest"],
            )
            .len();
            let found = if tracked(&fresh.capture.inputs, sid) {
                evidence(
                    &fresh.parts,
                    &fresh.capture.inputs,
                    sid,
                    "artifactDigest",
                    &p["artifactDigest"],
                )
            } else {
                Vec::new()
            };
            if tracked(&source.inputs, sid) && count == 1 && found.len() == 1 {
                candidates = found
            } else if !found.is_empty() {
                candidates = found;
                ambiguous = true
            }
        }
        if !ambiguous && candidates.is_empty() {
            absent.insert(i);
            continue;
        }
        if ambiguous || candidates.len() != 1 {
            conflicts.push(json!({"kind":if candidates.is_empty(){"target_missing"}else{"target_ambiguous"},"sourcePartId":source_part,"targetPartIds":candidates.iter().map(|i|i+1).collect::<Vec<_>>()}));
            continue;
        }
        targets.insert(i, candidates[0]);
    }
    let mut claims: Vec<(usize, Vec<i64>)> = Vec::new();
    let mut ordered: Vec<_> = targets.iter().collect();
    ordered.sort_by_key(|(i, _)| source.parts[**i]["id"].as_i64());
    for (i, target) in ordered {
        if let Some((_, v)) = claims.iter_mut().find(|(t, _)| t == target) {
            v.push(num(&source.parts[*i], "id")?)
        } else {
            claims.push((*target, vec![num(&source.parts[*i], "id")?]));
        }
    }
    for (target, ids) in claims {
        if ids.len() > 1 {
            conflicts.push(
                json!({"kind":"target_collision","sourcePartIds":ids,"targetPartId":target+1}),
            );
        }
    }
    if !conflicts.is_empty() {
        sort(&mut conflicts);
        return Ok(conflicts);
    }
    let original = fresh.parts.clone();
    for (i, field, value) in decisions {
        if absent.contains(&i) {
            continue;
        }
        let target = *targets
            .get(&i)
            .ok_or_else(|| anyhow!("Rebase target missing"))?;
        let source_part = &source.parts[i];
        let base = baseline(source_part)?;
        let p = &original[target];
        let collision = p[field] != base[field]
            && p[field] != value
            && (field != "included"
                || !source_part["baseRevisionPartId"].is_null()
                || !p["baseRevisionPartId"].is_null());
        if collision {
            conflicts.push(json!({"kind":"concurrent_decision","sourcePartId":source_part["id"],"targetPartId":target+1,"field":field}));
        } else {
            fresh.parts[target][field] = value.clone();
            if field == "quantityOverride" {
                fresh.parts[target]["quantityEffective"] = if value.is_null() {
                    fresh.parts[target]["quantityInferred"].clone()
                } else {
                    value
                };
            }
        }
    }
    sort(&mut conflicts);
    if conflicts.is_empty() {
        fresh.digest =
            required_units::model::planning(&fresh.base, &fresh.capture.inputs, &fresh.parts);
    }
    Ok(conflicts)
}
fn stored(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    profile: i64,
    key: &str,
    r: &RebaseRequest,
) -> Result<Option<Outcome>> {
    let generation = u64::from(r.expected_source_lifecycle_version)
        + u64::from(matches!(r.expected_source_state, SourceState::Open));
    let winner = one(
        tx,
        "SELECT id FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND created_by=? AND idempotency_key=?",
        &[&tenant, &profile, &actor, &key],
    )?;
    if let Some(w) = winner {
        let d = required_units::draft(tx, tenant, profile, num(&w, "id")?)?
            .ok_or_else(|| anyhow!("Stored rebase missing"))?;
        return Ok(Some(
            if d.header["rebasedFromDraftId"] == r.source_draft_id.get()
                && d.header["rebasedFromLifecycleVersion"] == generation
                && d.header["rebasedFromSnapshotDigest"]
                    == r.expected_source_snapshot_digest.as_str()
            {
                Outcome::Existing {
                    draft: snapshot(&d)?,
                }
            } else {
                Outcome::IdempotencyConflict
            },
        ));
    }
    let successor = one(
        tx,
        "SELECT id FROM plan_drafts WHERE tenant_id=? AND profile_id=? AND rebased_from_draft_id=? AND rebased_from_lifecycle_version=?",
        &[
            &tenant,
            &profile,
            &(r.source_draft_id.get() as i64),
            &(generation as i64),
        ],
    )?;
    if let Some(w) = successor {
        let d = required_units::draft(tx, tenant, profile, num(&w, "id")?)?
            .ok_or_else(|| anyhow!("Successor missing"))?;
        if d.header["rebasedFromSnapshotDigest"] == r.expected_source_snapshot_digest.as_str() {
            return Ok(Some(Outcome::Existing {
                draft: snapshot(&d)?,
            }));
        }
        let source = required_units::draft(tx, tenant, profile, r.source_draft_id.get() as i64)?;
        return Ok(Some(match source {
            Some(d) => Outcome::SourceConflict {
                draft: snapshot(&d)?,
            },
            None => Outcome::NotFound,
        }));
    }
    Ok(None)
}
fn validate_source(d: &Draft, r: &RebaseRequest) -> Result<Option<Outcome>> {
    let state = match r.expected_source_state {
        SourceState::Open => "open",
        SourceState::Abandoned => "abandoned",
    };
    if d.header["state"] != state {
        return Ok(Some(Outcome::NotAbandoned {
            state: text(&d.header, "state")?.into(),
        }));
    }
    if d.header["lifecycleVersion"] != r.expected_source_lifecycle_version
        || d.header["snapshotDigest"] != r.expected_source_snapshot_digest.as_str()
    {
        return Ok(Some(Outcome::SourceConflict {
            draft: snapshot(d)?,
        }));
    }
    Ok(None)
}
fn inputs_equal(a: &[Value], b: &[Value]) -> bool {
    let canonical = |v: &[Value]| {
        let mut out: Vec<_> = v
            .iter()
            .map(|v| required_units::model::project(v, required_units::model::INPUT_FIELDS))
            .collect();
        out.sort_by(required_units::model::js_cmp);
        out
    };
    canonical(a) == canonical(b)
}
pub(super) fn run(
    connection: &mut Connection,
    c: &Command,
    key: &str,
    r: &RebaseRequest,
) -> Result<Outcome> {
    let key = js_trim(key);
    ensure!(!key.is_empty(), "Invalid rebase key");
    ensure!(
        r.expected_source_lifecycle_version <= 2147483647
            && (!matches!(r.expected_source_state, SourceState::Open)
                || r.expected_source_lifecycle_version < 2147483647),
        Failure::InvalidLifecycleVersion
    );
    let profile = c.profile.get() as i64;
    let source_id = r.source_draft_id.get() as i64;
    let mut budget = observation::PreparationBudget::new(&c.cancelled, c.limits);
    let tx = connection.transaction()?;
    let (tenant, actor) = auth::observe_reconciliation_actor(&tx, &c.credential, c.policy)?;
    if let Some(o) = stored(&tx, &tenant, &actor, profile, key, r)? {
        return Ok(o);
    }
    let Some(source) = required_units::draft(&tx, &tenant, profile, source_id)? else {
        return Ok(Outcome::NotFound);
    };
    if let Some(o) = validate_source(&source, r)? {
        return Ok(o);
    }
    let Some(p) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    if baseline_required(&tx, &tenant, &p)? {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    let base = json!({"baseRevisionId":p["acceptedPlanRevisionId"],"basePlanVersion":p["acceptedPlanVersion"]});
    let same_base = base["baseRevisionId"] == source.header["baseRevisionId"]
        && base["basePlanVersion"] == source.header["basePlanVersion"];
    let unchanged = same_base
        && inputs_equal(
            &preparation::capture(&tx, &tenant, profile, c.reads.as_ref(), &mut budget)?.inputs,
            &source.inputs,
        );
    tx.commit()?;
    let mut prepared = if unchanged {
        None
    } else {
        let options = pp_contracts::working_drafts::RecomputeOptions {
            apply_manifest: false,
            ..Default::default()
        };
        let mut p = match preparation::prepare(
            connection,
            &tenant,
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
                    Some(Failure::NoLayers) => Ok(Outcome::NoLayers),
                    Some(Failure::NoStls) => Ok(Outcome::NoStls),
                    _ => Err(e),
                };
            }
        };
        let tx = connection.transaction()?;
        let old = base_parts(&tx, &tenant, profile, &source.header["baseRevisionId"])?;
        let current = base_parts(&tx, &tenant, profile, &base["baseRevisionId"])?;
        tx.commit()?;
        let conflicts = merge(&source, &old, &mut p, &current)?;
        if !conflicts.is_empty() {
            return Ok(Outcome::MergeConflicts { conflicts });
        }
        Some(p)
    };
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let final_actor = auth::reconciliation_actor_ref(&tx, &c.credential, c.policy)?;
    ensure!(
        final_actor == (tenant.clone(), actor.clone()),
        "Authentication principal changed"
    );
    if let Some(o) = stored(&tx, &tenant, &actor, profile, key, r)? {
        tx.commit()?;
        return Ok(o);
    }
    let Some(source) = required_units::draft(&tx, &tenant, profile, source_id)? else {
        return Ok(Outcome::NotFound);
    };
    if let Some(o) = validate_source(&source, r)? {
        return Ok(o);
    }
    let Some(p) = one(
        &tx,
        "SELECT * FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    else {
        return Ok(Outcome::NotFound);
    };
    if baseline_required(&tx, &tenant, &p)? {
        return Ok(Outcome::AcceptedBaselineRequired);
    }
    if p["acceptedPlanRevisionId"] != base["baseRevisionId"]
        || p["acceptedPlanVersion"] != base["basePlanVersion"]
    {
        return Ok(Outcome::AcceptedBaseChanged);
    }
    let current = preparation::capture(&tx, &tenant, profile, c.reads.as_ref(), &mut budget)?;
    let Some(prepared) = prepared.take() else {
        return Ok(if inputs_equal(&current.inputs, &source.inputs) {
            Outcome::BaseUnchanged
        } else {
            Outcome::InputsChanged
        });
    };
    if current.fingerprint != prepared.capture.fingerprint {
        return Ok(Outcome::InputsChanged);
    }
    budget.check()?;
    let generation = u64::from(r.expected_source_lifecycle_version)
        + u64::from(matches!(r.expected_source_state, SourceState::Open));
    if matches!(r.expected_source_state, SourceState::Open) {
        ensure!(tx.execute("UPDATE plan_drafts SET state='abandoned',lifecycle_version=? WHERE tenant_id=? AND profile_id=? AND id=? AND state='open' AND lifecycle_version=? AND snapshot_digest=?",params![generation as i64,tenant,profile,source_id,r.expected_source_lifecycle_version,r.expected_source_snapshot_digest.as_str()])?==1,"Rebase lost source draft");
    }
    let id = insert_prepared(
        &tx,
        &tenant,
        &actor,
        profile,
        key,
        &prepared,
        Some(RebaseOrigin {
            source_id,
            generation: generation as i64,
            digest: r.expected_source_snapshot_digest.as_str(),
        }),
    )?;
    let d = required_units::draft(&tx, &tenant, profile, id)?
        .ok_or_else(|| anyhow!("Rebased draft missing"))?;
    let result = Outcome::Rebased {
        draft: snapshot(&d)?,
    };
    tx.commit()?;
    Ok(result)
}
