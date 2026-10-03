use anyhow::{Result, anyhow, ensure};
use pp_contracts::{autosave::PositiveId, reconciliation::ReconciliationRequest};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::{Credentials, Deletion, Outcome as CatalogOutcome, Request as CatalogRequest},
    checkoff_progress::{Basis, Request as ProgressRequest},
    jobs::{self, JobKind, Payload, UserOperation, WorkerAdmission},
    read_model::{AcceptedRead, Credential, Snapshot},
    required_units::ReconciliationCommand,
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Value, json};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};
const WAIT: Duration = Duration::from_secs(5);
fn secret() -> Secret {
    Secret::new("required-unit-fixture-secret".into())
}
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}
fn snapshot(owner: &WriterOwner) -> Result<Snapshot> {
    let batch = owner.accepted_reads().read(
        Credential::Session(secret()),
        &[1],
        &AtomicBool::new(false),
        WAIT,
    )?;
    match batch
        .builds
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("Missing Build"))?
        .accepted
    {
        AcceptedRead::Ready { snapshot } => Ok(*snapshot),
        other => Err(anyhow!("Accepted fixture unavailable: {other:?}")),
    }
}
fn reconcile(owner: &WriterOwner, request: &ReconciliationRequest) -> Result<Value> {
    Ok(serde_json::to_value(owner.required_units().reconcile(
        ReconciliationCommand::new(
            PositiveId::new(1).map_err(anyhow::Error::msg)?,
            PositiveId::new(2).map_err(anyhow::Error::msg)?,
            request.clone(),
            "composed-selection".into(),
            Credential::Session(secret()),
        )?,
        &AtomicBool::new(false),
        WAIT,
    )?)?)
}
fn job(owner: &WriterOwner, op: UserOperation) -> Result<jobs::JobRecord> {
    match owner
        .jobs(policy())?
        .submit(
            jobs::Credential::Session(secret()),
            op,
            &AtomicBool::new(false),
            WAIT,
        )?
        .receive()?
    {
        jobs::Outcome::Job(job, _) => Ok(job),
        _ => Err(anyhow!("Missing job")),
    }
}
fn graph(directory: &Path) -> Result<Value> {
    let connection = Connection::open_with_flags(
        directory.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let tables = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = serde_json::Map::new();
    for table in tables {
        ensure!(
            table
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "Invalid table name"
        );
        let columns = connection
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))?
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut pk: Vec<_> = columns.iter().filter(|(_, pk)| *pk > 0).collect();
        pk.sort_by_key(|(_, pk)| *pk);
        let order = if pk.is_empty() {
            columns.iter().collect()
        } else {
            pk
        };
        let order = order
            .iter()
            .map(|(c, _)| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(",");
        let mut statement =
            connection.prepare(&format!("SELECT * FROM \"{table}\" ORDER BY {order}"))?;
        let mut cursor = statement.query([])?;
        let mut rows = Vec::new();
        while let Some(row) = cursor.next()? {
            let mut object = serde_json::Map::new();
            for (i, (c, _)) in columns.iter().enumerate() {
                object.insert(
                    c.clone(),
                    match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(t) => json!(std::str::from_utf8(t)?),
                        ValueRef::Blob(b) => json!({"hex":hex::encode(b)}),
                    },
                );
            }
            rows.push(Value::Object(object));
        }
        result.insert(table, json!(rows));
    }
    Ok(Value::Object(result))
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 3,
        "usage: progress-family-fixture DIRECTORY REQUEST_JSON"
    );
    let directory = Path::new(&args[1]);
    let request: ReconciliationRequest = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let (owner, ready) = WriterOwner::open(directory, Limits::default())?;
    ensure!(ready.version == 36, "Schema changed");
    let before = graph(directory)?;
    let original = snapshot(&owner)?;
    let part = original
        .parts
        .iter()
        .find(|p| p.filename == "bracket.stl")
        .ok_or_else(|| anyhow!("Missing fixture Part"))?;
    let response = owner.checkoff_progress().apply(
        Credentials::Session(secret()),
        ProgressRequest::Completion {
            expected: Basis::from(&original),
            token: part.units[1].token.clone(),
            completed: true,
        },
        &AtomicBool::new(false),
        WAIT,
    )?;
    ensure!(response.status == 200, "Completion refused");
    let progressed = snapshot(&owner)?;
    let after_progress = graph(directory)?;
    ensure!(
        after_progress["print_progress"] != before["print_progress"],
        "Progress unchanged"
    );
    let selected = reconcile(&owner, &request)?;
    ensure!(selected["kind"] == "ready", "Selection refused");
    let selection_graph = graph(directory)?;
    let header = selection_graph["plan_draft_required_unit_reconciliations"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    let basis: Value = serde_json::from_str(header["selection_basis_json"].as_str().unwrap())?;
    let expected_basis: Vec<_> = part.units.iter().map(|u| json!({"revisionPartId":part.revision_part_id,"token":u.token,"priorIndex":u.unit_index,"createdAt":before["required_units"].as_array().unwrap().iter().find(|r|r["token"]==u.token).unwrap()["created_at"],"completed":true,"assembled":false})).collect();
    ensure!(
        basis == json!(expected_basis),
        "Selection missed exact Checkoff progress"
    );
    let selected_tokens: Vec<_> = selection_graph["plan_draft_required_unit_assignments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["reconciliation_id"] == header["id"] && r["target_draft_part_id"] == 4)
        .map(|r| r["required_unit_token"].clone())
        .collect();
    ensure!(
        selected_tokens == vec![json!(part.units[0].token), json!(part.units[1].token)],
        "Completed shrink order changed"
    );
    let changed = job(
        &owner,
        UserOperation::Enqueue {
            key: "composed-source-job".into(),
            payload_version: 1,
            payload: Payload::ImportScan { project_id: 1 },
        },
    )?;
    let worker = owner.job_worker(WorkerAdmission {
        kinds: vec![(JobKind::ImportScan, 1)],
        total: 1,
        per_resource: 1,
        lease_seconds: 60,
    })?;
    let (_, lease) = worker
        .claim()?
        .ok_or_else(|| anyhow!("Missing real claim"))?;
    let mut source_lease = worker.begin_source_work(&lease, None, &AtomicBool::new(false), WAIT)?;
    source_lease.release()?;
    ensure!(
        matches!(
            owner
                .local_source_catalog()
                .execute(CatalogRequest::Delete { id: 1 })?,
            CatalogOutcome::Deletion(Deletion::ActiveWork)
        ),
        "Released lease lost reservation"
    );
    let after = graph(directory)?;
    for (table, rows) in before.as_object().unwrap() {
        if ![
            "print_progress",
            "plan_drafts",
            "plan_draft_required_unit_reconciliations",
            "plan_draft_required_unit_decisions",
            "plan_draft_required_unit_assignments",
            "sqlite_sequence",
        ]
        .contains(&table.as_str())
            && !table.starts_with("durable_job")
        {
            ensure!(&after[table] == rows, "Protected table changed: {table}");
        }
    }
    owner.shutdown()?;
    let (owner, _) = WriterOwner::open(directory, Limits::default())?;
    ensure!(
        serde_json::to_value(snapshot(&owner)?)? == serde_json::to_value(&progressed)?,
        "Progress changed on reopen"
    );
    ensure!(
        reconcile(&owner, &request)? == selected,
        "Selection replay changed"
    );
    ensure!(
        matches!(
            owner
                .local_source_catalog()
                .execute(CatalogRequest::Delete { id: 1 })?,
            CatalogOutcome::Deletion(Deletion::ActiveWork)
        ),
        "Restart lost reservation"
    );
    let new_worker = owner.job_worker(WorkerAdmission {
        kinds: vec![(JobKind::ImportScan, 1)],
        total: 1,
        per_resource: 1,
        lease_seconds: 60,
    })?;
    ensure!(
        new_worker
            .begin_source_work(&lease, None, &AtomicBool::new(false), WAIT)
            .is_err(),
        "Stale lease accepted"
    );
    job(
        &owner,
        UserOperation::Cancel {
            job_id: changed.job_id,
        },
    )?;
    let final_graph = graph(directory)?;
    for (table, rows) in before.as_object().unwrap() {
        let foreign = |value: &Value| {
            value
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| {
                    r.get("tenant_id")
                        .or_else(|| r.get("tenant"))
                        .and_then(Value::as_str)
                        .is_some_and(|t| t != "default")
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        ensure!(
            foreign(rows) == foreign(&final_graph[table]),
            "Foreign rows changed: {table}"
        );
    }
    ensure!(
        final_graph["required_units"] == before["required_units"]
            && final_graph["plan_revision_required_units"]
                == before["plan_revision_required_units"],
        "Immutable unit identities changed"
    );
    owner.shutdown()?;
    println!(
        "{}",
        json!({"schema":36,"progress":response,"selection":selected,"selection_basis":basis,"graph_before":before,"graph_after":final_graph,"restart":true,"stale_claim_refused":true,"source_reservation":true,"handler_calls":0})
    );
    Ok(())
}
