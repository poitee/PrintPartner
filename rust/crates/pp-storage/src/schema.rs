use anyhow::{Result, bail, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, types::Value};
use serde::Deserialize;
use std::{
    fs::File,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
struct SchemaData {
    migrations: Vec<String>,
    repair: Vec<String>,
    stranded: String,
    extras: Vec<String>,
    seeds: Vec<SeedGroup>,
}
#[derive(Deserialize)]
struct SeedGroup {
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
}
#[derive(Debug, serde::Serialize)]
pub struct SchemaReady {
    pub version: u64,
    pub previous_version: u64,
    pub backup: Option<PathBuf>,
}

struct PreflightCopy(PathBuf);
impl Drop for PreflightCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn preflight(path: &Path, owned: bool) -> Result<u64> {
    let marker = path.parent().unwrap().join(".desktop-owner.json");
    ensure!(owned || !marker.exists(), "Data directory already owned");
    if !path.exists() || path.metadata()?.len() == 0 {
        return Ok(0);
    }
    let capture = || -> Result<Vec<(String, Option<Vec<u8>>)>> {
        ["", "-wal", "-journal"]
            .into_iter()
            .map(|suffix| {
                let file = path.with_file_name(format!("print-partner.db{suffix}"));
                let bytes = match std::fs::read(file) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error.into()),
                };
                Ok((suffix.to_owned(), bytes))
            })
            .collect()
    };
    let source = capture()?;
    let copy = PreflightCopy(std::env::temp_dir().join(format!(
        "pp-preflight-{}",
        hex::encode(rand::random::<[u8; 16]>())
    )));
    std::fs::DirBuilder::new().mode(0o700).create(&copy.0)?;
    for (suffix, bytes) in &source {
        if let Some(bytes) = bytes {
            std::fs::write(copy.0.join(format!("print-partner.db{suffix}")), bytes)?;
        }
    }
    ensure!(
        source == capture()?,
        "Database changed during preflight capture"
    );
    ensure!(owned || !marker.exists(), "Data directory already owned");
    let conn = Connection::open(copy.0.join("print-partner.db"))?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    ensure!(
        integrity == "ok",
        "SQLite integrity_check failed: {integrity}"
    );
    let has_settings: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings')",
        [],
        |r| r.get(0),
    )?;
    let value: Option<String> = if has_settings {
        conn.query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let version = match value {
        None => 0,
        Some(value) => {
            ensure!(
                !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
                "Invalid database schema version"
            );
            value
                .parse::<u64>()
                .map_err(|_| anyhow::anyhow!("Database schema version exceeds supported range"))?
        }
    };
    ensure!(
        version <= 36,
        "Database schema version {version} is newer than supported version 36"
    );
    ensure!(
        version == 0 || version >= 31,
        "Cannot upgrade database schema version {version}; install Print Partner v3.3.0 first"
    );
    crate::jobs::validate_schema(&conn, version)?;
    crate::uploads::validate_schema(&conn, version)?;
    Ok(version)
}

pub(crate) fn configure(conn: &Connection, read_only: bool) -> Result<()> {
    if !read_only {
        conn.pragma_update(None, "journal_mode", "WAL")?;
    }
    conn.execute_batch(
        "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    )?;
    conn.pragma_update(None, "query_only", i64::from(read_only))?;
    let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    ensure!(journal == "wal", "WAL required");
    for (name, expected) in [
        ("synchronous", 2),
        ("foreign_keys", 1),
        ("busy_timeout", 5000),
        ("query_only", i64::from(read_only)),
    ] {
        let actual: i64 = conn.pragma_query_value(None, name, |r| r.get(0))?;
        ensure!(actual == expected, "SQLite {name} invariant failed");
    }
    Ok(())
}

pub(crate) fn backup(conn: &Connection, path: &Path, replace: bool) -> Result<()> {
    if path.exists()
        && let Some(source) = conn.path()
    {
        ensure!(
            path.canonicalize()? != Path::new(source).canonicalize()?,
            "Backup cannot replace the open database"
        );
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Backup parent missing"))?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".backup-{}.db",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let result = (|| -> Result<()> {
        conn.backup("main", &temp, None)?;
        let check = Connection::open_with_flags(&temp, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let integrity: String = check.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        ensure!(integrity == "ok", "Backup integrity failed");
        drop(check);
        File::open(&temp)?.sync_all()?;
        if replace {
            std::fs::rename(&temp, path)?;
        } else {
            std::fs::hard_link(&temp, path)?;
            std::fs::remove_file(&temp)?;
        }
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if temp.exists() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

pub(crate) fn initialize(
    path: &Path,
    version: u64,
    now: &str,
) -> Result<(Connection, SchemaReady)> {
    let mut conn = Connection::open(path)?;
    let backup_path = if version < 36 && path.metadata()?.len() > 0 {
        let target = path.parent().unwrap().join("backups/pre-schema36.db");
        if !target.exists() {
            backup(&conn, &target, true)?;
        }
        Some(target)
    } else {
        None
    };
    configure(&conn, false)?;
    let data: SchemaData = serde_json::from_str(include_str!("../data/schema.json"))?;
    for sql in &data.migrations {
        if let Err(error) = conn.execute_batch(sql)
            && !error
                .to_string()
                .to_ascii_lowercase()
                .contains("duplicate column name")
        {
            return Err(error.into());
        }
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for sql in &data.repair {
        tx.execute_batch(sql)?;
    }
    let stranded: Option<i64> = tx.query_row(&data.stranded, [], |r| r.get(0)).optional()?;
    if let Some(id) = stranded {
        bail!(
            "Active Source revision {id} cannot be moved without conflicting with protected history; manual recovery is required"
        );
    }
    tx.commit()?;
    add_column(
        &conn,
        "parts",
        "spoolman_spool_id",
        "ALTER TABLE parts ADD COLUMN spoolman_spool_id TEXT",
    )?;
    conn.execute_batch(&data.extras[0])?;
    add_column(
        &conn,
        "print_progress",
        "assembled",
        "ALTER TABLE print_progress ADD COLUMN assembled INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(&data.extras[1])?;
    if version < 34 {
        conn.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES('default','schema_version','34') ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value",[])?;
    }
    for group in data.seeds {
        let tx = conn.transaction()?;
        let sql = format!(
            "INSERT OR IGNORE INTO {}({}) VALUES({})",
            group.table,
            group.columns.join(","),
            vec!["?"; group.columns.len()].join(",")
        );
        for row in group.rows {
            let values = row
                .into_iter()
                .zip(&group.columns)
                .map(|(value, column)| {
                    if column == "imported_at" {
                        return Ok(Value::Text(now.into()));
                    }
                    match value {
                        serde_json::Value::Null => Ok(Value::Null),
                        serde_json::Value::String(s) => Ok(Value::Text(s)),
                        serde_json::Value::Number(n) => n
                            .as_i64()
                            .map(Value::Integer)
                            .ok_or_else(|| anyhow::anyhow!("Invalid seed integer")),
                        _ => bail!("Invalid seed scalar"),
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            tx.execute(&sql, rusqlite::params_from_iter(values))?;
        }
        tx.commit()?;
    }
    if version < 35 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("jobs/schema.sql"))?;
        tx.execute(
            "UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'",
            [],
        )?;
        tx.commit()?;
    }
    if version < 36 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("uploads/schema.sql"))?;
        tx.execute(
            "UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version'",
            [],
        )?;
        tx.commit()?;
    }
    Ok((
        conn,
        SchemaReady {
            version: 36,
            previous_version: version,
            backup: backup_path,
        },
    ))
}

fn add_column(conn: &Connection, table: &str, column: &str, sql: &str) -> Result<()> {
    let columns = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == column) {
        conn.execute_batch(sql)?;
    }
    Ok(())
}
