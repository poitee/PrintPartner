use anyhow::{Result, ensure};
use pp_contracts::{autosave::PositiveId, publication::ApplyRequest};
use pp_storage::{
    Limits, WriterOwner,
    auth::Secret,
    plan_publication::{PublicationCommand, RequiredUnitTokenAllocator, TokenAllocationFailure},
    read_model::Credential,
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
struct Transcript {
    values: std::vec::IntoIter<String>,
    consumed: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}
impl RequiredUnitTokenAllocator for Transcript {
    fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure> {
        let value = self.values.next().ok_or(TokenAllocationFailure)?;
        self.consumed
            .lock()
            .map_err(|_| TokenAllocationFailure)?
            .push(value.clone());
        let raw = hex::decode(value.strip_prefix("ppu_").ok_or(TokenAllocationFailure)?)
            .map_err(|_| TokenAllocationFailure)?;
        raw.try_into().map_err(|_| TokenAllocationFailure)
    }
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 7,
        "usage: plan-publication-fixture DIRECTORY PROFILE_ID DRAFT_ID IDEMPOTENCY_KEY REQUEST_JSON TOKEN_TRANSCRIPT_JSON"
    );
    let directory = Path::new(&args[1]);
    let secret = std::env::var("PP_PUBLICATION_SESSION")?;
    let request: ApplyRequest = serde_json::from_slice(&std::fs::read(&args[5])?)?;
    let profile = PositiveId::new(args[2].parse()?).map_err(anyhow::Error::msg)?;
    let draft = PositiveId::new(args[3].parse()?).map_err(anyhow::Error::msg)?;
    let transcript: Vec<String> = serde_json::from_slice(&std::fs::read(&args[6])?)?;
    let consumed = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let before = graph(directory)?;
    let mut results = Vec::new();
    let mut accepted_reads = Vec::new();
    let mut failed = false;
    for _ in 0..2 {
        let (owner, _) = WriterOwner::open_with_token_allocator(
            directory,
            Limits::default(),
            Box::new(Transcript {
                values: transcript.clone().into_iter(),
                consumed: consumed.clone(),
            }),
        )?;
        let command = PublicationCommand::new(
            profile,
            draft,
            request.clone(),
            args[4].clone(),
            Credential::Session(Secret::new(secret.clone())),
        )?;
        let result =
            owner
                .publication()
                .apply(command, &AtomicBool::new(false), Duration::from_secs(5));
        let view = owner.accepted_reads().read(
            Credential::Session(Secret::new(secret.clone())),
            &[profile.get() as i64],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?;
        accepted_reads.push(serde_json::to_value(view)?);
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
        json!({"first":results[0],"restart":results.get(1),"accepted_reads":accepted_reads,"consumed_tokens":*consumed.lock().expect("transcript"),"graph_before":before,"graph_after":graph(directory)?})
    );
    ensure!(!failed, "Publication fixture operation failed");
    Ok(())
}
