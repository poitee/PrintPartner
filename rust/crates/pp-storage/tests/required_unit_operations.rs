#![cfg(feature = "desktop_rebuild")]
use pp_domain::PositiveId;
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
    required_units::{Failure, ReconciliationClient, ReconciliationCommand, ReconciliationRequest},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

#[path = "common/process.rs"]
mod child_process;

const UNCHANGED: (&[u8], &str) = (
    include_bytes!("fixtures/required-units/unchanged.db"),
    include_str!("fixtures/required-units/unchanged.json"),
);
const SHRINK: (&[u8], &str) = (
    include_bytes!("fixtures/required-units/shrink.db"),
    include_str!("fixtures/required-units/shrink.json"),
);
const UNSAFE: (&[u8], &str) = (
    include_bytes!("fixtures/required-units/unsafe.db"),
    include_str!("fixtures/required-units/unsafe.json"),
);

fn token(n: u8) -> String {
    format!("ppu_{n:032x}")
}

fn session() -> Credential {
    Credential::Session(Secret::new("required-unit-fixture-secret".into()))
}

fn neutral() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}

fn strict() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::FirstAccountOnly,
        session_tenant: auth::SessionTenantPolicy::SingleAccountDefault,
        first_user: auth::FirstUserTenant::NewUser,
    }
}

struct Fixture {
    path: PathBuf,
    case: Value,
}

impl Fixture {
    fn new((database, case): (&[u8], &str)) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-required-units-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("print-partner.db"), database).unwrap();
        Self {
            path,
            case: serde_json::from_str(case).unwrap(),
        }
    }

    fn open(&self) -> WriterOwner {
        WriterOwner::open(&self.path, Limits::default()).unwrap().0
    }

    fn sql(&self) -> Connection {
        Connection::open(self.path.join("print-partner.db")).unwrap()
    }

    fn request(&self) -> Value {
        self.case["request"].clone()
    }

    fn command(&self, key: &str, request: Value, credential: Credential) -> ReconciliationCommand {
        self.command_for(1, 2, key, request, credential)
    }

    fn command_for(
        &self,
        profile: u64,
        draft: u64,
        key: &str,
        request: Value,
        credential: Credential,
    ) -> ReconciliationCommand {
        ReconciliationCommand::new(
            PositiveId::new(profile).unwrap(),
            PositiveId::new(draft).unwrap(),
            serde_json::from_value(request).unwrap(),
            key,
            credential,
        )
        .unwrap()
    }

    fn run(
        &self,
        client: &ReconciliationClient,
        command: ReconciliationCommand,
    ) -> anyhow::Result<Value> {
        let outcome = client.reconcile(
            command,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )?;
        Ok(serde_json::to_value(outcome)?)
    }

    fn call(
        &self,
        client: &ReconciliationClient,
        key: &str,
        request: Value,
    ) -> anyhow::Result<Value> {
        self.run(client, self.command(key, request, session()))
    }

    fn rows(&self, sql: &str) -> Vec<Value> {
        let connection = self.sql();
        let mut statement = connection.prepare(sql).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|i| {
                        Ok(match row.get_ref(i)? {
                            rusqlite::types::ValueRef::Null => Value::Null,
                            rusqlite::types::ValueRef::Integer(n) => json!(n),
                            value => json!(value.as_str().unwrap()),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map(Value::from)
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn count(&self, table: &str) -> i64 {
        self.sql()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn selection(&self) -> Vec<Value> {
        self.rows("SELECT id,state,digest_format,current_required_unit_reconciliation_id,snapshot_digest FROM plan_drafts WHERE id=2")
    }

    fn assignments(&self, reconciliation: i64) -> Vec<Value> {
        self.rows(&format!("SELECT target_draft_part_id,unit_index,kind,required_unit_token FROM plan_draft_required_unit_assignments WHERE reconciliation_id={reconciliation} ORDER BY target_draft_part_id,unit_index"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn reuse(part: i64, index: i64, n: u8) -> Value {
    json!([part, index, "reuse", token(n)])
}

#[test]
fn unchanged_draft_matches_node_and_replays_after_restart() {
    let f = Fixture::new(UNCHANGED);
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let first = f.call(&client, "selection", f.request()).unwrap();
    assert_eq!(first, f.case["result"]);
    let digest = &first["workspace"]["draft"]["snapshot_digest"];
    assert_eq!(
        f.selection(),
        [json!([2, "open", "plan-draft-v2", 2, digest])]
    );
    assert_eq!(
        f.rows("SELECT id,actor_id,idempotency_key,result_kind,expected_assignment_count,finalized_at IS NOT NULL FROM plan_draft_required_unit_reconciliations ORDER BY id"),
        [
            json!([1, "default", "baseline", "ready", 6, 1]),
            json!([2, "default", "selection", "ready", 6, 1])
        ]
    );
    assert_eq!(
        f.assignments(2),
        [
            reuse(4, 0, 1),
            reuse(4, 1, 2),
            reuse(4, 2, 3),
            reuse(5, 0, 4),
            reuse(6, 0, 5),
            reuse(6, 1, 6)
        ]
    );
    owner.shutdown().unwrap();
    let before = f.rows("SELECT * FROM plan_draft_required_unit_reconciliations ORDER BY id");
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    assert_eq!(f.call(&client, "selection", f.request()).unwrap(), first);
    assert_eq!(
        f.rows("SELECT * FROM plan_draft_required_unit_reconciliations ORDER BY id"),
        before
    );
    owner.shutdown().unwrap();
}

#[test]
fn completed_shrink_selection_stays_frozen() {
    let f = Fixture::new(SHRINK);
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let first = f.call(&client, "selection", f.request()).unwrap();
    assert_eq!(first, f.case["result"]);
    assert_eq!(
        f.assignments(2),
        [
            reuse(4, 0, 1),
            reuse(4, 1, 3),
            reuse(5, 0, 4),
            reuse(6, 0, 5),
            reuse(6, 1, 6)
        ]
    );
    let stored = "SELECT selection_basis_json,result_json FROM plan_draft_required_unit_reconciliations WHERE id=2";
    let basis = json!([
        {"revisionPartId":1,"token":token(1),"priorIndex":0,"createdAt":"2026-08-20T12:00:00.000Z","completed":false,"assembled":false},
        {"revisionPartId":1,"token":token(2),"priorIndex":1,"createdAt":"2026-08-20T12:00:00.000Z","completed":false,"assembled":false},
        {"revisionPartId":1,"token":token(3),"priorIndex":2,"createdAt":"2026-08-20T12:00:00.000Z","completed":true,"assembled":false}
    ]);
    let frozen = f.rows(stored);
    assert_eq!(
        serde_json::from_str::<Value>(frozen[0][0].as_str().unwrap()).unwrap(),
        basis
    );
    assert_eq!(
        serde_json::from_str::<Value>(frozen[0][1].as_str().unwrap()).unwrap()["surplus"],
        json!([token(2)])
    );
    owner.shutdown().unwrap();
    f.sql()
        .execute("UPDATE print_progress SET completed=0,assembled=0", [])
        .unwrap();
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    assert_eq!(f.call(&client, "selection", f.request()).unwrap(), first);
    assert_eq!(f.rows(stored), frozen);
    owner.shutdown().unwrap();
}

#[test]
fn unresolved_replacement_supersession_and_changed_payload() {
    let f = Fixture::new(UNSAFE);
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let first = f.call(&client, "selection", f.request()).unwrap();
    assert_eq!(first, f.case["result"]);
    assert_eq!(f.assignments(2), Vec::<Value>::new());
    let replace = json!({
        "expected_snapshot_digest":first["workspace"]["draft"]["snapshot_digest"],
        "decisions":[{"kind":"replace","target_draft_part_id":4}]
    });
    assert_eq!(
        f.call(&client, "selection", replace.clone()).unwrap(),
        json!({"kind":"idempotency_conflict"})
    );
    let ready = f.call(&client, "replacement", replace).unwrap();
    assert_eq!(
        ready["workspace"]["reconciliation"],
        json!({"kind":"ready","reused_units":3,"new_units":3,"surplus_units":3})
    );
    assert_eq!(
        f.rows("SELECT reconciliation_id,target_draft_part_id,kind,predecessor_revision_part_id FROM plan_draft_required_unit_decisions"),
        [json!([3, 4, "replace", null])]
    );
    assert_eq!(
        f.assignments(3),
        [
            json!([4, 0, "create", null]),
            json!([4, 1, "create", null]),
            json!([4, 2, "create", null]),
            reuse(5, 0, 4),
            reuse(6, 0, 5),
            reuse(6, 1, 6)
        ]
    );
    assert_eq!(
        f.call(&client, "selection", f.request()).unwrap(),
        json!({"kind":"draft_changed"})
    );
    assert_eq!(f.count("plan_draft_required_unit_reconciliations"), 3);
    owner.shutdown().unwrap();
}

#[test]
fn missing_closed_and_stale_drafts_return_node_outcomes_without_writes() {
    let f = Fixture::new(UNCHANGED);
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let before = f.count("plan_draft_required_unit_reconciliations");
    let request = f.request();
    let profile = f.command_for(9, 2, "missing", request.clone(), session());
    assert_eq!(
        f.run(&client, profile).unwrap(),
        json!({"kind":"profile_not_found"})
    );
    let draft = f.command_for(1, 9, "missing", request.clone(), session());
    assert_eq!(
        f.run(&client, draft).unwrap(),
        json!({"kind":"draft_not_found"})
    );
    let consumed = f
        .run(&client, f.command_for(1, 1, "consumed", request, session()))
        .unwrap();
    assert_eq!(consumed["kind"], "not_open");
    assert_eq!(consumed["workspace"]["draft"]["state"], "consumed");
    let stale = json!({"expected_snapshot_digest":"0".repeat(64),"decisions":[]});
    let stale = f.call(&client, "stale", stale).unwrap();
    let mut unselected = f.case["result"]["workspace"].clone();
    unselected["draft"]["snapshot_digest"] = f.request()["expected_snapshot_digest"].clone();
    unselected["reconciliation"] = json!({"kind":"unresolved","conflicts":[]});
    assert_eq!(
        stale,
        json!({"kind":"draft_changed","workspace":unselected})
    );
    let missing_target = json!({
        "expected_snapshot_digest":f.request()["expected_snapshot_digest"],
        "decisions":[{"kind":"replace","target_draft_part_id":99}]
    });
    assert_eq!(
        f.call(&client, "target", missing_target)
            .unwrap_err()
            .to_string(),
        "Required-unit reconciliation decision target is missing"
    );
    assert_eq!(f.count("plan_draft_required_unit_reconciliations"), before);
    owner.shutdown().unwrap();
}

#[test]
fn late_constraint_rolls_back_all_selection_rows() {
    let f = Fixture::new(UNCHANGED);
    f.sql().execute_batch("CREATE TRIGGER fixture_late_constraint BEFORE UPDATE OF current_required_unit_reconciliation_id ON plan_drafts BEGIN SELECT RAISE(ABORT,'fixture late constraint'); END").unwrap();
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let tables = [
        "plan_draft_required_unit_reconciliations",
        "plan_draft_required_unit_decisions",
        "plan_draft_required_unit_assignments",
    ];
    let before = tables.map(|table| f.count(table));
    let selection = f.selection();
    let error = f.call(&client, "selection", f.request()).unwrap_err();
    assert!(
        error.to_string().contains("fixture late constraint"),
        "{error:#}"
    );
    assert_eq!(tables.map(|table| f.count(table)), before);
    assert_eq!(f.selection(), selection);
    owner.shutdown().unwrap();
}

#[test]
fn cancelled_and_stopped_clients_do_not_write() {
    let f = Fixture::new(UNCHANGED);
    let owner = f.open();
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let before = f.count("plan_draft_required_unit_reconciliations");
    let error = client
        .reconcile(
            f.command("cancelled", f.request(), session()),
            Arc::new(AtomicBool::new(true)),
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::Cancelled)));
    owner.shutdown().unwrap();
    let error = f.call(&client, "stopped", f.request()).unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::Stopped)));
    assert_eq!(f.count("plan_draft_required_unit_reconciliations"), before);
}

#[test]
fn single_account_policy_maps_the_account_to_the_default_tenant() {
    let f = Fixture::new(UNCHANGED);
    f.sql()
        .execute_batch(
            "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE users SET id='uuid-account'; UPDATE sessions SET user_id='uuid-account'; COMMIT",
        )
        .unwrap();
    let owner = f.open();
    let neutral = owner.required_units_with_policy(neutral()).unwrap();
    assert_eq!(
        f.call(&neutral, "neutral", f.request()).unwrap(),
        json!({"kind":"profile_not_found"})
    );
    let strict = owner.required_units_with_policy(strict()).unwrap();
    assert_eq!(
        f.call(&strict, "strict", f.request()).unwrap(),
        f.case["result"]
    );
    assert_eq!(
        f.rows("SELECT actor_id,idempotency_key FROM plan_draft_required_unit_reconciliations WHERE id=2"),
        [json!(["uuid-account", "strict"])]
    );
    owner.shutdown().unwrap();
}

#[test]
fn multiple_accounts_and_invalid_credentials_fail_closed() {
    let f = Fixture::new(UNCHANGED);
    f.sql().execute("INSERT INTO users(id,email,display_name,password_hash,is_admin,created_at) VALUES('second','second@example.test','Second',NULL,0,'2026-01-01T00:00:00.000Z')",[]).unwrap();
    let owner = f.open();
    let before = f.count("plan_draft_required_unit_reconciliations");
    let strict = owner.required_units_with_policy(strict()).unwrap();
    let error = f.call(&strict, "strict", f.request()).unwrap_err();
    assert!(matches!(
        error.downcast_ref(),
        Some(auth::AuthFailure::OwnerMappingRequired)
    ));
    let client = owner.required_units_with_policy(neutral()).unwrap();
    for secret in ["", "invalid"] {
        let credential = Credential::Session(Secret::new(secret.into()));
        let error = f
            .run(&client, f.command("bad", f.request(), credential))
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref(),
            Some(auth::AuthFailure::SessionRequired)
        ));
    }
    assert_eq!(f.count("plan_draft_required_unit_reconciliations"), before);
    assert_eq!(
        f.call(&client, "neutral", f.request()).unwrap(),
        f.case["result"]
    );
    owner.shutdown().unwrap();
}

#[test]
fn api_keys_record_tenant_actor_usage_and_revocation() {
    let f = Fixture::new(UNCHANGED);
    let owner = f.open();
    let auth = owner.auth(auth::FirstUserTenant::NewUser);
    let call = |request| {
        auth.submit(
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    };
    let auth::Outcome::KeyCreated { key, info } = call(auth::Request::CreateKey {
        session: Secret::new("required-unit-fixture-secret".into()),
    }) else {
        panic!("key was not created")
    };
    let client = owner.required_units_with_policy(neutral()).unwrap();
    let credential = |tenant: &str| Credential::ApiKey {
        routed_tenant: tenant.into(),
        secret: Secret::new(key.expose().to_owned()),
    };
    assert!(
        f.run(
            &client,
            f.command("foreign", f.request(), credential("foreign"))
        )
        .is_err()
    );
    assert_eq!(
        f.run(
            &client,
            f.command("key", f.request(), credential("default"))
        )
        .unwrap(),
        f.case["result"]
    );
    assert_eq!(
        f.rows("SELECT actor_id,idempotency_key FROM plan_draft_required_unit_reconciliations WHERE id=2"),
        [json!(["tenant:default", "key"])]
    );
    let keys =
        f.rows("SELECT value FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'");
    let keys: Value = serde_json::from_str(keys[0][0].as_str().unwrap()).unwrap();
    assert!(keys[0]["lastUsedAt"].is_string());
    call(auth::Request::RevokeKey {
        session: Secret::new("required-unit-fixture-secret".into()),
        key_id: info.id,
    });
    assert!(
        f.run(
            &client,
            f.command("key", f.request(), credential("default"))
        )
        .is_err()
    );
    owner.shutdown().unwrap();
}

#[test]
fn request_and_command_reject_malformed_input() {
    let digest = "a".repeat(64);
    assert!(
        serde_json::from_value::<ReconciliationRequest>(
            json!({"expected_snapshot_digest":digest,"decisions":[]})
        )
        .is_ok()
    );
    for value in [
        json!({"expected_snapshot_digest":digest,"decisions":[],"actor":"forged"}),
        json!({"expected_snapshot_digest":"A".repeat(64),"decisions":[]}),
        json!({"expected_snapshot_digest":"a".repeat(63),"decisions":[]}),
        json!({"expected_snapshot_digest":digest,"decisions":[{"kind":"replace","target_draft_part_id":0}]}),
        json!({"expected_snapshot_digest":digest,"decisions":[{"kind":"replace","target_draft_part_id":1,"predecessor_revision_part_id":2}]}),
    ] {
        assert!(serde_json::from_value::<ReconciliationRequest>(value).is_err());
    }
    let request = || {
        serde_json::from_value(json!({"expected_snapshot_digest":digest,"decisions":[]})).unwrap()
    };
    let id = PositiveId::new(1).unwrap();
    for key in ["", " \u{3000}\t", &"k".repeat(161)] {
        let error = ReconciliationCommand::new(id, id, request(), key, session()).err();
        assert_eq!(error.unwrap().to_string(), "Invalid idempotency key");
    }
    for key in ["\u{feff} key \n", &"k".repeat(160)] {
        assert!(ReconciliationCommand::new(id, id, request(), key, session()).is_ok());
    }
}

#[test]
fn fixture_runner_reports_the_node_result_and_its_restart_replay() {
    let f = Fixture::new(UNCHANGED);
    let request = std::env::temp_dir().join(format!(
        "pp-required-units-request-{}.json",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    std::fs::write(&request, f.request().to_string()).unwrap();
    let output = child_process::command(env!("CARGO_BIN_EXE_required-unit-fixture"))
        .arg(&f.path)
        .args(["1", "2", "selection"])
        .arg(&request)
        .env("PP_RECONCILIATION_SESSION", "required-unit-fixture-secret")
        .output()
        .unwrap();
    std::fs::remove_file(&request).unwrap();
    assert!(output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["first"], f.case["result"]);
    assert_eq!(report["restart"], f.case["result"]);
    let reconciliations = |graph: &str| {
        report[graph]["plan_draft_required_unit_reconciliations"]
            .as_array()
            .map(Vec::len)
    };
    assert_eq!(reconciliations("graph_before"), Some(1));
    assert_eq!(reconciliations("graph_after"), Some(2));
}
