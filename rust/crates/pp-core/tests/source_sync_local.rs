use pp_core::source_sync::LocalSourceSyncWorker;
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy,
        Request as AuthRequest, Secret, SessionTenantPolicy,
    },
    catalog::{
        CreateSource, Credentials, Deletion, Outcome as CatalogOutcome, Request as CatalogRequest,
    },
    jobs::{
        ClaimedAttempt, CompletedResult, Credential, Decision, EffectIntent, EffectOperation,
        JobKind, Outcome as JobOutcome, Payload, PersistentState, ResultArtifact, SourceSyncResult,
        UserOperation, WorkerAdmission, WorkerOperation,
    },
    source_scan::{LocalDocumentKind, LocalDocumentRecord},
};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
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

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-source-sync-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn register(owner: &WriterOwner, ordinal: u8) -> String {
    let AuthOutcome::Session { token, .. } = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            AuthRequest::Register {
                email: format!("source-sync-{ordinal}@example.com"),
                display_name: format!("Source Sync {ordinal}"),
                password: Secret::new(format!("long-source-sync-password-{ordinal}")),
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
    token.expose().to_owned()
}

fn create_local_source(owner: &WriterOwner, token: &str, name: &str) -> i64 {
    let CatalogOutcome::Source(Some(source)) = owner
        .source_catalog_with_policy(Credentials::Session(Secret::new(token.into())), policy())
        .unwrap()
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: name.into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    source.id
}

fn enqueue(
    owner: &WriterOwner,
    token: &str,
    key: &str,
    project_ids: Option<Vec<u64>>,
) -> anyhow::Result<String> {
    let JobOutcome::Job(job, _) = owner
        .jobs(policy())?
        .submit(
            Credential::Session(Secret::new(token.into())),
            UserOperation::Enqueue {
                key: key.into(),
                payload_version: 1,
                payload: Payload::Sync { project_ids },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
    else {
        panic!("job expected")
    };
    Ok(job.job_id)
}

fn enqueue_import(
    owner: &WriterOwner,
    token: &str,
    key: &str,
    source_id: i64,
) -> anyhow::Result<String> {
    let JobOutcome::Job(job, _) = owner
        .jobs(policy())?
        .submit(
            Credential::Session(Secret::new(token.into())),
            UserOperation::Enqueue {
                key: key.into(),
                payload_version: 1,
                payload: Payload::ImportScan {
                    project_id: source_id.try_into()?,
                },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
    else {
        panic!("job expected")
    };
    Ok(job.job_id)
}

fn admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: vec![
            (JobKind::SuppliedSourceImport, 1),
            (JobKind::ImportScan, 1),
            (JobKind::Sync, 1),
        ],
        total: 1,
        per_resource: 1,
        lease_seconds: 3600,
    }
}

fn read(path: &Path) -> Connection {
    Connection::open_with_flags(
        path.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}

fn history(path: &Path, job_id: &str) -> Vec<(i64, String, String)> {
    read(path)
        .prepare(
            "SELECT version,state,event FROM durable_job_history WHERE job_id=?1 ORDER BY version",
        )
        .unwrap()
        .query_map([job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn public_job(owner: &WriterOwner, token: &str, job_id: &str) -> serde_json::Value {
    serde_json::to_value(
        owner
            .jobs(policy())
            .unwrap()
            .read_public(
                Credential::Session(Secret::new(token.into())),
                job_id.into(),
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn import_scan_refuses_an_observation_captured_for_another_source_before_mutation() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 31);
    let source_a = create_local_source(&owner, &token, "Guard Source A");
    let source_b = create_local_source(&owner, &token, "Guard Source B");
    let sync_job = enqueue(
        &owner,
        &token,
        "capture-source-b-observation",
        Some(vec![source_b.try_into().unwrap()]),
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut sync_claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(sync_claim.job.job_id, sync_job);
    worker.open_source_sync(&sync_claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut source_b_target) = worker
        .claim_next_source_sync_target(&mut sync_claim.lease)
        .unwrap()
    else {
        panic!("Source B target expected")
    };
    let source_b_observation = source_b_target.observation().clone();
    worker
        .settle_source_sync_target(
            &mut sync_claim.lease,
            &mut source_b_target,
            source_b_observation.clone().settlement(Vec::new()),
        )
        .unwrap();
    worker.finish_source_sync(&sync_claim.lease).unwrap();

    let import_job = enqueue_import(
        &owner,
        &token,
        "reject-source-b-observation-for-source-a",
        source_a,
    )
    .unwrap();
    let ClaimedAttempt {
        mut lease,
        source_work,
        ..
    } = worker.claim_kind(JobKind::ImportScan).unwrap().unwrap();
    let source_work = source_work.unwrap();
    let source_a_observation = worker.observe_local_scan(&lease, &source_work).unwrap();
    assert_eq!(source_a_observation.source_id(), source_a);

    let history_before = history(&root, &import_job);
    let public_before = public_job(&owner, &token, &import_job);
    let source_b_docs_before = read(&root)
        .query_row(
            "SELECT count(*) FROM source_docs WHERE project_id=?1",
            [source_b],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    let error = worker
        .settle_local_scan(
            &mut lease,
            &source_work,
            source_b_observation.settlement(vec![LocalDocumentRecord {
                relative_path: "wrong-source.md".into(),
                kind: LocalDocumentKind::Markdown,
                size_bytes: 1,
                content_sha256: "0".repeat(64),
            }]),
        )
        .unwrap_err();
    assert!(error.to_string().contains("settlement Source mismatch"));
    assert_eq!(history(&root, &import_job), history_before);
    assert_eq!(public_job(&owner, &token, &import_job), public_before);
    let database = read(&root);
    assert_eq!(
        database
            .query_row(
                "SELECT source_id,phase FROM source_scan_executions WHERE job_id=?1",
                [&import_job],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap(),
        (source_a, "observed".into())
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM source_docs WHERE project_id=?1",
                [source_b],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        source_b_docs_before
    );
    drop(database);
    drop(source_work);
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_cannot_finish_a_nonempty_claim_before_opening_its_batch() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 32);
    let foreign_token = register(&owner, 34);
    let source = create_local_source(&owner, &token, "Finish Guard Source");
    let job_id = enqueue(
        &owner,
        &token,
        "finish-before-open",
        Some(vec![source.try_into().unwrap()]),
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(claim.job.job_id, job_id);
    let history_before = history(&root, &job_id);
    let public_before = public_job(&owner, &token, &job_id);

    assert!(worker.finish_source_sync(&claim.lease).is_err());
    assert_eq!(history(&root, &job_id), history_before);
    assert_eq!(public_job(&owner, &token, &job_id), public_before);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_sync_batches WHERE job_id=?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );

    worker.open_source_sync(&claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut target) = worker
        .claim_next_source_sync_target(&mut claim.lease)
        .unwrap()
    else {
        panic!("Local target expected")
    };
    let key = target.key().clone();
    let mut direct_successor_retry = claim.lease.clone();
    let settlement = target.settlement(Vec::new());
    let settled = worker
        .settle_source_sync_target(&mut claim.lease, &mut target, settlement)
        .unwrap();
    let history_after_acknowledgement = history(&root, &job_id);
    let repeated_acknowledgement = worker
        .adopt_source_sync_target(&mut direct_successor_retry, key)
        .unwrap();
    assert_eq!(repeated_acknowledgement, settled);
    assert_eq!(history(&root, &job_id), history_after_acknowledgement);
    let pp_storage::source_sync::SourceSyncFinishOutcome::Completed(completed) =
        worker.finish_source_sync(&direct_successor_retry).unwrap()
    else {
        panic!("ordinary Sync completion required reconciliation")
    };
    assert_eq!(completed.job.job_id, job_id);
    assert_eq!(completed.job.state, PersistentState::Succeeded);
    let history_after_finish = history(&root, &job_id);
    let pp_storage::source_sync::SourceSyncFinishOutcome::Completed(repeated) =
        worker.finish_source_sync(&direct_successor_retry).unwrap()
    else {
        panic!("validated Sync reply retry required reconciliation")
    };
    assert_eq!(repeated.job.state_version, completed.job.state_version);
    assert_eq!(history(&root, &job_id), history_after_finish);
    let jobs = owner.jobs(policy()).unwrap();
    let recovery = jobs
        .inspect_source_sync_recovery(
            Credential::Session(Secret::new(token.clone())),
            job_id.clone(),
            completed.job.state_version,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(recovery.job_id(), job_id);
    assert_eq!(
        recovery.state(),
        pp_storage::source_sync::SyncRecoveryState::Completed
    );
    assert_eq!(recovery.targets().len(), 1);
    assert!(recovery.targets()[0].acknowledged());
    assert!(
        jobs.inspect_source_sync_recovery(
            Credential::Session(Secret::new(token)),
            job_id,
            completed.job.state_version - 1,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .is_err()
    );
    assert!(
        jobs.inspect_source_sync_recovery(
            Credential::Session(Secret::new(foreign_token)),
            completed.job.job_id.clone(),
            completed.job.state_version,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .is_err()
    );
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_rejects_generic_completion_and_unselected_reservation_and_refreshes_ack_progress() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 33);
    let first = create_local_source(&owner, &token, "Contract Source A");
    let second = create_local_source(&owner, &token, "Contract Source B");
    let unselected = create_local_source(&owner, &token, "Unselected Source");
    let job_id = enqueue(
        &owner,
        &token,
        "source-sync-contract-guards",
        Some(vec![first.try_into().unwrap(), second.try_into().unwrap()]),
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&claim.lease).unwrap();

    assert!(
        worker
            .begin_source_work(
                &claim.lease,
                Some(unselected),
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .is_err()
    );
    let history_before_refusals = history(&root, &job_id);
    assert!(
        worker
            .update(
                &mut claim.lease,
                WorkerOperation::BeginEffect(EffectIntent {
                    operation: EffectOperation::SourceRefresh,
                    basis_hash: "0".repeat(64),
                    content_hash: "1".repeat(64),
                    target: first.to_string(),
                })
            )
            .is_err()
    );
    assert!(
        worker
            .update(
                &mut claim.lease,
                WorkerOperation::ConfirmEffect(ResultArtifact {
                    receipt_id: "source-sync-must-refuse".into(),
                    content_hash: "1".repeat(64),
                    target: first.to_string(),
                })
            )
            .is_err()
    );
    assert!(
        owner
            .jobs(policy())
            .unwrap()
            .submit(
                Credential::Session(Secret::new(token.clone())),
                UserOperation::Reconcile {
                    job_id: job_id.clone(),
                    expected_version: claim.job.state_version,
                    expected_generation: claim.job.generation,
                    effect_hash: "1".repeat(64),
                    decision: Decision::Abandon,
                    receipt: None,
                },
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap()
            .receive()
            .is_err()
    );
    assert!(
        worker
            .update(&mut claim.lease, WorkerOperation::Finish(None))
            .is_err()
    );
    assert_eq!(history(&root, &job_id), history_before_refusals);
    assert!(
        worker
            .update(
                &mut claim.lease,
                WorkerOperation::FinishPublic {
                    artifact: None,
                    result: Box::new(CompletedResult::SourceSync(SourceSyncResult {
                        synced: 0,
                        failed: 0,
                        results: Vec::new(),
                        failures: Vec::new(),
                    })),
                },
            )
            .is_err()
    );
    assert_eq!(history(&root, &job_id), history_before_refusals);

    let pp_storage::source_sync::NextSyncTarget::Local(mut target) = worker
        .claim_next_source_sync_target(&mut claim.lease)
        .unwrap()
    else {
        panic!("first selected target expected")
    };
    let settlement = target.settlement(Vec::new());
    worker
        .settle_source_sync_target(&mut claim.lease, &mut target, settlement)
        .unwrap();
    assert_eq!(
        public_job(&owner, &token, &job_id)["progress"],
        serde_json::json!(50)
    );
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
            UserOperation::Cancel {
                job_id: job_id.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    assert!(matches!(
        worker
            .claim_next_source_sync_target(&mut claim.lease)
            .unwrap(),
        pp_storage::source_sync::NextSyncTarget::Halted
    ));
    let database = read(&root);
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM source_sync_targets WHERE job_id=?1 AND state='not_run'",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    let cancelled = public_job(&owner, &token, &job_id);
    assert_eq!(cancelled["status"], "cancelled");
    assert!(cancelled["result"].is_null());
    drop(worker);
    let newer = enqueue(&owner, &token, "newer-clean-cancel", Some(Vec::new())).unwrap();
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
            UserOperation::Cancel { job_id: newer },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_sync_batches WHERE job_id=?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_worker_fail_returns_job_and_closes_clean_tail() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 35);
    let source = create_local_source(&owner, &token, "Worker Fail Source");
    let job_id = enqueue(&owner, &token, "worker-fail", Some(vec![source as u64])).unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&claim.lease).unwrap();
    let failed = worker
        .update(&mut claim.lease, WorkerOperation::Fail)
        .unwrap();
    assert_eq!(failed.job_id, job_id);
    assert_eq!(failed.state, PersistentState::Failed);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_sync_targets WHERE job_id=?1 AND state='not_run'",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    let second = create_local_source(&owner, &token, "Worker Fail Tail Source");
    let retained_job = enqueue(
        &owner,
        &token,
        "cancel-claimed-head",
        Some(vec![source as u64, second as u64]),
    )
    .unwrap();
    let mut retained_claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&retained_claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(retained_target) = worker
        .claim_next_source_sync_target(&mut retained_claim.lease)
        .unwrap()
    else {
        panic!("claimed head expected")
    };
    let JobOutcome::Job(retained, _) = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
            UserOperation::Cancel {
                job_id: retained_job.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("cancelled Sync job expected")
    };
    assert_eq!(retained.state, PersistentState::ReconciliationRequired);
    let database = read(&root);
    let states = database
        .prepare("SELECT state FROM source_sync_targets WHERE job_id=?1 ORDER BY ordinal")
        .unwrap()
        .query_map([&retained_job], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(states, vec!["reconciliation_required", "not_run"]);
    assert_eq!(
        database
            .query_row(
                "SELECT phase,halt_code FROM source_sync_batches WHERE job_id=?1",
                [&retained_job],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap(),
        ("reconciliation_required".into(), None)
    );
    drop(database);
    drop(retained_target);
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_reopens_after_an_acknowledged_head_and_completes_the_tail() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 36);
    let first = create_local_source(&owner, &token, "Reopen Source A");
    let second = create_local_source(&owner, &token, "Reopen Source B");
    let job_id = enqueue(
        &owner,
        &token,
        "reopen-acknowledged-head",
        Some(vec![first as u64, second as u64]),
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut first_target) = worker
        .claim_next_source_sync_target(&mut claim.lease)
        .unwrap()
    else {
        panic!("first target expected")
    };
    let settlement = first_target.settlement(Vec::new());
    worker
        .settle_source_sync_target(&mut claim.lease, &mut first_target, settlement)
        .unwrap();
    drop(worker);
    owner.shutdown().unwrap();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(claim.job.job_id, job_id);
    worker.open_source_sync(&claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut second_target) = worker
        .claim_next_source_sync_target(&mut claim.lease)
        .unwrap()
    else {
        panic!("second target expected")
    };
    assert_eq!(second_target.observation().source_id(), second);
    let settlement = second_target.settlement(Vec::new());
    worker
        .settle_source_sync_target(&mut claim.lease, &mut second_target, settlement)
        .unwrap();
    assert!(matches!(
        worker
            .claim_next_source_sync_target(&mut claim.lease)
            .unwrap(),
        pp_storage::source_sync::NextSyncTarget::Complete
    ));
    let pp_storage::source_sync::SourceSyncFinishOutcome::Completed(completed) =
        worker.finish_source_sync(&claim.lease).unwrap()
    else {
        panic!("reopened Sync completion required reconciliation")
    };
    assert_eq!(completed.aggregate.synced, 2);
    assert_eq!(completed.aggregate.failed, 0);
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_recovery_preserves_the_target_claim_counter() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 37);
    let source = create_local_source(&owner, &token, "Recovered Pending Source");
    let job_id = enqueue(
        &owner,
        &token,
        "recovered-pending-counter",
        Some(vec![source as u64]),
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(target) = worker
        .claim_next_source_sync_target(&mut claim.lease)
        .unwrap()
    else {
        panic!("claimed target expected")
    };
    let key = target.key().clone();
    drop(target);
    drop(worker);
    owner.shutdown().unwrap();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&claim.lease).unwrap();
    assert_eq!(
        worker
            .inspect_source_sync_target(&claim.lease, key)
            .unwrap(),
        pp_storage::source_sync::SyncTargetInspection::Pending
    );
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT state,claim_generation FROM source_sync_targets WHERE job_id=?1 AND ordinal=0",
                [&job_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap(),
        ("pending".into(), 1)
    );
    let JobOutcome::Job(cancelled, _) = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
            UserOperation::Cancel {
                job_id: job_id.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("cancelled Sync job expected")
    };
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT state,claim_generation FROM source_sync_targets WHERE job_id=?1 AND ordinal=0",
                [&job_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap(),
        ("not_run".into(), 1)
    );
    let recovery = owner
        .jobs(policy())
        .unwrap()
        .inspect_source_sync_recovery(
            Credential::Session(Secret::new(token)),
            job_id,
            cancelled.state_version,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        recovery.targets()[0].disposition(),
        pp_storage::source_sync::SyncRecoveryDisposition::NotRun
    );
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_adoption_rejects_an_expired_attempt_without_mutation() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 38);
    let source = create_local_source(&owner, &token, "Adoption Boundary Source");
    let first_job = enqueue(
        &owner,
        &token,
        "adoption-boundary-first",
        Some(vec![source as u64]),
    )
    .unwrap();
    let mut short_admission = admission();
    short_admission.lease_seconds = 1;
    let worker = owner
        .job_worker_with_policy(policy(), short_admission.clone())
        .unwrap();
    let mut first_claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&first_claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut first_target) = worker
        .claim_next_source_sync_target(&mut first_claim.lease)
        .unwrap()
    else {
        panic!("first target expected")
    };
    let first_key = first_target.key().clone();
    let mut expired_retry = first_claim.lease.clone();
    let settlement = first_target.settlement(Vec::new());
    worker
        .settle_source_sync_target(&mut first_claim.lease, &mut first_target, settlement)
        .unwrap();
    std::thread::sleep(Duration::from_secs(2));
    let history_before_expired = history(&root, &first_job);
    assert!(
        worker
            .adopt_source_sync_target(&mut expired_retry, first_key)
            .is_err()
    );
    assert_eq!(history(&root, &first_job), history_before_expired);
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn source_sync_adoption_rejects_foreign_and_stale_requests_before_authority_refusal() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner, 39);
    let source = create_local_source(&owner, &token, "Adoption Refusal Source");
    let first_job = enqueue(
        &owner,
        &token,
        "adoption-refusal-first",
        Some(vec![source as u64]),
    )
    .unwrap();
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let mut first_claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&first_claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut first_target) = worker
        .claim_next_source_sync_target(&mut first_claim.lease)
        .unwrap()
    else {
        panic!("first target expected")
    };
    let first_key = first_target.key().clone();
    let settlement = first_target.settlement(Vec::new());
    worker
        .settle_source_sync_target(&mut first_claim.lease, &mut first_target, settlement)
        .unwrap();
    let pp_storage::source_sync::SourceSyncFinishOutcome::Completed(_) =
        worker.finish_source_sync(&first_claim.lease).unwrap()
    else {
        panic!("first Sync completion expected")
    };
    assert_eq!(public_job(&owner, &token, &first_job)["status"], "done");
    let second_job = enqueue(
        &owner,
        &token,
        "adoption-boundary-second",
        Some(vec![source as u64]),
    )
    .unwrap();
    let mut second_claim = worker.claim_kind(JobKind::Sync).unwrap().unwrap();
    worker.open_source_sync(&second_claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut second_target) = worker
        .claim_next_source_sync_target(&mut second_claim.lease)
        .unwrap()
    else {
        panic!("second target expected")
    };
    let second_key = second_target.key().clone();
    let mut stale_retry = second_claim.lease.clone();
    let settlement = second_target.settlement(Vec::new());
    worker
        .settle_source_sync_target(&mut second_claim.lease, &mut second_target, settlement)
        .unwrap();
    worker
        .update(&mut second_claim.lease, WorkerOperation::Heartbeat)
        .unwrap();
    owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            AuthRequest::Logout {
                token: Secret::new(token),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let history_before_refusals = history(&root, &second_job);
    assert!(
        worker
            .adopt_source_sync_target(&mut second_claim.lease, first_key)
            .is_err()
    );
    assert!(
        worker
            .adopt_source_sync_target(&mut stale_retry, second_key)
            .is_err()
    );
    assert_eq!(history(&root, &second_job), history_before_refusals);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT state FROM source_sync_targets WHERE job_id=?1 AND ordinal=0",
                [&second_job],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "succeeded"
    );
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn local_source_sync_owns_ordinals_results_and_acknowledged_reopen() {
    let root = directory();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 42);
    let tenant_a = register(&owner, 1);
    let tenant_b = register(&owner, 2);
    let foreign = create_local_source(&owner, &tenant_b, "Foreign Source");
    let mut sources = Vec::new();
    for ordinal in 0..17 {
        let source = create_local_source(
            &owner,
            &tenant_a,
            &format!("Local Source {:02}", 17 - ordinal),
        );
        if ordinal != 16 {
            let local = root.join("repos").join(source.to_string());
            std::fs::create_dir_all(&local).unwrap();
            std::fs::write(local.join("README.md"), format!("# Source {source}\n")).unwrap();
        }
        sources.push(source);
    }
    let setup = Connection::open(root.join("print-partner.db")).unwrap();
    setup
        .execute(
            "UPDATE projects SET metadata_json=?1 WHERE id=?2",
            (
                r#"{"sync_error":"old","sync_required":true,"kept":1}"#,
                sources[0],
            ),
        )
        .unwrap();
    setup
        .execute(
            "UPDATE projects SET local_path=NULL WHERE id=?1",
            [sources[15]],
        )
        .unwrap();
    drop(setup);

    let explicit = vec![
        sources[0] as u64,
        foreign as u64,
        sources[0] as u64,
        9_999_999,
    ];
    let explicit_job = enqueue(&owner, &tenant_a, "sync-explicit", Some(explicit)).unwrap();
    let worker = LocalSourceSyncWorker::new(&owner, policy()).unwrap();
    let completed = worker.run_one().unwrap().unwrap();
    assert_eq!(completed.job.job_id, explicit_job);
    assert_eq!(completed.job.state, PersistentState::Succeeded);
    let Some(CompletedResult::SourceSync(result)) = completed.job.public_result else {
        panic!("SourceSync result expected")
    };
    assert_eq!(result.synced, 2);
    assert_eq!(result.failed, 2);
    assert_eq!(result.results.len(), 2);
    assert_eq!(result.results[0].project_id, Some(sources[0] as u64));
    assert_eq!(result.results[1].project_id, Some(sources[0] as u64));
    assert_eq!(result.failures[0].project_id, Some(foreign as u64));
    assert!(result.failures[0].name.is_none());
    assert_eq!(result.failures[0].error, "Source not found");

    let database = read(&root);
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM source_sync_targets WHERE job_id=?1 AND reservation_acknowledged=1",
                [&explicit_job],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        4
    );
    let ordinals = database
        .prepare("SELECT ordinal,requested_source_id FROM source_sync_targets WHERE job_id=?1 ORDER BY ordinal")
        .unwrap()
        .query_map([&explicit_job], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(ordinals[0], (0, sources[0]));
    assert_eq!(ordinals[2], (2, sources[0]));
    let metadata: String = database
        .query_row(
            "SELECT metadata_json FROM projects WHERE id=?1 AND last_synced_at IS NOT NULL",
            [sources[0]],
            |row| row.get(0),
        )
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["kept"], 1);
    assert!(metadata.get("sync_error").is_none());
    assert!(metadata.get("sync_required").is_none());
    drop(database);

    let all_failed_job = enqueue(
        &owner,
        &tenant_a,
        "sync-all-failed",
        Some(vec![foreign as u64, 9_999_998]),
    )
    .unwrap();
    let failed = worker.run_one().unwrap().unwrap();
    assert_eq!(failed.job.job_id, all_failed_job);
    assert_eq!(failed.job.state, PersistentState::Failed);
    assert_eq!(failed.job.progress, Some(100));
    assert!(failed.job.public_result.is_none());
    assert_eq!(failed.aggregate.failed, 2);

    let empty_job = enqueue(&owner, &tenant_a, "sync-empty", Some(Vec::new())).unwrap();
    let empty = worker.run_one().unwrap().unwrap();
    assert_eq!(empty.job.job_id, empty_job);
    assert_eq!(empty.aggregate.synced, 0);
    assert_eq!(empty.aggregate.failed, 0);

    let all_job = enqueue(&owner, &tenant_a, "sync-all", None).unwrap();
    let all = worker.run_one().unwrap().unwrap();
    assert_eq!(all.job.job_id, all_job);
    assert_eq!(all.aggregate.synced, 17);
    assert_eq!(all.aggregate.results.len(), 17);
    for source in [sources[15], sources[16]] {
        assert_eq!(
            all.aggregate
                .results
                .iter()
                .find(|result| result.project_id == Some(source as u64))
                .unwrap()
                .doc_count,
            0
        );
    }
    let captured = read(&root)
        .prepare(
            "SELECT requested_source_id FROM source_sync_targets WHERE job_id=?1 ORDER BY ordinal",
        )
        .unwrap()
        .query_map([&all_job], |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut expected = sources[1..].to_vec();
    expected.sort_unstable();
    expected.push(sources[0]);
    assert_eq!(captured, expected);

    let held_job = enqueue(
        &owner,
        &tenant_a,
        "sync-held-delete",
        Some(vec![sources[1] as u64]),
    )
    .unwrap();
    let held_storage = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![
                    (JobKind::SuppliedSourceImport, 1),
                    (JobKind::ImportScan, 1),
                    (JobKind::Sync, 1),
                ],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let mut held_claim = held_storage.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(held_claim.job.job_id, held_job);
    held_storage.open_source_sync(&held_claim.lease).unwrap();
    let pp_storage::source_sync::NextSyncTarget::Local(mut held_target) = held_storage
        .claim_next_source_sync_target(&mut held_claim.lease)
        .unwrap()
    else {
        panic!("held Local target expected")
    };
    let CatalogOutcome::Deletion(Deletion::ActiveWork) = owner
        .source_catalog_with_policy(
            Credentials::Session(Secret::new(tenant_a.clone())),
            policy(),
        )
        .unwrap()
        .execute(CatalogRequest::Delete { id: sources[1] })
        .unwrap()
    else {
        panic!("active Sync target must block Source deletion")
    };
    let settlement = held_target.settlement(Vec::new());
    held_storage
        .settle_source_sync_target(&mut held_claim.lease, &mut held_target, settlement)
        .unwrap();
    held_storage.finish_source_sync(&held_claim.lease).unwrap();
    drop(held_storage);

    let thousand = vec![sources[0] as u64; 1000];
    let thousand_job = enqueue(&owner, &tenant_a, "sync-thousand", Some(thousand)).unwrap();
    let storage = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![
                    (JobKind::SuppliedSourceImport, 1),
                    (JobKind::ImportScan, 1),
                    (JobKind::Sync, 1),
                ],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let claim = storage.claim_kind(JobKind::Sync).unwrap().unwrap();
    assert_eq!(claim.job.job_id, thousand_job);
    storage.open_source_sync(&claim.lease).unwrap();
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_sync_targets WHERE job_id=?1",
                [&thousand_job],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1000
    );
    assert!(
        enqueue(
            &owner,
            &tenant_a,
            "sync-thousand-one",
            Some(vec![sources[0] as u64; 1001]),
        )
        .is_err()
    );
    drop(storage);
    drop(worker);
    assert!(owner.retain_jobs(1, 2).unwrap() >= 4);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_sync_batches WHERE job_id=?1",
                [&explicit_job],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    let archived: String = read(&root)
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&explicit_job],
            |row| row.get(0),
        )
        .unwrap();
    let archived: serde_json::Value = serde_json::from_str(&archived).unwrap();
    assert_eq!(archived["state"], "succeeded");
    assert_eq!(archived["public_result"]["synced"], 2);
    owner.shutdown().unwrap();

    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 42);
    let snapshot = owner
        .jobs(policy())
        .unwrap()
        .read_public(
            Credential::Session(Secret::new(tenant_a)),
            held_job,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matches!(
        snapshot.result,
        Some(CompletedResult::SourceSync(_))
    ));
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_docs WHERE project_id=?1",
                [sources[0]],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    println!(
        "{}",
        serde_json::json!({
            "schema_version": 42,
            "explicit_ordinals": 4,
            "duplicate_successes": 2,
            "foreign_unavailable_name_null": true,
            "all_failed_public_result_null": true,
            "explicit_empty_zero": true,
            "captured_all_local_targets": 17,
            "null_and_missing_path_zero_results": true,
            "active_target_blocked_delete": true,
            "admitted_explicit_targets": 1000,
            "refused_explicit_targets": 1001,
            "retention_cascaded_journal": true,
            "reopen_retained_public_result": true,
            "reopen_source_doc_count": 1
        })
    );
    owner.shutdown().unwrap();
}
