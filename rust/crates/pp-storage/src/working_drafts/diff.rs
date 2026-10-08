use super::*;
use crate::manifest_text::DraftPart;
use crate::required_units::part_rows;
use required_units::model::{INPUT_FIELDS, PART_FIELDS, js_cmp, project};
use std::collections::HashSet;

pub(super) fn read(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: &Value,
    d: &Draft,
) -> Result<DraftDiff> {
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
        parts = part_rows(
            tx,
            "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=?",
            &[&tenant, &id],
        )?;
        required_units::normalize_parts(&mut parts)?;
        parts = parts
            .iter()
            .map(|part| part.projected(&[vec!["id"], PART_FIELDS.to_vec()].concat()))
            .collect();
    }
    let after_inputs = saved.model.ordinary["inputs"]
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
    for after in &saved.model.parts {
        let before = parts.iter().find(|before| {
            !after["baseRevisionPartId"].is_null() && before["id"] == after["baseRevisionPartId"]
        });
        if let Some(before) = before {
            linked.insert(num(before, "id")?);
            let fields: Vec<_> = PART_FIELDS
                .iter()
                .filter(|f| !before.same_field(after, f))
                .copied()
                .collect();
            if !fields.is_empty() {
                changed.push(ChangedPart {
                    before: before.clone(),
                    after: after.clone(),
                    fields,
                });
            }
        } else {
            added.push(after.clone());
        }
    }
    let mut removed: Vec<_> = parts
        .into_iter()
        .filter(|before| !linked.contains(&before["id"].as_i64().unwrap_or_default()))
        .collect();
    added.sort_by(|a, b| {
        crate::manifest_text::compare_json_bytes(
            &a.json_fields(&snapshot_part_fields(), false),
            &b.json_fields(&snapshot_part_fields(), false),
        )
    });
    changed.sort_by(|a, b| {
        crate::manifest_text::compare_json_bytes(
            &a.after.json_fields(&snapshot_part_fields(), false),
            &b.after.json_fields(&snapshot_part_fields(), false),
        )
    });
    removed
        .sort_by(|a, b| crate::manifest_text::compare_json_bytes(&before_json(a), &before_json(b)));
    let ordinary = json!({"baseRevisionId":d.header["baseRevisionId"],"basePlanVersion":d.header["basePlanVersion"],"baseIsCurrent":profile["acceptedPlanRevisionId"] == d.header["baseRevisionId"] && profile["acceptedPlanVersion"] == d.header["basePlanVersion"],"inputs":{"added":added_inputs,"removed":removed_inputs,"changed":changed_inputs}});
    Ok(DraftDiff(DraftDiffModel {
        ordinary,
        added,
        removed,
        changed,
    }))
}

#[derive(Debug)]
struct ChangedPart {
    before: DraftPart,
    after: DraftPart,
    fields: Vec<&'static str>,
}
#[derive(Debug)]
pub(super) struct DraftDiffModel {
    ordinary: Value,
    added: Vec<DraftPart>,
    removed: Vec<DraftPart>,
    changed: Vec<ChangedPart>,
}
fn before_json(part: &DraftPart) -> Vec<u8> {
    part.json_fields(&[vec!["id"], PART_FIELDS.to_vec()].concat(), false)
}
fn array<T>(values: &[T], output: &mut Vec<u8>, write: impl Fn(&T, &mut Vec<u8>)) {
    output.push(b'[');
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            output.push(b',');
        }
        write(value, output);
    }
    output.push(b']');
}
impl DraftDiffModel {
    pub(super) fn write_json(&self) -> Vec<u8> {
        let object = self.ordinary.as_object().expect("scalar diff fields");
        let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        keys.push("parts");
        let mut output = vec![b'{'];
        for (i, key) in keys.iter().enumerate() {
            if i > 0 {
                output.push(b',');
            }
            crate::manifest_text::JsText::scalar(key).write_json(&mut output);
            output.push(b':');
            if *key != "parts" {
                output.extend_from_slice(
                    &serde_json::to_vec(&object[*key]).expect("scalar diff field"),
                );
                continue;
            }
            output.extend_from_slice(b"{\"added\":");
            array(&self.added, &mut output, |part, output| {
                output.extend_from_slice(b"{\"after\":");
                output.extend_from_slice(&part.json_fields(&snapshot_part_fields(), false));
                output.push(b'}');
            });
            output.extend_from_slice(b",\"removed\":");
            array(&self.removed, &mut output, |part, output| {
                output.extend_from_slice(b"{\"before\":");
                output.extend_from_slice(&before_json(part));
                output.push(b'}');
            });
            output.extend_from_slice(b",\"changed\":");
            array(&self.changed, &mut output, |part, output| {
                output.extend_from_slice(b"{\"before\":");
                output.extend_from_slice(&before_json(&part.before));
                output.extend_from_slice(b",\"after\":");
                output.extend_from_slice(&part.after.json_fields(&snapshot_part_fields(), false));
                output.extend_from_slice(b",\"fields\":");
                output.extend_from_slice(
                    &serde_json::to_vec(&part.fields).expect("static field names"),
                );
                output.push(b'}');
            });
            output.push(b'}');
        }
        output.push(b'}');
        output
    }
}
