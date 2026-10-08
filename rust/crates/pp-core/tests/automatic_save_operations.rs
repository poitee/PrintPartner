use pp_core::draft_observations::{
    DraftReadConfiguration, FilesystemPolicy, issue_plan_save, issue_working_drafts,
};
use pp_storage::working_drafts::PositiveId;
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    jobs,
    plan_publication::Outcome as PublicationOutcome,
    plan_save::{Outcome, PlanSaveClient, SaveCommand},
    read_model::Credential,
    working_drafts::{Outcome as DraftOutcome, Request},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
const WAIT: Duration = Duration::from_secs(5);
fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
fn configuration(root: &Path) -> DraftReadConfiguration {
    DraftReadConfiguration {
        repos: root.join("repos"),
        relative_base: root.into(),
        policy: FilesystemPolicy::TrustedSingleUser,
        limits: Default::default(),
        shipped_hints: [root.join("no-a"), root.join("no-b")],
        custom_hints: None,
        community_manifests: Default::default(),
    }
}
fn auth_call(owner: &WriterOwner, request: auth::Request) -> auth::Outcome {
    owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(request, Arc::new(AtomicBool::new(false)), WAIT)
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}
fn session(secret: &str) -> Credential {
    Credential::Session(Secret::new(secret.into()))
}
fn graph(root: &Path) -> Value {
    let c = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut result = serde_json::Map::new();
    let names = c
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for name in names {
        let mut stmt = c
            .prepare(&format!("SELECT * FROM {name} ORDER BY rowid"))
            .unwrap();
        let cols = stmt
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let mut rows = stmt.query([]).unwrap();
        let mut values = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            let mut value = serde_json::Map::new();
            for (i, k) in cols.iter().enumerate() {
                use rusqlite::types::ValueRef;
                value.insert(
                    k.clone(),
                    match row.get_ref(i).unwrap() {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(std::str::from_utf8(s).unwrap()),
                        ValueRef::Blob(b) => json!(hex::encode(b)),
                    },
                );
            }
            values.push(Value::Object(value));
        }
        result.insert(name, json!(values));
    }
    Value::Object(result)
}
fn save(
    client: &PlanSaveClient,
    credential: Credential,
    key: &str,
    request: &Value,
) -> anyhow::Result<Outcome> {
    client.save(
        SaveCommand::new(
            credential,
            PositiveId::new(1).unwrap(),
            serde_json::from_value(request.clone())?,
            key.into(),
        )?,
        Arc::new(AtomicBool::new(false)),
        WAIT,
    )
}
fn fixture() -> (PathBuf, WriterOwner, String, Value) {
    let root = std::env::temp_dir().join(format!(
        "pp-save-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(root.join("repos/1/revisions/fixture")).unwrap();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("../../pp-storage/tests/fixtures/plan-publication/first.db"),
    )
    .unwrap();
    std::fs::write(
        root.join("repos/1/revisions/fixture/bracket.stl"),
        b"solid bracket\nendsolid bracket\n",
    )
    .unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let auth::Outcome::ResetToken(Some(reset)) = auth_call(
        &owner,
        auth::Request::RequestReset {
            email: "publication@example.test".into(),
        },
    ) else {
        panic!("reset")
    };
    auth_call(
        &owner,
        auth::Request::ResetPassword {
            token: reset,
            replacement: Secret::new("ordinary-save-owner-password".into()),
        },
    );
    let auth::Outcome::Session { token, .. } = auth_call(
        &owner,
        auth::Request::Login {
            email: "publication@example.test".into(),
            password: Secret::new("ordinary-save-owner-password".into()),
        },
    ) else {
        panic!("login")
    };
    let client = issue_working_drafts(&owner, policy(), configuration(&root)).unwrap();
    let DraftOutcome::Read { draft } = client
        .execute(
            session(token.expose()),
            PositiveId::new(1).unwrap(),
            Request::Read {
                draft_id: PositiveId::new(1).unwrap(),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
    else {
        panic!("draft")
    };
    let setup = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (part_key,relative_path,source_layer):(String,String,Option<String>)=setup.query_row("SELECT part_key,relative_path,source_layer FROM plan_draft_parts WHERE draft_id=? ORDER BY id LIMIT 1",[draft.identity().draft_id().get() as i64],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    let request = json!({"expected_base":{"revision_id":null,"plan_version":0},"expected_draft":{"draft_id":1,"state":"open","lifecycle_version":draft.identity().lifecycle_version(),"snapshot_digest":draft.identity().snapshot_digest(),"base":{"revision_id":null,"plan_version":0}},"remap_checkoff_links":false,"decisions":[{"kind":"set_quantity_override","target":{"part_key":part_key,"relative_path":relative_path,"source_layer":source_layer},"value":2}]});
    (root, owner, token.expose().into(), request)
}
#[test]
fn save_issued_auth_replay_reopen_key_audit_and_job_refusal_preserve_graphs() {
    let (root, owner, token, request) = fixture();
    let client = issue_plan_save(&owner, policy(), configuration(&root)).unwrap();
    let before = graph(&root);
    let cancelled = client.save(
        SaveCommand::new(
            session(&token),
            PositiveId::new(1).unwrap(),
            serde_json::from_value(request.clone()).unwrap(),
            "cancelled".into(),
        )
        .unwrap(),
        Arc::new(AtomicBool::new(true)),
        WAIT,
    );
    assert!(cancelled.is_err());
    assert_eq!(graph(&root), before);
    let auth::Outcome::Session { token: foreign, .. } = auth_call(
        &owner,
        auth::Request::Register {
            email: "foreign-save@example.test".into(),
            display_name: "Foreign".into(),
            password: Secret::new("ordinary-foreign-password".into()),
        },
    ) else {
        panic!("foreign")
    };
    let before = graph(&root);
    assert!(matches!(
        save(&client, session(foreign.expose()), "foreign", &request).unwrap(),
        Outcome::Refused { .. }
    ));
    assert_eq!(graph(&root), before);
    let first = save(&client, session(&token), "session-save", &request).unwrap();
    let Outcome::Saved {
        receipt: first_receipt,
        authority,
        ..
    } = first
    else {
        panic!("saved")
    };
    assert_eq!(authority.snapshot.plan_version, 1);
    let saved_graph = graph(&root);
    assert_eq!(
        saved_graph["plan_apply_requests"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        saved_graph["plan_apply_admissions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        saved_graph["plan_apply_requests"][0]["request_digest"],
        saved_graph["plan_apply_admissions"][0]["request_digest"]
    );
    assert!(matches!(
        save(&client, session(&token), "session-save", &request).unwrap(),
        Outcome::Saved { .. }
    ));
    assert_eq!(graph(&root), saved_graph);
    owner.shutdown().unwrap();
    assert!(save(&client, session(&token), "session-save", &request).is_err());
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let client = issue_plan_save(&owner, policy(), configuration(&root)).unwrap();
    let startup = graph(&root);
    let Outcome::Saved { receipt, .. } =
        save(&client, session(&token), "session-save", &request).unwrap()
    else {
        panic!("replay")
    };
    assert_eq!(
        serde_json::to_value(receipt).unwrap(),
        serde_json::to_value(&first_receipt).unwrap()
    );
    assert_eq!(graph(&root), startup);
    let auth::Outcome::KeyCreated { key, info } = auth_call(
        &owner,
        auth::Request::CreateKey {
            session: Secret::new(token.clone()),
        },
    ) else {
        panic!("key")
    };
    let key_credential = |tenant: &str| Credential::ApiKey {
        routed_tenant: tenant.into(),
        secret: Secret::new(key.expose().into()),
    };
    let mut second = request.clone();
    second["expected_draft"] = Value::Null;
    second["expected_base"] = json!({"revision_id":1,"plan_version":1});
    second["decisions"][0]["value"] = json!(3);
    let before = graph(&root);
    assert!(save(&client, key_credential("foreign"), "key-save", &second).is_err());
    assert_eq!(graph(&root), before);
    let Outcome::Saved {
        receipt: second_receipt,
        ..
    } = save(&client, key_credential("default"), "key-save", &second).unwrap()
    else {
        panic!("key save")
    };
    assert_eq!(second_receipt.plan_version().get(), 2);
    let after = graph(&root);
    assert_eq!(after["plan_apply_admissions"].as_array().unwrap().len(), 2);
    let auth::Outcome::Keys { keys, .. } = auth_call(
        &owner,
        auth::Request::ListKeys {
            session: Secret::new(token.clone()),
        },
    ) else {
        panic!("list keys")
    };
    assert!(keys.iter().any(|k| k.last_used_at.is_some()));
    assert!(
        after["plan_drafts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["created_by"] == "tenant:default")
    );
    let Outcome::Saved {
        receipt, authority, ..
    } = save(&client, session(&token), "session-save", &request).unwrap()
    else {
        panic!("historical")
    };
    assert_eq!(receipt.plan_version().get(), 1);
    assert_eq!(authority.snapshot.plan_version, 2);
    let job = owner
        .jobs(policy())
        .unwrap()
        .submit(
            jobs::Credential::PhysicalOwner(owner.job_physical_owner()),
            jobs::UserOperation::Enqueue {
                key: "save-affected".into(),
                payload_version: 1,
                payload: jobs::Payload::PrinterUpload {
                    printer_id: "fixture-printer".into(),
                    artifact_path: "exports/fixture.gcode".into(),
                    filename: "fixture.gcode".into(),
                    start: false,
                    profile_id: Some(1),
                    host_name: None,
                    checkoff_units: vec![],
                    unlabeled_names: vec![],
                },
            },
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap();
    assert!(matches!(job, jobs::Outcome::Job(..)));
    let mut blocked = second.clone();
    blocked["expected_base"] = json!({"revision_id":2,"plan_version":2});
    let before = graph(&root);
    let refused = save(&client, session(&token), "blocked-job", &blocked).unwrap();
    assert!(matches!(
        refused,
        Outcome::Refused {
            reason: pp_storage::plan_save::Refusal::Publication {
                outcome: PublicationOutcome::ExecutionConflict { .. }
            }
        }
    ));
    assert_eq!(graph(&root), before);
    auth_call(
        &owner,
        auth::Request::RevokeKey {
            session: Secret::new(token.clone()),
            key_id: info.id,
        },
    );
    let before = graph(&root);
    assert!(save(&client, key_credential("default"), "key-save", &second).is_err());
    assert_eq!(graph(&root), before);
    auth_call(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token.clone()),
        },
    );
    let before = graph(&root);
    assert!(save(&client, session(&token), "session-save", &request).is_err());
    assert_eq!(graph(&root), before);
    std::fs::write(
        root.join("save-graphs.json"),
        serde_json::to_vec_pretty(
            &json!({"saved":saved_graph,"startup":startup,"key_saved":after,"final":before}),
        )
        .unwrap(),
    )
    .unwrap();
    println!("Save graph evidence: {}", root.display());
    owner.shutdown().unwrap();
}

#[test]
fn save_failure_after_publication_rolls_back_admission_and_complete_graph() {
    let (root, owner, token, request) = fixture();
    let client = issue_plan_save(&owner, policy(), configuration(&root)).unwrap();
    let connection = rusqlite::Connection::open(root.join("print-partner.db")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_save_closure BEFORE UPDATE ON plan_drafts WHEN NEW.state='abandoned' BEGIN SELECT RAISE(ABORT,'fixture save closure failure'); END;").unwrap();
    drop(connection);
    let before = graph(&root);
    assert!(save(&client, session(&token), "late-save-failure", &request).is_err());
    assert_eq!(graph(&root), before);
    let connection = rusqlite::Connection::open(root.join("print-partner.db")).unwrap();
    connection
        .execute_batch("DROP TRIGGER fail_save_closure")
        .unwrap();
    drop(connection);
    assert!(matches!(
        save(&client, session(&token), "late-save-failure", &request).unwrap(),
        Outcome::Saved { .. }
    ));
    let after = graph(&root);
    assert_eq!(after["plan_apply_requests"].as_array().unwrap().len(), 1);
    assert_eq!(after["plan_apply_admissions"].as_array().unwrap().len(), 1);
    owner.shutdown().unwrap();
}
