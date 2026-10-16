#![cfg(feature = "desktop_rebuild")]
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
    required_units::ReconciliationCommand,
    working_drafts::{DraftState, Failure, Outcome, PositiveId, Request, WorkingDraftClient},
};
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

fn session() -> Credential {
    Credential::Session(Secret::new("required-unit-fixture-secret".into()))
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

struct Fixture {
    path: PathBuf,
    case: Value,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let case = include_str!("fixtures/working-drafts-node.jsonl")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|case| case["name"] == name)
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "pp-draft-core-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        let database: &[u8] = match case["fixture"].as_str().unwrap() {
            "unchanged" => include_bytes!("fixtures/required-units/unchanged.db"),
            "shrink" => include_bytes!("fixtures/required-units/shrink.db"),
            "unsafe" => include_bytes!("fixtures/required-units/unsafe.db"),
            other => panic!("Unknown Node fixture {other}"),
        };
        std::fs::write(path.join("print-partner.db"), database).unwrap();
        let fixture = Self { path, case };
        for statement in fixture.case["setup"].as_array().unwrap() {
            let values = statement["params"]
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
            fixture
                .sql()
                .execute(
                    statement["sql"].as_str().unwrap(),
                    rusqlite::params_from_iter(values),
                )
                .unwrap();
        }
        fixture
    }
    fn sql(&self) -> Connection {
        Connection::open(self.path.join("print-partner.db")).unwrap()
    }
    fn open(&self) -> WriterOwner {
        WriterOwner::open(&self.path, Limits::default()).unwrap().0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn run(client: &WorkingDraftClient, profile: u64, request: Request) -> anyhow::Result<Outcome> {
    client.execute(
        session(),
        id(profile),
        request,
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(2),
    )
}
fn body(client: &WorkingDraftClient, request: Request) -> String {
    String::from_utf8(
        run(client, 1, request)
            .unwrap()
            .into_json_body()
            .unwrap()
            .into_bytes(),
    )
    .unwrap()
}
fn compare_node(name: &str) {
    let fixture = Fixture::new(name);
    let owner = fixture.open();
    if name == "selected" {
        let client = owner.required_units_with_policy(policy()).unwrap();
        let command = ReconciliationCommand::new(id(1), id(2), serde_json::from_value(json!({
            "expected_snapshot_digest":"ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3", "decisions":[],
        })).unwrap(), "core-selection", session()).unwrap();
        client
            .reconcile(
                command,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap();
    }
    let observer = fixture.sql();
    let before: i64 = observer
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    for (request, kind, field) in [
        (Request::List, "listed", "drafts"),
        (Request::Read { draft_id: id(2) }, "read", "draft"),
        (Request::Diff { draft_id: id(2) }, "diff", "diff"),
        (
            Request::Workspace { draft_id: id(2) },
            "workspace",
            "workspace",
        ),
    ] {
        let expected = match kind {
            "listed" => &fixture.case["list"],
            "read" => &fixture.case["read"],
            _ => &fixture.case[kind],
        };
        if let Some(expected) = expected.as_str() {
            let actual = body(&client, request);
            let expected = format!("{{\"kind\":\"{kind}\",\"{field}\":{expected}}}");
            if actual != expected {
                let index = actual
                    .bytes()
                    .zip(expected.bytes())
                    .position(|(a, b)| a != b)
                    .unwrap_or(actual.len().min(expected.len()));
                panic!(
                    "{name} {kind} differs at byte {index}: actual {:?}, Node {:?}",
                    &actual.as_bytes()[index.saturating_sub(20)..(index + 160).min(actual.len())],
                    &expected.as_bytes()
                        [index.saturating_sub(20)..(index + 160).min(expected.len())]
                );
            }
        }
    }
    if let Some(consumed) = fixture.case["consumed"].as_str() {
        assert_eq!(
            body(&client, Request::Read { draft_id: id(1) }),
            format!("{{\"kind\":\"read\",\"draft\":{consumed}}}")
        );
    }
    assert_eq!(
        observer
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        before
    );
    owner.shutdown().unwrap();
    let owner = fixture.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    assert_eq!(
        body(&client, Request::Read { draft_id: id(2) }),
        format!(
            "{{\"kind\":\"read\",\"draft\":{}}}",
            fixture.case["read"].as_str().unwrap()
        )
    );
    owner.shutdown().unwrap();
}
macro_rules! node_case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() {
            compare_node($name);
        }
    };
}
node_case!(unchanged_reads_match_node, "unchanged");
node_case!(
    legacy_input_diff_uses_node_defaults_and_last_source_match,
    "legacy-input"
);
node_case!(list_orders_creation_before_id_like_node, "list-order");
node_case!(shrink_reads_match_node, "shrink");
node_case!(unsafe_predecessor_reads_match_node, "unsafe");
node_case!(selected_reconciliation_reads_match_node, "selected");
node_case!(rebase_origin_reads_match_node, "rebase-origin");
node_case!(empty_snapshot_reads_match_node, "empty");
node_case!(input_and_part_diff_matches_node_order, "diff");
node_case!(lone_surrogate_document_and_diff_match_node_bytes, "utf16");

#[test]
fn identity_and_list_expose_the_validated_draft_basis() {
    let f = Fixture::new("unchanged");
    let owner = f.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    let Outcome::Read { draft } = run(&client, 1, Request::Read { draft_id: id(2) }).unwrap()
    else {
        panic!("Expected read");
    };
    let identity = draft.identity();
    assert_eq!(identity.draft_id(), id(2));
    assert_eq!(identity.state(), DraftState::Open);
    assert_eq!(identity.state().as_str(), "open");
    assert_eq!(identity.lifecycle_version(), 0);
    assert_eq!(
        identity.snapshot_digest().as_str(),
        "ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3"
    );
    assert_eq!(identity.base_revision_id(), Some(id(1)));
    assert_eq!(identity.base_plan_version().get(), 1);
    let Outcome::Listed { drafts } = run(&client, 1, Request::List).unwrap() else {
        panic!("Expected list");
    };
    assert_eq!(
        drafts
            .iter()
            .map(|d| (
                d.draft_id().get(),
                d.state().as_str(),
                d.lifecycle_version()
            ))
            .collect::<Vec<_>>(),
        [(1, "consumed", 1), (2, "open", 0)]
    );
    owner.shutdown().unwrap();
}

#[test]
fn missing_profiles_and_drafts_are_not_found() {
    let f = Fixture::new("unchanged");
    let owner = f.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    for request in [
        Request::List,
        Request::Read { draft_id: id(2) },
        Request::Diff { draft_id: id(2) },
        Request::Workspace { draft_id: id(2) },
    ] {
        assert_eq!(
            run(&client, 999, request)
                .unwrap()
                .into_json_body()
                .unwrap()
                .into_bytes(),
            br#"{"kind":"not_found"}"#
        );
    }
    for request in [
        Request::Read { draft_id: id(999) },
        Request::Diff { draft_id: id(999) },
        Request::Workspace { draft_id: id(999) },
    ] {
        assert_eq!(body(&client, request), r#"{"kind":"not_found"}"#);
    }
    assert_eq!(
        serde_json::from_str::<Value>(&body(&client, Request::Read { draft_id: id(2) })).unwrap()["draft"]
            ["id"],
        2
    );
    owner.shutdown().unwrap();
}

#[test]
fn workspace_and_full_diff_compare_both_halves_of_the_current_base() {
    let f = Fixture::new("unchanged");
    let owner = f.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    f.sql().execute_batch("INSERT INTO plan_revisions SELECT 2,tenant_id,profile_id,2,id,input_set_id,provenance_kind,digest_format,snapshot_digest,created_by,accepted_by,created_at,accepted_at FROM plan_revisions WHERE id=1").unwrap();
    for (revision, version, expected) in [
        (Some(1), 1, true),
        (Some(1), 2, false),
        (Some(2), 1, false),
        (None, 0, false),
    ] {
        f.sql().execute("UPDATE build_profiles SET accepted_plan_revision_id=?,accepted_plan_version=? WHERE id=1", (revision, version)).unwrap();
        let diff: Value =
            serde_json::from_str(&body(&client, Request::Diff { draft_id: id(2) })).unwrap();
        let workspace: Value =
            serde_json::from_str(&body(&client, Request::Workspace { draft_id: id(2) })).unwrap();
        assert_eq!(diff["diff"]["baseIsCurrent"], expected);
        assert_eq!(workspace["workspace"]["diff"]["base_is_current"], expected);
    }
    owner.shutdown().unwrap();
}

#[test]
fn readers_reject_corrupt_snapshots_and_origins() {
    let f = Fixture::new("unchanged");
    let owner = f.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    f.sql()
        .execute(
            "UPDATE plan_draft_parts SET quantity_effective=7 WHERE id=4",
            [],
        )
        .unwrap();
    for request in [
        Request::Read { draft_id: id(2) },
        Request::Diff { draft_id: id(2) },
        Request::Workspace { draft_id: id(2) },
    ] {
        assert_eq!(
            run(&client, 1, request).unwrap_err().to_string(),
            "Plan draft snapshot digest mismatch"
        );
    }
    owner.shutdown().unwrap();
    let f = Fixture::new("unchanged");
    let owner = f.open();
    f.sql().execute_batch("PRAGMA ignore_check_constraints=ON; DROP TRIGGER trg_plan_drafts_lineage_update; DROP TRIGGER trg_plan_drafts_lineage_immutable; UPDATE plan_drafts SET rebased_from_draft_id=1 WHERE id=2").unwrap();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    for request in [
        Request::Read { draft_id: id(2) },
        Request::Diff { draft_id: id(2) },
        Request::Workspace { draft_id: id(2) },
    ] {
        assert!(matches!(
            run(&client, 1, request).unwrap_err().downcast_ref(),
            Some(Failure::CorruptOrigin)
        ));
    }
    owner.shutdown().unwrap();
}

#[test]
fn cancellation_shutdown_and_authentication_fail_without_a_result() {
    let f = Fixture::new("unchanged");
    let owner = f.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    assert_eq!(
        client
            .execute(
                session(),
                id(1),
                Request::List,
                Arc::new(AtomicBool::new(false)),
                Duration::MAX
            )
            .unwrap_err()
            .to_string(),
        "Invalid queue wait"
    );
    let error = client
        .execute(
            session(),
            id(1),
            Request::List,
            Arc::new(AtomicBool::new(true)),
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::Cancelled)));
    let error = client
        .execute(
            Credential::Session(Secret::new("not-a-session".into())),
            id(1),
            Request::List,
            Arc::new(AtomicBool::new(false)),
            Duration::ZERO,
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "Authentication required");
    assert_eq!(
        serde_json::from_str::<Value>(&body(&client, Request::List)).unwrap()["drafts"][1]["id"],
        2
    );
    owner.shutdown().unwrap();
    assert!(matches!(
        run(&client, 1, Request::List).unwrap_err().downcast_ref(),
        Some(Failure::Stopped)
    ));
}

#[test]
fn session_policy_controls_tenant_scoping_for_reads() {
    let f = Fixture::new("unchanged");
    f.sql().execute_batch("BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE users SET id='uuid-account'; UPDATE sessions SET user_id='uuid-account'; COMMIT").unwrap();
    let owner = f.open();
    let client = owner.working_drafts_with_policy(policy()).unwrap();
    assert_eq!(body(&client, Request::List), r#"{"kind":"not_found"}"#);
    let strict = owner
        .working_drafts_with_policy(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::FirstAccountOnly,
            session_tenant: auth::SessionTenantPolicy::SingleAccountDefault,
            ..policy()
        })
        .unwrap();
    assert_eq!(
        body(&strict, Request::List),
        format!(
            "{{\"kind\":\"listed\",\"drafts\":{}}}",
            f.case["list"].as_str().unwrap()
        )
    );
    owner.shutdown().unwrap();
}
