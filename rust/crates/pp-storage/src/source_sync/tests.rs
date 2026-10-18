use super::*;
use crate::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog,
    jobs::{
        self, AuthorityRefusalPhase, AuthorityRefusalReason, ClaimedAttempt, Credential,
        ServerWorkerClient, UserOperation, WorkerAdmission, WorkerOperation,
    },
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

fn admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: vec![(JobKind::Sync, 1)],
        total: 1,
        per_resource: 1,
        lease_seconds: 60,
    }
}

struct Fixture {
    owner: WriterOwner,
    root: PathBuf,
    token: String,
    catalog: catalog::SourceCatalogClient,
    worker: ServerWorkerClient,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pp-source-sync-{}", rand::random::<u64>()));
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let auth::Outcome::Session { token, .. } = owner
            .auth(FirstUserTenant::NewUser)
            .submit(
                auth::Request::Register {
                    email: "source-sync@example.com".into(),
                    display_name: "Sync".into(),
                    password: auth::Secret::new("source-sync-test-password".into()),
                },
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
        else {
            panic!("session expected")
        };
        let token = token.expose().to_owned();
        let catalog = owner
            .source_catalog_with_policy(
                catalog::Credentials::Session(auth::Secret::new(token.clone())),
                policy(),
            )
            .unwrap();
        let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
        Self {
            owner,
            root,
            token,
            catalog,
            worker,
        }
    }

    fn source(&self, name: &str) -> i64 {
        let catalog::Outcome::Source(Some(source)) = self
            .catalog
            .execute(catalog::Request::Create {
                source: catalog::CreateSource {
                    name: name.into(),
                    source_kind: Some("local".into()),
                    source_type: Some("local".into()),
                    ..Default::default()
                },
            })
            .unwrap()
        else {
            panic!("Source expected")
        };
        source.id
    }

    fn user(&self, operation: UserOperation) -> JobRecord {
        let jobs::Outcome::Job(job, _) = self
            .owner
            .jobs(policy())
            .unwrap()
            .submit(
                Credential::Session(auth::Secret::new(self.token.clone())),
                operation,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap()
            .receive()
            .unwrap()
        else {
            panic!("Job expected")
        };
        job
    }

    fn enqueue(&self, project_ids: Option<Vec<u64>>) -> String {
        self.user(UserOperation::Enqueue {
            key: "sync".into(),
            payload_version: 1,
            payload: Payload::Sync { project_ids },
        })
        .job_id
    }

    fn open(&self) -> AttemptLease {
        let ClaimedAttempt {
            lease, source_work, ..
        } = self.worker.claim_kind(JobKind::Sync).unwrap().unwrap();
        assert!(source_work.is_none());
        self.worker.open_source_sync(&lease).unwrap();
        lease
    }

    fn next(&self, lease: &mut AttemptLease) -> NextSyncTarget {
        self.worker.claim_next_source_sync_target(lease).unwrap()
    }

    fn connection(&self) -> Connection {
        Connection::open(self.root.join("print-partner.db")).unwrap()
    }

    fn job(&self, job_id: &str) -> JobRecord {
        let mut connection = self.connection();
        let tx = connection.transaction().unwrap();
        crate::jobs::load(&tx, job_id).unwrap().unwrap()
    }

    fn targets(&self, job_id: &str) -> Vec<(i64, String, Option<String>)> {
        self.connection()
            .prepare("SELECT requested_source_id,state,failure_code FROM source_sync_targets WHERE job_id=?1 ORDER BY ordinal")
            .unwrap()
            .query_map([job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn batch(&self, job_id: &str) -> (String, Option<String>) {
        self.connection()
            .query_row(
                "SELECT phase,halt_code FROM source_sync_batches WHERE job_id=?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn snapshot(&self) -> Value {
        let connection = self.connection();
        let rows = |sql: &str| -> Vec<Vec<String>> {
            let mut statement = connection.prepare(sql).unwrap();
            let width = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..width)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .map(|value| value.map(|value| format!("{value:?}")))
                        .collect()
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        serde_json::json!([
            rows("SELECT * FROM source_sync_batches"),
            rows("SELECT * FROM source_sync_targets ORDER BY ordinal"),
            rows("SELECT document FROM durable_jobs"),
            rows("SELECT count(*) FROM durable_job_history"),
        ])
    }

    fn begin_work(&self, id: i64) -> Result<catalog::SourceWorkLease> {
        self.catalog
            .begin_work(id, &AtomicBool::new(false), Duration::from_secs(5))
    }
}

fn local(target: NextSyncTarget) -> SyncTargetLease {
    let NextSyncTarget::Local(target) = target else {
        panic!("Local target expected")
    };
    target
}

#[test]
fn targets_follow_the_payload_order_and_unavailable_sources_fail() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/source-sync/source-sync.json"
    ))
    .unwrap();
    let sync = Fixture::new();
    let local_id = sync.source("Local");
    let remote = sync.source("Remote");
    sync.connection()
        .execute(
            "UPDATE projects SET source_type='github' WHERE id=?1",
            [remote],
        )
        .unwrap();
    // Node attempts the payload in order: the missing id, then the Local Source.
    let missing = golden["project_ids"][0].as_i64().unwrap();
    assert_eq!(golden["attempts"].as_array().unwrap().len(), 2);
    let job_id = sync.enqueue(Some(vec![missing as u64, remote as u64, local_id as u64]));
    let mut lease = sync.open();
    let version = lease.version();
    let NextSyncTarget::OrdinaryFailure(failure) = sync.next(&mut lease) else {
        panic!("ordinary failure expected")
    };
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        golden["result"]["failures"][0]
    );
    assert_eq!(lease.version(), version + 1);
    assert_eq!(sync.job(&job_id).progress, Some(33));
    let NextSyncTarget::OrdinaryFailure(failure) = sync.next(&mut lease) else {
        panic!("ordinary failure expected")
    };
    assert_eq!(
        failure,
        SourceSyncFailure {
            project_id: Some(remote as u64),
            name: Some("Remote".into()),
            error: "Source kind is not supported by Local Sync".into(),
        }
    );
    assert_eq!(sync.job(&job_id).progress, Some(66));
    let target = local(sync.next(&mut lease));
    assert_eq!(target.key().ordinal, 2);
    assert_eq!(target.observation().source_id(), local_id);
    assert_eq!(
        sync.targets(&job_id),
        [
            (missing, "failed".into(), Some("unavailable".into())),
            (remote, "failed".into(), Some("unsupported_kind".into())),
            (local_id, "claimed".into(), None)
        ]
    );
    sync.begin_work(remote).unwrap().release().unwrap();
}

#[test]
fn all_selection_seals_the_least_recently_synced_sources_first() {
    let sync = Fixture::new();
    let [first, second, third] = ["First", "Second", "Third"].map(|name| sync.source(name));
    sync.connection()
        .execute_batch(&format!(
            "UPDATE projects SET last_synced_at='2' WHERE id={first};
             UPDATE projects SET last_synced_at='1' WHERE id={second};"
        ))
        .unwrap();
    let job_id = sync.enqueue(None);
    let lease = sync.open();
    let sealed = vec![
        (third, "pending".into(), None),
        (second, "pending".into(), None),
        (first, "pending".into(), None),
    ];
    assert_eq!(sync.targets(&job_id), sealed);
    let late = sync.source("Late");
    sync.worker.open_source_sync(&lease).unwrap();
    assert_eq!(sync.targets(&job_id), sealed);
    sync.connection()
        .execute(
            "UPDATE source_sync_targets SET requested_source_id=?1 WHERE job_id=?2 AND ordinal=0",
            params![late, job_id],
        )
        .unwrap();
    let before = sync.snapshot();
    let error = sync.worker.open_source_sync(&lease).unwrap_err();
    assert_eq!(error.to_string(), "Sync target basis mismatch");
    assert_eq!(sync.snapshot(), before);
}

#[test]
fn recovery_returns_a_claim_to_pending_and_keeps_its_counter() {
    let sync = Fixture::new();
    let id = sync.source("Recovered");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    drop(local(sync.next(&mut lease)));
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt { mut lease, .. } = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&lease).unwrap();
    let reset: (String, Option<i64>, Option<String>, i64) = Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT state,parent_generation,reservation_token,claim_generation FROM source_sync_targets WHERE job_id=?1",
            [&job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(reset, ("pending".into(), None, None, 1));
    let target = local(worker.claim_next_source_sync_target(&mut lease).unwrap());
    assert_eq!(target.claim_generation, 2);
}

#[test]
fn claimed_target_records_its_attempt_and_holds_the_source() {
    let sync = Fixture::new();
    let id = sync.source("Held");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let ClaimedAttempt { mut lease, .. } = sync.worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    let bridge = sync
        .worker
        .begin_source_work(
            &lease,
            Some(id),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .err()
        .unwrap();
    assert_eq!(bridge.to_string(), "Attempt is not Source work");
    sync.worker.open_source_sync(&lease).unwrap();
    let version = lease.version();
    let target = local(sync.next(&mut lease));
    assert_eq!(lease.version(), version);
    let proof = target.source_work.proof().unwrap();
    let observation = &target.observation;
    type Captured = (
        String,
        i64,
        i64,
        String,
        String,
        String,
        String,
        i64,
        String,
    );
    let captured: Captured = sync
        .connection()
        .query_row(
            "SELECT state,claim_generation,parent_generation,attempt_worker,attempt_fence_digest,reservation_incarnation,reservation_token,configuration_version,authority_actor FROM source_sync_targets WHERE job_id=?1",
            [&job_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        captured,
        (
            "claimed".into(),
            1,
            lease.generation(),
            lease.worker().into(),
            digest(lease.fence()),
            proof.incarnation.clone(),
            format!("{:016x}", proof.token),
            observation.configuration_version,
            observation.authority_actor.clone(),
        )
    );
    assert_eq!(target.claim_generation, 1);
    let busy = sync.begin_work(id).err().unwrap();
    assert!(busy.downcast_ref::<SourceBusy>().is_some(), "{busy:#}");
    let again = sync
        .worker
        .claim_next_source_sync_target(&mut lease)
        .err()
        .unwrap();
    assert_eq!(again.to_string(), "Prior Sync target is not pending");
    drop(target);
    sync.begin_work(id).unwrap().release().unwrap();
}

#[test]
fn busy_source_leaves_the_target_pending() {
    let sync = Fixture::new();
    let id = sync.source("Busy");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    let mut held = sync.begin_work(id).unwrap();
    let before = sync.snapshot();
    let version = lease.version();
    let error = sync
        .worker
        .claim_next_source_sync_target(&mut lease)
        .err()
        .unwrap();
    assert!(error.downcast_ref::<SourceBusy>().is_some(), "{error:#}");
    assert_eq!(sync.snapshot(), before);
    assert_eq!(lease.version(), version);
    held.release().unwrap();
    assert_eq!(local(sync.next(&mut lease)).key().ordinal, 0);
    assert_eq!(sync.targets(&job_id)[0].1, "claimed");
}

#[test]
fn cancel_and_revoked_authority_close_the_batch() {
    for (revoke, claimed) in [(false, false), (false, true), (true, false), (true, true)] {
        let sync = Fixture::new();
        let [first, second] = ["First", "Second"].map(|name| sync.source(name));
        let job_id = sync.enqueue(Some(vec![first as u64, second as u64]));
        let mut lease = sync.open();
        let target = claimed.then(|| local(sync.next(&mut lease)));
        let job = if revoke {
            sync.connection()
                .execute("DELETE FROM sessions", [])
                .unwrap();
            assert!(matches!(sync.next(&mut lease), NextSyncTarget::Halted));
            let job = sync.job(&job_id);
            let refusal = job.authority_refusal.as_ref().unwrap();
            assert_eq!(
                (refusal.reason, refusal.phase, refusal.generation),
                (
                    AuthorityRefusalReason::CredentialInvalid,
                    AuthorityRefusalPhase::SourceWriter,
                    job.generation - 1
                )
            );
            assert_eq!(lease.version(), job.state_version);
            job
        } else {
            let job = sync.user(UserOperation::Cancel {
                job_id: job_id.clone(),
            });
            assert!(matches!(sync.next(&mut lease), NextSyncTarget::Halted));
            job
        };
        let (code, recovery) = if revoke {
            (
                "authority_refused",
                "Original credential is no longer valid",
            )
        } else {
            ("cancelled", "Sync was cancelled")
        };
        assert_eq!(job.recovery.as_deref(), Some(recovery));
        assert!(job.worker.is_none() && job.fence.is_none());
        let not_run = |id| (id, "not_run".into(), Some("batch_halt".into()));
        if claimed {
            let reason = if revoke { code } else { "local_settlement" };
            assert_eq!(job.state, PersistentState::ReconciliationRequired);
            assert_eq!(
                sync.targets(&job_id),
                [
                    (first, "reconciliation_required".into(), Some(reason.into())),
                    not_run(second)
                ]
            );
            assert_eq!(
                sync.batch(&job_id),
                ("reconciliation_required".into(), None)
            );
        } else {
            let state = if revoke {
                PersistentState::Failed
            } else {
                PersistentState::Cancelled
            };
            assert_eq!(job.state, state);
            assert_eq!(sync.targets(&job_id), [not_run(first), not_run(second)]);
            assert_eq!(sync.batch(&job_id), ("halted".into(), Some(code.into())));
        }
        drop(target);
    }
}

#[test]
fn repeated_authority_refusal_halt_preserves_evidence() {
    for claimed in [false, true] {
        let sync = Fixture::new();
        let id = sync.source("Refused");
        let job_id = sync.enqueue(Some(vec![id as u64]));
        let mut lease = sync.open();
        let target = claimed.then(|| local(sync.next(&mut lease)));
        sync.connection()
            .execute("DELETE FROM sessions", [])
            .unwrap();
        assert!(matches!(sync.next(&mut lease), NextSyncTarget::Halted));
        let refused = sync.job(&job_id);
        let before = sync.snapshot();
        let mut connection = sync.connection();
        let tx = connection.transaction().unwrap();
        let repeated = halt_job(
            &tx,
            refused.clone(),
            "authority_refused",
            refused.recovery.as_deref().unwrap(),
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(repeated.generation, refused.generation);
        assert_eq!(repeated.authority_refusal, refused.authority_refusal);
        assert_eq!(repeated.recovery, refused.recovery);
        assert_eq!(sync.snapshot(), before);
        drop(connection);
        drop(target);
        let Fixture { owner, root, .. } = sync;
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn authority_refusal_survives_cancel_twice_and_reopen() {
    let mut sync = Fixture::new();
    let id = sync.source("Refused");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    let target = local(sync.next(&mut lease));
    sync.connection()
        .execute("DELETE FROM sessions", [])
        .unwrap();
    assert!(matches!(sync.next(&mut lease), NextSyncTarget::Halted));
    let refused = sync.job(&job_id);
    assert_eq!(refused.state, PersistentState::ReconciliationRequired);
    assert_eq!(
        refused.recovery.as_deref(),
        Some("Original credential is no longer valid")
    );
    assert_eq!(
        sync.targets(&job_id)[0].2.as_deref(),
        Some("authority_refused")
    );
    let auth::Outcome::Session { token, .. } = sync
        .owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            auth::Request::Login {
                email: "source-sync@example.com".into(),
                password: auth::Secret::new("source-sync-test-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("session expected")
    };
    sync.token = token.expose().to_owned();
    let before = sync.snapshot();
    let cancelled = sync.user(UserOperation::Cancel {
        job_id: job_id.clone(),
    });
    assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.recovery, refused.recovery);
    assert_eq!(cancelled.authority_refusal, refused.authority_refusal);
    assert_eq!(cancelled.generation, refused.generation);
    let after = sync.snapshot();
    assert_eq!(after[0], before[0]);
    assert_eq!(after[1], before[1]);
    let repeated = sync.user(UserOperation::Cancel {
        job_id: job_id.clone(),
    });
    assert_eq!(repeated.authority_refusal, refused.authority_refusal);
    assert_eq!(repeated.recovery, refused.recovery);
    assert_eq!(repeated.generation, refused.generation);
    assert_eq!(sync.snapshot(), after);
    drop(target);
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let mut connection = Connection::open(root.join("print-partner.db")).unwrap();
    let tx = connection.transaction().unwrap();
    let reopened = jobs::load(&tx, &job_id).unwrap().unwrap();
    assert_eq!(reopened.authority_refusal, refused.authority_refusal);
    assert_eq!(reopened.recovery, refused.recovery);
    assert_eq!(reopened.generation, refused.generation);
    assert!(reopened.cancel_requested);
    assert_eq!(reopened.state, PersistentState::ReconciliationRequired);
    let failure: (String, String) = tx.query_row(
        "SELECT failure_code,failure_detail FROM source_sync_targets WHERE job_id=?1 AND ordinal=0",
        [&job_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(
        failure,
        (
            "authority_refused".into(),
            "Original credential is no longer valid".into()
        )
    );
    drop(tx);
    drop(connection);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn worker_failure_halts_an_open_batch() {
    let sync = Fixture::new();
    let id = sync.source("Failed");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    let job = sync
        .worker
        .update(&mut lease, WorkerOperation::Fail)
        .unwrap();
    assert_eq!(job.state, PersistentState::Failed);
    assert_eq!(job.recovery.as_deref(), Some("Source Sync worker failed"));
    assert_eq!(sync.batch(&job_id), ("halted".into(), Some("fatal".into())));
}

#[test]
fn claims_require_an_open_batch_and_the_live_attempt() {
    let sync = Fixture::new();
    let id = sync.source("Unopened");
    sync.enqueue(Some(vec![id as u64]));
    let ClaimedAttempt { mut lease, .. } = sync.worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    let before = sync.snapshot();
    let unopened = sync
        .worker
        .claim_next_source_sync_target(&mut lease)
        .err()
        .unwrap();
    assert_eq!(unopened.to_string(), "Sync batch is not open");
    assert_eq!(sync.snapshot(), before);
    sync.worker.open_source_sync(&lease).unwrap();
    let mut stale = lease.clone();
    sync.worker
        .update(&mut lease, WorkerOperation::Progress(1))
        .unwrap();
    let before = sync.snapshot();
    let error = sync
        .worker
        .claim_next_source_sync_target(&mut stale)
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "Stale attempt fence");
    assert_eq!(sync.snapshot(), before);
    assert_eq!(local(sync.next(&mut lease)).key().ordinal, 0);
}
