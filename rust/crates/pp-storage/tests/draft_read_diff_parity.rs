#![cfg(feature = "desktop_rebuild")]

use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
    working_drafts::{PositiveId, Request, WorkingDraftClient},
};
use rusqlite::{Connection, OpenFlags, types::Value as SqlValue};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

struct Fixture {
    path: PathBuf,
    case: Value,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../fixtures/parity/draft-read-diff/node.json"
        ))
        .unwrap();
        let case = cases.into_iter().find(|case| case["name"] == name).unwrap();
        let path = std::env::temp_dir().join(format!(
            "pp-draft-read-diff-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("print-partner.db"),
            include_bytes!("fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        let fixture = Self { path, case };
        let sql = Connection::open(fixture.path.join("print-partner.db")).unwrap();
        sql.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        for statement in fixture.case["setup"].as_array().unwrap() {
            let params = statement["params"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| match value {
                    Value::Null => SqlValue::Null,
                    Value::String(value) => SqlValue::Text(value.clone()),
                    Value::Number(value) => SqlValue::Integer(value.as_i64().unwrap()),
                    _ => panic!("Invalid fixture parameter {value}"),
                })
                .collect::<Vec<_>>();
            sql.execute(
                statement["sql"].as_str().unwrap(),
                rusqlite::params_from_iter(params),
            )
            .unwrap();
        }
        fixture
    }
    fn open(&self) -> WriterOwner {
        WriterOwner::open(&self.path, Limits::default()).unwrap().0
    }
    fn observer(&self) -> Connection {
        Connection::open_with_flags(
            self.path.join("print-partner.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
fn id(value: u64) -> PositiveId {
    PositiveId::new(value).unwrap()
}
fn body(client: &WorkingDraftClient, check: &Value) -> String {
    let draft_id = || id(check["draftId"].as_u64().unwrap());
    let request = match check["request"].as_str().unwrap() {
        "list" => Request::List,
        "read" => Request::Read {
            draft_id: draft_id(),
        },
        "diff" => Request::Diff {
            draft_id: draft_id(),
        },
        "workspace" => Request::Workspace {
            draft_id: draft_id(),
        },
        other => panic!("Unknown fixture request {other}"),
    };
    String::from_utf8(
        client
            .execute(
                Credential::Session(Secret::new("required-unit-fixture-secret".into())),
                id(check["profileId"].as_u64().unwrap()),
                request,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
            .into_json_body()
            .unwrap()
            .into_bytes(),
    )
    .unwrap()
}
fn compare_body(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    let index = actual
        .bytes()
        .zip(expected.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or(actual.len().min(expected.len()));
    let excerpt = |value: &str| {
        String::from_utf8_lossy(
            &value.as_bytes()[index.saturating_sub(20)..(index + 160).min(value.len())],
        )
        .into_owned()
    };
    Err(format!(
        "Body differs at byte {index}. Rust {:?}, Node {:?}",
        excerpt(actual),
        excerpt(expected)
    ))
}

type Rows = Vec<(String, Vec<Vec<SqlValue>>)>;
fn observe(sql: &Connection) -> (i64, Rows) {
    let version = sql
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    let mut tables = sql
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap();
    let tables = tables
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    let rows = tables
        .into_iter()
        .map(|table| {
            let quoted = table.replace('"', "\"\"");
            let mut statement = sql.prepare(&format!("SELECT * FROM \"{quoted}\"")).unwrap();
            let count = statement.column_count();
            let mut rows = statement
                .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
                .unwrap()
                .map(Result::unwrap)
                .collect::<Vec<Vec<SqlValue>>>();
            rows.sort_by_cached_key(|row| format!("{row:?}"));
            (table, rows)
        })
        .collect();
    (version, rows)
}
fn compare_node(name: &str) {
    let fixture = Fixture::new(name);
    let owner = fixture.open();
    let observer = fixture.observer();
    let before = observe(&observer);
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    for _ in 0..2 {
        for check in fixture.case["checks"].as_array().unwrap() {
            compare_body(&body(&client, check), check["body"].as_str().unwrap())
                .unwrap_or_else(|error| panic!("{name} {}. {error}", check["name"]));
        }
        assert_eq!(observe(&observer), before, "{name} reads mutated SQLite");
    }
    owner.shutdown().unwrap();
    let owner = fixture.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    for check in fixture.case["checks"].as_array().unwrap() {
        compare_body(&body(&client, check), check["body"].as_str().unwrap())
            .unwrap_or_else(|error| panic!("{name} {} after reopen. {error}", check["name"]));
    }
    assert_eq!(
        observe(&observer),
        before,
        "{name} reopened reads mutated SQLite"
    );
    owner.shutdown().unwrap();
}

#[test]
fn open0_full_bodies_match_node() {
    compare_node("open0");
}
#[test]
fn abandoned1_full_bodies_match_node() {
    compare_node("abandoned1");
}
#[test]
fn resumed2_full_bodies_match_node() {
    compare_node("resumed2");
}
#[test]
fn abandoned3_full_bodies_match_node() {
    compare_node("abandoned3");
}
#[test]
fn list_orders_creation_before_id_and_breaks_ties_by_id() {
    compare_node("list-created-before-id");
}
#[test]
fn comparison_rejects_lifecycle_changes_and_omitted_diff_fields_in_runtime_output() {
    let fixture = Fixture::new("abandoned3");
    let owner = fixture.open();
    let observer = fixture.observer();
    let before = observe(&observer);
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    for (name, original, replacement) in [
        (
            "target-read",
            "\"lifecycleVersion\":3",
            "\"lifecycleVersion\":4",
        ),
        ("target-diff", "\"baseIsCurrent\":true,", ""),
    ] {
        let check = fixture.case["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["name"] == name)
            .unwrap();
        let actual = body(&client, check);
        let expected = check["body"].as_str().unwrap();
        compare_body(&actual, expected).unwrap();
        assert_eq!(actual.matches(original).count(), 1);
        let mutant = actual.replacen(original, replacement, 1);
        serde_json::from_str::<Value>(&mutant).unwrap();
        assert!(
            compare_body(&mutant, expected).is_err(),
            "{name} mutation escaped the parity comparison"
        );
    }
    assert_eq!(observe(&observer), before);
    owner.shutdown().unwrap();
}
