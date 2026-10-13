use pp_contracts::{autosave::PositiveId, reconciliation::ReconciliationRequest};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
    required_units::{AdmissionFailure, ReconciliationClient, ReconciliationCommand},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
const NORMAL: &[u8] = include_bytes!("fixtures/required-units/unchanged.db");
const NORMAL_JSON: &str = include_str!("fixtures/required-units/unchanged.json");
const SHRINK: &[u8] = include_bytes!("fixtures/required-units/shrink.db");
const SHRINK_JSON: &str = include_str!("fixtures/required-units/shrink.json");
const UNSAFE: &[u8] = include_bytes!("fixtures/required-units/unsafe.db");
const UNSAFE_JSON: &str = include_str!("fixtures/required-units/unsafe.json");
struct Fixture {
    path: PathBuf,
    case: Value,
}
impl Fixture {
    fn new(bytes: &[u8], case: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-required-units-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("print-partner.db"), bytes).unwrap();
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
    fn command(&self, key: &str, request: Value, credential: Credential) -> ReconciliationCommand {
        ReconciliationCommand::new(
            PositiveId::new(self.case["profile"].as_u64().unwrap()).unwrap(),
            PositiveId::new(self.case["draft"].as_u64().unwrap()).unwrap(),
            serde_json::from_value(request).unwrap(),
            key.into(),
            credential,
        )
        .unwrap()
    }
    fn call(
        &self,
        client: &ReconciliationClient,
        key: &str,
        request: Value,
    ) -> anyhow::Result<Value> {
        Ok(serde_json::to_value(client.reconcile(
            self.command(key, request, session()),
            &AtomicBool::new(false),
            Duration::from_secs(2),
        )?)?)
    }
    fn count(&self) -> i64 {
        self.sql()
            .query_row(
                "SELECT COUNT(*) FROM plan_draft_required_unit_reconciliations",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn session() -> Credential {
    Credential::Session(Secret::new("required-unit-fixture-secret".into()))
}
fn strict() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::FirstAccountOnly,
        session_tenant: auth::SessionTenantPolicy::SingleAccountDefault,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
#[test]
fn node_workspace_and_exact_restart_identity() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
    let owner = f.open();
    let request = f.case["request"].clone();
    let first = f
        .call(&owner.required_units(), "selection", request.clone())
        .unwrap();
    assert_eq!(first, f.case["result"]);
    let header:Vec<(i64,String,String)>=f.sql().prepare("SELECT id,reconciliation_digest,result_json FROM plan_draft_required_unit_reconciliations ORDER BY id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    owner.shutdown().unwrap();
    let owner = f.open();
    assert_eq!(
        f.call(&owner.required_units(), "selection", request)
            .unwrap(),
        first
    );
    assert_eq!(f.sql().prepare("SELECT id,reconciliation_digest,result_json FROM plan_draft_required_unit_reconciliations ORDER BY id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<rusqlite::Result<Vec<(i64,String,String)>>>().unwrap(),header);
    owner.shutdown().unwrap();
}
#[test]
fn completed_shrink_selection_stays_frozen() {
    let f = Fixture::new(SHRINK, SHRINK_JSON);
    let owner = f.open();
    let request = f.case["request"].clone();
    let first = f
        .call(&owner.required_units(), "selection", request.clone())
        .unwrap();
    assert_eq!(first, f.case["result"]);
    let basis: String = f
        .sql()
        .query_row(
            "SELECT selection_basis_json FROM plan_draft_required_unit_reconciliations WHERE id=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(basis.contains("\"completed\":true"));
    owner.shutdown().unwrap();
    f.sql()
        .execute("UPDATE print_progress SET completed=0,assembled=0", [])
        .unwrap();
    let owner = f.open();
    assert_eq!(
        f.call(&owner.required_units(), "selection", request)
            .unwrap(),
        first
    );
    let current: String = f
        .sql()
        .query_row(
            "SELECT selection_basis_json FROM plan_draft_required_unit_reconciliations WHERE id=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, basis);
    owner.shutdown().unwrap();
}
#[test]
fn unresolved_replacement_supersession_and_changed_payload() {
    let f = Fixture::new(UNSAFE, UNSAFE_JSON);
    let owner = f.open();
    let client = owner.required_units();
    let initial = f.case["request"].clone();
    let first = f.call(&client, "selection", initial.clone()).unwrap();
    assert_eq!(first, f.case["result"]);
    assert_eq!(first["workspace"]["reconciliation"]["kind"], "unresolved");
    let changed = json!({"expected_snapshot_digest":first["workspace"]["draft"]["snapshot_digest"],"decisions":[{"kind":"replace","target_draft_part_id":first["workspace"]["parts"][0]["draft_part_id"]}]});
    assert_eq!(
        f.call(&client, "selection", changed.clone()).unwrap(),
        json!({"kind":"idempotency_conflict"})
    );
    let ready = f.call(&client, "replacement", changed).unwrap();
    assert_eq!(ready["workspace"]["reconciliation"]["kind"], "ready");
    assert_eq!(
        f.call(&client, "selection", initial).unwrap(),
        json!({"kind":"draft_changed"})
    );
    assert_eq!(f.count(), 3);
    owner.shutdown().unwrap();
}
#[test]
fn late_constraint_rolls_back_all_selection_rows() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
    f.sql().execute_batch("CREATE TRIGGER fixture_late_constraint BEFORE UPDATE OF current_required_unit_reconciliation_id ON plan_drafts BEGIN SELECT RAISE(ABORT,'fixture late constraint'); END").unwrap();
    let owner = f.open();
    let before = f.count();
    let assignments: i64 = f
        .sql()
        .query_row(
            "SELECT COUNT(*) FROM plan_draft_required_unit_assignments",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let error = f
        .call(
            &owner.required_units(),
            "selection",
            f.case["request"].clone(),
        )
        .unwrap_err();
    assert!(error.to_string().contains("fixture late constraint"));
    assert_eq!(f.count(), before);
    assert_eq!(
        f.sql()
            .query_row(
                "SELECT COUNT(*) FROM plan_draft_required_unit_assignments",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        assignments
    );
    let digest: String = f
        .sql()
        .query_row(
            "SELECT snapshot_digest FROM plan_drafts WHERE id=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(digest, f.case["request"]["expected_snapshot_digest"]);
    owner.shutdown().unwrap();
}
#[test]
fn cancelled_and_stopped_clients_do_not_write() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
    let owner = f.open();
    let client = owner.required_units();
    let before = f.count();
    let error = client
        .reconcile(
            f.command("cancelled", f.case["request"].clone(), session()),
            &AtomicBool::new(true),
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<AdmissionFailure>(),
        Some(AdmissionFailure::Cancelled)
    ));
    assert_eq!(f.count(), before);
    owner.shutdown().unwrap();
    let error = f
        .call(&client, "stopped", f.case["request"].clone())
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<AdmissionFailure>(),
        Some(AdmissionFailure::Stopped)
    ));
    assert_eq!(f.count(), before);
}
#[test]
fn strict_actor_mapping_is_private_and_neutral_is_unchanged() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
    f.sql()
        .execute_batch(
            "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE users SET id='uuid-account';UPDATE sessions SET user_id='uuid-account'; COMMIT",
        )
        .unwrap();
    let owner = f.open();
    let strict = owner.required_units_with_policy(strict()).unwrap();
    assert_eq!(
        f.call(
            &owner.required_units(),
            "neutral",
            f.case["request"].clone()
        )
        .unwrap(),
        json!({"kind":"profile_not_found"})
    );
    let ready = f
        .call(&strict, "strict", f.case["request"].clone())
        .unwrap();
    assert_eq!(ready["kind"], "ready");
    let actor: String = f
        .sql()
        .query_row(
            "SELECT actor_id FROM plan_draft_required_unit_reconciliations WHERE id=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(actor, "uuid-account");
    owner.shutdown().unwrap();
}
#[test]
fn multiple_accounts_and_invalid_credentials_fail_closed() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
    f.sql().execute("INSERT INTO users(id,email,display_name,password_hash,is_admin,created_at) VALUES('second','second@example.test','Second',NULL,0,'2026-01-01T00:00:00.000Z')",[]).unwrap();
    let owner = f.open();
    let before = f.count();
    let error = f
        .call(
            &owner.required_units_with_policy(strict()).unwrap(),
            "strict",
            f.case["request"].clone(),
        )
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<auth::AuthFailure>(),
        Some(auth::AuthFailure::OwnerMappingRequired)
    ));
    assert!(
        owner
            .required_units()
            .reconcile(
                f.command(
                    "bad",
                    f.case["request"].clone(),
                    Credential::Session(Secret::new("invalid".into()))
                ),
                &AtomicBool::new(false),
                Duration::from_secs(1)
            )
            .is_err()
    );
    assert_eq!(f.count(), before);
    assert_eq!(
        f.call(
            &owner.required_units(),
            "neutral",
            f.case["request"].clone()
        )
        .unwrap()["kind"],
        "ready"
    );
    owner.shutdown().unwrap();
}
#[test]
fn key_actor_audit_usage_revocation_and_tenant_routing() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
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
    let auth::Outcome::KeyCreated { key, info, .. } = call(auth::Request::CreateKey {
        session: Secret::new("required-unit-fixture-secret".into()),
    }) else {
        panic!("key")
    };
    let client = owner.required_units();
    let raw = key.expose().to_owned();
    let credential = |tenant: &str| Credential::ApiKey {
        routed_tenant: tenant.into(),
        secret: Secret::new(raw.clone()),
    };
    assert!(
        client
            .reconcile(
                f.command("wrong", f.case["request"].clone(), credential("foreign")),
                &AtomicBool::new(false),
                Duration::from_secs(1)
            )
            .is_err()
    );
    let ready = client
        .reconcile(
            f.command("key", f.case["request"].clone(), credential("default")),
            &AtomicBool::new(false),
            Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(serde_json::to_value(ready).unwrap()["kind"], "ready");
    let actor: String = f
        .sql()
        .query_row(
            "SELECT actor_id FROM plan_draft_required_unit_reconciliations WHERE id=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(actor, "tenant:default");
    let keys: String = f
        .sql()
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(serde_json::from_str::<Value>(&keys).unwrap()[0]["lastUsedAt"].is_string());
    call(auth::Request::RevokeKey {
        session: Secret::new("required-unit-fixture-secret".into()),
        key_id: info.id,
    });
    assert!(
        client
            .reconcile(
                f.command("key", f.case["request"].clone(), credential("default")),
                &AtomicBool::new(false),
                Duration::from_secs(1)
            )
            .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn contract_rejects_unknown_duplicate_and_invalid_targets() {
    let valid = json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[]});
    assert!(serde_json::from_value::<ReconciliationRequest>(valid.clone()).is_ok());
    for value in [
        json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[],"actor":"forged"}),
        json!({"expected_snapshot_digest":"A".repeat(64),"decisions":[]}),
        json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[{"kind":"replace","target_draft_part_id":0}]}),
        json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[{"kind":"replace","target_draft_part_id":1,"predecessor_revision_part_id":2}]}),
        json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[{"kind":"replace","target_draft_part_id":1},{"kind":"replace","target_draft_part_id":1}]}),
    ] {
        assert!(serde_json::from_value::<ReconciliationRequest>(value).is_err());
    }
}
#[test]
fn absent_source_files_do_not_change_stored_reconciliation() {
    let f = Fixture::new(NORMAL, NORMAL_JSON);
    assert!(!f.path.join("repos").exists());
    let owner = f.open();
    let result = f
        .call(
            &owner.required_units(),
            "selection",
            f.case["request"].clone(),
        )
        .unwrap();
    assert_eq!(result, f.case["result"]);
    assert_eq!(std::fs::read_dir(f.path.join("repos")).unwrap().count(), 0);
    owner.shutdown().unwrap();
}
#[test]
fn workspace_contract_preserves_required_nulls_and_text_bounds() {
    let f: Value = serde_json::from_str(NORMAL_JSON).unwrap();
    let workspace = f["result"]["workspace"].clone();
    assert!(
        serde_json::from_value::<pp_contracts::reconciliation::Workspace>(workspace.clone())
            .is_ok()
    );
    let mut missing = workspace.clone();
    missing["parts"][0]
        .as_object_mut()
        .unwrap()
        .remove("quantity_override");
    assert!(serde_json::from_value::<pp_contracts::reconciliation::Workspace>(missing).is_err());
    let mut long = workspace.clone();
    long["parts"][0]["filename"] = json!("a".repeat(1001));
    assert!(serde_json::from_value::<pp_contracts::reconciliation::Workspace>(long).is_err());
    let mut empty = workspace;
    empty["reconciliation"] = json!({"kind":"unresolved","conflicts":[{"kind":"ambiguous_exact_match","target_draft_part_id":1,"candidate_revision_part_ids":[]}]});
    assert!(serde_json::from_value::<pp_contracts::reconciliation::Workspace>(empty).is_err());
}
