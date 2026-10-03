use crate::{
    Envelope, Shared, WriterOwner,
    auth::{self, AuthPolicy},
    catalog::Credentials,
    read_model::{AcceptedRead, Part, Snapshot, graph},
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const MAX_SAFE: i64 = 9_007_199_254_740_991;
fn integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<i64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    if let Some(value) = number
        .as_i64()
        .filter(|n| n.unsigned_abs() <= MAX_SAFE as u64)
    {
        return Ok(value);
    }
    match number.as_f64() {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64 => Ok(n as i64),
        _ => Err(serde::de::Error::custom(
            "Expected a JavaScript-safe integer",
        )),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Basis {
    #[serde(deserialize_with = "integer")]
    pub profile_id: i64,
    #[serde(deserialize_with = "integer")]
    pub plan_version: i64,
    #[serde(deserialize_with = "integer")]
    pub plan_revision_id: i64,
    pub plan_revision_digest: String,
    pub required_unit_mapping_digest: String,
}
impl From<&Snapshot> for Basis {
    fn from(s: &Snapshot) -> Self {
        Self {
            profile_id: s.profile.id,
            plan_version: s.plan_version,
            plan_revision_id: s.revision_id,
            plan_revision_digest: s.revision_digest.clone(),
            required_unit_mapping_digest: s.required_unit_mapping_digest.clone(),
        }
    }
}
impl Basis {
    fn valid(&self) -> bool {
        [self.profile_id, self.plan_version, self.plan_revision_id]
            .into_iter()
            .all(|v| (1..=MAX_SAFE).contains(&v))
            && [
                &self.plan_revision_digest,
                &self.required_unit_mapping_digest,
            ]
            .into_iter()
            .all(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRow {
    #[serde(deserialize_with = "integer")]
    pub part_id: i64,
    #[serde(deserialize_with = "integer")]
    pub printed_count: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    pub expected: Basis,
    pub rows: Vec<ImportRow>,
}
impl Import {
    pub fn parse(value: Value) -> std::result::Result<Self, Response> {
        let request: Self = serde_json::from_value(value).map_err(|_| invalid_import())?;
        request.validate()?;
        Ok(request)
    }
    fn validate(&self) -> std::result::Result<(), Response> {
        let mut seen = HashSet::new();
        if !self.expected.valid()
            || !(1..=10_000).contains(&self.rows.len())
            || self.rows.iter().any(|r| {
                !(1..=MAX_SAFE).contains(&r.part_id)
                    || !(0..=10_000).contains(&r.printed_count)
                    || !seen.insert(r.part_id)
            })
        {
            return Err(invalid_import());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Completion {
        expected: Basis,
        token: String,
        completed: bool,
    },
    Assembly {
        expected: Basis,
        token: String,
        assembled: bool,
    },
    Import {
        request: Import,
    },
    CompletionCoordinate {
        part_id: i64,
        body: Value,
    },
    AssemblyCoordinate {
        part_id: i64,
        body: Value,
    },
}
impl Request {
    pub fn parse(value: Value) -> std::result::Result<Self, Response> {
        let import = value.get("operation").and_then(Value::as_str) == Some("import");
        let request = serde_json::from_value(value).map_err(|_| {
            if import {
                invalid_import()
            } else {
                failure(400, "Invalid Accepted Plan progress request", None)
            }
        })?;
        validate(&request)?;
        Ok(request)
    }
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct CompletionBody {
    pub part_id: i64,
    pub printed_count: usize,
    pub print_units: Vec<bool>,
    pub assembled_units: Vec<bool>,
    pub missing: bool,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct AssemblyBody {
    pub part_id: i64,
    pub assembled_count: usize,
    pub assembled_units: Vec<bool>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Body {
    Completion(CompletionBody),
    Assembly(AssemblyBody),
    Imported {
        updated_parts: usize,
    },
    Failure {
        detail: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Body,
}
fn failure(status: u16, detail: &str, code: Option<&str>) -> Response {
    Response {
        status,
        body: Body::Failure {
            detail: detail.into(),
            code: code.map(str::to_owned),
        },
    }
}
fn invalid_import() -> Response {
    failure(400, "Request is invalid", Some("invalid_request"))
}
fn refusal(import: bool, kind: &str) -> Response {
    let (status, detail, code) = match kind {
        "missing" => (
            404,
            if import {
                "Plan or Part not found"
            } else {
                "Part unit not found"
            },
            "progress_target_not_found",
        ),
        "stale" => (
            409,
            "Accepted Plan changed; reload and retry",
            "stale_accepted_plan",
        ),
        "archived" => (
            409,
            "Archived Plan Progress cannot be changed",
            "plan_archived",
        ),
        "dirty" | "uninitialized" => (
            409,
            if import {
                "Accepted Plan state is unavailable"
            } else if kind == "dirty" {
                "Accepted Plan requires compatibility repair"
            } else {
                "Accepted Plan operational state is not initialized"
            },
            "accepted_state_unavailable",
        ),
        "invalid_rows" => (422, "Printed counts are invalid", "invalid_rows"),
        "unavailable" => (
            503,
            if import {
                "Plan draft update is unavailable"
            } else {
                "Accepted Plan update is unavailable"
            },
            "transaction_unavailable",
        ),
        "integrity" if !import => (500, "Accepted Plan data is inconsistent", "internal_error"),
        _ => (
            500,
            if import {
                "Accepted Progress import failed"
            } else {
                "Internal Server Error"
            },
            "internal_error",
        ),
    };
    failure(status, detail, import.then_some(code))
}

#[derive(Clone)]
pub struct ProgressClient {
    shared: Arc<Shared>,
    repos: PathBuf,
    policy: AuthPolicy,
}
pub(super) struct Command {
    credentials: Credentials,
    request: Request,
    repos: PathBuf,
    policy: AuthPolicy,
}
impl WriterOwner {
    pub fn checkoff_progress(&self) -> ProgressClient {
        self.checkoff_progress_with_policy(AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
            first_user: auth::FirstUserTenant::NewUser,
        })
        .expect("neutral policy")
    }
    pub fn checkoff_progress_with_policy(&self, policy: AuthPolicy) -> Result<ProgressClient> {
        auth::validate_policy(policy)?;
        Ok(ProgressClient {
            shared: self.client.shared.clone(),
            repos: self
                .lease
                .as_ref()
                .expect("live owner")
                .data_dir()
                .join("repos"),
            policy,
        })
    }
}
impl ProgressClient {
    pub fn apply(
        &self,
        credentials: Credentials,
        request: Request,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<Response> {
        let import = matches!(request, Request::Import { .. });
        if let Err(response) = validate(&request) {
            return Ok(response);
        }
        let deadline = Instant::now() + wait;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!("Writer admission poisoned"))?;
        loop {
            if queue.closed || cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Ok(refusal(import, "unavailable"));
            }
            if queue.pending.len() < self.shared.capacity {
                break;
            }
            queue = self
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!("Writer admission poisoned"))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::Checkoff {
            command: Command {
                credentials,
                request,
                repos: self.repos.clone(),
                policy: self.policy,
            },
            reply,
        });
        self.shared.changed.notify_all();
        drop(queue);
        receiver.recv().map_err(|_| anyhow!("Checkoff reply lost after admission; reread progress before deciding whether to retry"))?
    }
}
fn coordinate(body: &Value, assembly: bool) -> std::result::Result<(i64, bool), Response> {
    let field = if assembly { "assembled" } else { "completed" };
    if body.get("unit_index").is_none_or(Value::is_null)
        || body.get(field).is_none_or(Value::is_null)
    {
        return Err(failure(
            400,
            &format!("unit_index and {field} required"),
            None,
        ));
    }
    let index = body["unit_index"]
        .as_f64()
        .filter(|x| x.is_finite() && x.fract() == 0.0 && *x >= 0.0);
    let flag = body[field].as_bool();
    match (index, flag) {
        (Some(index), Some(flag)) => Ok((
            if index > MAX_SAFE as f64 {
                MAX_SAFE
            } else {
                index as i64
            },
            flag,
        )),
        _ => Err(failure(
            400,
            &format!("unit_index must be a non-negative integer and {field} a boolean"),
            None,
        )),
    }
}
fn validate(request: &Request) -> std::result::Result<(), Response> {
    match request {
        Request::Import { request } => request.validate(),
        Request::Completion {
            expected, token, ..
        }
        | Request::Assembly {
            expected, token, ..
        } => {
            if expected.valid()
                && token.len() == 36
                && token.starts_with("ppu_")
                && token[4..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                Ok(())
            } else {
                Err(failure(400, "Invalid Accepted Plan progress request", None))
            }
        }
        Request::CompletionCoordinate { body, .. } => coordinate(body, false).map(|_| ()),
        Request::AssemblyCoordinate { body, .. } => coordinate(body, true).map(|_| ()),
    }
}
fn complete_rows(tx: &Transaction<'_>, tenant: &str, snapshot: &Snapshot) -> Result<()> {
    for part in &snapshot.parts {
        let mut stmt = tx.prepare("SELECT tenant_id,unit_index FROM print_progress WHERE part_id=?1 AND unit_index<?2 ORDER BY unit_index")?;
        let rows = stmt
            .query_map(
                params![part.projection_part_id, part.units.len() as i64],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() != part.units.len()
            || rows
                .iter()
                .enumerate()
                .any(|(i, (t, index))| t != tenant || *index != i as i64)
        {
            return Err(graph::Integrity {
                code: "progress",
                message: "Accepted Plan progress rows are incomplete".into(),
            }
            .into());
        }
    }
    Ok(())
}
fn set_completed(
    tx: &Transaction<'_>,
    tenant: &str,
    part: i64,
    index: i64,
    completed: bool,
) -> Result<()> {
    let changed = tx.execute("UPDATE print_progress SET completed=?1, assembled=CASE WHEN ?1 THEN assembled ELSE 0 END WHERE tenant_id=?2 AND part_id=?3 AND unit_index=?4", params![completed, tenant, part, index])?;
    ensure!(
        changed == 1,
        "Progress update did not find exactly one current unit"
    );
    Ok(())
}
fn completion(part: &Part) -> Response {
    let printed_count = part.units.iter().filter(|u| u.completed).count();
    Response {
        status: 200,
        body: Body::Completion(CompletionBody {
            part_id: part.projection_part_id,
            printed_count,
            print_units: part.units.iter().map(|u| u.completed).collect(),
            assembled_units: part.units.iter().map(|u| u.assembled).collect(),
            missing: printed_count < part.units.len(),
        }),
    }
}
fn assembly(part: &Part) -> Response {
    Response {
        status: 200,
        body: Body::Assembly(AssemblyBody {
            part_id: part.projection_part_id,
            assembled_count: part.units.iter().filter(|u| u.assembled).count(),
            assembled_units: part.units.iter().map(|u| u.assembled).collect(),
        }),
    }
}
pub(super) fn execute(connection: &mut Connection, command: Command) -> Result<Response> {
    let import = matches!(command.request, Request::Import { .. });
    let tx = match connection.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(_) => return Ok(refusal(import, "internal")),
    };
    let tenant = auth::catalog_tenant(&tx, command.credentials, command.policy)?;
    let response = match mutate(&tx, &tenant, command.request, &command.repos) {
        Ok(response) => response,
        Err(error) => {
            return Ok(refusal(
                import,
                if error.is::<graph::Integrity>() {
                    "integrity"
                } else {
                    "internal"
                },
            ));
        }
    };
    if response.status == 200 && tx.commit().is_err() {
        return Ok(refusal(import, "internal"));
    }
    Ok(response)
}
fn mutate(
    tx: &Transaction<'_>,
    tenant: &str,
    request: Request,
    repos: &std::path::Path,
) -> Result<Response> {
    let import = matches!(request, Request::Import { .. });
    let profile = match &request {
        Request::Import { request } => request.expected.profile_id,
        Request::Completion { expected, .. } | Request::Assembly { expected, .. } => {
            expected.profile_id
        }
        Request::CompletionCoordinate { part_id, .. }
        | Request::AssemblyCoordinate { part_id, .. } => {
            let id = tx
                .query_row(
                    "SELECT profile_id FROM parts WHERE tenant_id=?1 AND id=?2",
                    params![tenant, part_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?;
            let Some(id) = id else {
                return Ok(failure(404, "Part not found", None));
            };
            id
        }
    };
    let mut snapshot = match graph::read(tx, tenant, profile, repos, &mut graph::Budget::default())?
    {
        AcceptedRead::Ready { snapshot } => snapshot,
        AcceptedRead::Missing => {
            return Ok(refusal(import, if import { "internal" } else { "missing" }));
        }
        AcceptedRead::Empty { .. } => return Ok(refusal(import, "stale")),
        AcceptedRead::CompatibilityDirty => return Ok(refusal(import, "dirty")),
        AcceptedRead::Uninitialized => return Ok(refusal(import, "uninitialized")),
        AcceptedRead::IntegrityFailure { .. } => return Ok(refusal(import, "integrity")),
    };
    let request = match request {
        Request::CompletionCoordinate { part_id, body } => {
            let (index, completed) = coordinate(&body, false).expect("validated coordinate");
            let Some(part) = snapshot
                .parts
                .iter()
                .find(|p| p.projection_part_id == part_id)
            else {
                return Ok(failure(404, "Part not found", None));
            };
            let Some(unit) = part.units.iter().find(|u| u.unit_index == index) else {
                return Ok(failure(400, "unit_index out of range", None));
            };
            Request::Completion {
                expected: Basis::from(snapshot.as_ref()),
                token: unit.token.clone(),
                completed,
            }
        }
        Request::AssemblyCoordinate { part_id, body } => {
            let (index, assembled) = coordinate(&body, true).expect("validated coordinate");
            let Some(part) = snapshot
                .parts
                .iter()
                .find(|p| p.projection_part_id == part_id)
            else {
                return Ok(failure(404, "Part not found", None));
            };
            let Some(unit) = part.units.iter().find(|u| u.unit_index == index) else {
                return Ok(failure(400, "unit_index out of range", None));
            };
            Request::Assembly {
                expected: Basis::from(snapshot.as_ref()),
                token: unit.token.clone(),
                assembled,
            }
        }
        other => other,
    };
    let expected = match &request {
        Request::Completion { expected, .. } | Request::Assembly { expected, .. } => expected,
        Request::Import { request } => &request.expected,
        _ => unreachable!(),
    };
    if *expected != Basis::from(snapshot.as_ref()) {
        return Ok(refusal(import, "stale"));
    }
    if snapshot
        .profile
        .archived_at
        .as_ref()
        .is_some_and(|s| !s.is_empty())
    {
        return Ok(refusal(import, "archived"));
    }
    complete_rows(tx, tenant, &snapshot)?;
    match request {
        Request::Import { request } => {
            for row in &request.rows {
                let Some(part) = snapshot
                    .parts
                    .iter()
                    .find(|p| p.projection_part_id == row.part_id)
                else {
                    return Ok(refusal(true, "missing"));
                };
                if row.printed_count > part.units.len() as i64 {
                    return Ok(refusal(true, "invalid_rows"));
                }
            }
            let mut updated_parts = 0;
            for row in request.rows {
                let part = snapshot
                    .parts
                    .iter()
                    .find(|p| p.projection_part_id == row.part_id)
                    .expect("validated Part");
                if part
                    .units
                    .iter()
                    .any(|u| u.completed != (u.unit_index < row.printed_count))
                {
                    updated_parts += 1;
                }
                for unit in &part.units {
                    set_completed(
                        tx,
                        tenant,
                        row.part_id,
                        unit.unit_index,
                        unit.unit_index < row.printed_count,
                    )?;
                }
            }
            Ok(Response {
                status: 200,
                body: Body::Imported { updated_parts },
            })
        }
        Request::Completion {
            token, completed, ..
        } => {
            let Some(part) = snapshot
                .parts
                .iter_mut()
                .find(|p| p.units.iter().any(|u| u.token == token))
            else {
                return Ok(refusal(false, "missing"));
            };
            let index = part
                .units
                .iter()
                .find(|u| u.token == token)
                .expect("located unit")
                .unit_index;
            for unit in &mut part.units {
                if (completed && unit.unit_index <= index)
                    || (!completed && unit.unit_index >= index)
                {
                    set_completed(
                        tx,
                        tenant,
                        part.projection_part_id,
                        unit.unit_index,
                        completed,
                    )?;
                    unit.completed = completed;
                    if !completed {
                        unit.assembled = false;
                    }
                }
            }
            Ok(completion(part))
        }
        Request::Assembly {
            token, assembled, ..
        } => {
            let Some(part) = snapshot
                .parts
                .iter_mut()
                .find(|p| p.units.iter().any(|u| u.token == token))
            else {
                return Ok(refusal(false, "missing"));
            };
            let unit = part
                .units
                .iter_mut()
                .find(|u| u.token == token)
                .expect("located unit");
            if !assembled || unit.completed {
                let changed = tx.execute("UPDATE print_progress SET assembled=?1 WHERE tenant_id=?2 AND part_id=?3 AND unit_index=?4", params![assembled,tenant,part.projection_part_id,unit.unit_index])?;
                ensure!(
                    changed == 1,
                    "Progress update did not find exactly one current unit"
                );
                unit.assembled = assembled;
            }
            Ok(assembly(part))
        }
        _ => unreachable!(),
    }
}
