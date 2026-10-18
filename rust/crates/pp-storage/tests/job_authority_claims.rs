#![cfg(feature = "desktop_rebuild")]
//! Claim and worker-advance original authority, ported from the reference
//! `job_authority_recovery.rs`. Node's in-process runner keeps no queue across
//! restarts and never revalidates the enqueuing session, so these cases test
//! the reference engine's behavior instead of a Node result.
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/common/claimed_attempt.rs"
));
use anyhow::Result;
use pp_storage::jobs::ClaimedAttempt;
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        self, AuthFailure, AuthPolicy, AuthorityFailure, FirstUserTenant, RegistrationPolicy,
        Secret, SessionTenantPolicy,
    },
    jobs::{
        Credential, Decision, EffectIntent, EffectOperation, JobKind, JobRecord, Outcome, Payload,
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

fn logout(owner: &WriterOwner, token: &str) {
    auth(
        owner,
        auth::Request::Logout {
            token: Secret::new(token.into()),
        },
    )
    .unwrap();
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

fn submit(
    owner: &WriterOwner,
    credential: Credential,
    operation: UserOperation,
) -> Result<Outcome> {
    owner
        .jobs(policy())?
        .submit(
            credential,
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()
}

fn enqueue(owner: &WriterOwner, credential: Credential, key: &str, payload: Payload) -> JobRecord {
    let Outcome::Job(job, _) = submit(
        owner,
        credential,
        UserOperation::Enqueue {
            key: key.into(),
            payload_version: 1,
            payload,
        },
    )
    .unwrap() else {
        panic!("job expected")
    };
    job
}

fn get(owner: &WriterOwner, token: &str, job_id: &str) -> JobRecord {
    let Outcome::Job(job, _) = submit(
        owner,
        session(token),
        UserOperation::Get {
            job_id: job_id.into(),
        },
    )
    .unwrap() else {
        panic!("job expected")
    };
    job
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

fn session(token: &str) -> Credential {
    Credential::Session(Secret::new(token.into()))
}

fn assert_authority(error: &anyhow::Error, expected: AuthorityFailure) {
    assert_eq!(
        error.downcast_ref::<AuthorityFailure>(),
        Some(&expected),
        "{error:?}"
    );
}

fn stored(path: &Path, job_id: &str) -> serde_json::Value {
    let document: String = Connection::open(path.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&document).unwrap()
}

fn state(path: &Path, job_id: &str) -> String {
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT state FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn replace_document(path: &Path, job_id: &str, edit: impl FnOnce(&mut serde_json::Value)) {
    let mut document = stored(path, job_id);
    edit(&mut document);
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE durable_jobs SET created=?2,lease_until=?3,document=?4 WHERE id=?1",
            rusqlite::params![
                job_id,
                document["created_at"].as_i64().unwrap(),
                document["lease_until"].as_i64(),
                serde_json::to_string(&document).unwrap()
            ],
        )
        .unwrap();
}

#[test]
fn session_authority_reopens_without_raw_secret_and_dies_with_original_session() {
    let path = directory();
    let owner = open(&path);
    let (user, original) = register(&owner, "session@example.com");
    let queued = enqueue(
        &owner,
        session(&original),
        "session-restart",
        Payload::CheckSourceUpdates {},
    );
    let public = serde_json::to_string(&queued).unwrap();
    assert!(!public.contains("_authority"));
    assert!(!public.contains(&original));
    owner.shutdown().unwrap();
    let durable = stored(&path, &queued.job_id);
    assert!(durable["_authority"].is_object());
    assert!(!durable.to_string().contains(&original));

    let owner = open(&path);
    let replacement = login(&owner, "session@example.com");
    let replay = enqueue(
        &owner,
        session(&replacement),
        "session-restart",
        Payload::CheckSourceUpdates {},
    );
    assert_eq!(replay.job_id, queued.job_id);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed_attempt!(_, lease) = worker.claim().unwrap().unwrap();
    let identity = worker.authorize(&lease).unwrap();
    assert_eq!(identity.tenant(), user.tenant_id);
    assert_eq!(identity.subject(), format!("user:{}", user.user_id));

    logout(&owner, &original);
    let error = worker.authorize(&lease).unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    owner.shutdown().unwrap();
    assert_eq!(state(&path, &queued.job_id), "running");
}

#[test]
fn session_expiry_and_policy_drift_commit_safe_refusal() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "expiry@example.com");
    let expired = enqueue(
        &owner,
        session(&token),
        "session-expiry",
        Payload::CheckSourceUpdates {},
    );
    owner.shutdown().unwrap();
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let refused = stored(&path, &expired.job_id);
    assert_eq!(
        (refused["state"].as_str(), refused["state_version"].as_i64()),
        (Some("failed"), Some(2))
    );
    assert_eq!(
        refused["_authority_refusal"]["reason"],
        "credential_invalid"
    );
    assert_eq!(refused["_authority_refusal"]["phase"], "claim");
    assert_eq!(refused["recovery"], "Original authority is no longer valid");

    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "policy@example.com");
    let queued = enqueue(
        &owner,
        session(&token),
        "session-policy",
        Payload::CheckSourceUpdates {},
    );
    owner.shutdown().unwrap();
    let owner = open(&path);
    let mut changed = policy();
    changed.session_tenant = SessionTenantPolicy::SingleAccountDefault;
    let worker = owner.job_worker_with_policy(changed, admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let refused = stored(&path, &queued.job_id);
    assert_eq!(refused["state"], "failed");
    assert_eq!(refused["_authority_refusal"]["reason"], "policy_changed");
}

#[test]
fn routed_key_authority_reopens_and_rotation_cannot_be_substituted() {
    let path = directory();
    let owner = open(&path);
    let (user, session_token) = register(&owner, "key@example.com");
    let (key_id, raw_key) = create_key(&owner, &session_token);
    let routed = |key: &str| Credential::RoutedKey {
        tenant: user.tenant_id.clone(),
        key: Secret::new(key.into()),
    };
    let queued = enqueue(
        &owner,
        routed(&raw_key),
        "key-restart",
        Payload::CheckSourceUpdates {},
    );
    owner.shutdown().unwrap();
    assert!(!stored(&path, &queued.job_id).to_string().contains(&raw_key));

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed_attempt!(_, lease) = worker.claim().unwrap().unwrap();
    assert_eq!(worker.authorize(&lease).unwrap().tenant(), user.tenant_id);
    let auth::Outcome::KeyCreated {
        key: replacement, ..
    } = auth(
        &owner,
        auth::Request::RotateKey {
            session: Secret::new(session_token.clone()),
            key_id,
        },
    )
    .unwrap()
    else {
        panic!("rotated key expected")
    };
    let replay = enqueue(
        &owner,
        routed(replacement.expose()),
        "key-restart",
        Payload::CheckSourceUpdates {},
    );
    assert_eq!(replay.job_id, queued.job_id);
    assert_authority(
        &worker.authorize(&lease).unwrap_err(),
        AuthorityFailure::CredentialInvalid,
    );
    owner.shutdown().unwrap();
}

#[test]
fn physical_owner_attempts_have_no_original_authority_and_stale_leases_fail() {
    let path = directory();
    let owner = open(&path);
    let physical = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "physical",
        Payload::CheckSourceUpdates {},
    );
    owner.shutdown().unwrap();
    assert!(stored(&path, &physical.job_id)["_authority"].is_null());
    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    assert_eq!(lease.job_id(), physical.job_id);
    assert_authority(
        &worker.authorize(&lease).unwrap_err(),
        AuthorityFailure::Missing,
    );
    let stale = lease.clone();
    worker
        .update(&mut lease, WorkerOperation::Progress(9))
        .unwrap();
    assert!(
        worker
            .authorize(&stale)
            .unwrap_err()
            .to_string()
            .contains("Stale attempt fence")
    );
    let foreign = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(
        foreign
            .authorize(&lease)
            .unwrap_err()
            .to_string()
            .contains("Foreign worker")
    );
    let unbound = owner.job_worker(admission()).unwrap();
    assert!(unbound.authorize(&lease).is_err());
    owner.shutdown().unwrap();
}

#[test]
fn refused_queue_entries_commit_and_do_not_poison_healthy_work() {
    for (healthy_payload, recovered) in [
        (Payload::CheckSourceUpdates {}, true),
        (Payload::ExportChecklistHtml { profile_id: 7 }, false),
    ] {
        let path = directory();
        let owner = open(&path);
        let (_, token) = register(&owner, "queue-poison@example.com");
        let healthy = enqueue(
            &owner,
            Credential::PhysicalOwner(owner.job_physical_owner()),
            "healthy",
            healthy_payload,
        );
        if recovered {
            let claimed_attempt!(_, lease) = owner
                .job_worker(admission())
                .unwrap()
                .claim()
                .unwrap()
                .unwrap();
            assert_eq!(lease.job_id(), healthy.job_id);
            replace_document(&path, &healthy.job_id, |document| {
                document["lease_until"] = 0.into();
            });
        }
        let refused = enqueue(
            &owner,
            session(&token),
            "refused",
            Payload::CheckSourceUpdates {},
        );
        logout(&owner, &token);
        replace_document(&path, &refused.job_id, |document| {
            document["created_at"] = 1.into()
        });
        replace_document(&path, &healthy.job_id, |document| {
            document["created_at"] = 2.into()
        });

        let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
        let claimed_attempt!(claimed, _) = worker.claim().unwrap().expect("healthy claim");
        assert_eq!(claimed.job_id, healthy.job_id);
        assert_eq!(claimed.attempt, if recovered { 2 } else { 1 });
        assert_eq!(claimed.state, PersistentState::Running);
        owner.shutdown().unwrap();
        let refused = stored(&path, &refused.job_id);
        assert_eq!(refused["state"], "failed");
        assert_eq!(refused["_authority_refusal"]["phase"], "claim");
    }
}

#[test]
fn all_refused_queue_entries_become_idle_once_across_restart() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "idle-refusal@example.com");
    let refused = enqueue(
        &owner,
        session(&token),
        "idle-refusal",
        Payload::CheckSourceUpdates {},
    );
    logout(&owner, &token);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let first = stored(&path, &refused.job_id);
    assert_eq!(first["state"], "failed");

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let second = stored(&path, &refused.job_id);
    assert_eq!(second["state_version"], first["state_version"]);
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
        session(&replacement),
        "idle-refusal",
        Payload::CheckSourceUpdates {},
    );
    assert_eq!(replay.job_id, refused.job_id);
    assert_eq!(replay.state, PersistentState::Failed);
    assert!(
        !serde_json::to_string(&replay)
            .unwrap()
            .contains("_authority")
    );
    owner.shutdown().unwrap();
}

#[test]
fn absent_legacy_authority_is_refused_and_never_upgraded() {
    let path = directory();
    let owner = open(&path);
    let legacy = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "absent-legacy",
        Payload::CheckSourceUpdates {},
    );
    owner.shutdown().unwrap();
    replace_document(&path, &legacy.job_id, |document| {
        document.as_object_mut().unwrap().remove("_authority");
    });
    let owner = open(&path);
    assert!(
        owner
            .job_worker(admission())
            .unwrap()
            .claim()
            .unwrap()
            .is_none()
    );
    owner.shutdown().unwrap();
    let document = stored(&path, &legacy.job_id);
    assert_eq!(document["state"], "failed");
    assert!(document.get("_authority").is_none());
    assert_eq!(document["_authority_refusal"]["reason"], "missing_original");
}

#[test]
fn policy_faults_stay_hard_errors_and_corrupt_authority_is_quarantined() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "policy-control@example.com");
    let required = enqueue(
        &owner,
        session(&token),
        "policy-required",
        Payload::CheckSourceUpdates {},
    );
    let error = owner
        .job_worker(admission())
        .unwrap()
        .claim()
        .err()
        .expect("unbound claim");
    assert_authority(&error, AuthorityFailure::PolicyRequired);
    owner.shutdown().unwrap();
    assert_eq!(state(&path, &required.job_id), "queued");

    replace_document(&path, &required.job_id, |document| {
        document["_authority"] = serde_json::json!({"version": 99});
    });
    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    assert_eq!(state(&path, &required.job_id), "quarantined");

    let owner = open(&directory());
    for (credential, expected) in [
        (session(""), AuthFailure::SessionRequired),
        (
            session(&"x".repeat(4097)),
            AuthFailure::InvalidInput(auth::AuthInputFailure::TooLong),
        ),
    ] {
        let error = submit(
            &owner,
            credential,
            UserOperation::Enqueue {
                key: "rejected-admission".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
        )
        .err()
        .expect("credential admitted");
        assert_eq!(
            error.downcast_ref::<AuthFailure>().map(ToString::to_string),
            Some(expected.to_string()),
            "{error:?}"
        );
    }
    owner.shutdown().unwrap();
}

#[test]
fn policy_required_commits_prior_recovery_without_mutating_the_authority_job() {
    let path = directory();
    let owner = open(&path);
    let recovering = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "recover-before-policy-error",
        Payload::ExportChecklistHtml { profile_id: 7 },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let claimed_attempt!(_, lease) = worker.claim().unwrap().unwrap();
    assert_eq!(lease.job_id(), recovering.job_id);
    let (_, token) = register(&owner, "recovery-policy@example.com");
    let required = enqueue(
        &owner,
        session(&token),
        "policy-error-after-recovery",
        Payload::CheckSourceUpdates {},
    );
    replace_document(&path, &recovering.job_id, |document| {
        document["lease_until"] = 0.into();
    });

    assert_authority(
        &worker.claim().err().expect("unbound claim"),
        AuthorityFailure::PolicyRequired,
    );
    assert_eq!(state(&path, &recovering.job_id), "queued");
    assert_eq!(state(&path, &required.job_id), "queued");
    owner.shutdown().unwrap();
}

#[test]
fn kind_claims_skip_other_kinds_and_require_admission() {
    let owner = open(&directory());
    let checklist = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "checklist",
        Payload::ExportChecklistHtml { profile_id: 7 },
    );
    let updates = enqueue(
        &owner,
        Credential::PhysicalOwner(owner.job_physical_owner()),
        "updates",
        Payload::CheckSourceUpdates {},
    );
    let worker = owner
        .job_worker(WorkerAdmission {
            kinds: vec![
                (JobKind::CheckSourceUpdates, 1),
                (JobKind::ExportChecklistHtml, 1),
            ],
            total: 2,
            per_resource: 1,
            lease_seconds: 60,
        })
        .unwrap();
    let claimed_attempt!(claimed, _) = worker
        .claim_kind(JobKind::ExportChecklistHtml)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.job_id, checklist.job_id);
    assert!(
        worker
            .claim_kind(JobKind::ExportChecklistHtml)
            .unwrap()
            .is_none()
    );
    assert!(
        worker
            .claim_kind(JobKind::Sync)
            .err()
            .unwrap()
            .to_string()
            .contains("Job kind is not admitted")
    );
    let claimed_attempt!(claimed, _) = worker
        .claim_kind(JobKind::CheckSourceUpdates)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.job_id, updates.job_id);
    owner.shutdown().unwrap();
}

#[test]
fn revoked_attempt_refuses_new_effects_and_success_without_applying_them() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "revoked-operations@example.com");
    let effect_job = enqueue(
        &owner,
        session(&token),
        "revoked-effect",
        Payload::ExportChecklistHtml { profile_id: 1 },
    );
    let finish_job = enqueue(
        &owner,
        session(&token),
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
    let claimed_attempt!(first, first_lease) = worker.claim().unwrap().unwrap();
    let claimed_attempt!(second, second_lease) = worker.claim().unwrap().unwrap();
    let (mut effect_lease, mut finish_lease) = if first.job_id == effect_job.job_id {
        assert_eq!(second.job_id, finish_job.job_id);
        (first_lease, second_lease)
    } else {
        assert_eq!(first.job_id, finish_job.job_id);
        assert_eq!(second.job_id, effect_job.job_id);
        (second_lease, first_lease)
    };
    logout(&owner, &token);

    let error = worker
        .update(
            &mut effect_lease,
            WorkerOperation::BeginEffect(EffectIntent {
                operation: EffectOperation::LocalArtifact,
                ..effect("result")
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
    let refused_effect = get(&owner, &replacement, &effect_job.job_id);
    assert_eq!(refused_effect.state, PersistentState::Failed);
    assert!(refused_effect.effects.is_empty());
    let refused_finish = get(&owner, &replacement, &finish_job.job_id);
    assert_eq!(refused_finish.state, PersistentState::Failed);
    assert!(refused_finish.result.is_none());
    let document = stored(&path, &finish_job.job_id);
    assert_eq!(document["_authority_refusal"]["phase"], "worker_advance");
    assert_eq!(
        document["_authority_refusal"]["reason"],
        "credential_invalid"
    );
    owner.shutdown().unwrap();
}

#[test]
fn authority_loss_fences_the_attempt_and_preserves_only_matching_evidence() {
    let path = directory();
    let owner = open(&path);
    let (user, token) = register(&owner, "effect-refusal@example.com");
    let queued = enqueue(
        &owner,
        session(&token),
        "effect-refusal",
        Payload::CheckSourceUpdates {},
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    assert_eq!(worker.authorize(&lease).unwrap().tenant(), user.tenant_id);
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(effect("source:all")),
        )
        .unwrap();
    logout(&owner, &token);

    let error = worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("source:all")),
        )
        .unwrap_err();
    assert_authority(&error, AuthorityFailure::CredentialInvalid);
    assert!(worker.authorize(&lease).is_err());

    let replacement = login(&owner, "effect-refusal@example.com");
    let refused = get(&owner, &replacement, &queued.job_id);
    assert_eq!(refused.state, PersistentState::ReconciliationRequired);
    assert_eq!(refused.effects[0].receipt, Some(receipt("source:all")));
    assert!(!refused.effects[0].confirmed);
    let blocked = enqueue(
        &owner,
        session(&replacement),
        "resource-blocked",
        Payload::CheckSourceUpdates {},
    );
    assert_ne!(blocked.job_id, queued.job_id);
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();

    let owner = open(&path);
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    let replacement = login(&owner, "effect-refusal@example.com");
    let observed = get(&owner, &replacement, &queued.job_id);
    let matching = observed.effects[0].receipt.clone().unwrap();
    let before = stored(&path, &queued.job_id);
    let reconcile = |decision, receipt| UserOperation::Reconcile {
        job_id: observed.job_id.clone(),
        expected_version: observed.state_version,
        expected_generation: observed.generation,
        effect_hash: observed.effects[0].intent.content_hash.clone(),
        decision,
        receipt,
    };
    let changed = ResultArtifact {
        receipt_id: "changed-observed-receipt".into(),
        ..matching.clone()
    };
    assert!(
        submit(
            &owner,
            session(&replacement),
            reconcile(Decision::ConfirmSucceeded, Some(changed)),
        )
        .is_err()
    );
    assert_eq!(stored(&path, &queued.job_id), before);
    assert!(
        submit(
            &owner,
            session(&replacement),
            reconcile(Decision::ConfirmNoEffect, None),
        )
        .is_err()
    );
    assert_eq!(stored(&path, &queued.job_id), before);
    let Outcome::Job(confirmed, _) = submit(
        &owner,
        session(&replacement),
        reconcile(Decision::ConfirmSucceeded, Some(matching.clone())),
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
    let queued = enqueue(
        &owner,
        session(&token),
        "mismatch-refusal",
        Payload::CheckSourceUpdates {},
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(effect("source:all")),
        )
        .unwrap();
    logout(&owner, &token);
    let error = worker
        .update(&mut lease, WorkerOperation::ConfirmEffect(receipt("wrong")))
        .unwrap_err();
    assert!(error.to_string().contains("Receipt mismatch"));
    let document = stored(&path, &queued.job_id);
    assert_eq!(document["state"], "effect_admitted");
    assert!(document["effects"][0]["receipt"].is_null());
    owner.shutdown().unwrap();
}

/// Not in the reference: an attempt whose stored authority is lost mid-run
/// refuses its next operation as a missing original.
#[test]
fn attempt_without_stored_authority_refuses_its_next_operation() {
    let path = directory();
    let owner = open(&path);
    let (_, token) = register(&owner, "missing-mid-run@example.com");
    let job = enqueue(
        &owner,
        session(&token),
        "missing-mid-run",
        Payload::CheckSourceUpdates {},
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    replace_document(&path, &job.job_id, |document| {
        document.as_object_mut().unwrap().remove("_authority");
    });
    let error = worker
        .update(&mut lease, WorkerOperation::Progress(5))
        .unwrap_err();
    assert_authority(&error, AuthorityFailure::Missing);
    let document = stored(&path, &job.job_id);
    assert_eq!(document["state"], "failed");
    assert!(document["progress"].is_null());
    assert_eq!(document["_authority_refusal"]["reason"], "missing_original");
    assert_eq!(document["_authority_refusal"]["phase"], "worker_advance");
    owner.shutdown().unwrap();
}

/// Enqueues a session-owned supplied import, optionally as a cancelled import
/// past the attempt limit, then revokes the session.
fn revoked_import(path: &Path, owner: &WriterOwner, key: &str, cleanup: bool) -> String {
    let (_, token) = register(owner, &format!("{key}@example.com"));
    let queued = enqueue(owner, session(&token), key, Payload::CheckSourceUpdates {});
    let generation = if cleanup { 100 } else { queued.generation };
    replace_document(path, &queued.job_id, |document| {
        document["kind"] = "supplied-source-import".into();
        document["payload"] = serde_json::to_value(Payload::SuppliedSourceImport {
            project_id: 1,
            operation_key: key.into(),
            input_version: 1,
        })
        .unwrap();
        if cleanup {
            document["attempt"] = 100.into();
            document["generation"] = generation.into();
            document["cancel_requested"] = true.into();
        }
    });
    Connection::open(path.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE durable_jobs SET kind='supplied-source-import',resource='source:1',generation=?2 WHERE id=?1",
            rusqlite::params![queued.job_id, generation],
        )
        .unwrap();
    logout(owner, &token);
    queued.job_id
}

#[test]
fn targeted_refusal_commits_before_returning_the_typed_error() {
    for (key, cleanup) in [("targeted-refusal", false), ("cleanup-refusal", true)] {
        let path = directory();
        let owner = open(&path);
        let job_id = revoked_import(&path, &owner, key, cleanup);
        let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
        let error = worker
            .claim_import(&job_id)
            .err()
            .expect("targeted revoked job did not return an error");
        assert_authority(&error, AuthorityFailure::CredentialInvalid);
        owner.shutdown().unwrap();
        let document = stored(&path, &job_id);
        assert_eq!(document["state"], "failed");
        assert_eq!(document["_authority_refusal"]["phase"], "targeted_claim");
    }
}
