use super::{BasisRow, StoredAssignment, StoredConflict, StoredResult, UNIT_LIMIT};
use super::{Check, PositiveId, model};
use anyhow::{Result, anyhow, bail, ensure};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, value::RawValue};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};

struct CheckedIo<'a, T> {
    inner: T,
    check: Check<'a>,
    remaining: usize,
}
impl<T> CheckedIo<'_, T> {
    fn checkpoint(&mut self, bytes: usize) -> io::Result<()> {
        if bytes >= self.remaining {
            (self.check)().map_err(io::Error::other)?;
            self.remaining = 4096;
        } else {
            self.remaining -= bytes;
        }
        Ok(())
    }
}
impl<T: Read> Read for CheckedIo<'_, T> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.checkpoint(bytes.len())?;
        self.inner.read(bytes)
    }
}
impl<T: Write> Write for CheckedIo<'_, T> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.checkpoint(bytes.len())?;
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write(value: &impl Serialize, out: &mut impl Write, check: Check<'_>) -> Result<()> {
    check()?;
    let mut out = io::BufWriter::new(CheckedIo {
        inner: out,
        check,
        remaining: 0,
    });
    let result = serde_json::to_writer(&mut out, value);
    let flushed = out.flush();
    check()?;
    result?;
    flushed?;
    Ok(())
}

fn parse_json<T: DeserializeOwned>(input: &str, label: &str, check: Check<'_>) -> Result<T> {
    check()?;
    let parsed = serde_json::from_reader(CheckedIo {
        inner: input.as_bytes(),
        check,
        remaining: 0,
    });
    check()?;
    parsed.map_err(|_| anyhow!("{label} is invalid"))
}

pub(in crate::required_units) fn digest(
    value: &impl Serialize,
    check: Check<'_>,
) -> Result<String> {
    struct Hash(Sha256);
    impl Write for Hash {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    check()?;
    let mut hash = Hash(Sha256::new());
    write(value, &mut hash, check)?;
    Ok(hex::encode(hash.0.finalize()))
}

pub(in crate::required_units) fn string(
    value: &impl Serialize,
    check: Check<'_>,
) -> Result<String> {
    let mut out = Vec::new();
    write(value, &mut out, check)?;
    Ok(String::from_utf8(out)?)
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

type RawFields = HashMap<String, Box<RawValue>>;

fn raw_array(
    fields: &RawFields,
    name: &str,
    label: &str,
    check: Check<'_>,
) -> Result<Vec<Box<RawValue>>> {
    parse_json(fields[name].get(), label, check)
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

fn canonical(value: &impl Serialize, input: &str, label: &str, check: Check<'_>) -> Result<()> {
    struct Compare<'a>(&'a [u8]);
    impl Write for Compare<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let Some(rest) = self.0.strip_prefix(bytes) else {
                return Err(io::Error::other("noncanonical JSON"));
            };
            self.0 = rest;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    check()?;
    let mut out = Compare(input.as_bytes());
    let result = write(value, &mut out, check);
    check()?;
    ensure!(
        result.is_ok() && out.0.is_empty(),
        "{label} is not canonical"
    );
    Ok(())
}

pub(super) fn basis(input: &str, check: Check<'_>) -> Result<Vec<BasisRow>> {
    let raw: Vec<Box<RawValue>> = parse_json(input, "Required-unit selection basis", check)?;
    let mut slots = HashSet::new();
    let mut tokens = HashSet::new();
    let mut rows = raw
        .iter()
        .map(|raw| {
            check()?;
            let value: Value = parse_json(raw.get(), "Required-unit selection basis", check)?;
            let row = record(&value, "Required-unit selection basis row")?;
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
            Ok((raw, revision_part_id, prior_index))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .map(|(row, revision_part_id, prior_index)| {
            check()?;
            let row: Value = parse_json(row.get(), "Required-unit selection basis", check)?;
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
                slots.insert((revision_part_id.get(), prior_index))
                    && tokens.insert(token.to_owned()),
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
    check()?;
    rows.sort_by_key(|row| (row.revision_part_id.get(), row.prior_index));
    canonical(&rows, input, "Required-unit selection basis", check)?;
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

fn ready(parsed: &Value, fields: &RawFields, check: Check<'_>) -> Result<StoredResult> {
    keys(
        parsed,
        &["kind", "assignments", "surplus"],
        "Required-unit reconciliation result",
    )?;
    ensure!(
        fields["assignments"].get().trim_start().starts_with('[')
            && fields["surplus"].get().trim_start().starts_with('['),
        "Required-unit reconciliation ready result is invalid"
    );
    let assignments = raw_array(
        fields,
        "assignments",
        "Required-unit reconciliation result",
        check,
    )?;
    let surplus = raw_array(
        fields,
        "surplus",
        "Required-unit reconciliation result",
        check,
    )?;
    let mut assignments = assignments
        .iter()
        .map(|raw| {
            check()?;
            assignment(&parse_json(
                raw.get(),
                "Required-unit reconciliation result",
                check,
            )?)
        })
        .collect::<Result<Vec<_>>>()?;
    let surplus = surplus
        .iter()
        .map(|raw| {
            check()?;
            let value: Value = parse_json(raw.get(), "Required-unit reconciliation result", check)?;
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("Required-unit reconciliation surplus is invalid"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut slots = HashSet::new();
    let mut tokens = HashSet::new();
    for assignment in &assignments {
        check()?;
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
        check()?;
        model::validate_token(token)?;
    }
    for token in &surplus {
        check()?;
        ensure!(
            tokens.insert(token.as_str()),
            "Required-unit reconciliation surplus is duplicated"
        );
    }
    let mut surplus = surplus;
    surplus.sort();
    check()?;
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

fn unresolved(parsed: &Value, fields: &RawFields, check: Check<'_>) -> Result<StoredResult> {
    keys(
        parsed,
        &["kind", "conflicts"],
        "Required-unit reconciliation result",
    )?;
    ensure!(
        fields["conflicts"].get().trim_start().starts_with('['),
        "Required-unit reconciliation conflicts are invalid"
    );
    let raw = raw_array(
        fields,
        "conflicts",
        "Required-unit reconciliation conflicts",
        check,
    )?;
    let mut conflicts = raw
        .iter()
        .map(|raw| {
            check()?;
            conflict(&parse_json(
                raw.get(),
                "Required-unit reconciliation result",
                check,
            )?)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut targets = HashSet::new();
    for conflict in &mut conflicts {
        check()?;
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

pub(super) fn result(input: &str, check: Check<'_>) -> Result<StoredResult> {
    let fields: RawFields = parse_json(input, "Required-unit reconciliation result", check)?;
    let mut header = serde_json::Map::new();
    for (key, raw) in &fields {
        header.insert(
            key.clone(),
            if key == "kind" {
                parse_json(raw.get(), "Required-unit reconciliation result", check)?
            } else {
                Value::Null
            },
        );
    }
    let parsed = Value::Object(header);
    let result = if parsed["kind"] == "unresolved" {
        unresolved(&parsed, &fields, check)?
    } else {
        ensure!(
            parsed["kind"] == "ready",
            "Required-unit reconciliation kind is invalid"
        );
        ready(&parsed, &fields, check)?
    };
    canonical(&result, input, "Required-unit reconciliation result", check)?;
    Ok(result)
}
