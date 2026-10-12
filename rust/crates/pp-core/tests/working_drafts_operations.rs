use pp_storage::working_drafts::{Outcome, PositiveId, Request, Transition};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

#[test]
fn issued_session_reads_abandons_and_resumes_saved_draft() {
    let root = std::env::temp_dir().join(format!(
        "pp-working-draft-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("../../pp-storage/tests/fixtures/plan-publication/first.db"),
    )
    .unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let policy = auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    };
    let auth = owner.auth_with_policy(policy).unwrap();
    let session = auth
        .submit(
            auth::Request::Register {
                email: "working-draft@example.test".into(),
                display_name: "Working Draft".into(),
                password: Secret::new("ordinary-local-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let auth::Outcome::Session { token, .. } = session else {
        panic!("Expected genuine registration session")
    };
    let repos = root.join("repos");
    std::fs::create_dir_all(repos.join("1/revisions/fixture")).unwrap();
    std::fs::write(
        repos.join("1/revisions/fixture/bracket.stl"),
        b"solid bracket\nendsolid bracket\n",
    )
    .unwrap();
    std::fs::write(
        repos.join("1/revisions/fixture/[a] cover_x2.stl"),
        b"solid cover\nendsolid cover\n",
    )
    .unwrap();
    let client = pp_core::draft_observations::issue_working_drafts(
        &owner,
        policy,
        pp_core::draft_observations::DraftReadConfiguration {
            repos,
            limits: Default::default(),
            relative_base: root.clone(),
            policy: pp_core::draft_observations::FilesystemPolicy::TrustedSingleUser,
            shipped_hints: [
                root.join("missing-first.yaml"),
                root.join("missing-second.yaml"),
            ],
            custom_hints: None,
            community_manifests: Default::default(),
        },
    )
    .unwrap();
    let missing = client
        .execute(
            Credential::Session(Secret::new(token.expose().into())),
            PositiveId::new(1).unwrap(),
            Request::List,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matches!(missing, Outcome::NotFound));
    let reset = auth
        .submit(
            auth::Request::RequestReset {
                email: "publication@example.test".into(),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let auth::Outcome::ResetToken(Some(reset)) = reset else {
        panic!("Expected local reset token")
    };
    auth.submit(
        auth::Request::ResetPassword {
            token: reset,
            replacement: Secret::new("ordinary-owner-password".into()),
        },
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(5),
    )
    .unwrap()
    .recv()
    .unwrap()
    .unwrap();
    let owner_session = auth
        .submit(
            auth::Request::Login {
                email: "publication@example.test".into(),
                password: Secret::new("ordinary-owner-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let auth::Outcome::Session { token, .. } = owner_session else {
        panic!("Expected issued owner session")
    };
    let call = |request| {
        client
            .execute(
                Credential::Session(Secret::new(token.expose().into())),
                PositiveId::new(1).unwrap(),
                request,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )
            .unwrap()
    };
    let draft_id = PositiveId::new(1).unwrap();
    let Outcome::Read { draft: before } = call(Request::Read { draft_id }) else {
        panic!("Expected saved draft")
    };
    let Outcome::Transitioned { draft: abandoned } = call(Request::Transition {
        draft_id,
        transition: Transition::Abandon,
        expected_lifecycle_version: 0,
    }) else {
        panic!("Expected abandon")
    };
    assert_eq!(abandoned["state"], "abandoned");
    assert_eq!(abandoned["snapshotDigest"], before["snapshotDigest"]);
    assert!(matches!(
        call(Request::Transition {
            draft_id,
            transition: Transition::Abandon,
            expected_lifecycle_version: 0
        }),
        Outcome::Unchanged { .. }
    ));
    let Outcome::Transitioned { draft: resumed } = call(Request::Transition {
        draft_id,
        transition: Transition::Resume,
        expected_lifecycle_version: 1,
    }) else {
        panic!("Expected resume")
    };
    assert_eq!(resumed["state"], "open");
    assert_eq!(resumed["lifecycleVersion"], 2);
    assert_eq!(resumed["snapshotDigest"], before["snapshotDigest"]);
    assert!(matches!(
        call(Request::Workspace { draft_id }),
        Outcome::Workspace { .. }
    ));
    let Outcome::Created { draft: recomputed } = call(Request::Recompute {
        idempotency_key: "first-recompute".into(),
        options: Default::default(),
    }) else {
        panic!("Expected complete public recompute")
    };
    assert_eq!(recomputed["parts"].as_array().unwrap().len(), 2);
    assert!(
        recomputed["parts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["artifactDigest"].as_str().is_some_and(|d| d.len() == 64))
    );
    let Outcome::Existing { draft: replay } = call(Request::Recompute {
        idempotency_key: "first-recompute".into(),
        options: Default::default(),
    }) else {
        panic!("Expected retained winner")
    };
    assert_eq!(replay, recomputed);
    let service = client
        .service(
            Credential::Session(Secret::new(token.expose().into())),
            PositiveId::new(1).unwrap(),
            Request::Recompute {
                idempotency_key: "service-recompute".into(),
                options: Default::default(),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap();
    let Outcome::Service {
        outcome,
        committed_draft: Some(committed),
    } = service
    else {
        panic!("Expected service auto-selection")
    };
    assert_eq!(serde_json::to_value(outcome).unwrap()["kind"], "ready");
    assert_eq!(committed["parts"].as_array().unwrap().len(), 2);
    let auth::Outcome::KeyCreated { info, key } = auth
        .submit(
            auth::Request::CreateKey {
                session: Secret::new(token.expose().into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("Expected owner-issued API key")
    };
    let key_call = |tenant: &str, request| {
        client.execute(
            Credential::ApiKey {
                routed_tenant: tenant.into(),
                secret: Secret::new(key.expose().into()),
            },
            PositiveId::new(1).unwrap(),
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
    };
    assert!(matches!(
        key_call("default", Request::List).unwrap(),
        Outcome::Listed { .. }
    ));
    let before_denial = graph(&root);
    assert!(key_call("another-tenant", Request::List).is_err());
    assert_eq!(graph(&root), before_denial);
    let Outcome::Created { draft: by_key } = key_call(
        "default",
        Request::Recompute {
            idempotency_key: "first-recompute".into(),
            options: Default::default(),
        },
    )
    .unwrap() else {
        panic!("Expected key-owned draft")
    };
    assert_eq!(by_key["createdBy"], "tenant:default");
    auth.submit(
        auth::Request::RevokeKey {
            session: Secret::new(token.expose().into()),
            key_id: info.id,
        },
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(5),
    )
    .unwrap()
    .recv()
    .unwrap()
    .unwrap();
    let before_denial = graph(&root);
    assert!(key_call("default", Request::List).is_err());
    assert_eq!(graph(&root), before_denial);
    assert!(
        client
            .execute(
                Credential::Session(Secret::new(token.expose().into())),
                PositiveId::new(1).unwrap(),
                Request::List,
                Arc::new(AtomicBool::new(true)),
                Duration::from_secs(5)
            )
            .is_err()
    );
    assert_eq!(graph(&root), before_denial);
    owner.shutdown().unwrap();
    assert!(
        client
            .execute(
                Credential::Session(Secret::new(token.expose().into())),
                PositiveId::new(1).unwrap(),
                Request::List,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5)
            )
            .is_err()
    );
    let (reopened, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let configuration = pp_core::draft_observations::DraftReadConfiguration {
        repos: root.join("repos"),
        relative_base: root.clone(),
        policy: pp_core::draft_observations::FilesystemPolicy::TrustedSingleUser,
        limits: Default::default(),
        shipped_hints: [root.join("missing-a"), root.join("missing-b")],
        custom_hints: None,
        community_manifests: Default::default(),
    };
    let reopened_client =
        pp_core::draft_observations::issue_working_drafts(&reopened, policy, configuration)
            .unwrap();
    let after_startup = graph(&root);
    let Outcome::Read { draft: reread } = reopened_client
        .execute(
            Credential::Session(Secret::new(token.expose().into())),
            PositiveId::new(1).unwrap(),
            Request::Read {
                draft_id: PositiveId::new(by_key["id"].as_u64().unwrap()).unwrap(),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
    else {
        panic!("Expected retained draft")
    };
    assert_eq!(reread, by_key);
    assert_eq!(graph(&root), after_startup);
    reopened.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

fn graph(root: &std::path::Path) -> std::collections::BTreeMap<String, Vec<Vec<String>>> {
    let c = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let names = c
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut s = c
                .prepare(&format!("SELECT * FROM {name} ORDER BY rowid"))
                .unwrap();
            let n = s.column_count();
            let rows = s
                .query_map([], |row| {
                    Ok((0..n)
                        .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                        .collect())
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
