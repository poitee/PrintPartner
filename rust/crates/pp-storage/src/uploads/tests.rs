use super::{expected, validate_schema};
use crate::{Limits, WriterOwner, schema::SchemaReady, tests::directory};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

fn immutable(path: &Path) -> Connection {
    Connection::open_with_flags(
        format!("file:{}?immutable=1", path.display()),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap()
}

fn version_at(path: &Path) -> String {
    immutable(path)
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn backups(directory: &Path) -> Vec<(String, String, Vec<u8>)> {
    let Ok(entries) = std::fs::read_dir(directory.join("backups")) else {
        return Vec::new();
    };
    let mut found: Vec<_> = entries
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                version_at(&path),
                std::fs::read(&path).unwrap(),
            )
        })
        .collect();
    found.sort();
    found
}

fn upgrade(label: &str, input: &[u8]) -> (PathBuf, SchemaReady) {
    let directory = directory(label);
    std::fs::write(directory.join("print-partner.db"), input).unwrap();
    let (owner, ready) = WriterOwner::open(&directory, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    (directory, ready)
}

fn assert_reopen_is_noop(directory: &Path) {
    let before = backups(directory);
    let (owner, ready) = WriterOwner::open(directory, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    assert_eq!(
        (ready.version, ready.previous_version, ready.backup),
        (39, 39, None)
    );
    assert_eq!(backups(directory), before);
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    validate_schema(&connection, 39).unwrap();
}

#[test]
fn each_upgrade_step_backs_up_its_input_before_writing() {
    let node = include_bytes!("../../tests/fixtures/accepted-plan-node.db");
    let (from34, ready) = upgrade("uploads-from34", node);
    assert_eq!((ready.version, ready.previous_version), (39, 34));
    assert_eq!(ready.backup, Some(from34.join("backups/pre-schema37.db")));
    let chain = backups(&from34);
    let names: Vec<_> = chain
        .iter()
        .map(|(name, version, _)| (name.as_str(), version.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("pre-schema37.db", "34"),
            ("pre-schema38.db", "37"),
            ("pre-schema39.db", "38"),
        ]
    );
    for (name, version) in [("pre-schema38.db", 37), ("pre-schema39.db", 38)] {
        let saved = immutable(&from34.join("backups").join(name));
        validate_schema(&saved, version).unwrap();
        crate::plan_publication::validate_schema(&saved, version).unwrap();
    }
    assert_reopen_is_noop(&from34);

    let at37 = &chain[1].2;
    let at38 = &chain[2].2;
    let schema35 = directory("uploads-schema35");
    std::fs::write(schema35.join("schema37.db"), at37).unwrap();
    let raw = Connection::open(schema35.join("schema37.db")).unwrap();
    raw.execute_batch("DROP TABLE plan_apply_admissions; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'")
        .unwrap();
    raw.backup("main", schema35.join("schema35.db"), None)
        .unwrap();
    let at35 = std::fs::read(schema35.join("schema35.db")).unwrap();

    for (label, input, previous, steps) in [
        ("uploads-from35", &at35, 35, &[37, 38, 39][..]),
        ("uploads-from37", at37, 37, &[38, 39][..]),
        ("uploads-from38", at38, 38, &[39][..]),
    ] {
        let (directory, ready) = upgrade(label, input);
        assert_eq!((ready.version, ready.previous_version), (39, previous));
        let first = format!("pre-schema{}.db", steps[0]);
        assert_eq!(ready.backup, Some(directory.join("backups").join(&first)));
        let saved = backups(&directory);
        let names: Vec<_> = saved.iter().map(|(name, _, _)| name.clone()).collect();
        let expected: Vec<_> = steps
            .iter()
            .map(|step| format!("pre-schema{step}.db"))
            .collect();
        assert_eq!(names, expected, "{label}");
        assert!(
            saved[0].2 == *input,
            "{label} backup differs from its input"
        );
        assert_eq!(saved[0].1, previous.to_string(), "{label}");
        assert_reopen_is_noop(&directory);
    }
}

#[test]
fn failed_step_backup_aborts_before_the_step_writes() {
    let node = include_bytes!("../../tests/fixtures/accepted-plan-node.db");
    let (from34, _) = upgrade("uploads-abort-source", node);
    for (input, step, version) in [("pre-schema38.db", 38, "37"), ("pre-schema39.db", 39, "38")] {
        let directory = directory(&format!("uploads-abort-{step}"));
        let database = directory.join("print-partner.db");
        std::fs::copy(from34.join("backups").join(input), &database).unwrap();
        let before = std::fs::read(&database).unwrap();
        let blocked = directory.join(format!("backups/pre-schema{step}.db"));
        std::fs::create_dir_all(&blocked).unwrap();
        let error = WriterOwner::open(&directory, Limits::default())
            .err()
            .unwrap();
        assert!(
            format!("{error:#}").contains("schema::backup: rename temporary backup"),
            "{error:#}"
        );
        assert!(
            std::fs::read(&database).unwrap() == before,
            "{step} input changed"
        );
        assert_eq!(version_at(&database), version);
        assert_eq!(
            std::fs::read_dir(directory.join("backups"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir(&blocked).unwrap();
        let (owner, ready) = WriterOwner::open(&directory, Limits::default()).unwrap();
        owner.shutdown().unwrap();
        assert_eq!(ready.backup, Some(blocked.clone()));
        assert!(
            std::fs::read(&blocked).unwrap() == before,
            "{step} backup differs"
        );
    }
}

#[test]
fn fresh_database_installs_schema39_without_backups() {
    let directory = directory("uploads-fresh");
    let (owner, ready) = WriterOwner::open(&directory, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    assert_eq!(
        (ready.version, ready.previous_version, ready.backup),
        (39, 0, None)
    );
    assert!(!directory.join("backups").exists());
    assert_reopen_is_noop(&directory);
}

#[test]
fn validator_matches_each_version_threshold() {
    for version in [35, 37, 38, 39] {
        let connection = expected(version).unwrap();
        for candidate in [35, 37, 38, 39] {
            let result = validate_schema(&connection, candidate);
            let installed = |v: u64| if v < 38 { 0 } else { v };
            if installed(candidate) == installed(version) {
                result.unwrap();
            } else {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "Source import schema mismatch",
                    "{version} as {candidate}"
                );
            }
        }
    }
}

#[test]
fn validator_refuses_drifted_objects_and_columns() {
    let connection = expected(39).unwrap();
    connection
        .execute_batch("DROP TRIGGER trg_source_preclaim_refusals_cursor_insert")
        .unwrap();
    assert_eq!(
        validate_schema(&connection, 39).unwrap_err().to_string(),
        "Source import schema mismatch"
    );

    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE projects(id INTEGER PRIMARY KEY);
             CREATE TABLE source_revisions(id INTEGER PRIMARY KEY);
             CREATE TABLE source_docs(id INTEGER PRIMARY KEY);",
        )
        .unwrap();
    let columns = super::COLUMNS.replace("DEFAULT 1", "DEFAULT 2");
    for sql in [
        columns.as_str(),
        include_str!("schema.sql"),
        include_str!("../remote_sources/schema.sql"),
        include_str!("../remote_sources/preclaim39.sql"),
    ] {
        connection.execute_batch(sql).unwrap();
    }
    assert_eq!(
        validate_schema(&connection, 39).unwrap_err().to_string(),
        "Source revision column schema mismatch: projects.source_configuration_version"
    );
}

fn refusal(rows: &str) -> String {
    let connection = expected(39).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON")
        .unwrap();
    connection.execute_batch(rows).unwrap();
    validate_schema(&connection, 39).unwrap_err().to_string()
}

#[test]
fn validator_refuses_rows_outside_the_schema_invariants() {
    for (rows, message) in [
        (
            "INSERT INTO source_import_quota VALUES('t','k',0,0,0)",
            "Orphan Source quota",
        ),
        (
            "INSERT INTO source_docs(id,input_digest) VALUES(1,'x')",
            "Partial Source document provenance",
        ),
        (
            "INSERT INTO source_revisions(id,source_configuration_version) VALUES(1,1)",
            "Partial Source revision provenance",
        ),
        (
            "INSERT INTO source_revision_observations VALUES('t','k',1,'p','j',1,NULL,NULL,1,0,'now')",
            "Invalid Source observation context",
        ),
        (
            "INSERT INTO source_preclaim_refusals VALUES('t','k',1,'other','j',0,0,'now')",
            "Invalid Source preclaim refusal",
        ),
    ] {
        assert_eq!(refusal(rows), message);
    }
    let digest = "0".repeat(64);
    let trigger: String = expected(39)
        .unwrap()
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='trg_source_preclaim_refusals_cursor_insert'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        refusal(&format!(
            "INSERT INTO source_revisions VALUES(1,1,'{digest}','{digest}','v');
             INSERT INTO source_revision_observations VALUES('t','k',1,'p','j',1,NULL,1,1,0,'now');
             DROP TRIGGER trg_source_preclaim_refusals_cursor_insert;
             INSERT INTO source_preclaim_refusals VALUES('t','k',1,'authority_refused','j',0,0,'now');
             {trigger};"
        )),
        "Source observation cursor collision"
    );
}

fn schema37_input(label: &str, edit: &str) -> Vec<u8> {
    let node = include_bytes!("../../tests/fixtures/accepted-plan-node.db");
    let (from34, _) = upgrade(&format!("{label}-source"), node);
    let path = from34.join("backups/pre-schema38.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch(edit)
        .unwrap();
    assert_eq!(version_at(&path), "37");
    std::fs::read(&path).unwrap()
}

fn starters(path: &Path) -> i64 {
    immutable(path)
        .query_row(
            "SELECT count(*) FROM printer_profiles WHERE tenant_id='default' AND name='Generic Klipper Machine'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

// The backup API rewrites header counters for a WAL input, so backups are
// compared by schema and rows rather than by bytes.
fn contents(path: &Path) -> Vec<String> {
    let connection = immutable(path);
    let mut found: Vec<String> = connection
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name")
        .unwrap()
        .query_map([], |row| {
            Ok(format!(
                "{:?}",
                (
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?
                )
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for table in tables {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
            .or_else(|_| connection.prepare(&format!("SELECT * FROM \"{table}\"")))
            .unwrap();
        let width = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..width)
                    .map(|index| row.get::<_, rusqlite::types::Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .map(|row| format!("{table} {:?}", row.unwrap()));
        found.extend(rows);
    }
    found
}

#[test]
fn step_backups_precede_starter_seed_writes() {
    let input = schema37_input(
        "uploads-seed",
        "UPDATE printer_profiles SET name='Renamed starter' WHERE tenant_id='default' AND name='Generic Klipper Machine'",
    );

    let blocked = directory("uploads-seed-blocked");
    let database = blocked.join("print-partner.db");
    std::fs::write(&database, &input).unwrap();
    assert_eq!(starters(&database), 0);
    let original = contents(&database);
    std::fs::create_dir_all(blocked.join("backups/pre-schema38.db")).unwrap();
    let error = WriterOwner::open(&blocked, Limits::default())
        .err()
        .unwrap();
    assert!(
        format!("{error:#}").contains("schema::backup: rename temporary backup"),
        "{error:#}"
    );
    assert!(
        std::fs::read(&database).unwrap() == input,
        "refused open changed the database"
    );
    assert_eq!(version_at(&database), "37");
    assert_eq!(starters(&database), 0);

    let (directory, ready) = upgrade("uploads-seed-open", &input);
    let saved = directory.join("backups/pre-schema38.db");
    assert_eq!(ready.backup, Some(saved.clone()));
    assert_eq!(starters(&saved), 0);
    assert_eq!(contents(&saved), original);
    assert_eq!(starters(&directory.join("backups/pre-schema39.db")), 0);
    // The seeded row may still sit in the WAL, which an immutable reader skips.
    let live: i64 = Connection::open(directory.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT count(*) FROM printer_profiles WHERE tenant_id='default' AND name='Generic Klipper Machine'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live, 1);
    assert_reopen_is_noop(&directory);
}

#[test]
fn step_refuses_drifted_existing_columns_before_its_stamp() {
    for (label, edit, column) in [
        (
            "uploads-column-type",
            "ALTER TABLE projects ADD COLUMN source_configuration_version TEXT",
            "projects.source_configuration_version",
        ),
        (
            "uploads-column-foreign-key",
            "ALTER TABLE source_docs ADD COLUMN source_revision_id INTEGER",
            "source_docs.source_revision_id",
        ),
    ] {
        let input = schema37_input(label, edit);
        let directory = directory(&format!("{label}-open"));
        let database = directory.join("print-partner.db");
        std::fs::write(&database, &input).unwrap();
        let original = contents(&database);
        for _ in 0..2 {
            let error = WriterOwner::open(&directory, Limits::default())
                .err()
                .unwrap();
            assert_eq!(version_at(&database), "37", "{label}");
            assert_eq!(contents(&database), original, "{label}");
            assert!(
                format!("{error:#}")
                    .contains(&format!("Source revision column schema mismatch: {column}")),
                "{label}: {error:#}"
            );
        }
    }

    let input = schema37_input(
        "uploads-column-kept",
        "ALTER TABLE projects ADD COLUMN source_configuration_version INTEGER NOT NULL DEFAULT 1",
    );
    let (directory, ready) = upgrade("uploads-column-kept-open", &input);
    assert_eq!((ready.version, ready.previous_version), (39, 37));
    assert_reopen_is_noop(&directory);
}

fn live(directory: &Path, sql: &str) -> rusqlite::types::Value {
    Connection::open(directory.join("print-partner.db"))
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

// Fixture revision 1 is its project's active revision.
fn tenant_mismatch_with_provenance() -> String {
    let digest = |c: char| c.to_string().repeat(64);
    format!(
        "{}UPDATE source_revisions SET tenant_id='old-tenant',source_configuration_version=3,activation_observation_digest='{}',input_digest='{}',producer_version='probe' WHERE id=1;",
        super::COLUMNS,
        digest('a'),
        digest('b')
    )
}

const REVISION: &str = "SELECT tenant_id||':'||source_configuration_version||':'||producer_version FROM source_revisions WHERE id=1";

#[test]
fn steps_run_after_the_tenant_repair() {
    let input = schema37_input("uploads-repair", &tenant_mismatch_with_provenance());
    let (directory, ready) = upgrade("uploads-repair-open", &input);
    assert_eq!((ready.version, ready.previous_version), (39, 37));
    assert_eq!(
        live(&directory, REVISION),
        "default:3:probe".to_owned().into()
    );
    let saved = immutable(&directory.join("backups/pre-schema38.db"));
    let tenant: String = saved
        .query_row(
            "SELECT tenant_id FROM source_revisions WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tenant, "old-tenant");
    assert_reopen_is_noop(&directory);
}

#[test]
fn steps_run_after_missing_common_tables_are_restored() {
    let input = schema37_input("uploads-restore", "DROP TABLE source_docs");
    let (directory, ready) = upgrade("uploads-restore-open", &input);
    assert_eq!((ready.version, ready.previous_version), (39, 37));
    assert_eq!(
        live(&directory, "SELECT count(*) FROM source_docs"),
        0.into()
    );
    assert_reopen_is_noop(&directory);
}

#[test]
fn renamed_starter_and_tenant_repair_upgrade_with_the_seed_last() {
    let input = schema37_input(
        "uploads-repair-seed",
        &format!(
            "{}UPDATE printer_profiles SET name='Renamed starter' WHERE tenant_id='default' AND name='Generic Klipper Machine';",
            tenant_mismatch_with_provenance()
        ),
    );
    let directory = directory("uploads-repair-seed-open");
    let database = directory.join("print-partner.db");
    std::fs::write(&database, &input).unwrap();
    let original = contents(&database);
    assert_eq!(starters(&database), 0);
    let (owner, ready) = WriterOwner::open(&directory, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    assert_eq!((ready.version, ready.previous_version), (39, 37));
    let first = directory.join("backups/pre-schema38.db");
    assert_eq!(ready.backup, Some(first.clone()));
    assert_eq!(contents(&first), original);
    assert_eq!(starters(&directory.join("backups/pre-schema39.db")), 0);
    assert_eq!(
        live(&directory, REVISION),
        "default:3:probe".to_owned().into()
    );
    let seeded = "SELECT count(*) FROM printer_profiles WHERE tenant_id='default' AND name='Generic Klipper Machine'";
    assert_eq!(live(&directory, seeded), 1.into());
    assert_reopen_is_noop(&directory);
}
