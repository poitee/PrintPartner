use crate::manifest_text::{DraftPart, digest_json_bytes};
use crate::required_units::{
    model::{INPUT_FIELDS, PART_FIELDS, role},
    storage::{num, text},
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
pub(super) fn revision_digest(parts: &[DraftPart]) -> Result<String> {
    let mut parts = parts
        .iter()
        .map(|part| {
            let bytes = part.json_fields(PART_FIELDS, true);
            let key = std::str::from_utf8(&bytes)?
                .encode_utf16()
                .collect::<Vec<_>>();
            Ok((key, bytes))
        })
        .collect::<Result<Vec<_>>>()?;
    parts.sort_by(|a, b| a.0.cmp(&b.0));
    let mut bytes = b"{\"format\":\"plan-revision-parts-v1\",\"parts\":[".to_vec();
    for (i, (_, part)) in parts.iter().enumerate() {
        if i > 0 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(part);
    }
    bytes.extend_from_slice(b"]}");
    Ok(digest_json_bytes(&bytes))
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
    let mut assignments: Vec<Assignment> = serde_json::from_value(assignments.clone())?;
    assignments.sort_by_key(Assignment::slot);
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
        validate_part_text(p, 0)?;
    }
    let digest = revision_digest(&parts)?;
    Ok(Prepared {
        parts,
        assignments,
        progress,
        digest,
    })
}

pub(super) fn validate_part_text(part: &DraftPart, extra: usize) -> Result<()> {
    let manifest = &part.manifest;
    validate_named_text(
        part,
        &[
            "partKey",
            "relativePath",
            "filename",
            "sourceLayer",
            "status",
            "roleInferred",
            "roleOverride",
            "filamentColorId",
            "filamentCustomHex",
            "spoolmanSpoolId",
            "notes",
            "githubBlobUrl",
            "artifactDigest",
        ],
        extra
            + manifest
                .requirement
                .as_ref()
                .map_or(0, |text| utf8_len(&text.0))
            + manifest
                .option_group_id
                .as_ref()
                .map_or(0, |id| utf8_len(&id.0))
            + manifest.manifest_source.as_ref().map_or(0, String::len),
    )
}

/// Node's `validateAcceptedOperationalTextRow`: the UTF-8 length of the named
/// text fields plus `extra` bytes of text held outside `row`.
pub(super) fn validate_named_text(row: &Value, fields: &[&str], extra: usize) -> Result<()> {
    let bytes = fields
        .iter()
        .filter_map(|field| row[*field].as_str())
        .map(str::len)
        .sum::<usize>();
    ensure!(
        bytes + extra <= 65536,
        "Accepted operational row text limit"
    );
    Ok(())
}

/// `Buffer.byteLength(text, "utf8")`, which encodes a lone surrogate as U+FFFD.
fn utf8_len(text: &crate::manifest_text::JsText) -> usize {
    String::from_utf16_lossy(text.units()).len()
}
