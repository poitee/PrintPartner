#![cfg(feature = "desktop_rebuild")]
//! Engine arms for supplied Source imports, ported from the reference engine.
//! Node's runner has no supplied-import kind (see `jobs_engine_parity.rs`), so
//! these cases test the reference behavior: targeted claims, the owned-phase
//! advance rule, and cancellation that returns the import to its owner. Unlike
//! the reference, the attempt limit does not bound that cleanup claim.
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/common/claimed_attempt.rs"
));
use pp_storage::jobs::ClaimedAttempt;
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    jobs::{
        Credential, EffectIntent, EffectOperation, JobKind, JobRecord, Outcome, Payload,
        PersistentState, UserOperation, WorkerAdmission, WorkerOperation,
    },
};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-supplied-imports-{}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn open(path: &Path) -> WriterOwner {
    WriterOwner::open(path, Limits::default()).unwrap().0
}

fn admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: JobKind::ALL.into_iter().map(|kind| (kind, 2)).collect(),
        total: 4,
        per_resource: 1,
        lease_seconds: 60,
    }
}

fn user(owner: &WriterOwner, operation: UserOperation) -> JobRecord {
    let Outcome::Job(job, _) = owner
        .jobs(AuthPolicy {
            registration: RegistrationPolicy::Open,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        })
        .unwrap()
        .submit(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("job expected")
    };
    job
}

fn enqueue(owner: &WriterOwner, key: &str, payload: Payload) -> JobRecord {
    user(
        owner,
        UserOperation::Enqueue {
            key: key.into(),
            payload_version: 1,
            payload,
        },
    )
}

/// Enqueues a job and rewrites it as a supplied import for `source_id`, the
/// internal kind only the upload journal enqueues.
fn supplied_import(path: &Path, owner: &WriterOwner, key: &str, source_id: u64) -> String {
    let pp_storage::catalog::Outcome::Source(Some(source)) = owner
        .local_source_catalog()
        .execute(pp_storage::catalog::Request::Create {
            source: pp_storage::catalog::CreateSource {
                name: key.into(),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    assert_eq!(source.id as u64, source_id);
    let job_id = enqueue(owner, key, Payload::CheckSourceUpdates {}).job_id;
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let document: String = db
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: serde_json::Value = serde_json::from_str(&document).unwrap();
    document["kind"] = "supplied-source-import".into();
    document["payload"] = serde_json::to_value(Payload::SuppliedSourceImport {
        project_id: source_id,
        operation_key: key.into(),
        input_version: 1,
    })
    .unwrap();
    db.execute(
        "UPDATE durable_jobs SET kind='supplied-source-import',resource=?2,document=?3 WHERE id=?1",
        rusqlite::params![job_id, format!("source:{source_id}"), document.to_string()],
    )
    .unwrap();
    job_id
}

fn get(owner: &WriterOwner, job_id: &str) -> JobRecord {
    user(
        owner,
        UserOperation::Get {
            job_id: job_id.into(),
        },
    )
}

#[test]
fn targeted_claim_takes_only_the_named_queued_import() {
    let path = directory();
    let owner = open(&path);
    let older = supplied_import(&path, &owner, "older", 1);
    let named = supplied_import(&path, &owner, "named", 2);
    let plain = enqueue(
        &owner,
        "plain",
        Payload::ExportChecklistHtml { profile_id: 7 },
    )
    .job_id;
    let worker = owner.job_worker(admission()).unwrap();

    let claimed_attempt!(claimed, lease) = worker.claim_import(&named).unwrap().unwrap();
    assert_eq!(claimed.job_id, named);
    assert_eq!(lease.job_id(), named);
    assert_eq!(claimed.state, PersistentState::Running);
    assert!(worker.claim_import(&named).unwrap().is_none());
    assert!(worker.claim_import(&plain).unwrap().is_none());
    assert!(worker.claim_import("unknown").unwrap().is_none());
    assert_eq!(get(&owner, &older).state, PersistentState::Queued);
    assert_eq!(get(&owner, &plain).state, PersistentState::Queued);
    owner.shutdown().unwrap();
}

#[test]
fn targeted_import_claim_reserves_its_source_and_leaves_busy_work_queued() {
    let path = directory();
    let owner = open(&path);
    let job_id = supplied_import(&path, &owner, "reserved", 1);
    let other = supplied_import(&path, &owner, "other", 2);
    let catalog = owner.local_source_catalog();
    let mut direct = catalog
        .begin_work(1, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    let mut config = admission();
    config.per_resource = 2;
    let worker = owner.job_worker(config).unwrap();
    let before = get(&owner, &job_id);
    assert!(worker.claim_import(&job_id).unwrap().is_none());
    let after = get(&owner, &job_id);
    assert_eq!(after.state, PersistentState::Queued);
    assert_eq!(after.state_version, before.state_version);
    assert_eq!(after.attempt, before.attempt);
    assert_eq!(after.generation, before.generation);
    assert_eq!(get(&owner, &other).state, PersistentState::Queued);
    direct.release().unwrap();

    let claimed = worker.claim_import(&job_id).unwrap().unwrap();
    assert_eq!(claimed.job.job_id, job_id);
    assert!(claimed.source_work.is_some());
    let error = worker
        .begin_source_work(
            &claimed.lease,
            None,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .err()
        .expect("import must reserve its Source");
    assert!(
        error
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );
    let other_claim = worker.claim_import(&other).unwrap().unwrap();
    assert_eq!(other_claim.job.job_id, other);
    assert!(other_claim.source_work.is_some());

    let cancelled = cancel(&owner, &job_id);
    assert!(worker.claim_import(&job_id).unwrap().is_none());
    assert_eq!(get(&owner, &job_id).state_version, cancelled.state_version);
    drop(claimed);
    let cleanup = worker.claim_import(&job_id).unwrap().unwrap();
    assert!(cleanup.job.cancel_requested);
    assert!(cleanup.source_work.is_some());
    owner.shutdown().unwrap();
}

#[test]
fn import_attempts_advance_only_by_heartbeat_and_progress() {
    let path = directory();
    let owner = open(&path);
    let job_id = supplied_import(&path, &owner, "phases", 1);
    let worker = owner.job_worker(admission()).unwrap();
    let claimed_attempt!(_, mut lease) = worker.claim_import(&job_id).unwrap().unwrap();
    worker
        .update(&mut lease, WorkerOperation::Heartbeat)
        .unwrap();
    assert_eq!(
        worker
            .update(&mut lease, WorkerOperation::Progress(40))
            .unwrap()
            .progress,
        Some(40)
    );
    for operation in [
        WorkerOperation::BeginEffect(EffectIntent {
            operation: EffectOperation::SourceRefresh,
            basis_hash: "a".repeat(64),
            content_hash: "b".repeat(64),
            target: "source:1".into(),
        }),
        WorkerOperation::Finish(None),
        WorkerOperation::Fail,
    ] {
        let error = worker.update(&mut lease, operation).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Supplied imports advance through owned phases"
        );
    }
    let job = get(&owner, &job_id);
    assert_eq!(job.state, PersistentState::Running);
    assert!(job.effects.is_empty());
    owner.shutdown().unwrap();
}

#[test]
fn cancelled_import_returns_to_its_owner_through_cancel_and_recovery() {
    let path = directory();
    let owner = open(&path);
    let job_id = supplied_import(&path, &owner, "cancel", 1);
    let worker = owner.job_worker(admission()).unwrap();
    let claimed_attempt!(claimed, _, source_work) = worker.claim_import(&job_id).unwrap().unwrap();

    let cancelled = user(
        &owner,
        UserOperation::Cancel {
            job_id: job_id.clone(),
        },
    );
    assert_eq!(cancelled.state, PersistentState::Queued);
    assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.generation, claimed.generation + 1);
    assert!(cancelled.lease_until.is_none());

    assert!(worker.claim_import(&job_id).unwrap().is_none());
    drop(source_work);
    let claimed_attempt!(reclaimed, _) = worker.claim_import(&job_id).unwrap().unwrap();
    assert!(reclaimed.cancel_requested);
    owner.shutdown().unwrap();
    let owner = open(&path);
    let recovered = get(&owner, &job_id);
    assert_eq!(recovered.state, PersistentState::Queued);
    assert!(recovered.cancel_requested);
    assert_eq!(recovered.generation, reclaimed.generation + 1);
    owner.shutdown().unwrap();
}

/// Sets the attempt count, raising the generation with it so the record stays
/// valid on reopen.
fn set_attempt(path: &Path, job_id: &str, attempt: i64) {
    let db = Connection::open(path.join("print-partner.db")).unwrap();
    let document: String = db
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: serde_json::Value = serde_json::from_str(&document).unwrap();
    document["attempt"] = attempt.into();
    document["generation"] = attempt.into();
    db.execute(
        "UPDATE durable_jobs SET generation=?2,document=?3 WHERE id=?1",
        rusqlite::params![job_id, attempt, document.to_string()],
    )
    .unwrap();
}

fn cancel(owner: &WriterOwner, job_id: &str) -> JobRecord {
    user(
        owner,
        UserOperation::Cancel {
            job_id: job_id.into(),
        },
    )
}

#[test]
fn cancelled_import_stays_claimable_for_cleanup_past_the_attempt_limit() {
    let path = directory();
    let owner = open(&path);
    let job_id = supplied_import(&path, &owner, "cancel-at-limit", 1);
    let running = supplied_import(&path, &owner, "running-at-limit", 2);
    set_attempt(&path, &job_id, 99);
    set_attempt(&path, &running, 100);
    let worker = owner.job_worker(admission()).unwrap();
    let claimed_attempt!(claimed, _, source_work) = worker.claim_import(&job_id).unwrap().unwrap();
    assert_eq!(claimed.attempt, 100);

    let cancelled = cancel(&owner, &job_id);
    assert_eq!(cancelled.state, PersistentState::Queued);
    assert!(worker.claim_import(&job_id).unwrap().is_none());
    assert_eq!(get(&owner, &job_id).state_version, cancelled.state_version);
    drop(source_work);
    let claimed_attempt!(cleanup, cleanup_lease, cleanup_source) =
        worker.claim_import(&job_id).unwrap().unwrap();
    assert!(cleanup.cancel_requested);
    assert_eq!(cleanup.attempt, 101);
    assert_eq!(cleanup.generation, cancelled.generation + 1);
    assert!(cleanup_source.is_some());
    let error = worker
        .begin_source_work(
            &cleanup_lease,
            None,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .err()
        .expect("cleanup must reserve its Source");
    assert!(
        error
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );

    let Err(error) = worker.claim_import(&running) else {
        panic!("attempt limit expected")
    };
    assert_eq!(error.to_string(), "Job attempt limit reached");
    assert_eq!(get(&owner, &running).state, PersistentState::Queued);
    owner.shutdown().unwrap();
}

#[test]
fn recovery_returns_a_cancelled_import_at_the_attempt_limit_to_its_owner() {
    let path = directory();
    let owner = open(&path);
    let job_id = supplied_import(&path, &owner, "recover-at-limit", 1);
    let running = supplied_import(&path, &owner, "fail-at-limit", 2);
    set_attempt(&path, &job_id, 99);
    set_attempt(&path, &running, 99);
    let worker = owner.job_worker(admission()).unwrap();
    assert!(cancel(&owner, &job_id).cancel_requested);
    let claimed_attempt!(reclaimed, _) = worker.claim_import(&job_id).unwrap().unwrap();
    assert_eq!(reclaimed.attempt, 100);
    let claimed_attempt!(claimed, _) = worker.claim_import(&running).unwrap().unwrap();
    assert_eq!(claimed.attempt, 100);
    owner.shutdown().unwrap();

    let owner = open(&path);
    let recovered = get(&owner, &job_id);
    assert_eq!(recovered.state, PersistentState::Queued);
    assert!(recovered.cancel_requested);
    assert_eq!(recovered.generation, reclaimed.generation + 1);
    let failed = get(&owner, &running);
    assert_eq!(failed.state, PersistentState::Failed);
    assert_eq!(failed.recovery.as_deref(), Some("Attempt limit reached"));
    let worker = owner.job_worker(admission()).unwrap();
    let claimed_attempt!(cleanup, _) = worker.claim_import(&job_id).unwrap().unwrap();
    assert_eq!(cleanup.attempt, 101);
    owner.shutdown().unwrap();
}
