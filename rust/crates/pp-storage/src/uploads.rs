use anyhow::{Result, anyhow, ensure};
use rusqlite::Connection;
use std::collections::BTreeSet;

#[cfg(test)]
mod tests;

const COLUMNS: &str = include_str!("remote_sources/columns38.sql");

type Install = fn(&Connection) -> Result<()>;

pub(crate) const SCHEMA_STEPS: [(u64, Install); 2] =
    [(38, install_imports), (39, install_preclaim)];

fn install_imports(connection: &Connection) -> Result<()> {
    for (table, column, definition) in added_columns()? {
        crate::schema::add_column(
            connection,
            table,
            column,
            &format!("ALTER TABLE {table} ADD COLUMN {definition}"),
        )?;
    }
    connection.execute_batch(include_str!("uploads/schema.sql"))?;
    Ok(connection.execute_batch(include_str!("remote_sources/schema.sql"))?)
}

fn install_preclaim(connection: &Connection) -> Result<()> {
    Ok(connection.execute_batch(include_str!("remote_sources/preclaim39.sql"))?)
}

type Object = (String, String, Option<String>);

fn objects(connection: &Connection) -> Result<Vec<Object>> {
    Ok(connection
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

fn expected(version: u64) -> Result<Connection> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(
        "CREATE TABLE projects(id INTEGER PRIMARY KEY);
         CREATE TABLE source_revisions(id INTEGER PRIMARY KEY);
         CREATE TABLE source_docs(id INTEGER PRIMARY KEY);",
    )?;
    for (step, install) in SCHEMA_STEPS {
        if step <= version {
            install(&expected)?;
        }
    }
    Ok(expected)
}

pub(crate) fn owned_objects() -> Result<BTreeSet<String>> {
    let stubs: BTreeSet<String> = objects(&expected(0)?)?
        .into_iter()
        .map(|(_, name, _)| name)
        .collect();
    Ok(objects(&expected(u64::MAX)?)?
        .into_iter()
        .map(|(_, name, _)| name)
        .filter(|name| !stubs.contains(name))
        .collect())
}

pub(crate) fn added_columns() -> Result<Vec<(&'static str, &'static str, &'static str)>> {
    COLUMNS
        .lines()
        .map(|statement| {
            let words: Vec<&str> = statement.split_whitespace().collect();
            let definition = statement
                .split_once(" ADD COLUMN ")
                .map(|(_, definition)| definition.trim_end_matches(';'));
            match (words.get(2), words.get(5), definition) {
                (Some(table), Some(column), Some(definition)) => Ok((*table, *column, definition)),
                _ => Err(anyhow!("Invalid Source column migration")),
            }
        })
        .collect()
}

pub(crate) fn validate_schema(connection: &Connection, version: u64) -> Result<()> {
    let owned = owned_objects()?;
    let actual: Vec<Object> = objects(connection)?
        .into_iter()
        .filter(|(_, name, _)| owned.contains(name))
        .collect();
    let expected: Vec<Object> = objects(&expected(version)?)?
        .into_iter()
        .filter(|(_, name, _)| owned.contains(name))
        .collect();
    ensure!(actual == expected, "Source import schema mismatch");
    if version < SCHEMA_STEPS[0].0 {
        return Ok(());
    }
    for (table, column, definition) in added_columns()? {
        ensure!(
            column_definition(connection, table, column)? == definition,
            "Source revision column schema mismatch: {table}.{column}"
        );
    }
    for (check, message) in [
        (
            "SELECT EXISTS(SELECT 1 FROM source_import_quota q LEFT JOIN source_import_operations o USING(tenant,operation_key) WHERE o.tenant IS NULL)",
            "Orphan Source quota",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_docs WHERE NOT ((source_revision_id IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_revision_id IS NOT NULL AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL)))",
            "Partial Source document provenance",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_revisions WHERE NOT ((source_configuration_version IS NULL AND activation_observation_digest IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_configuration_version IS NOT NULL AND activation_observation_digest IS NOT NULL AND length(activation_observation_digest) = 64 AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL)))",
            "Partial Source revision provenance",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_revision_observations WHERE attempt_generation <= 0 OR cancel_requested NOT IN (0,1) OR receipt_activated NOT IN (0,1) OR (receipt_activated IS NOT NULL AND revision_id IS NULL))",
            "Invalid Source observation context",
        ),
    ] {
        let failed: bool = connection.query_row(check, [], |row| row.get(0))?;
        ensure!(!failed, "{message}");
    }
    if version < SCHEMA_STEPS[1].0 {
        return Ok(());
    }
    for (check, message) in [
        (
            "SELECT EXISTS(SELECT 1 FROM source_preclaim_refusals WHERE cursor<=0 OR phase!='authority_refused' OR admitted_generation!=0 OR cancel_requested NOT IN (0,1))",
            "Invalid Source preclaim refusal",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_preclaim_refusals p JOIN source_revision_observations o USING(tenant_id,operation_key,cursor))",
            "Source observation cursor collision",
        ),
    ] {
        let failed: bool = connection.query_row(check, [], |row| row.get(0))?;
        ensure!(!failed, "{message}");
    }
    Ok(())
}

fn column_definition(connection: &Connection, table: &str, column: &str) -> Result<String> {
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    let body = &sql[sql
        .find('(')
        .ok_or_else(|| anyhow!("Missing table definition"))?
        + 1..];
    let mut depth = 0;
    let mut literal = false;
    let mut start = 0;
    for (index, character) in body.char_indices() {
        if character == '\'' {
            literal = !literal;
        }
        if literal {
            continue;
        }
        if character == '(' {
            depth += 1;
        } else if (character == ',' || character == ')') && depth == 0 {
            let definition = body[start..index].trim();
            if definition.split_whitespace().next() == Some(column) {
                return Ok(definition.to_owned());
            }
            start = index + 1;
        } else if character == ')' {
            depth -= 1;
        }
    }
    Err(anyhow!("Missing Source column definition {table}.{column}"))
}
