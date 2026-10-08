use crate::manifest_text::{DraftPart, compare_json_bytes, digest_json_bytes};
use anyhow::{Result, bail, ensure};
use pp_contracts::reconciliation::Decision;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(super) const FORMAT: &str = "required-unit-reconciliation-v1";
pub(crate) const PART_FIELDS: &[&str] = &[
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
    "quantityInferred",
    "quantityOverride",
    "quantityEffective",
    "included",
    "notes",
    "githubBlobUrl",
    "geometrySame",
    "requirement",
    "optionGroupId",
    "manifestSource",
    "artifactDigest",
];
pub(crate) const INPUT_FIELDS: &[&str] = &[
    "sourceId",
    "sourceLayer",
    "layerOrder",
    "trackingKind",
    "sourceRevisionId",
    "manifestDigest",
    "effectiveNamingDigest",
];
pub(crate) fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}
pub(crate) fn js_cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    a.to_string()
        .encode_utf16()
        .cmp(b.to_string().encode_utf16())
}
pub(crate) fn project(row: &Value, fields: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for field in fields {
        out.insert((*field).into(), row[*field].clone());
    }
    Value::Object(out)
}
pub(crate) fn planning(draft: &Value, inputs: &[Value], parts: &[DraftPart]) -> String {
    let mut inputs: Vec<_> = inputs.iter().map(|r| project(r, INPUT_FIELDS)).collect();
    inputs.sort_by(|a, b| {
        a["layerOrder"]
            .as_i64()
            .cmp(&b["layerOrder"].as_i64())
            .then(a["sourceId"].as_i64().cmp(&b["sourceId"].as_i64()))
            .then_with(|| js_cmp(a, b))
    });
    let fields = [vec!["baseRevisionPartId"], PART_FIELDS.to_vec()].concat();
    let mut parts = parts
        .iter()
        .map(|p| p.json_fields(&fields, false))
        .collect::<Vec<_>>();
    parts.sort_by(|a, b| compare_json_bytes(a, b));
    let mut bytes = b"{\"format\":\"plan-draft-v1\",\"base_revision_id\":".to_vec();
    bytes.extend_from_slice(&serde_json::to_vec(&draft["baseRevisionId"]).expect("base revision"));
    bytes.extend_from_slice(b",\"base_plan_version\":");
    bytes.extend_from_slice(&serde_json::to_vec(&draft["basePlanVersion"]).expect("plan version"));
    bytes.extend_from_slice(b",\"inputs\":");
    bytes.extend_from_slice(&serde_json::to_vec(&inputs).expect("scalar inputs"));
    bytes.extend_from_slice(b",\"parts\":[");
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(p);
    }
    bytes.extend_from_slice(b"]}");
    digest_json_bytes(&bytes)
}
pub(crate) fn selection(planning: &str, reconciliation: Option<&str>) -> String {
    digest(
        &json!({"format":"plan-draft-v2","planning_digest":planning,"required_unit_reconciliation":reconciliation.map(|d| json!({"format":FORMAT,"digest":d}))}),
    )
}
pub(super) fn decisions(input: &[Decision]) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    let mut predecessors = HashSet::new();
    for d in input {
        let target = d.target().get();
        result.push(match d {
        Decision::Replace {..} => json!({"kind":"replace","targetDraftPartId":target}),
        Decision::SelectExactPredecessor {predecessor_revision_part_id,..} | Decision::AcceptPriorCompletion {predecessor_revision_part_id,..} => {
            ensure!(predecessors.insert(predecessor_revision_part_id.get()),"Required-unit reconciliation predecessor is already selected");
            json!({"kind":if matches!(d,Decision::SelectExactPredecessor {..}) {"select_exact_predecessor"} else {"accept_prior_completion"},"targetDraftPartId":target,"predecessorRevisionPartId":predecessor_revision_part_id.get()})
        }
    });
    }
    result.sort_by_key(|d| d["targetDraftPartId"].as_i64());
    Ok(result)
}
#[derive(Clone)]
pub(crate) struct Unit {
    pub token: String,
    pub prior_index: i64,
    pub created_at: String,
    pub completed: bool,
    pub assembled: bool,
}
pub(crate) struct BasePart {
    pub id: i64,
    pub source_id: Option<i64>,
    pub artifact: Option<String>,
    pub role: String,
    pub units: Vec<Unit>,
}
pub(crate) struct Reconciled {
    pub result: Value,
    pub basis: Value,
}
impl Reconciled {
    pub fn full(&self) -> Value {
        let mut result = self.result.clone();
        result["selectionBasis"] = self.basis.clone();
        result
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    id: i64,
    base_revision_part_id: Option<i64>,
    source_layer: String,
    artifact_digest: Option<String>,
    role_inferred: String,
    role_override: Option<String>,
    quantity_effective: i64,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    source_layer: String,
    source_id: i64,
}
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Assignment {
    Reuse {
        #[serde(rename = "draftPartId")]
        draft_part_id: i64,
        #[serde(rename = "unitIndex")]
        unit_index: usize,
        token: String,
    },
    Create {
        #[serde(rename = "draftPartId")]
        draft_part_id: i64,
        #[serde(rename = "unitIndex")]
        unit_index: usize,
    },
}
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Conflict {
    UnsafePredecessor {
        #[serde(rename = "targetDraftPartId")]
        target_draft_part_id: i64,
        #[serde(rename = "predecessorRevisionPartId")]
        predecessor_revision_part_id: i64,
    },
    AmbiguousExactMatch {
        #[serde(rename = "targetDraftPartId")]
        target_draft_part_id: i64,
        #[serde(rename = "candidateRevisionPartIds")]
        candidate_revision_part_ids: Vec<i64>,
    },
    PredecessorClaimed {
        #[serde(rename = "targetDraftPartId")]
        target_draft_part_id: i64,
        #[serde(rename = "predecessorRevisionPartId")]
        predecessor_revision_part_id: i64,
    },
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BasisRow {
    revision_part_id: i64,
    token: String,
    prior_index: i64,
    created_at: String,
    completed: bool,
    assembled: bool,
}
enum Selection {
    Normal(usize),
    PriorCompletion(usize),
    Create,
}
fn exact(target: &Target, source: Option<i64>, base: &BasePart) -> bool {
    source.is_some()
        && source == base.source_id
        && target.artifact_digest.is_some()
        && target.artifact_digest == base.artifact
        && target
            .role_override
            .as_ref()
            .unwrap_or(&target.role_inferred)
            == &base.role
}
pub(crate) fn role(part: &Value) -> &str {
    part["roleOverride"]
        .as_str()
        .or_else(|| part["roleInferred"].as_str())
        .unwrap_or("")
}
fn basis(part: &BasePart) -> Vec<BasisRow> {
    part.units
        .iter()
        .map(|u| BasisRow {
            revision_part_id: part.id,
            token: u.token.clone(),
            prior_index: u.prior_index,
            created_at: u.created_at.clone(),
            completed: u.completed,
            assembled: u.assembled,
        })
        .collect()
}
pub(super) fn reconcile(
    parts: &[DraftPart],
    inputs: &[Value],
    base: &[BasePart],
    decisions: &[Decision],
) -> Result<Reconciled> {
    let mut targets = parts
        .iter()
        .map(|part| part.scalar.clone())
        .map(serde_json::from_value::<Target>)
        .collect::<serde_json::Result<Vec<_>>>()?;
    targets.sort_by_key(|p| p.id);
    let inputs = inputs
        .iter()
        .cloned()
        .map(serde_json::from_value::<Input>)
        .collect::<serde_json::Result<Vec<_>>>()?;
    let mut sources = HashMap::new();
    for i in inputs {
        let id = if sources.contains_key(&i.source_layer) {
            None
        } else {
            Some(i.source_id)
        };
        sources.insert(i.source_layer, id);
    }
    let mut ids = HashSet::new();
    let mut tokens = HashSet::new();
    for p in base {
        ensure!(p.id > 0 && ids.insert(p.id), "Invalid predecessor ID");
        for (i, u) in p.units.iter().enumerate() {
            ensure!(
                u.prior_index == i as i64
                    && tokens.insert(&u.token)
                    && !(u.assembled && !u.completed),
                "Invalid predecessor mapping"
            );
            validate_token(&u.token)?;
        }
    }
    ids.clear();
    for p in &targets {
        ensure!(
            p.id > 0 && ids.insert(p.id) && (1..=10_000).contains(&p.quantity_effective),
            "Invalid target Part"
        );
    }
    for d in decisions {
        ensure!(
            ids.contains(&(d.target().get() as i64)),
            "Required-unit reconciliation decision target is missing"
        );
    }
    let candidates: Vec<Vec<usize>> = targets
        .iter()
        .map(|p| {
            base.iter()
                .enumerate()
                .filter_map(|(i, b)| {
                    exact(p, sources.get(&p.source_layer).copied().flatten(), b).then_some(i)
                })
                .collect()
        })
        .collect();
    let mut counts = HashMap::new();
    for candidates in &candidates {
        for i in candidates {
            *counts.entry(*i).or_insert(0) += 1;
        }
    }
    let mut claims = HashSet::new();
    let mut choices = Vec::new();
    let mut conflicts = Vec::new();
    for (target, candidates) in targets.iter().zip(&candidates) {
        let decision = decisions
            .iter()
            .find(|d| d.target().get() as i64 == target.id);
        let known = base
            .iter()
            .position(|b| Some(b.id) == target.base_revision_part_id);
        let mode = if let Some(known) = known {
            if candidates.contains(&known) {
                ensure!(
                    decision.is_none(),
                    "Required-unit reconciliation decision is not applicable"
                );
                Selection::Normal(known)
            } else {
                match decision {
                    None => {
                        conflicts.push(Conflict::UnsafePredecessor {
                            target_draft_part_id: target.id,
                            predecessor_revision_part_id: base[known].id,
                        });
                        continue;
                    }
                    Some(Decision::AcceptPriorCompletion {
                        predecessor_revision_part_id,
                        ..
                    }) => {
                        ensure!(
                            predecessor_revision_part_id.get() as i64 == base[known].id,
                            "Accepted prior completion predecessor is not the known predecessor"
                        );
                        Selection::PriorCompletion(known)
                    }
                    Some(Decision::Replace { .. }) => Selection::Create,
                    _ => bail!(
                        "Exact predecessor selection is not applicable to an unsafe predecessor"
                    ),
                }
            }
        } else if candidates.len() == 1 && counts[&candidates[0]] == 1 {
            ensure!(
                decision.is_none(),
                "Required-unit reconciliation decision is not applicable"
            );
            Selection::Normal(candidates[0])
        } else if !candidates.is_empty() {
            match decision {
                None => {
                    let mut ids: Vec<_> = candidates.iter().map(|i| base[*i].id).collect();
                    ids.sort();
                    conflicts.push(Conflict::AmbiguousExactMatch {
                        target_draft_part_id: target.id,
                        candidate_revision_part_ids: ids,
                    });
                    continue;
                }
                Some(Decision::SelectExactPredecessor {
                    predecessor_revision_part_id,
                    ..
                }) => {
                    let selected = candidates
                        .iter()
                        .find(|i| base[**i].id == predecessor_revision_part_id.get() as i64)
                        .ok_or_else(|| {
                            anyhow::anyhow!("Selected predecessor is not an exact-match candidate")
                        })?;
                    Selection::Normal(*selected)
                }
                Some(Decision::Replace { .. }) => Selection::Create,
                _ => bail!("Prior completion requires a known unsafe predecessor"),
            }
        } else {
            ensure!(
                decision.is_none(),
                "Required-unit reconciliation decision is not applicable"
            );
            Selection::Create
        };
        if let Selection::Normal(i) | Selection::PriorCompletion(i) = mode
            && !claims.insert(i)
        {
            conflicts.push(Conflict::PredecessorClaimed {
                target_draft_part_id: target.id,
                predecessor_revision_part_id: base[i].id,
            });
            continue;
        }
        choices.push((target, mode));
    }
    if !conflicts.is_empty() {
        return Ok(Reconciled {
            result: json!({"kind":"unresolved","conflicts":conflicts}),
            basis: json!([]),
        });
    }
    let mut assignments = Vec::new();
    let mut rows = Vec::new();
    let mut selected = HashSet::new();
    for (target, mode) in choices {
        let count = target.quantity_effective as usize;
        let mut units = match mode {
            Selection::Create => Vec::new(),
            Selection::Normal(i) | Selection::PriorCompletion(i) => {
                let prior_completion = matches!(mode, Selection::PriorCompletion(_));
                let predecessor = &base[i];
                let mut units: Vec<_> = predecessor
                    .units
                    .iter()
                    .filter(|u| !prior_completion || u.completed)
                    .collect();
                if prior_completion || count < predecessor.units.len() {
                    rows.extend(basis(predecessor));
                    units.sort_by(|a, b| {
                        b.completed
                            .cmp(&a.completed)
                            .then_with(|| {
                                crate::read_model::views::folder_compare(
                                    &a.created_at,
                                    &b.created_at,
                                )
                            })
                            .then_with(|| {
                                crate::read_model::views::folder_compare(&a.token, &b.token)
                            })
                    });
                    units.truncate(count);
                }
                units.sort_by_key(|u| u.prior_index);
                units
            }
        };
        let reused = units.len();
        for (unit_index, u) in units.drain(..).enumerate() {
            selected.insert(u.token.clone());
            assignments.push(Assignment::Reuse {
                draft_part_id: target.id,
                unit_index,
                token: u.token.clone(),
            });
        }
        for unit_index in reused..count {
            assignments.push(Assignment::Create {
                draft_part_id: target.id,
                unit_index,
            });
        }
    }
    let mut surplus: Vec<_> = base
        .iter()
        .flat_map(|b| b.units.iter())
        .filter(|u| !selected.contains(&u.token))
        .map(|u| u.token.clone())
        .collect();
    surplus.sort();
    rows.sort_by_key(|r| (r.revision_part_id, r.prior_index));
    Ok(Reconciled {
        result: json!({"kind":"ready","assignments":assignments,"surplus":surplus}),
        basis: json!(rows),
    })
}
pub(crate) fn validate_token(t: &str) -> Result<()> {
    ensure!(
        t.len() == 36
            && t.starts_with("ppu_")
            && t.bytes()
                .skip(4)
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid Required-unit token"
    );
    Ok(())
}
