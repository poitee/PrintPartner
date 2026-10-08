use crate::manifest_text::{DraftPart, compare_json_bytes, digest_json_bytes};
use crate::required_units::{
    model::{INPUT_FIELDS, PART_FIELDS, role},
    num, text,
};
use anyhow::{Result, anyhow, ensure};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) const REVISION_FORMAT: &str = "plan-revision-parts-v1";
pub(super) const REQUEST_FORMAT: &str = "plan-apply-request-v1";
pub(super) fn snake(s: &str) -> String {
    let mut r = String::new();
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            r.push('_');
            r.push(c.to_ascii_lowercase())
        } else {
            r.push(c)
        }
    }
    r
}
pub(super) fn canonical(row: &Value, fields: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for field in fields {
        result.insert(snake(field), row[*field].clone());
    }
    Value::Object(result)
}
pub(super) fn revision_digest(parts: &[DraftPart]) -> String {
    let mut parts = parts
        .iter()
        .map(|part| part.json_fields(PART_FIELDS, true))
        .collect::<Vec<_>>();
    parts.sort_by(|a, b| compare_json_bytes(a, b));
    let mut bytes = b"{\"format\":\"plan-revision-parts-v1\",\"parts\":[".to_vec();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(part);
    }
    bytes.extend_from_slice(b"]}");
    digest_json_bytes(&bytes)
}
pub(super) fn inputs(rows: &[Value]) -> Vec<Value> {
    let mut rows: Vec<_> = rows.iter().map(|p| canonical(p, INPUT_FIELDS)).collect();
    rows.sort_by_key(|p| p["source_id"].as_i64());
    rows
}
pub(super) fn object_name(filename: &str, token: &str) -> String {
    let base = filename.rsplit('/').next().unwrap_or(filename);
    let base = if base.to_ascii_lowercase().ends_with(".stl") {
        &base[..base.len() - 4]
    } else {
        base
    };
    let mut stem: String = base
        .encode_utf16()
        .map(|c| {
            if c < 128 && ((c as u8).is_ascii_alphanumeric() || b"_ .()+-".contains(&(c as u8))) {
                char::from(c as u8)
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        stem = "part".into()
    }
    stem.truncate(200 - 2 - token.len());
    format!("{stem}__{token}")
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Assignment {
    Create {
        #[serde(rename = "draftPartId")]
        part: i64,
        #[serde(rename = "unitIndex")]
        index: i64,
    },
    Reuse {
        #[serde(rename = "draftPartId")]
        part: i64,
        #[serde(rename = "unitIndex")]
        index: i64,
        token: String,
    },
}
impl Assignment {
    pub fn slot(&self) -> (i64, i64) {
        match self {
            Self::Create { part, index } | Self::Reuse { part, index, .. } => (*part, *index),
        }
    }
}
pub(super) struct Prepared {
    pub parts: Vec<DraftPart>,
    pub assignments: Vec<Assignment>,
    pub progress: Vec<(bool, bool)>,
    pub digest: String,
}
pub(super) fn prepare(
    parts: Vec<DraftPart>,
    assignments: &Value,
    base: &HashMap<String, (Value, bool, bool)>,
) -> Result<Prepared> {
    let assignments: Vec<Assignment> = serde_json::from_value(assignments.clone())?;
    let mut counts = HashMap::new();
    let mut reused = HashSet::new();
    let mut progress = Vec::new();
    let ids: HashSet<_> = parts.iter().map(|p| num(p, "id")).collect::<Result<_>>()?;
    ensure!(ids.len() == parts.len(), "Duplicate draft Part");
    for a in &assignments {
        let (part, index) = a.slot();
        let count = counts.entry(part).or_insert(0);
        ensure!(
            ids.contains(&part) && index == *count,
            "Invalid assignment coordinate"
        );
        *count += 1;
        progress.push(match a {
            Assignment::Create { .. } => (false, false),
            Assignment::Reuse { token, .. } => {
                ensure!(reused.insert(token), "Duplicate reused unit");
                let (_, completed, assembled) = base
                    .get(token)
                    .ok_or_else(|| anyhow!("Unknown reused unit"))?;
                ensure!(!assembled || *completed, "Invalid base progress");
                (*completed, *assembled)
            }
        });
    }
    for p in &parts {
        let quantity = num(p, "quantityEffective")?;
        ensure!(
            (1..=10_000).contains(&quantity)
                && Some(quantity)
                    == p["quantityOverride"]
                        .as_i64()
                        .or(p["quantityInferred"].as_i64())
                && counts.get(&num(p, "id")?) == Some(&quantity),
            "Incomplete publication quantity"
        );
        let _ = text(p, "filename")?;
        let _ = role(p);
        ensure!(
            p.as_object()
                .ok_or_else(|| anyhow!("Invalid Part"))?
                .values()
                .filter_map(Value::as_str)
                .map(str::len)
                .sum::<usize>()
                + p.manifest
                    .requirement
                    .as_ref()
                    .map_or(0, |text| manifest_byte_len(&text.0))
                + p.manifest
                    .option_group_id
                    .as_ref()
                    .map_or(0, |id| manifest_byte_len(&id.0))
                + p.manifest.manifest_source.as_ref().map_or(0, String::len)
                <= 65536,
            "Accepted operational row text limit"
        );
    }
    let digest = revision_digest(&parts);
    Ok(Prepared {
        parts,
        assignments,
        progress,
        digest,
    })
}

fn manifest_byte_len(text: &crate::manifest_text::JsText) -> usize {
    match text.as_scalar() {
        Some(scalar) => scalar.len(),
        None => {
            let mut bytes = Vec::new();
            text.write_json(&mut bytes);
            bytes.len() - 2
        }
    }
}
