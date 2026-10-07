use anyhow::Result;
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        self, AuthFailure, AuthPolicy, AuthorityFailure, FirstUserTenant, RegistrationPolicy,
        Secret, SessionTenantPolicy,
    },
    jobs::{
        ClaimedAttempt, Credential, EffectIntent, EffectOperation, JobKind, Outcome, Payload,
        PersistentState, ResultArtifact, UserOperation, WorkerAdmission, WorkerOperation,
    },
};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-job-authority-{}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn open(path: &Path) -> WriterOwner {
    WriterOwner::open(path, Limits::default()).unwrap().0
}

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

fn admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: JobKind::ALL.into_iter().map(|kind| (kind, 1)).collect(),
        total: 4,
        per_resource: 1,
        lease_seconds: 60,
    }
}

fn auth(owner: &WriterOwner, request: auth::Request) -> Result<auth::Outcome> {
    owner
        .auth_with_policy(policy())?
        .submit(
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )?
        .recv()
        .unwrap()
}

fn register(owner: &WriterOwner, email: &str) -> (auth::User, String) {
    let auth::Outcome::Session { user, token } = auth(
        owner,
        auth::Request::Register {
            email: email.into(),
            display_name: "Authority test".into(),
            password: Secret::new("long-test-password".into()),
        },
    )
    .unwrap() else {
        panic!("session expected")
    };
    (user, token.expose().into())
}

fn login(owner: &WriterOwner, email: &str) -> String {
    let auth::Outcome::Session { token, .. } = auth(
        owner,
        auth::Request::Login {
            email: email.into(),
            password: Secret::new("long-test-password".into()),
        },
    )
    .unwrap() else {
        panic!("session expected")
    };
    token.expose().into()
}

fn enqueue(owner: &WriterOwner, credential: Credential, key: &str) -> pp_storage::jobs::JobRecord {
    enqueue_payload(owner, credential, key, Payload::CheckSourceUpdates {})
}

fn enqueue_payload(
    owner: &WriterOwner,
    credential: Credential,
    key: &str,
    payload: Payload,
) -> pp_storage::jobs::JobRecord {
    let outcome = owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential,
            UserOperation::Enqueue {
                key: key.into(),
                payload_version: 1,
                payload,
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    let Outcome::Job(job, _) = outcome else {
        panic!("job expected")
    };
    job
}

fn source(client: &pp_storage::catalog::SourceCatalogClient, name: &str) -> u64 {
    let pp_storage::catalog::Outcome::Source(Some(source)) = client
        .execute(pp_storage::catalog::Request::Create {
            source: pp_storage::catalog::CreateSource {
                name: name.into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    u64::try_from(source.id).unwrap()
}

fn local_source(owner: &WriterOwner, name: &str) -> u64 {
    source(&owner.local_source_catalog(), name)
}

fn get_with_session(owner: &WriterOwner, token: &str, job_id: &str) -> pp_storage::jobs::JobRecord {
    let outcome = call_with_session(
        owner,
        token,
        UserOperation::Get {
            job_id: job_id.into(),
        },
    )
    .unwrap();
    let Outcome::Job(job, _) = outcome else {
        panic!("job expected")
    };
    job
}

fn call_with_session(
    owner: &WriterOwner,
    token: &str,
    operation: UserOperation,
) -> Result<Outcome> {
    owner
        .jobs(policy())?
        .submit(
            Credential::Session(Secret::new(token.into())),
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()
}

fn assert_authority(error: &anyhow::Error, expected: AuthorityFailure) {
    assert_eq!(
        error.downcast_ref::<AuthorityFailure>(),
        Some(&expected),
        "{error:?}"
    );
}

fn stored_document(path: &Path, job_id: &str) -> String {
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn replace_document(path: &Path, job_id: &str, edit: impl FnOnce(&mut serde_json::Value)) {
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let document: String = db
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: serde_json::Value = serde_json::from_str(&document).unwrap();
    edit(&mut document);
    db.execute(
        "UPDATE durable_jobs SET document=?2 WHERE id=?1",
        [job_id, &serde_json::to_string(&document).unwrap()],
    )
    .unwrap();
}

fn set_created(path: &Path, job_id: &str, created: i64) {
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let document: String = db
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: serde_json::Value = serde_json::from_str(&document).unwrap();
    document["created_at"] = created.into();
    db.execute(
        "UPDATE durable_jobs SET created=?2,document=?3 WHERE id=?1",
        rusqlite::params![job_id, created, serde_json::to_string(&document).unwrap()],
    )
    .unwrap();
}

fn make_supplied_import(path: &Path, job_id: &str, source_id: u64) {
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let document: String = db
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: serde_json::Value = serde_json::from_str(&document).unwrap();
    document["kind"] = serde_json::json!("supplied-source-import");
    document["payload"] = serde_json::to_value(Payload::SuppliedSourceImport {
        project_id: source_id,
        operation_key: "targeted-authority".into(),
        input_version: 1,
    })
    .unwrap();
    db.execute(
        "UPDATE durable_jobs SET kind='supplied-source-import',resource=?2,document=?3 WHERE id=?1",
        rusqlite::params![
            job_id,
            format!("source:{source_id}"),
            serde_json::to_string(&document).unwrap()
        ],
    )
    .unwrap();
}

fn effect(target: &str) -> EffectIntent {
    EffectIntent {
        operation: EffectOperation::SourceRefresh,
        basis_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        target: target.into(),
    }
}

fn receipt(target: &str) -> ResultArtifact {
    ResultArtifact {
        receipt_id: "authority-receipt".into(),
        content_hash: "b".repeat(64),
        target: target.into(),
    }
}

#[test]
fn session_authority_reopens_without_raw_secret_and_dies_with_original_session() {
    let path = directory();
    let owner = open(&path);
    let (user, original) = register(&owner, "session@example.com");
    let queued = enqueue(
        &owner,
        Credential::Session(Secret::new(original.clone())),
        "session-restart",
    );
    let public = serde_json::to_string(&queued).unwrap();
    assert!(!public.contains("_authority"));
    assert!(!public.contains(&original));
    owner.shutdown().unwrap();

    let durable = stored_document(&path, &queued.job_id);
    assert!(durable.contains("\"_authority\""));
    assert!(!durable.contains(&original));

    let owner = open(&path);
    let replacement = login(&owner, "session@example.com");
    let replay = enqueue(
        &owner,
        Credential::Session(Secret::new(replacement.clone())),
        "session-restart",
    );
    assert_eq!(replay.job_id, queued.job_id);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    let identity = worker.authorize(&lease).unwrap();
    assert_eq!(identity.tenant(), user.tenant_id);
    assert_eq!(identity.subject(), format!("user:{}", user.user_id));
    worker
        .update(&mut lease, WorkerOperation::Progress(17))
        .unwrap();

    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(original),
        },
    )
    .unwrap();
    let error = worker.authorize(&lease).unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    let error = worker
        .update(&mut lease, WorkerOperation::Progress(18))
        .unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    let refused = get_with_session(&owner, &replacement, &queued.job_id);
    assert_eq!(refused.progress, Some(17));
    assert_eq!(refused.state, PersistentState::Failed);
    assert!(worker.authorize(&lease).is_err());
    owner.shutdown().unwrap();
}

#[test]
fn session_expiry_and_policy_drift_commit_safe_refusal() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "expiry@example.com");
    let expired = enqueue(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "session-expiry",
    );
    owner.shutdown().unwrap();
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    db.execute(
        "UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'",
        [],
    )
    .unwrap();
    drop(db);

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let state: (String, i64) = db
        .query_row(
            "SELECT state,version FROM durable_jobs WHERE id=?1",
            [&expired.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("failed".into(), 2));
    drop(db);

    let policy_path = directory();
    let owner = open(&policy_path);
    let (_, token) = register(&owner, "policy@example.com");
    let queued = enqueue(
        &owner,
        Credential::Session(Secret::new(token)),
        "session-policy",
    );
    owner.shutdown().unwrap();
    let owner = open(&policy_path);
    let mut changed = policy();
    changed.session_tenant = SessionTenantPolicy::SingleAccountDefault;
    let worker = owner.job_worker_with_policy(changed, admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let state: String = Connection::open(policy_path.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT state FROM durable_jobs WHERE id=?1",
            [&queued.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "failed");
}

fn create_key(owner: &WriterOwner, session: &str) -> (String, String) {
    let auth::Outcome::KeyCreated { info, key } = auth(
        owner,
        auth::Request::CreateKey {
            session: Secret::new(session.into()),
        },
    )
    .unwrap() else {
        panic!("key expected")
    };
    (info.id, key.expose().into())
}

#[test]
fn routed_key_authority_reopens_and_revoke_or_rotate_cannot_be_substituted() {
    let path = directory();
    let owner = open(&path);
    let (user, session) = register(&owner, "key@example.com");
    let (key_id, raw_key) = create_key(&owner, &session);
    let queued = enqueue(
        &owner,
        Credential::RoutedKey {
            tenant: user.tenant_id.clone(),
            key: Secret::new(raw_key.clone()),
        },
        "key-restart",
    );
    let wrong_route = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::RoutedKey {
                tenant: "wrong-tenant".into(),
                key: Secret::new(raw_key.clone()),
            },
            UserOperation::Enqueue {
                key: "wrong-route".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive();
    assert!(wrong_route.is_err());
    owner.shutdown().unwrap();
    assert_eq!(
        Connection::open(path.join("print-partner.db"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM durable_jobs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let durable = stored_document(&path, &queued.job_id);
    assert!(!durable.contains(&raw_key));

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        lease,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    assert_eq!(worker.authorize(&lease).unwrap().tenant(), user.tenant_id);
    let auth::Outcome::KeyCreated {
        info: replacement_info,
        key: replacement,
    } = auth(
        &owner,
        auth::Request::RotateKey {
            session: Secret::new(session.clone()),
            key_id,
        },
    )
    .unwrap()
    else {
        panic!("rotated key expected")
    };
    assert!(!replacement.expose().is_empty());
    assert!(!replacement_info.id.is_empty());
    let replay = enqueue(
        &owner,
        Credential::RoutedKey {
            tenant: user.tenant_id.clone(),
            key: Secret::new(replacement.expose().into()),
        },
        "key-restart",
    );
    assert_eq!(replay.job_id, queued.job_id);
    let error = worker.authorize(&lease).unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);

    owner.shutdown().unwrap();

    let revoke_path = directory();
    let owner = open(&revoke_path);
    let (user, session) = register(&owner, "key-revoke@example.com");
    let (revoke_id, revoked_raw) = create_key(&owner, &session);
    let revoked = enqueue(
        &owner,
        Credential::RoutedKey {
            tenant: user.tenant_id.clone(),
            key: Secret::new(revoked_raw),
        },
        "key-revoke",
    );
    auth(
        &owner,
        auth::Request::RevokeKey {
            session: Secret::new(session),
            key_id: revoke_id,
        },
    )
    .unwrap();
    owner.shutdown().unwrap();
    let owner = open(&revoke_path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    assert_eq!(
        Connection::open(revoke_path.join("print-partner.db"))
            .unwrap()
            .query_row(
                "SELECT state FROM durable_jobs WHERE id=?1",
                [&revoked.job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "failed"
    );
}

#[test]
fn routed_key_expiry_and_stale_attempts_fail_and_legacy_jobs_stay_unupgraded() {
    let path = directory();
    let owner = open(&path);
    let (user, session) = register(&owner, "key-expiry@example.com");
    let (key_id, raw_key) = create_key(&owner, &session);
    let queued = enqueue(
        &owner,
        Credential::RoutedKey {
            tenant: user.tenant_id,
            key: Secret::new(raw_key),
        },
        "key-expiry",
    );
    owner.shutdown().unwrap();
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let raw: String = db
        .query_row(
            "SELECT value FROM app_settings WHERE key='api_keys_v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut keys: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let key = keys
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|key| key["id"] == key_id)
        .unwrap();
    key["expiresAt"] = "2000-01-01T00:00:00.000Z".into();
    db.execute(
        "UPDATE app_settings SET value=?1 WHERE key='api_keys_v1'",
        [serde_json::to_string(&keys).unwrap()],
    )
    .unwrap();
    drop(db);
    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    assert_eq!(
        Connection::open(path.join("print-partner.db"))
            .unwrap()
            .query_row(
                "SELECT state FROM durable_jobs WHERE id=?1",
                [&queued.job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "failed"
    );

    let legacy_path = directory();
    let owner = open(&legacy_path);
    let legacy = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "legacy-physical",
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    let error = worker.authorize(&lease).unwrap_err();
    assert_authority(&error, AuthorityFailure::Missing);
    let stale = lease.clone();
    worker
        .update(&mut lease, WorkerOperation::Progress(9))
        .unwrap();
    assert!(worker.authorize(&stale).is_err());
    let foreign = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(foreign.authorize(&lease).is_err());
    assert_eq!(legacy.job_id, lease.job_id());
    owner.shutdown().unwrap();
}

#[test]
fn refused_queue_entries_commit_and_do_not_poison_healthy_work() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "queue-poison@example.com");
    let session_catalog = owner
        .source_catalog_with_policy(
            pp_storage::catalog::Credentials::Session(Secret::new(token.clone())),
            policy(),
        )
        .unwrap();
    let refused_source = source(&session_catalog, "Refused busy Source");
    let healthy_source = local_source(&owner, "Healthy recovered Source");
    let healthy = enqueue_payload(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "healthy-same-kind",
        Payload::ImportScan {
            project_id: healthy_source,
        },
    );
    let recovering_worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        lease: _,
        source_work,
    } = recovering_worker.claim().unwrap().unwrap();
    assert_eq!(claimed.job_id, healthy.job_id);
    drop(source_work);
    let refused = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "refused-same-kind",
        Payload::ImportScan {
            project_id: refused_source,
        },
    );
    let busy = session_catalog
        .begin_work(
            i64::try_from(refused_source).unwrap(),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();
    set_created(&path, &refused.job_id, 1);
    set_created(&path, &healthy.job_id, 2);
    let mut healthy_document: serde_json::Value =
        serde_json::from_str(&stored_document(&path, &healthy.job_id)).unwrap();
    healthy_document["lease_until"] = 0.into();
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE durable_jobs SET lease_until=0,document=?2 WHERE id=?1",
            rusqlite::params![
                healthy.job_id,
                serde_json::to_string(&healthy_document).unwrap()
            ],
        )
        .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        lease: _,
        source_work,
    } = worker.claim().unwrap().expect("healthy claim");
    assert_eq!(claimed.job_id, healthy.job_id);
    assert_eq!(claimed.attempt, 2);
    assert_eq!(claimed.state, PersistentState::Running);
    assert!(source_work.is_some());
    drop(source_work);
    drop(busy);
    owner.shutdown().unwrap();

    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let state: String = db
        .query_row(
            "SELECT state FROM durable_jobs WHERE id=?1",
            [&refused.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "failed");
    let document = stored_document(&path, &refused.job_id);
    assert!(document.contains("\"_authority_refusal\""));

    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "cross-kind-poison@example.com");
    let refused = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "refused-cross-kind",
        Payload::Sync { project_ids: None },
    );
    let source_id = local_source(&owner, "Healthy cross-kind Source");
    let healthy = enqueue_payload(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "healthy-cross-kind",
        Payload::ImportScan {
            project_id: source_id,
        },
    );
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();
    owner.shutdown().unwrap();
    set_created(&path, &refused.job_id, 1);
    set_created(&path, &healthy.job_id, 2);
    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        lease: _,
        source_work: _source_work,
    } = worker.claim().unwrap().expect("cross-kind healthy claim");
    assert_eq!(claimed.job_id, healthy.job_id);
    assert_ne!(claimed.tenant, refused.tenant);
    owner.shutdown().unwrap();
}

#[test]
fn all_refused_queue_entries_become_idle_once_across_restart() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "idle-refusal@example.com");
    let refused = enqueue(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "idle-refusal",
    );
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();

    let first = stored_document(&path, &refused.job_id);
    let first: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(first["state"], "failed");
    let version = first["state_version"].as_i64().unwrap();

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let second: serde_json::Value =
        serde_json::from_str(&stored_document(&path, &refused.job_id)).unwrap();
    assert_eq!(second["state_version"], version);
    assert_eq!(second["_authority_refusal"], first["_authority_refusal"]);

    let mut archived = second;
    archived["updated_at"] = 0.into();
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE durable_jobs SET updated=0,document=?2 WHERE id=?1",
            rusqlite::params![refused.job_id, serde_json::to_string(&archived).unwrap()],
        )
        .unwrap();
    let owner = open(&path);
    assert_eq!(owner.retain_jobs(1000, 10000).unwrap(), 1);
    let archived: String = Connection::open(path.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&refused.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let archived: serde_json::Value = serde_json::from_str(&archived).unwrap();
    assert!(archived["_authority"].is_object());
    assert_eq!(archived["_authority_refusal"], first["_authority_refusal"]);
    let replacement = login(&owner, "idle-refusal@example.com");
    let replay = enqueue(
        &owner,
        Credential::Session(Secret::new(replacement)),
        "idle-refusal",
    );
    assert_eq!(replay.job_id, refused.job_id);
    let public = serde_json::to_string(&replay).unwrap();
    assert!(!public.contains("_authority"));
    assert!(!public.contains("_authority_refusal"));
    owner.shutdown().unwrap();
}

#[test]
fn revoked_attempt_refuses_new_effects_and_success_without_applying_them() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "revoked-operations@example.com");
    let effect_job = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "revoked-effect",
        Payload::ExportChecklistHtml { profile_id: 1 },
    );
    let finish_job = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "revoked-finish",
        Payload::ExportChecklistHtml { profile_id: 2 },
    );
    let mut worker_admission = admission();
    worker_admission
        .kinds
        .iter_mut()
        .find(|(kind, _)| *kind == JobKind::ExportChecklistHtml)
        .unwrap()
        .1 = 2;
    let worker = owner
        .job_worker_with_policy(policy(), worker_admission)
        .unwrap();
    let ClaimedAttempt {
        job: first,
        lease: first_lease,
        source_work: first_source_work,
    } = worker.claim().unwrap().unwrap();
    let ClaimedAttempt {
        job: second,
        lease: second_lease,
        source_work: second_source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(first_source_work.is_none());
    assert!(second_source_work.is_none());
    let (mut effect_lease, mut finish_lease) = if first.job_id == effect_job.job_id {
        assert_eq!(second.job_id, finish_job.job_id);
        (first_lease, second_lease)
    } else {
        assert_eq!(first.job_id, finish_job.job_id);
        assert_eq!(second.job_id, effect_job.job_id);
        (second_lease, first_lease)
    };
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();

    let error = worker
        .update(
            &mut effect_lease,
            WorkerOperation::BeginEffect(EffectIntent {
                operation: EffectOperation::LocalArtifact,
                basis_hash: "a".repeat(64),
                content_hash: "b".repeat(64),
                target: "result".into(),
            }),
        )
        .unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    let error = worker
        .update(
            &mut finish_lease,
            WorkerOperation::Finish(Some(receipt("result"))),
        )
        .unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);

    let replacement = login(&owner, "revoked-operations@example.com");
    let refused_effect = get_with_session(&owner, &replacement, &effect_job.job_id);
    assert_eq!(refused_effect.state, PersistentState::Failed);
    assert!(refused_effect.effects.is_empty());
    let refused_finish = get_with_session(&owner, &replacement, &finish_job.job_id);
    assert_eq!(refused_finish.state, PersistentState::Failed);
    assert!(refused_finish.result.is_none());
    owner.shutdown().unwrap();
}

#[test]
fn authority_loss_fences_the_attempt_and_preserves_only_matching_evidence() {
    let path = directory();
    let owner = open(&path);
    let (user, token) = register(&owner, "effect-refusal@example.com");
    let queued = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "effect-refusal",
        Payload::Sync { project_ids: None },
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    let authority = worker.authorize(&lease).unwrap();
    assert_eq!(authority.tenant(), user.tenant_id);
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(effect("source:all")),
        )
        .unwrap();
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();

    let error = worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("source:all")),
        )
        .unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    assert!(worker.authorize(&lease).is_err());

    let replacement = login(&owner, "effect-refusal@example.com");
    let refused = get_with_session(&owner, &replacement, &queued.job_id);
    assert_eq!(refused.state, PersistentState::ReconciliationRequired);
    assert_eq!(refused.effects[0].receipt, Some(receipt("source:all")));
    assert!(!refused.effects[0].confirmed);
    let blocked = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(replacement)),
        "resource-blocked",
        Payload::Sync { project_ids: None },
    );
    assert_ne!(blocked.job_id, queued.job_id);
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    let replacement = login(&owner, "effect-refusal@example.com");
    let observed = get_with_session(&owner, &replacement, &queued.job_id);
    let matching = observed.effects[0].receipt.clone().unwrap();
    let before = stored_document(&path, &queued.job_id);
    let mut changed = matching.clone();
    changed.receipt_id = "changed-observed-receipt".into();
    assert!(
        call_with_session(
            &owner,
            &replacement,
            UserOperation::Reconcile {
                job_id: observed.job_id.clone(),
                expected_version: observed.state_version,
                expected_generation: observed.generation,
                effect_hash: observed.effects[0].intent.content_hash.clone(),
                decision: pp_storage::jobs::Decision::ConfirmSucceeded,
                receipt: Some(changed),
            },
        )
        .is_err()
    );
    assert_eq!(stored_document(&path, &queued.job_id), before);
    assert!(
        call_with_session(
            &owner,
            &replacement,
            UserOperation::Reconcile {
                job_id: observed.job_id.clone(),
                expected_version: observed.state_version,
                expected_generation: observed.generation,
                effect_hash: observed.effects[0].intent.content_hash.clone(),
                decision: pp_storage::jobs::Decision::ConfirmNoEffect,
                receipt: None,
            },
        )
        .is_err()
    );
    assert_eq!(stored_document(&path, &queued.job_id), before);
    let Outcome::Job(confirmed, _) = call_with_session(
        &owner,
        &replacement,
        UserOperation::Reconcile {
            job_id: observed.job_id.clone(),
            expected_version: observed.state_version,
            expected_generation: observed.generation,
            effect_hash: observed.effects[0].intent.content_hash.clone(),
            decision: pp_storage::jobs::Decision::ConfirmSucceeded,
            receipt: Some(matching.clone()),
        },
    )
    .unwrap() else {
        panic!("job expected")
    };
    assert_eq!(confirmed.state, PersistentState::Succeeded);
    assert!(confirmed.effects[0].confirmed);
    assert_eq!(confirmed.effects[0].receipt, Some(matching));
    owner.shutdown().unwrap();

    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "mismatch-refusal@example.com");
    let queued = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "mismatch-refusal",
        Payload::Sync { project_ids: None },
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(effect("source:all")),
        )
        .unwrap();
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();
    let error = worker
        .update(&mut lease, WorkerOperation::ConfirmEffect(receipt("wrong")))
        .unwrap_err();
    assert!(error.to_string().contains("Receipt mismatch"));
    let document: serde_json::Value =
        serde_json::from_str(&stored_document(&path, &queued.job_id)).unwrap();
    assert_eq!(document["state"], "effect_admitted");
    assert!(document["effects"][0]["receipt"].is_null());
    owner.shutdown().unwrap();
}

#[test]
fn explicit_physical_owner_and_absent_legacy_authority_stay_distinct() {
    let physical_path = directory();
    let owner = open(&physical_path);
    let physical = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "explicit-physical",
    );
    owner.shutdown().unwrap();
    let physical_document: serde_json::Value =
        serde_json::from_str(&stored_document(&physical_path, &physical.job_id)).unwrap();
    assert!(physical_document.get("_authority").unwrap().is_null());
    let owner = open(&physical_path);
    let worker = owner.job_worker(admission()).unwrap();
    assert_eq!(worker.claim().unwrap().unwrap().job.job_id, physical.job_id);
    owner.shutdown().unwrap();

    let legacy_path = directory();
    let owner = open(&legacy_path);
    let legacy = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "absent-legacy",
    );
    owner.shutdown().unwrap();
    replace_document(&legacy_path, &legacy.job_id, |document| {
        document.as_object_mut().unwrap().remove("_authority");
    });
    let owner = open(&legacy_path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let legacy_document: serde_json::Value =
        serde_json::from_str(&stored_document(&legacy_path, &legacy.job_id)).unwrap();
    assert_eq!(legacy_document["state"], "failed");
    assert!(legacy_document.get("_authority").is_none());
    assert_eq!(
        legacy_document["_authority_refusal"]["reason"],
        "missing_original"
    );
}

#[test]
fn policy_and_codec_faults_stay_hard_errors_and_user_auth_errors_keep_their_type() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "policy-control@example.com");
    let required = enqueue(
        &owner,
        Credential::Session(Secret::new(token)),
        "policy-required",
    );
    owner.shutdown().unwrap();
    let owner = open(&path);
    let worker = owner.job_worker(admission()).unwrap();
    let error = match worker.claim() {
        Err(error) => error,
        Ok(_) => panic!("policy-free worker claimed authority job"),
    };
    assert_authority(&error, AuthorityFailure::PolicyRequired);
    owner.shutdown().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored_document(&path, &required.job_id))
            .unwrap()["state"],
        "queued"
    );

    replace_document(&path, &required.job_id, |document| {
        document["_authority"] = serde_json::json!({"version": 99});
    });
    let error = match WriterOwner::open(&path, Limits::default()) {
        Err(error) => error,
        Ok(_) => panic!("corrupt authority document was accepted"),
    };
    assert!(error.to_string().contains("missing field") || error.to_string().contains("Invalid"));

    let path = directory();
    let owner = open(&path);
    let error = match owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(String::new())),
            UserOperation::Get {
                job_id: "missing".into(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
    {
        Err(error) => error,
        Ok(_) => panic!("empty session was accepted"),
    };
    assert!(matches!(
        error.downcast_ref::<AuthFailure>(),
        Some(AuthFailure::SessionRequired)
    ));

    let error = match owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(String::new())),
            UserOperation::Enqueue {
                key: "empty-session-admission".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
    {
        Err(error) => error,
        Ok(_) => panic!("empty session was admitted"),
    };
    assert!(matches!(
        error.downcast_ref::<AuthFailure>(),
        Some(AuthFailure::SessionRequired)
    ));

    let error = match owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new("x".repeat(4097))),
            UserOperation::Enqueue {
                key: "oversized-session-admission".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
    {
        Err(error) => error,
        Ok(_) => panic!("oversized session was admitted"),
    };
    assert!(matches!(
        error.downcast_ref::<AuthFailure>(),
        Some(AuthFailure::InvalidInput(auth::AuthInputFailure::TooLong))
    ));

    let error = match owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::RoutedKey {
                tenant: "missing-tenant".into(),
                key: Secret::new(String::new()),
            },
            UserOperation::Enqueue {
                key: "empty-key-admission".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
    {
        Err(error) => error,
        Ok(_) => panic!("empty routed key was admitted"),
    };
    assert!(matches!(
        error.downcast_ref::<AuthFailure>(),
        Some(AuthFailure::SessionRequired)
    ));
    owner.shutdown().unwrap();
}

#[test]
fn policy_required_commits_prior_recovery_without_mutating_the_authority_job() {
    let path = directory();
    let owner = open(&path);
    let source_id = local_source(&owner, "Recovery policy Source");
    let recovering = enqueue_payload(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "recover-before-policy-error",
        Payload::ImportScan {
            project_id: source_id,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        lease,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    assert_eq!(lease.job_id(), recovering.job_id);
    let (_, token) = register(&owner, "recovery-policy@example.com");
    let required = enqueue_payload(
        &owner,
        Credential::Session(Secret::new(token)),
        "policy-error-after-recovery",
        Payload::Sync { project_ids: None },
    );
    replace_document(&path, &recovering.job_id, |document| {
        document["lease_until"] = 0.into();
    });
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE durable_jobs SET lease_until=0 WHERE id=?1",
            [&recovering.job_id],
        )
        .unwrap();

    let error = match worker.claim() {
        Err(error) => error,
        Ok(_) => panic!("unbound worker passed required policy"),
    };
    assert_authority(&error, AuthorityFailure::PolicyRequired);
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let recovered_state: String = db
        .query_row(
            "SELECT state FROM durable_jobs WHERE id=?1",
            [&recovering.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let required_state: String = db
        .query_row(
            "SELECT state FROM durable_jobs WHERE id=?1",
            [&required.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recovered_state, "queued");
    assert_eq!(required_state, "queued");
    owner.shutdown().unwrap();
}

#[test]
fn targeted_refusal_commits_before_returning_the_typed_error() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "targeted-refusal@example.com");
    let queued = enqueue(
        &owner,
        Credential::Session(Secret::new(token.clone())),
        "targeted-refusal",
    );
    let catalog = owner
        .source_catalog_with_policy(
            pp_storage::catalog::Credentials::Session(Secret::new(token.clone())),
            policy(),
        )
        .unwrap();
    let pp_storage::catalog::Outcome::Source(Some(source)) = catalog
        .execute(pp_storage::catalog::Request::Create {
            source: pp_storage::catalog::CreateSource {
                name: "Targeted refusal Source".into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    make_supplied_import(&path, &queued.job_id, u64::try_from(source.id).unwrap());
    let busy = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    auth(
        &owner,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let error = match worker.claim_import(&queued.job_id) {
        Err(error) => error,
        Ok(_) => panic!("targeted revoked job did not return an error"),
    };
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    drop(busy);
    owner.shutdown().unwrap();
    let document: serde_json::Value =
        serde_json::from_str(&stored_document(&path, &queued.job_id)).unwrap();
    assert_eq!(document["state"], "failed");
    assert_eq!(document["_authority_refusal"]["phase"], "targeted_claim");
}

#[test]
fn authenticated_live_lease_precedes_stale_and_foreign_rejections() {
    let path = directory();
    let owner = open(&path);
    let (user, token) = register(&owner, "live-lease@example.com");
    enqueue(
        &owner,
        Credential::Session(Secret::new(token)),
        "live-lease",
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        lease: mut live,
        source_work: _source_work,
    } = worker.claim().unwrap().unwrap();
    let authority = worker.authorize(&live).unwrap();
    assert_eq!(authority.tenant(), user.tenant_id);
    assert_eq!(authority.subject(), format!("user:{}", user.user_id));

    let stale = live.clone();
    worker
        .update(&mut live, WorkerOperation::Progress(11))
        .unwrap();
    assert!(
        worker
            .authorize(&stale)
            .unwrap_err()
            .to_string()
            .contains("Stale")
    );
    let foreign = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(
        foreign
            .authorize(&live)
            .unwrap_err()
            .to_string()
            .contains("Foreign worker")
    );
    owner.shutdown().unwrap();
}
