use super::{BasisRow, StoredAssignment, StoredConflict, StoredResult, UNIT_LIMIT};
use super::{PositiveId, model};
use anyhow::{Result, anyhow, bail, ensure};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

fn parsed(input: &str, label: &str) -> Result<Value> {
    serde_json::from_str(input).map_err(|_| anyhow!("{label} is invalid"))
}

fn record<'a>(value: &'a Value, label: &str) -> Result<&'a Value> {
    ensure!(value.is_object(), "{label} is invalid");
    Ok(value)
}

fn keys(value: &Value, expected: &[&str], label: &str) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("{label} is invalid"))?;
    ensure!(
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key)),
        "{label} is invalid"
    );
    Ok(())
}

fn array<'a>(value: &'a Value, label: &str) -> Result<&'a [Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| anyhow!("{label} is invalid"))
}

fn id(value: &Value, label: &str) -> Result<PositiveId> {
    let number = value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= pp_domain::MAX_SAFE_INTEGER as f64)
        .ok_or_else(|| anyhow!("{label} is invalid"))?;
    PositiveId::new(number as u64).map_err(|_| anyhow!("{label} is invalid"))
}

fn index(value: &Value, label: &str) -> Result<u16> {
    let number = value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < f64::from(UNIT_LIMIT))
        .ok_or_else(|| anyhow!("{label} is invalid"))?;
    Ok(number as u16)
}

fn canonical(value: &impl Serialize, input: &str, label: &str) -> Result<()> {
    ensure!(
        serde_json::to_string(value)? == input,
        "{label} is not canonical"
    );
    Ok(())
}

pub(super) fn basis(input: &str) -> Result<Vec<BasisRow>> {
    let parsed = parsed(input, "Required-unit selection basis")?;
    let mut slots = HashSet::new();
    let mut tokens = HashSet::new();
    let mut rows = array(&parsed, "Required-unit selection basis")?
        .iter()
        .map(|value| {
            let row = record(value, "Required-unit selection basis row")?;
            keys(
                row,
                &[
                    "revisionPartId",
                    "token",
                    "priorIndex",
                    "createdAt",
                    "completed",
                    "assembled",
                ],
                "Required-unit selection basis row",
            )?;
            let revision_part_id = id(&row["revisionPartId"], "Required-unit basis Part ID")?;
            let prior_index = index(&row["priorIndex"], "Required-unit basis index")?;
            Ok((row, revision_part_id, prior_index))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .map(|(row, revision_part_id, prior_index)| {
            let token = row["token"].as_str().unwrap_or_default();
            model::validate_token(token)?;
            let created_at = row["createdAt"].as_str().unwrap_or_default();
            ensure!(
                !created_at.is_empty(),
                "Required-unit basis creation time is invalid"
            );
            let (Some(completed), Some(assembled)) =
                (row["completed"].as_bool(), row["assembled"].as_bool())
            else {
                bail!("Required-unit basis progress is invalid");
            };
            ensure!(
                completed || !assembled,
                "Required-unit basis progress is corrupt"
            );
            ensure!(
                slots.insert((revision_part_id.get(), prior_index)) && tokens.insert(token),
                "Required-unit basis row is duplicated"
            );
            Ok(BasisRow {
                revision_part_id,
                token: token.to_owned(),
                prior_index,
                created_at: created_at.to_owned(),
                completed,
                assembled,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by_key(|row| (row.revision_part_id.get(), row.prior_index));
    canonical(&rows, input, "Required-unit selection basis")?;
    Ok(rows)
}

fn assignment(value: &Value) -> Result<StoredAssignment> {
    let row = record(value, "Required-unit assignment")?;
    if row["kind"] == "create" {
        keys(
            row,
            &["kind", "draftPartId", "unitIndex"],
            "Required-unit assignment",
        )?;
        return Ok(StoredAssignment::Create {
            draft_part_id: id(&row["draftPartId"], "Required-unit assignment Part ID")?,
            unit_index: index(&row["unitIndex"], "Required-unit assignment index")?,
        });
    }
    ensure!(
        row["kind"] == "reuse",
        "Required-unit assignment kind is invalid"
    );
    keys(
        row,
        &["kind", "draftPartId", "unitIndex", "token"],
        "Required-unit assignment",
    )?;
    let token = row["token"]
        .as_str()
        .ok_or_else(|| anyhow!("Required-unit token is invalid"))?;
    Ok(StoredAssignment::Reuse {
        draft_part_id: id(&row["draftPartId"], "Required-unit assignment Part ID")?,
        unit_index: index(&row["unitIndex"], "Required-unit assignment index")?,
        token: token.to_owned(),
    })
}

fn slot(assignment: &StoredAssignment) -> (u64, u16) {
    match assignment {
        StoredAssignment::Create {
            draft_part_id,
            unit_index,
        }
        | StoredAssignment::Reuse {
            draft_part_id,
            unit_index,
            ..
        } => (draft_part_id.get(), *unit_index),
    }
}

fn ready(parsed: &Value) -> Result<StoredResult> {
    keys(
        parsed,
        &["kind", "assignments", "surplus"],
        "Required-unit reconciliation result",
    )?;
    let (Some(assignments), Some(surplus)) = (
        parsed["assignments"].as_array(),
        parsed["surplus"].as_array(),
    ) else {
        bail!("Required-unit reconciliation ready result is invalid");
    };
    let mut assignments = assignments
        .iter()
        .map(assignment)
        .collect::<Result<Vec<_>>>()?;
    let surplus = surplus
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| anyhow!("Required-unit reconciliation surplus is invalid"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut slots = HashSet::new();
    let mut tokens = HashSet::new();
    for assignment in &assignments {
        ensure!(
            slots.insert(slot(assignment)),
            "Required-unit assignment slot is duplicated"
        );
        if let StoredAssignment::Reuse { token, .. } = assignment {
            model::validate_token(token)?;
            ensure!(
                tokens.insert(token.as_str()),
                "Required-unit assignment token is duplicated"
            );
        }
    }
    for token in &surplus {
        model::validate_token(token)?;
    }
    for token in &surplus {
        ensure!(
            tokens.insert(token),
            "Required-unit reconciliation surplus is duplicated"
        );
    }
    let mut surplus = surplus.into_iter().map(str::to_owned).collect::<Vec<_>>();
    surplus.sort();
    assignments.sort_by_key(slot);
    Ok(StoredResult::Ready {
        assignments,
        surplus,
    })
}

fn conflict(value: &Value) -> Result<StoredConflict> {
    let row = record(value, "Required-unit reconciliation conflict")?;
    if row["kind"] == "ambiguous_exact_match" {
        keys(
            row,
            &["kind", "targetDraftPartId", "candidateRevisionPartIds"],
            "Required-unit reconciliation conflict",
        )?;
        let candidates = row["candidateRevisionPartIds"]
            .as_array()
            .ok_or_else(|| anyhow!("Required-unit reconciliation candidates are invalid"))?;
        return Ok(StoredConflict::AmbiguousExactMatch {
            target_draft_part_id: id(&row["targetDraftPartId"], "Required-unit conflict target")?,
            candidate_revision_part_ids: candidates
                .iter()
                .map(|value| id(value, "Required-unit conflict candidate"))
                .collect::<Result<_>>()?,
        });
    }
    ensure!(
        row["kind"] == "unsafe_predecessor" || row["kind"] == "predecessor_claimed",
        "Required-unit reconciliation conflict kind is invalid"
    );
    keys(
        row,
        &["kind", "targetDraftPartId", "predecessorRevisionPartId"],
        "Required-unit reconciliation conflict",
    )?;
    let target_draft_part_id = id(&row["targetDraftPartId"], "Required-unit conflict target")?;
    let predecessor_revision_part_id = id(
        &row["predecessorRevisionPartId"],
        "Required-unit conflict predecessor",
    )?;
    Ok(if row["kind"] == "unsafe_predecessor" {
        StoredConflict::UnsafePredecessor {
            target_draft_part_id,
            predecessor_revision_part_id,
        }
    } else {
        StoredConflict::PredecessorClaimed {
            target_draft_part_id,
            predecessor_revision_part_id,
        }
    })
}

fn unresolved(parsed: &Value) -> Result<StoredResult> {
    keys(
        parsed,
        &["kind", "conflicts"],
        "Required-unit reconciliation result",
    )?;
    let mut conflicts = parsed["conflicts"]
        .as_array()
        .ok_or_else(|| anyhow!("Required-unit reconciliation conflicts are invalid"))?
        .iter()
        .map(conflict)
        .collect::<Result<Vec<_>>>()?;
    let mut targets = HashSet::new();
    for conflict in &mut conflicts {
        ensure!(
            targets.insert(conflict.target()),
            "Required-unit conflict target is duplicated"
        );
        if let StoredConflict::AmbiguousExactMatch {
            candidate_revision_part_ids: ids,
            ..
        } = conflict
        {
            ids.sort_by_key(|id| id.get());
            ensure!(
                !ids.is_empty() && ids.windows(2).all(|w| w[0] != w[1]),
                "Required-unit conflict candidates are invalid"
            );
        }
    }
    conflicts.sort_by_key(StoredConflict::target);
    Ok(StoredResult::Unresolved { conflicts })
}

pub(super) fn result(input: &str) -> Result<StoredResult> {
    let parsed = parsed(input, "Required-unit reconciliation result")?;
    let parsed = record(&parsed, "Required-unit reconciliation result")?;
    let result = if parsed["kind"] == "unresolved" {
        unresolved(parsed)?
    } else {
        ensure!(
            parsed["kind"] == "ready",
            "Required-unit reconciliation kind is invalid"
        );
        ready(parsed)?
    };
    canonical(&result, input, "Required-unit reconciliation result")?;
    Ok(result)
}
