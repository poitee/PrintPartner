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
    assert_eq!(abandoned.identity().state().as_str(), "abandoned");
    assert_eq!(
        abandoned.identity().snapshot_digest(),
        before.identity().snapshot_digest()
    );
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
    assert_eq!(resumed.identity().state().as_str(), "open");
    assert_eq!(resumed.identity().lifecycle_version(), 2);
    assert_eq!(
        resumed.identity().snapshot_digest(),
        before.identity().snapshot_digest()
    );
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
    assert_eq!(
        part_artifacts(&root, recomputed.identity().draft_id()).len(),
        2
    );
    assert_response_parts(&recomputed, 2);
    assert!(
        part_artifacts(&root, recomputed.identity().draft_id())
            .iter()
            .all(|digest| digest.as_ref().is_some_and(|digest| digest.len() == 64))
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
    assert_eq!(
        part_artifacts(&root, committed.identity().draft_id()).len(),
        2
    );
    assert_response_parts(&committed, 2);
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
    assert_eq!(
        created_by(&root, by_key.identity().draft_id()),
        "tenant:default"
    );
    let returned = by_key.clone().into_json_body().into_bytes();
    assert!(
        returned
            .windows(br#""createdBy":"tenant:default""#.len())
            .any(|bytes| bytes == br#""createdBy":"tenant:default""#)
    );
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
                draft_id: by_key.identity().draft_id(),
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

fn part_artifacts(root: &std::path::Path, id: PositiveId) -> Vec<Option<String>> {
    let connection = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    connection
        .prepare("SELECT artifact_digest FROM plan_draft_parts WHERE draft_id=? ORDER BY id")
        .unwrap()
        .query_map([id.get() as i64], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}
fn created_by(root: &std::path::Path, id: PositiveId) -> String {
    let connection = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    connection
        .query_row(
            "SELECT created_by FROM plan_drafts WHERE id=?",
            [id.get() as i64],
            |row| row.get(0),
        )
        .unwrap()
}

fn assert_response_parts(draft: &pp_storage::working_drafts::DraftDocument, count: usize) {
    let body = draft.clone().into_json_body().into_bytes();
    assert_eq!(
        body.windows(br#""partKey":""#.len())
            .filter(|bytes| *bytes == br#""partKey":""#)
            .count(),
        count
    );
    let prefix = br#""artifactDigest":""#;
    let digests = body
        .windows(prefix.len())
        .enumerate()
        .filter(|(_, bytes)| *bytes == prefix)
        .map(|(offset, _)| offset + prefix.len())
        .collect::<Vec<_>>();
    assert_eq!(digests.len(), count);
    for offset in digests {
        assert_eq!(body[offset + 64], b'"');
        assert!(
            body[offset..offset + 64]
                .iter()
                .all(|byte| byte.is_ascii_hexdigit())
        );
    }
}

#[test]
fn utf16_manifest_draft_selection_diff_publication_and_reopen() {
    use pp_contracts::{build_identity::BuildName, working_drafts::RecomputeOptions};
    use pp_storage::{
        build_graph::{BuildCommand, BuildOutcome, ManifestOptionsCommand},
        catalog::{
            CreateSource, Credentials, Outcome as CatalogOutcome, Request as CatalogRequest,
        },
        plan_publication::{PublicationClient, PublicationCommand},
    };
    let root = std::env::temp_dir().join(format!("pp-u15-flow-{:016x}", rand::random::<u64>()));
    println!(
        "{}",
        serde_json::json!({"case":"owned_utf16_root","root":root})
    );
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let policy = auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::ClaimDefault,
    };
    let auth::Outcome::Session { token, .. } = owner
        .auth_with_policy(policy)
        .unwrap()
        .submit(
            auth::Request::Register {
                email: "utf16-flow@example.test".into(),
                display_name: "UTF16 flow".into(),
                password: Secret::new("ordinary-utf16-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("session")
    };
    let credential = || Credential::Session(Secret::new(token.expose().into()));
    let CatalogOutcome::Source(Some(source)) = owner
        .source_catalog(Credentials::Session(Secret::new(token.expose().into())))
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "UTF16 source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..CreateSource::default()
            },
        })
        .unwrap()
    else {
        panic!("source")
    };
    let source_root = std::path::PathBuf::from(source.local_path.as_ref().unwrap());
    std::fs::create_dir_all(&source_root).unwrap();
    for name in ["stock.stl", "custom.stl"] {
        std::fs::write(
            source_root.join(name),
            format!("solid {name}\nendsolid {name}\n"),
        )
        .unwrap();
    }
    std::fs::write(
        source_root.join("print-partner.manifest.yaml"),
        br#"format: print-partner-manifest-v2
version: 2
parts:
  - match: custom.stl
    requirement: "\uD801"
    option_group: "\uD800"
option_groups:
  "\uD800":
    rule: pick_one
    parts: [stock.stl, custom.stl]
    variants:
      - id: stock
        parts: [stock.stl]
      - id: "\uDC00"
        parts: [custom.stl]
"#,
    )
    .unwrap();
    let config = || pp_core::draft_observations::DraftReadConfiguration {
        repos: root.join("repos"),
        relative_base: root.clone(),
        policy: pp_core::draft_observations::FilesystemPolicy::Isolated,
        limits: Default::default(),
        shipped_hints: [root.join("missing-a"), root.join("missing-b")],
        custom_hints: None,
        community_manifests: Default::default(),
    };
    let build_client =
        pp_core::draft_observations::issue_build_graph(&owner, policy, config()).unwrap();
    let build_call = |command| {
        build_client
            .execute(
                credential(),
                command,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )
            .unwrap()
    };
    let BuildOutcome::Created { profile, .. } = build_call(BuildCommand::Create {
        name: BuildName::parse("UTF16 draft build".into()).unwrap(),
        base_source: Some(pp_contracts::PositiveId::new(source.id as u64).unwrap()),
    }) else {
        panic!("build")
    };
    let build = pp_contracts::PositiveId::new(profile.id as u64).unwrap();
    let BuildOutcome::Manifest(builder) = build_call(BuildCommand::Manifest(
        ManifestOptionsCommand::ReadBuilder { build },
    )) else {
        panic!("builder")
    };
    let builder = builder.into_success_body().unwrap().into_bytes();
    assert!(has(&builder, br#""\ud800":{"rule":"pick_one""#));
    assert!(has(&builder, br#""id":"\udc00""#));
    let BuildOutcome::Manifest(saved) =
        build_call(BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build,
            request: br#"{"kit":{"selections":{"\ud800":"\udc00"}}}"#.to_vec(),
        }))
    else {
        panic!("kit")
    };
    assert!(has(
        &saved.into_success_body().unwrap().into_bytes(),
        br#""\ud800":"\udc00""#
    ));
    let client =
        pp_core::draft_observations::issue_working_drafts(&owner, policy, config()).unwrap();
    let profile_id = PositiveId::new(profile.id as u64).unwrap();
    let call = |request| {
        client
            .execute(
                credential(),
                profile_id,
                request,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )
            .unwrap()
    };
    let Outcome::Created { draft } = call(Request::Recompute {
        idempotency_key: "utf16-capture".into(),
        options: RecomputeOptions::default(),
    }) else {
        panic!("draft")
    };
    let id = draft.identity().draft_id();
    let before = draft.clone().into_json_body().into_bytes();
    assert!(has(&before, br#""requirement":"\ud801""#));
    assert!(has(&before, br#""optionGroupId":"\ud800""#));
    let Outcome::Read { draft: read } = call(Request::Read { draft_id: id }) else {
        panic!("read")
    };
    assert_eq!(read.clone().into_json_body().into_bytes(), before);
    let Outcome::Listed { drafts } = call(Request::List) else {
        panic!("list")
    };
    assert!(drafts.iter().any(|draft| draft.draft_id() == id));
    let Outcome::Diff { diff } = call(Request::Diff { draft_id: id }) else {
        panic!("diff")
    };
    let diff = diff.into_json_body().into_bytes();
    assert!(has(&diff, br#""optionGroupId":"\ud800""#));
    assert!(has(&diff, br#""requirement":"\ud801""#));
    let Outcome::Service {
        outcome: pp_contracts::reconciliation::Outcome::Ready { .. },
        ..
    } = client
        .service(
            credential(),
            profile_id,
            Request::PrepareApply {
                draft_id: id,
                expected: None,
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
    else {
        panic!("ready selection")
    };
    let Outcome::Read { draft: read } = call(Request::Read { draft_id: id }) else {
        panic!("selected draft")
    };
    let publication: PublicationClient = owner.publication_with_policy(policy).unwrap();
    let apply=serde_json::from_value(serde_json::json!({"expected_snapshot_digest":read.identity().snapshot_digest(),"expected_lifecycle_version":read.identity().lifecycle_version(),"expected_base":read.identity().base()})).unwrap();
    let applied = publication
        .apply(
            PublicationCommand::new(profile_id, id, apply, "utf16-publish".into(), credential())
                .unwrap(),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(
        matches!(applied, pp_contracts::publication::Outcome::Applied { .. }),
        "{applied:?}"
    );
    let batch = owner
        .accepted_reads_with_policy(policy)
        .unwrap()
        .read(
            credential(),
            &[profile.id],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let pp_storage::read_model::AcceptedRead::Ready { snapshot } = &batch.builds[0].accepted else {
        panic!("accepted snapshot")
    };
    let media_by_part_id = snapshot
        .parts
        .iter()
        .map(|part| {
            (
                part.projection_part_id,
                pp_storage::read_model::views::MediaObservation {
                    artifact_missing: false,
                    thumb_empty: true,
                },
            )
        })
        .collect();
    let observations = pp_storage::read_model::views::ReviewObservations {
        available_input_roots: Default::default(),
        media_by_part_id,
    };
    for include_excluded in [false, true] {
        let review = pp_storage::read_model::views::review_json(
            &batch.builds[0].accepted,
            include_excluded,
            &observations,
            &pp_storage::read_model::views::CatalogOnly,
        )
        .unwrap();
        assert!(review.summary_json().is_some());
        let body = review.into_bytes();
        assert!(has(&body, br#""option_group_id":"\ud800""#));
        assert!(has(&body, br#""requirement":"\ud801""#));
    }
    let Outcome::Created {
        draft: rebase_source,
    } = call(Request::Recompute {
        idempotency_key: "utf16-rebase-source".into(),
        options: RecomputeOptions {
            prefer_accepted: true,
            ..Default::default()
        },
    })
    else {
        panic!("rebase source")
    };
    let source_id = rebase_source.identity().draft_id();
    let Outcome::Transitioned { draft: abandoned } = call(Request::Transition {
        draft_id: source_id,
        transition: pp_contracts::working_drafts::Transition::Abandon,
        expected_lifecycle_version: rebase_source.identity().lifecycle_version(),
    }) else {
        panic!("abandon")
    };
    let setup = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (part_key,relative_path,source_layer):(String,String,Option<String>)=setup.query_row("SELECT match_key,relative_path,source_layer FROM parts WHERE profile_id=? AND relative_path='custom.stl'",[profile.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    drop(setup);
    let request=serde_json::from_value(serde_json::json!({"expected_base":{"revision_id":snapshot.revision_id,"plan_version":snapshot.plan_version},"expected_draft":null,"remap_checkoff_links":false,"decisions":[{"kind":"set_quantity_override","target":{"part_key":part_key,"relative_path":relative_path,"source_layer":source_layer},"value":2}]})).unwrap();
    let save_graph = graph(&root);
    let refused = client
        .plan_save()
        .save(
            pp_storage::plan_save::SaveCommand::new(
                credential(),
                profile_id,
                request,
                "utf16-unresolved-save".into(),
            )
            .unwrap(),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matches!(
        refused,
        pp_storage::plan_save::Outcome::Refused {
            reason: pp_storage::plan_save::Refusal::Publication {
                outcome: pp_contracts::publication::Outcome::ReconciliationRequired { .. }
            }
        }
    ));
    assert_eq!(graph(&root), save_graph);
    let Outcome::Created { draft: save_source } = call(Request::Recompute {
        idempotency_key: "utf16-selected-save-source".into(),
        options: RecomputeOptions {
            prefer_accepted: true,
            ..Default::default()
        },
    }) else {
        panic!("save source")
    };
    let select_replacements = |document: &pp_storage::working_drafts::DraftDocument, key: &str| {
        let database = rusqlite::Connection::open_with_flags(
            root.join("print-partner.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let ids=database.prepare("SELECT id FROM plan_draft_parts WHERE draft_id=? AND base_revision_part_id IS NOT NULL ORDER BY id").unwrap().query_map([document.identity().draft_id().get() as i64],|row|row.get::<_,i64>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        drop(database);
        let request=serde_json::from_value(serde_json::json!({"expected_snapshot_digest":document.identity().snapshot_digest(),"decisions":ids.iter().map(|id|serde_json::json!({"kind":"replace","target_draft_part_id":id})).collect::<Vec<_>>()})).unwrap();
        let result = client
            .service(
                credential(),
                profile_id,
                Request::Select {
                    draft_id: document.identity().draft_id(),
                    idempotency_key: key.into(),
                    request,
                },
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )
            .unwrap();
        assert!(
            matches!(
                result,
                Outcome::Service {
                    outcome: pp_contracts::reconciliation::Outcome::Ready { .. },
                    ..
                }
            ),
            "{result:?}"
        );
    };
    select_replacements(&save_source, "utf16-save-replacements");
    let Outcome::Read {
        draft: selected_save,
    } = call(Request::Read {
        draft_id: save_source.identity().draft_id(),
    })
    else {
        panic!("selected save")
    };
    let request=serde_json::from_value(serde_json::json!({"expected_base":{"revision_id":snapshot.revision_id,"plan_version":snapshot.plan_version},"expected_draft":{"draft_id":selected_save.identity().draft_id(),"state":"open","lifecycle_version":selected_save.identity().lifecycle_version(),"snapshot_digest":selected_save.identity().snapshot_digest(),"base":selected_save.identity().base()},"remap_checkoff_links":false,"decisions":[{"kind":"set_quantity_override","target":{"part_key":part_key,"relative_path":relative_path,"source_layer":source_layer},"value":2}]})).unwrap();
    let saved = client
        .plan_save()
        .save(
            pp_storage::plan_save::SaveCommand::new(
                credential(),
                profile_id,
                request,
                "utf16-save".into(),
            )
            .unwrap(),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap();
    let pp_storage::plan_save::Outcome::Saved { authority, .. } = &saved else {
        panic!("saved: {saved:?}")
    };
    assert_eq!(authority.snapshot.plan_version, 2);
    let saved_body = saved.into_json_body().into_bytes();
    assert!(has(&saved_body, br#""requirement":"\ud801""#));
    assert!(has(&saved_body, br#""optionGroupId":"\ud800""#));
    let rebased = call(Request::Rebase {
        idempotency_key: "utf16-rebase".into(),
        request: pp_contracts::working_drafts::RebaseRequest {
            source_draft_id: source_id,
            expected_source_state: pp_contracts::working_drafts::SourceState::Abandoned,
            expected_source_lifecycle_version: abandoned.identity().lifecycle_version(),
            expected_source_snapshot_digest: abandoned.identity().snapshot_digest().clone(),
        },
    });
    let Outcome::Rebased { draft: rebased } = rebased else {
        panic!("rebased: {rebased:?}")
    };
    select_replacements(&rebased, "utf16-http-save-replacements");
    let rebased_body = rebased.into_json_body().into_bytes();
    assert!(has(&rebased_body, br#""requirement":"\ud801""#));
    assert!(has(&rebased_body, br#""optionGroupId":"\ud800""#));
    let Outcome::Read { draft: after } = call(Request::Read { draft_id: id }) else {
        panic!("read after apply")
    };
    assert!(has(
        &after.clone().into_json_body().into_bytes(),
        br#""requirement":"\ud801""#
    ));
    let database = rusqlite::Connection::open_with_flags(
        root.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let metadata:(String,String)=database.query_row("SELECT typeof(requirement),typeof(option_group_id) FROM plan_draft_parts WHERE draft_id=? AND relative_path='custom.stl'",[id.get() as i64],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!(metadata, ("blob".into(), "blob".into()));
    drop(database);
    owner.shutdown().unwrap();
    let (reopened, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let reopened_client =
        pp_core::draft_observations::issue_working_drafts(&reopened, policy, config()).unwrap();
    let Outcome::Read { draft: reread } = reopened_client
        .execute(
            credential(),
            profile_id,
            Request::Read { draft_id: id },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
    else {
        panic!("reopen")
    };
    assert_eq!(
        reread.into_json_body().into_bytes(),
        after.into_json_body().into_bytes()
    );
    println!(
        "{}",
        serde_json::json!({"case":"utf16_manifest_draft_flow","root":root,"draft_id":id,"builder":String::from_utf8(builder).unwrap(),"snapshot":String::from_utf8(before).unwrap(),"diff":String::from_utf8(diff).unwrap(),"metadata_types":metadata,"saved":String::from_utf8(saved_body).unwrap(),"rebased":String::from_utf8(rebased_body).unwrap()})
    );
    reopened.shutdown().unwrap();
}
fn has(body: &[u8], expected: &[u8]) -> bool {
    body.windows(expected.len()).any(|bytes| bytes == expected)
}
