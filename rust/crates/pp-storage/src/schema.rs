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
    ensure!(
        owned || !crate::lease::prior_owner_blocks_unowned(&marker)?,
        "Data directory already owned"
    );
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
    ensure!(
        owned || !crate::lease::prior_owner_blocks_unowned(&marker)?,
        "Data directory already owned"
    );
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
        version <= 35,
        "Database schema version {version} is newer than supported version 35"
    );
    ensure!(
        version == 0 || version >= 31,
        "Cannot upgrade database schema version {version}; install Print Partner v3.3.0 first"
    );
    crate::jobs::validate_schema(&conn, version)?;
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
    let backup_path = if version < 35 && path.metadata()?.len() > 0 {
        let target = path.parent().unwrap().join("backups/pre-schema35.db");
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
        execute_migration(&conn, sql)?;
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
    // Historical Node client.ts rebuilt this table when source_revision_id was NOT NULL,
    // before stamping the current version. Schema 34 already publishes the repaired
    // shape, so this stays inside version 34 instead of allocating a new version.
    rebuild_legacy_plan_revision_inputs(&mut conn, &data.migrations)?;
    realign_equivalent_indexes_and_triggers(&mut conn, &data.migrations)?;
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
    // Node's fixture builder connects once to create the input and again to
    // create the expected database. The first Rust open must repeat that
    // INSERT OR IGNORE pass, including the sequence bump for rows that
    // already exist. user_version is unused by Node and is not part of the
    // schema graph, so it records that this one pass already happened.
    // Later opens only insert a missing starter. Another ignore pass would
    // allocate rowids for rows that are already there.
    let replayed: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let groups = data.seeds;
    let last = groups.len().saturating_sub(1);
    for (index, group) in groups.into_iter().enumerate() {
        let tx = conn.transaction()?;
        let sql = if replayed >= STARTER_SEED_REPLAY {
            starter_seed_insert_sql(&group.table, &group.columns)?
        } else {
            format!(
                "INSERT OR IGNORE INTO {}({}) VALUES({})",
                group.table,
                group.columns.join(","),
                vec!["?"; group.columns.len()].join(",")
            )
        };
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
        if replayed < STARTER_SEED_REPLAY && index == last {
            tx.execute_batch(&format!("PRAGMA user_version = {STARTER_SEED_REPLAY}"))?;
        }
        tx.commit()?;
    }
    {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if version < 35 {
            tx.execute_batch(include_str!("jobs/schema.sql"))?;
        }
        tx.execute_batch(include_str!("jobs/printer-start-indexes.sql"))?;
        if version < 35 {
            tx.execute(
                "UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'",
                [],
            )?;
        }
        tx.commit()?;
    }
    Ok((
        conn,
        SchemaReady {
            version: 35,
            previous_version: version,
            backup: backup_path,
        },
    ))
}

pub(crate) fn sql_identity(sql: &str) -> String {
    let mut tokens: Vec<&str> = sql.split_whitespace().collect();
    let mut index = 1;
    if matches!(tokens.get(index), Some(&"UNIQUE" | &"TEMP" | &"TEMPORARY")) {
        index += 1;
    }
    if matches!(
        tokens.get(index),
        Some(&"TABLE" | &"INDEX" | &"TRIGGER" | &"VIEW")
    ) {
        index += 1;
        if tokens.get(index) == Some(&"IF")
            && tokens.get(index + 1) == Some(&"NOT")
            && tokens.get(index + 2) == Some(&"EXISTS")
        {
            tokens.drain(index..index + 3);
        }
    }
    tokens.join(" ")
}

/// SQL text SQLite records in `sqlite_master` for a `CREATE` statement.
///
/// The catalog drops one leading `IF NOT EXISTS` and any whitespace before
/// `CREATE`. Indentation and later `NOT EXISTS` predicates stay as written.
fn sqlite_catalog_sql(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    let start = index;
    let mut words = Vec::new();
    while words.len() < 6 && index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let word_start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        words.push((word_start, index));
    }
    let word = |position: usize| words.get(position).map(|(from, to)| &sql[*from..*to]);
    let mut kind_at = 1;
    if matches!(word(kind_at), Some("UNIQUE" | "TEMP" | "TEMPORARY")) {
        kind_at += 1;
    }
    if word(0) == Some("CREATE")
        && matches!(word(kind_at), Some("TABLE" | "INDEX" | "TRIGGER" | "VIEW"))
        && word(kind_at + 1) == Some("IF")
        && word(kind_at + 2) == Some("NOT")
        && word(kind_at + 3) == Some("EXISTS")
    {
        let kind_end = words[kind_at].1;
        let exists_end = words[kind_at + 3].1;
        return format!("{}{}", &sql[start..kind_end], &sql[exists_end..]);
    }
    sql[start..].to_owned()
}

fn canonical_migration<'a>(migrations: &'a [String], needle: &str) -> Result<&'a str> {
    let mut matches = migrations.iter().filter(|sql| sql.contains(needle));
    let found = matches
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing migration containing {needle}"))?;
    ensure!(
        matches.next().is_none(),
        "Multiple migrations contain {needle}"
    );
    Ok(found)
}

const STARTER_SEED_REPLAY: i64 = 1;

fn quote_sql_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn starter_seed_insert_sql(table: &str, columns: &[String]) -> Result<String> {
    let tenant = columns
        .iter()
        .position(|column| column == "tenant_id")
        .ok_or_else(|| anyhow::anyhow!("Starter seed {table} has no tenant_id"))?;
    let name = columns
        .iter()
        .position(|column| column == "name")
        .ok_or_else(|| anyhow::anyhow!("Starter seed {table} has no name"))?;
    let quoted_table = quote_sql_ident(table);
    let column_list = columns
        .iter()
        .map(|column| quote_sql_ident(column))
        .collect::<Vec<_>>()
        .join(",");
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "INSERT INTO {quoted_table} ({column_list}) SELECT {placeholders} WHERE NOT EXISTS (SELECT 1 FROM {quoted_table} WHERE {} = ?{} AND {} = ?{})",
        quote_sql_ident("tenant_id"),
        tenant + 1,
        quote_sql_ident("name"),
        name + 1,
    ))
}

fn rebuild_legacy_plan_revision_inputs(conn: &mut Connection, migrations: &[String]) -> Result<()> {
    let notnull: Option<i64> = conn
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('plan_revision_inputs') WHERE name = 'source_revision_id'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if notnull != Some(1) {
        return Ok(());
    }
    let orphan: Option<i64> = conn
        .query_row(
            "SELECT input.id
               FROM plan_revision_inputs input
               LEFT JOIN source_revisions revision ON revision.id = input.source_revision_id
              WHERE revision.id IS NULL
              LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = orphan {
        bail!("Cannot migrate Plan revision input {id}: Source revision is missing");
    }
    let create = canonical_migration(
        migrations,
        "CREATE TABLE IF NOT EXISTS plan_revision_inputs",
    )?;
    let tenant_index = canonical_migration(migrations, "idx_plan_revision_inputs_tenant_set")?;
    let unique_index = canonical_migration(migrations, "uq_plan_revision_inputs_v2_set_source")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Historical schemaMigrations filled these columns before the client rebuild.
    // Current schema.json publishes the repaired CREATE instead of that UPDATE,
    // so a legacy NOT NULL table still needs the fill before the NOT NULL copy.
    tx.execute_batch(
        "UPDATE plan_revision_inputs
            SET source_id = (
                  SELECT project_id FROM source_revisions
                   WHERE source_revisions.id = plan_revision_inputs.source_revision_id
                ),
                source_layer = 'legacy:' || COALESCE((
                  SELECT project_id FROM source_revisions
                   WHERE source_revisions.id = plan_revision_inputs.source_revision_id
                ), 0)
          WHERE source_id IS NULL OR source_layer IS NULL",
    )?;
    tx.execute_batch("ALTER TABLE plan_revision_inputs RENAME TO plan_revision_inputs_v17")?;
    tx.execute_batch(create)?;
    tx.execute_batch(
        "INSERT INTO plan_revision_inputs (
            id, tenant_id, input_set_id, source_id, source_layer, layer_order,
            tracking_kind, source_revision_id, manifest_digest, effective_naming_digest
         )
         SELECT
            id, tenant_id, input_set_id, source_id, source_layer, layer_order,
            tracking_kind, source_revision_id, manifest_digest, effective_naming_digest
           FROM plan_revision_inputs_v17",
    )?;
    tx.execute_batch("DROP TABLE plan_revision_inputs_v17")?;
    tx.execute_batch(unique_index)?;
    tx.execute_batch(tenant_index)?;
    // Historical Node's empty rebuild records sqlite_sequence.seq = 0. Current
    // fresh initialization never inserts that row. The next AUTOINCREMENT id is
    // 1 either way, so drop only the empty marker and leave a real sequence.
    let has_sequence: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence')",
        [],
        |row| row.get(0),
    )?;
    if has_sequence {
        tx.execute_batch(
            "DELETE FROM sqlite_sequence
              WHERE name = 'plan_revision_inputs'
                AND seq = 0
                AND NOT EXISTS (SELECT 1 FROM plan_revision_inputs)",
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn realign_equivalent_indexes_and_triggers(
    conn: &mut Connection,
    migrations: &[String],
) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND type IN ('index', 'trigger')
            AND name NOT LIKE 'sqlite_%'",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut replacements = Vec::new();
    for (kind, name, sql) in rows {
        let identity = sql_identity(&sql);
        let mut matches = migrations
            .iter()
            .filter(|statement| sql_identity(statement) == identity);
        let Some(canonical) = matches.next() else {
            continue;
        };
        // sqlite_master omits the leading IF NOT EXISTS that schema.json keeps.
        // A raw compare is therefore false for every matching object and this
        // path drops and recreates it on every open. Compare the stored form.
        if matches.next().is_some() || sqlite_catalog_sql(canonical) == sqlite_catalog_sql(&sql) {
            continue;
        }
        replacements.push((kind, name, canonical.clone()));
    }
    if replacements.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (kind, name, statement) in &replacements {
        let drop_sql = match kind.as_str() {
            "index" => format!("DROP INDEX {}", quote_sql_ident(name)),
            "trigger" => format!("DROP TRIGGER {}", quote_sql_ident(name)),
            other => bail!("Refusing to realign {other} {name}"),
        };
        tx.execute_batch(&drop_sql)?;
        tx.execute_batch(statement)?;
    }
    tx.commit()?;
    Ok(())
}

fn execute_migration(conn: &Connection, sql: &str) -> Result<()> {
    match conn.execute_batch(sql) {
        Ok(()) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if sql.starts_with("ALTER TABLE ")
                && message.starts_with("duplicate column name: ") =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_ignores_only_sqlite_duplicate_column_errors() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE existing (id INTEGER)")
            .unwrap();
        let sql = "ALTER TABLE existing ADD COLUMN added TEXT";
        execute_migration(&conn, sql).unwrap();
        execute_migration(&conn, sql).unwrap();
        let error = execute_migration(
            &conn,
            "ALTER TABLE \"duplicate column name\" ADD COLUMN added TEXT",
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("no such table: "));
    }
}
