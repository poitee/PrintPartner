mod model;
#[cfg(test)]
mod tests;

use crate::{
    manifest_text::DraftPart,
    required_units::{
        self as ru,
        storage::{normalize_parts, num, one, part_rows, rows, text},
    },
};
use anyhow::{Result, anyhow, ensure};
use model::{Assignment, Prepared};
use pp_contracts::publication::UnmappableLink;
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn projection(p: &DraftPart) -> Result<DraftPart> {
    let mut row = p.projected(ru::model::PART_FIELDS);
    let o = row.as_object_mut().ok_or_else(|| anyhow!("Invalid Part"))?;
    o.remove("artifactDigest");
    o.remove("roleInferred");
    o.remove("roleOverride");
    o.remove("partKey");
    o.remove("quantityInferred");
    row["matchKey"] = p["partKey"].clone();
    row["quantityAuto"] = p["quantityInferred"].clone();
    row["role"] = json!(ru::model::role(p));
    Ok(row)
}
fn validate_projection(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    revision: i64,
) -> Result<Vec<DraftPart>> {
    let header = one(
        tx,
        "SELECT * FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
        &[&tenant, &profile, &revision],
    )?
    .ok_or_else(|| anyhow!("Missing accepted revision"))?;
    let mut immutable = part_rows(
        tx,
        "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
        &[&tenant, &revision],
    )?;
    normalize_parts(&mut immutable)?;
    ensure!(
        header["digestFormat"] == model::REVISION_FORMAT
            && model::revision_digest(&immutable)? == header["snapshotDigest"],
        "Accepted revision digest mismatch"
    );
    let mut current = part_rows(
        tx,
        "SELECT * FROM parts WHERE tenant_id=? AND profile_id=? ORDER BY id",
        &[&tenant, &profile],
    )?;
    normalize_parts(&mut current)?;
    ensure!(
        immutable.len() == current.len(),
        "Accepted projection count mismatch"
    );
    for part in &mut immutable {
        let actual = current
            .iter()
            .find(|p| p["id"] == part["projectionPartId"])
            .ok_or_else(|| anyhow!("Missing accepted projection"))?;
        for (key, value) in projection(part)?
            .as_object()
            .ok_or_else(|| anyhow!("Invalid Part"))?
        {
            if !["filamentColorId", "filamentCustomHex", "spoolmanSpoolId"].contains(&key.as_str())
            {
                ensure!(actual[key] == *value, "Accepted projection mismatch {key}");
            }
        }
        ensure!(
            actual.manifest == part.manifest,
            "Accepted manifest projection mismatch"
        );
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
        for field in ["filamentColorId", "filamentCustomHex", "spoolmanSpoolId"] {
            part[field] = actual[field].clone();
        }
    }
    Ok(immutable)
}
struct Production {
    links: Option<Vec<Value>>,
    queue: Option<Vec<Value>>,
    link_count: usize,
    queue_count: usize,
    owners: HashMap<i64, i64>,
}
fn setting(tx: &Transaction<'_>, tenant: &str, key: &str) -> Result<Option<Vec<Value>>> {
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
    match serde_json::from_str(raw)? {
        Value::Array(value) => Ok(Some(value)),
        _ => Err(anyhow!("Invalid production setting")),
    }
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
        for row in v {
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
        for row in v {
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
                .ok_or_else(|| anyhow!("Invalid assignment coordinate"))?;
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
        for row in v {
            if row["profile_id"] == profile {
                resolve(row, &row["units"])?;
                resolve(row, &row["resolved_units"])?;
            }
        }
    }
    if let Some(v) = &production.queue {
        for row in v {
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
            for row in &mut value {
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
                params![serde_json::to_string(&value)?, tenant, key],
            )?;
        }
    }
    Ok(())
}
