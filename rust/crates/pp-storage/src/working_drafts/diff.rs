use super::*;
use required_units::model::{INPUT_FIELDS, PART_FIELDS, js_cmp, project};
use std::collections::HashSet;

pub(super) fn read(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: &Value,
    d: &Draft,
) -> Result<Value> {
    let saved = snapshot(d)?;
    let mut inputs = Vec::new();
    let mut parts = Vec::new();
    if let Some(id) = d.header["baseRevisionId"].as_i64() {
        let revision = one(
            tx,
            "SELECT * FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
            &[&tenant, &num(profile, "id")?, &id],
        )?
        .ok_or_else(|| anyhow!("Plan draft base revision is missing"))?;
        if let Some(input_set) = revision["inputSetId"].as_i64() {
            inputs = rows(
                tx,
                "SELECT * FROM plan_revision_inputs WHERE tenant_id=? AND input_set_id=?",
                &[&tenant, &input_set],
            )?
            .iter()
            .map(|row| {
                let mut row = project(row, INPUT_FIELDS);
                if row["effectiveNamingDigest"].is_null() {
                    row["effectiveNamingDigest"] = json!("");
                }
                row
            })
            .collect();
        }
        parts = rows(
            tx,
            "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=?",
            &[&tenant, &id],
        )?;
        required_units::normalize_parts(&mut parts)?;
        parts = parts
            .iter()
            .map(|row| {
                let mut p = project(row, &["id"]);
                for f in PART_FIELDS {
                    p[*f] = row[*f].clone();
                }
                p
            })
            .collect();
    }
    let after_inputs = saved["inputs"]
        .as_array()
        .ok_or_else(|| anyhow!("Invalid inputs"))?;
    let mut added_inputs: Vec<_> = after_inputs
        .iter()
        .filter(|after| {
            !inputs
                .iter()
                .any(|before| before["sourceId"] == after["sourceId"])
        })
        .cloned()
        .collect();
    let mut removed_inputs: Vec<_> = inputs
        .iter()
        .filter(|before| {
            !after_inputs
                .iter()
                .any(|after| before["sourceId"] == after["sourceId"])
        })
        .cloned()
        .collect();
    let mut changed_inputs = Vec::new();
    for after in after_inputs {
        if let Some(before) = inputs
            .iter()
            .find(|before| before["sourceId"] == after["sourceId"])
            && before != &project(after, INPUT_FIELDS)
        {
            changed_inputs.push(json!({"before":before,"after":after}));
        }
    }
    let input_order = |a: &Value, b: &Value| {
        a["layerOrder"]
            .as_i64()
            .cmp(&b["layerOrder"].as_i64())
            .then(a["sourceId"].as_i64().cmp(&b["sourceId"].as_i64()))
    };
    added_inputs.sort_by(input_order);
    removed_inputs.sort_by(|a, b| input_order(a, b).then_with(|| js_cmp(a, b)));
    changed_inputs.sort_by_key(|row| row["after"]["sourceId"].as_i64());
    let mut linked = HashSet::new();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for after in saved["parts"]
        .as_array()
        .ok_or_else(|| anyhow!("Invalid Parts"))?
    {
        let before = parts.iter().find(|before| {
            !after["baseRevisionPartId"].is_null() && before["id"] == after["baseRevisionPartId"]
        });
        if let Some(before) = before {
            linked.insert(num(before, "id")?);
            let fields: Vec<_> = PART_FIELDS
                .iter()
                .filter(|f| before[**f] != after[**f])
                .copied()
                .collect();
            if !fields.is_empty() {
                changed.push(json!({"before":before,"after":after,"fields":fields}));
            }
        } else {
            added.push(json!({"after":after}));
        }
    }
    let mut removed: Vec<_> = parts
        .into_iter()
        .filter(|before| !linked.contains(&before["id"].as_i64().unwrap_or_default()))
        .map(|before| json!({"before":before}))
        .collect();
    added.sort_by(|a, b| js_cmp(&a["after"], &b["after"]));
    changed.sort_by(|a, b| js_cmp(&a["after"], &b["after"]));
    removed.sort_by(|a, b| js_cmp(&a["before"], &b["before"]));
    Ok(
        json!({"baseRevisionId":d.header["baseRevisionId"],"basePlanVersion":d.header["basePlanVersion"],"baseIsCurrent":profile["acceptedPlanRevisionId"] == d.header["baseRevisionId"] && profile["acceptedPlanVersion"] == d.header["basePlanVersion"],"inputs":{"added":added_inputs,"removed":removed_inputs,"changed":changed_inputs},"parts":{"added":added,"removed":removed,"changed":changed}}),
    )
}
