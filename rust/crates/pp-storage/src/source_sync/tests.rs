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
        kinds: vec![(JobKind::Sync, 1), (JobKind::CheckSourceUpdates, 1)],
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
        Self::with_admission(admission())
    }

    fn with_admission(admission: WorkerAdmission) -> Self {
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
        let worker = owner.job_worker_with_policy(policy(), admission).unwrap();
        Self {
            owner,
            root,
            token,
            catalog,
            worker,
        }
    }

    fn login(&mut self) {
        let auth::Outcome::Session { token, .. } = self
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
        self.token = token.expose().to_owned();
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
        database_snapshot(&self.connection())
    }

    fn begin_work(&self, id: i64) -> Result<catalog::SourceWorkLease> {
        self.catalog
            .begin_work(id, &AtomicBool::new(false), Duration::from_secs(5))
    }
}

fn database_snapshot(connection: &Connection) -> Value {
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

fn local(target: NextSyncTarget) -> SyncTargetLease {
    let NextSyncTarget::Local(target) = target else {
        panic!("Local target expected")
    };
    target
}

#[test]
fn generic_sync_finish_and_effects_preserve_the_claim_and_reservation() {
    let mut sync = Fixture::new();
    let id = sync.source("Owned target");
    sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    let target = local(sync.next(&mut lease));
    let proof = target.source_work.proof().unwrap();
    let operations = || {
        let receipt = jobs::ResultArtifact {
            receipt_id: "generic-receipt".into(),
            content_hash: "b".repeat(64),
            target: id.to_string(),
        };
        let mut operations = vec![
            WorkerOperation::Finish(None),
            WorkerOperation::Finish(Some(receipt.clone())),
            WorkerOperation::FinishPublic {
                artifact: None,
                result: Box::new(jobs::CompletedResult::SourceSync(jobs::SourceSyncResult {
                    synced: 1,
                    failed: 0,
                    results: vec![],
                    failures: vec![],
                })),
            },
            WorkerOperation::ConfirmEffect(receipt),
        ];
        operations.extend(
            [
                jobs::EffectOperation::SourceRefresh,
                jobs::EffectOperation::LocalArtifact,
                jobs::EffectOperation::PrinterUpload,
                jobs::EffectOperation::PrinterUploadAndStart,
                jobs::EffectOperation::PrinterStart,
                jobs::EffectOperation::SpoolmanDeduction,
            ]
            .map(|operation| {
                WorkerOperation::BeginEffect(jobs::EffectIntent {
                    operation,
                    basis_hash: "a".repeat(64),
                    content_hash: "b".repeat(64),
                    target: id.to_string(),
                })
            }),
        );
        operations
    };
    let before = sync.snapshot();
    let version = lease.version();
    for revoke in [false, true] {
        if revoke {
            sync.connection()
                .execute("DELETE FROM sessions", [])
                .unwrap();
            sync.login();
            sync.catalog = sync
                .owner
                .source_catalog_with_policy(
                    catalog::Credentials::Session(auth::Secret::new(sync.token.clone())),
                    policy(),
                )
                .unwrap();
        }
        for operation in operations() {
            let error = sync.worker.update(&mut lease, operation).unwrap_err();
            assert_eq!(
                error.to_string(),
                "Sync operation belongs to its journal owner"
            );
            assert_eq!(sync.snapshot(), before);
            assert_eq!(lease.version(), version);
            let retained = target.source_work.proof().unwrap();
            assert_eq!(retained.incarnation, proof.incarnation);
            assert_eq!(retained.token, proof.token);
            assert!(
                sync.begin_work(id)
                    .err()
                    .unwrap()
                    .downcast_ref::<SourceBusy>()
                    .is_some()
            );
        }
    }
    drop(target);
    sync.begin_work(id).unwrap().release().unwrap();
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn non_sync_generic_effects_and_finish_remain_available() {
    let sync = Fixture::new();
    sync.user(UserOperation::Enqueue {
        key: "updates".into(),
        payload_version: 1,
        payload: Payload::CheckSourceUpdates {},
    });
    let worker = &sync.worker;
    let mut lease = worker
        .claim_kind(JobKind::CheckSourceUpdates)
        .unwrap()
        .unwrap()
        .lease;
    for operation in [
        jobs::EffectOperation::SourceRefresh,
        jobs::EffectOperation::LocalArtifact,
    ] {
        let target = format!("{operation:?}");
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(jobs::EffectIntent {
                    operation,
                    basis_hash: "a".repeat(64),
                    content_hash: "b".repeat(64),
                    target: target.clone(),
                }),
            )
            .unwrap();
        worker
            .update(
                &mut lease,
                WorkerOperation::ConfirmEffect(jobs::ResultArtifact {
                    receipt_id: target.clone(),
                    content_hash: "b".repeat(64),
                    target,
                }),
            )
            .unwrap();
    }
    let done = worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    assert_eq!(done.state, PersistentState::Succeeded);
    assert_eq!(done.progress, Some(100));
    assert_eq!(done.effects.len(), 2);
    assert!(done.effects.iter().all(|effect| effect.confirmed));
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
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

fn reopen(sync: Fixture) -> Fixture {
    reopen_with_admission(sync, admission())
}

fn reopen_with_admission(sync: Fixture, admission: WorkerAdmission) -> Fixture {
    let Fixture {
        owner, root, token, ..
    } = sync;
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let catalog = owner
        .source_catalog_with_policy(
            catalog::Credentials::Session(auth::Secret::new(token.clone())),
            policy(),
        )
        .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission).unwrap();
    Fixture {
        owner,
        root,
        token,
        catalog,
        worker,
    }
}

fn change_job(sync: &Fixture, job_id: &str, change: impl FnOnce(&mut JobRecord)) {
    let mut connection = sync.connection();
    let tx = connection.transaction().unwrap();
    let mut job = jobs::load(&tx, job_id).unwrap().unwrap();
    change(&mut job);
    jobs::save(&tx, &mut job, "test_recovery_setup").unwrap();
    tx.commit().unwrap();
}

fn enqueue_later(sync: &Fixture, source_id: i64) -> String {
    sync.user(UserOperation::Enqueue {
        key: "later-sync".into(),
        payload_version: 1,
        payload: Payload::Sync {
            project_ids: Some(vec![source_id as u64]),
        },
    })
    .job_id
}

fn durable_claim_blocks_a_second_sync(restart: bool) {
    let admission = WorkerAdmission {
        kinds: vec![(JobKind::Sync, 2)],
        total: 2,
        per_resource: 2,
        ..admission()
    };
    let mut sync = Fixture::with_admission(admission.clone());
    let id = sync.source("Durably claimed");
    let first_job = sync.enqueue(Some(vec![id as u64]));
    let mut first = sync.open();
    drop(local(sync.next(&mut first)));
    if restart {
        sync = reopen_with_admission(sync, admission);
    } else {
        change_job(&sync, &first_job, |job| job.lease_until = Some(now() - 1));
    }
    let ClaimedAttempt {
        lease: resumed_first,
        ..
    } = sync.worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(resumed_first.job_id(), first_job);
    let second_job = enqueue_later(&sync, id);
    let worker = &sync.worker;
    let ClaimedAttempt {
        lease: mut second, ..
    } = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(second.job_id(), second_job);
    worker.open_source_sync(&second).unwrap();
    let before = sync.snapshot();
    let version = second.version();
    let error = worker
        .claim_next_source_sync_target(&mut second)
        .err()
        .unwrap();
    assert!(error.downcast_ref::<SourceBusy>().is_some(), "{error:#}");
    assert_eq!(sync.snapshot(), before);
    assert_eq!(second.version(), version);
    assert_eq!(sync.targets(&second_job), [(id, "pending".into(), None)]);
    sync.worker.open_source_sync(&resumed_first).unwrap();
    let target = local(worker.claim_next_source_sync_target(&mut second).unwrap());
    assert_eq!(target.claim_generation, 1);
    assert_eq!(sync.targets(&second_job), [(id, "claimed".into(), None)]);
}

#[test]
fn durable_claim_returns_source_busy_after_restart() {
    durable_claim_blocks_a_second_sync(true);
}

#[test]
fn durable_claim_returns_source_busy_after_lease_expiry() {
    durable_claim_blocks_a_second_sync(false);
}

fn terminal_recovery_closes_sync_batch(reason: &str, effect_confirmed: bool) {
    for restart in [false, true] {
        for claimed in [false, true] {
            let mut sync = Fixture::new();
            let [first, second] = ["First", "Second"].map(|name| sync.source(name));
            let job_id = sync.enqueue(Some(vec![first as u64, second as u64]));
            if reason == "attempt_limit" {
                change_job(&sync, &job_id, |job| {
                    job.attempt = 99;
                    job.generation = 99;
                });
            }
            let mut lease = sync.open();
            if claimed {
                drop(local(sync.next(&mut lease)));
            }
            let before = sync.job(&job_id);
            change_job(&sync, &job_id, |job| {
                job.lease_until = Some(now() - 1);
                if reason == "cancelled" {
                    job.cancel_requested = true;
                } else if reason == "effect" {
                    job.state = PersistentState::EffectAdmitted;
                    job.effects.push(jobs::EffectReceipt {
                        intent: jobs::EffectIntent {
                            operation: jobs::EffectOperation::SourceRefresh,
                            basis_hash: "a".repeat(64),
                            content_hash: "b".repeat(64),
                            target: first.to_string(),
                        },
                        attempt: job.attempt,
                        generation: job.generation,
                        confirmed: effect_confirmed,
                        no_effect: false,
                        receipt: effect_confirmed.then(|| jobs::ResultArtifact {
                            receipt_id: "sync-receipt".into(),
                            content_hash: "b".repeat(64),
                            target: first.to_string(),
                        }),
                        checklist_completion: None,
                    });
                }
            });
            let effects = sync.job(&job_id).effects;
            if restart {
                sync = reopen(sync);
            }
            assert!(sync.worker.claim_kind(JobKind::Sync).unwrap().is_none());
            let recovered = sync.job(&job_id);
            let unresolved = claimed || reason == "effect";
            assert_eq!(
                recovered.state,
                if unresolved {
                    PersistentState::ReconciliationRequired
                } else if reason == "cancelled" {
                    PersistentState::Cancelled
                } else {
                    PersistentState::Failed
                }
            );
            assert_eq!(recovered.generation, before.generation + 1);
            assert!(recovered.fence.is_none());
            assert!(recovered.worker.is_none());
            assert!(recovered.lease_until.is_none());
            assert_eq!(recovered.effects, effects);
            let detail = match reason {
                "attempt_limit" => "Attempt limit reached",
                "cancelled" => "Sync was cancelled",
                "effect" if effect_confirmed => {
                    "Resume from confirmed receipts requires handler reconciliation"
                }
                "effect" => "Inspect effect receipts and reconcile explicitly",
                _ => unreachable!(),
            };
            assert_eq!(recovered.recovery.as_deref(), Some(detail));
            assert_eq!(
                sync.targets(&job_id),
                [
                    if claimed {
                        (
                            first,
                            "reconciliation_required".into(),
                            Some("local_settlement".into()),
                        )
                    } else {
                        (first, "not_run".into(), Some("batch_halt".into()))
                    },
                    (second, "not_run".into(), Some("batch_halt".into())),
                ]
            );
            assert_eq!(
                sync.batch(&job_id),
                if unresolved {
                    ("reconciliation_required".into(), None)
                } else {
                    (
                        "halted".into(),
                        Some(
                            if reason == "cancelled" {
                                "cancelled"
                            } else {
                                "fatal"
                            }
                            .into(),
                        ),
                    )
                }
            );
            let snapshot = sync.snapshot();
            sync = reopen(sync);
            assert_eq!(sync.snapshot(), snapshot);
            let later_source = sync.source("Later work");
            let later = enqueue_later(&sync, later_source);
            let mut lease = sync.open();
            assert_eq!(lease.job_id(), later);
            assert_eq!(local(sync.next(&mut lease)).claim_generation, 1);
            assert_eq!(
                sync.targets(&later),
                [(later_source, "claimed".into(), None)]
            );
        }
    }
}

#[test]
fn attempt_limit_recovery_closes_sync_batch() {
    terminal_recovery_closes_sync_batch("attempt_limit", false);
}

#[test]
fn unconfirmed_effect_recovery_closes_sync_batch() {
    terminal_recovery_closes_sync_batch("effect", false);
}

#[test]
fn confirmed_effect_recovery_closes_sync_batch() {
    terminal_recovery_closes_sync_batch("effect", true);
}

#[test]
fn cancellation_recovery_closes_sync_batch() {
    terminal_recovery_closes_sync_batch("cancelled", false);
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
fn open_authority_refusal_prunes_terminal_jobs() {
    let sync = Fixture::new();
    let id = sync.source("Pending");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let ClaimedAttempt { lease, .. } = sync.worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    sync.worker.open_source_sync(&lease).unwrap();
    let mut connection = sync.connection();
    let tx = connection.transaction().unwrap();
    let mut older = jobs::load(&tx, &job_id).unwrap().unwrap();
    older.job_id = "older-terminal".into();
    older.state = PersistentState::Failed;
    older.worker = None;
    older.fence = None;
    older.lease_until = None;
    jobs::save(&tx, &mut older, "test_terminal").unwrap();
    tx.execute(
        "UPDATE durable_jobs SET updated=?1 WHERE id=?2",
        params![now() - 86401, older.job_id],
    )
    .unwrap();
    tx.execute("DELETE FROM sessions", []).unwrap();
    tx.commit().unwrap();
    let error = sync.worker.open_source_sync(&lease).unwrap_err();
    assert_eq!(
        error.downcast_ref::<auth::AuthorityFailure>(),
        Some(&auth::AuthorityFailure::CredentialInvalid)
    );
    assert_sync_refusal(&sync, &job_id, &lease, false, true);
    let tx = connection.transaction().unwrap();
    assert!(jobs::load(&tx, "older-terminal").unwrap().is_none());
    assert_eq!(
        tx.query_row("SELECT count(*) FROM durable_jobs", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(tx);
    assert_refusal_survives_reopen(sync, &job_id);
}

#[test]
fn open_and_advance_authority_refusal_halts_without_claimed_targets() {
    for (opened, advance) in [(false, false), (true, false), (true, true)] {
        let sync = Fixture::new();
        let id = sync.source("Pending");
        let job_id = sync.enqueue(Some(vec![id as u64]));
        let ClaimedAttempt { mut lease, .. } =
            sync.worker.claim_kind(JobKind::Sync).unwrap().unwrap();
        if opened {
            sync.worker.open_source_sync(&lease).unwrap();
        }
        sync.connection()
            .execute("DELETE FROM sessions", [])
            .unwrap();
        let error = if advance {
            sync.worker
                .update(&mut lease, WorkerOperation::Heartbeat)
                .unwrap_err()
        } else {
            sync.worker.open_source_sync(&lease).unwrap_err()
        };
        assert_eq!(
            error.downcast_ref::<auth::AuthorityFailure>(),
            Some(&auth::AuthorityFailure::CredentialInvalid)
        );
        let refused = sync.job(&job_id);
        assert_eq!(refused.state, PersistentState::Failed);
        assert_sync_refusal(&sync, &job_id, &lease, false, opened);
        assert_refusal_survives_reopen(sync, &job_id);
    }
}

#[test]
fn open_and_advance_authority_refusals_preserve_claimed_target_evidence() {
    for at_open in [false, true] {
        let mut sync = Fixture::new();
        let first = sync.source("Claimed");
        let second = sync.source("Pending");
        let job_id = sync.enqueue(Some(vec![first as u64, second as u64]));
        let mut lease = sync.open();
        let mut target = Some(local(sync.next(&mut lease)));
        let evidence = sync.connection().query_row(
            "SELECT parent_generation,attempt_worker,attempt_fence_digest,reservation_incarnation,reservation_token,configuration_version,authority_actor,authority_basis_digest,activation_observation_digest,path_observation_digest FROM source_sync_targets WHERE job_id=?1 AND ordinal=0",
            [&job_id],
            |row| (0..10).map(|index| row.get::<_, rusqlite::types::Value>(index)).collect::<rusqlite::Result<Vec<_>>>(),
        ).unwrap();
        if at_open {
            drop(target.take());
            let Fixture {
                owner, root, token, ..
            } = sync;
            owner.shutdown().unwrap();
            let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
            let catalog = owner
                .source_catalog_with_policy(
                    catalog::Credentials::Session(auth::Secret::new(token.clone())),
                    policy(),
                )
                .unwrap();
            let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
            lease = worker.claim_kind(JobKind::Sync).unwrap().unwrap().lease;
            sync = Fixture {
                owner,
                root,
                token,
                catalog,
                worker,
            };
        }
        sync.connection()
            .execute("DELETE FROM sessions", [])
            .unwrap();
        let error = if at_open {
            sync.worker.open_source_sync(&lease).unwrap_err()
        } else {
            sync.worker
                .update(&mut lease, WorkerOperation::Progress(10))
                .unwrap_err()
        };
        assert_eq!(
            error.downcast_ref::<auth::AuthorityFailure>(),
            Some(&auth::AuthorityFailure::CredentialInvalid)
        );
        assert_sync_refusal(&sync, &job_id, &lease, true, true);
        let retained = sync.connection().query_row(
            "SELECT parent_generation,attempt_worker,attempt_fence_digest,reservation_incarnation,reservation_token,configuration_version,authority_actor,authority_basis_digest,activation_observation_digest,path_observation_digest FROM source_sync_targets WHERE job_id=?1 AND ordinal=0",
            [&job_id],
            |row| (0..10).map(|index| row.get::<_, rusqlite::types::Value>(index)).collect::<rusqlite::Result<Vec<_>>>(),
        ).unwrap();
        assert_eq!(retained, evidence);
        assert_eq!(
            sync.targets(&job_id),
            [
                (
                    first,
                    "reconciliation_required".into(),
                    Some("authority_refused".into())
                ),
                (second, "not_run".into(), Some("batch_halt".into())),
            ]
        );
        if !at_open {
            sync.login();
            sync.catalog = sync
                .owner
                .source_catalog_with_policy(
                    catalog::Credentials::Session(auth::Secret::new(sync.token.clone())),
                    policy(),
                )
                .unwrap();
            let busy = sync.begin_work(first).err().unwrap();
            assert!(busy.downcast_ref::<SourceBusy>().is_some());
        }
        drop(target);
        assert_refusal_survives_reopen(sync, &job_id);
    }
}

#[test]
fn unrecognized_open_and_advance_failures_leave_the_batch_unchanged() {
    let sync = Fixture::new();
    let id = sync.source("Claimed");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    let target = local(sync.next(&mut lease));
    sync.connection()
        .execute("ALTER TABLE sessions RENAME TO unavailable_sessions", [])
        .unwrap();
    let before = sync.snapshot();
    let open_error = sync.worker.open_source_sync(&lease).unwrap_err();
    assert!(
        open_error.downcast_ref::<rusqlite::Error>().is_some(),
        "{open_error:#}"
    );
    assert_eq!(sync.snapshot(), before);
    let advance_error = sync
        .worker
        .update(&mut lease, WorkerOperation::Heartbeat)
        .unwrap_err();
    assert!(
        advance_error.downcast_ref::<rusqlite::Error>().is_some(),
        "{advance_error:#}"
    );
    assert_eq!(sync.snapshot(), before);
    sync.connection()
        .execute("ALTER TABLE unavailable_sessions RENAME TO sessions", [])
        .unwrap();
    assert_eq!(sync.job(&job_id).state, PersistentState::Running);
    drop(target);
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

fn assert_sync_refusal(
    sync: &Fixture,
    job_id: &str,
    lease: &AttemptLease,
    claimed: bool,
    opened: bool,
) {
    let job = sync.job(job_id);
    let refusal = job.authority_refusal.as_ref().unwrap();
    assert_eq!(
        (refusal.reason, refusal.phase, refusal.generation),
        (
            AuthorityRefusalReason::CredentialInvalid,
            AuthorityRefusalPhase::SourceWriter,
            lease.generation(),
        )
    );
    assert_eq!(job.generation, lease.generation() + 1);
    assert!(job.worker.is_none() && job.fence.is_none() && job.lease_until.is_none());
    assert_eq!(
        job.recovery.as_deref(),
        Some("Original credential is no longer valid")
    );
    assert_eq!(
        job.state,
        if claimed {
            PersistentState::ReconciliationRequired
        } else {
            PersistentState::Failed
        }
    );
    if opened {
        assert_eq!(
            sync.batch(job_id),
            if claimed {
                ("reconciliation_required".into(), None)
            } else {
                ("halted".into(), Some("authority_refused".into()))
            }
        );
        if !claimed {
            assert_eq!(sync.targets(job_id)[0].1, "not_run");
        }
    } else {
        assert_eq!(
            sync.connection()
                .query_row("SELECT count(*) FROM source_sync_batches", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(sync.targets(job_id).is_empty());
    }
    let before = sync.snapshot();
    assert!(sync.worker.open_source_sync(lease).is_err());
    let mut stale = lease.clone();
    assert!(
        sync.worker
            .update(&mut stale, WorkerOperation::Heartbeat)
            .is_err()
    );
    assert_eq!(sync.snapshot(), before);
}

fn assert_refusal_survives_reopen(sync: Fixture, job_id: &str) {
    let before = sync.snapshot();
    let refused = sync.job(job_id);
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let mut connection = Connection::open(root.join("print-partner.db")).unwrap();
    let tx = connection.transaction().unwrap();
    let reopened = jobs::load(&tx, job_id).unwrap().unwrap();
    assert_eq!(reopened.authority_refusal, refused.authority_refusal);
    assert_eq!(reopened.recovery, refused.recovery);
    assert_eq!(reopened.generation, refused.generation);
    assert_eq!(reopened.state, refused.state);
    drop(tx);
    assert_eq!(database_snapshot(&connection), before);
    drop(connection);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancel_preserves_a_batch_halted_by_worker_advance_refusal() {
    let mut sync = Fixture::new();
    let id = sync.source("Pending");
    let job_id = sync.enqueue(Some(vec![id as u64]));
    let mut lease = sync.open();
    // Retained jobs can contain generic effects admitted before GRE-854.
    let mut legacy = sync.job(&job_id);
    legacy.effects.push(jobs::EffectReceipt {
        intent: jobs::EffectIntent {
            operation: jobs::EffectOperation::SourceRefresh,
            basis_hash: "a".repeat(64),
            content_hash: "b".repeat(64),
            target: id.to_string(),
        },
        attempt: legacy.attempt,
        generation: legacy.generation,
        confirmed: false,
        no_effect: false,
        receipt: None,
        checklist_completion: None,
    });
    sync.connection()
        .execute(
            "UPDATE durable_jobs SET state='effect_admitted',document=json_set(document,'$.state','effect_admitted','$.effects',json(?1)) WHERE id=?2",
            params![serde_json::to_string(&legacy.effects).unwrap(), job_id],
        )
        .unwrap();
    sync.connection()
        .execute("DELETE FROM sessions", [])
        .unwrap();
    assert!(
        sync.worker
            .update(&mut lease, WorkerOperation::Heartbeat)
            .is_err()
    );
    let refused = sync.job(&job_id);
    assert_eq!(refused.state, PersistentState::ReconciliationRequired);
    assert_eq!(
        refused.authority_refusal.as_ref().unwrap().phase,
        AuthorityRefusalPhase::SourceWriter
    );
    assert_eq!(
        sync.batch(&job_id),
        ("reconciliation_required".into(), None)
    );
    sync.login();
    let cancelled = sync.user(UserOperation::Cancel {
        job_id: job_id.clone(),
    });
    assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.state, PersistentState::ReconciliationRequired);
    assert_eq!(cancelled.generation, refused.generation);
    assert_eq!(cancelled.authority_refusal, refused.authority_refusal);
    assert_eq!(
        sync.batch(&job_id),
        ("reconciliation_required".into(), None)
    );
    assert_eq!(
        sync.targets(&job_id),
        [(id, "not_run".into(), Some("batch_halt".into()))]
    );
    let Fixture { owner, root, .. } = sync;
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
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
    sync.login();
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
