use anyhow::{Result, ensure};
use pp_contracts::{autosave::PositiveId, reconciliation::ReconciliationRequest};
use pp_storage::{
    Limits, WriterOwner, auth::Secret, read_model::Credential,
    required_units::ReconciliationCommand,
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Value, json};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};
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
        args.len() == 6,
        "usage: required-unit-fixture DIRECTORY PROFILE_ID DRAFT_ID IDEMPOTENCY_KEY REQUEST_JSON"
    );
    let directory = Path::new(&args[1]);
    let secret = std::env::var("PP_RECONCILIATION_SESSION")?;
    let request: ReconciliationRequest = serde_json::from_slice(&std::fs::read(&args[5])?)?;
    let profile = PositiveId::new(args[2].parse()?).map_err(anyhow::Error::msg)?;
    let draft = PositiveId::new(args[3].parse()?).map_err(anyhow::Error::msg)?;
    let before = graph(directory)?;
    let mut results = Vec::new();
    let mut failed = false;
    for _ in 0..2 {
        let (owner, _) = WriterOwner::open(directory, Limits::default())?;
        let command = ReconciliationCommand::new(
            profile,
            draft,
            request.clone(),
            args[4].clone(),
            Credential::Session(Secret::new(secret.clone())),
        )?;
        let result = owner.required_units().reconcile(
            command,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        );
        owner.shutdown()?;
        results.push(match result {
            Ok(value) => serde_json::to_value(value)?,
            Err(error) => {
                failed = true;
                json!({"error":error.to_string()})
            }
        });
        if failed {
            break;
        }
    }
    println!(
        "{}",
        json!({"first":results[0],"restart":results.get(1),"graph_before":before,"graph_after":graph(directory)?})
    );
    ensure!(!failed, "Reconciliation fixture operation failed");
    Ok(())
}
