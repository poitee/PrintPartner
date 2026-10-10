use anyhow::Result;
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    jobs::*,
};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier, atomic::AtomicBool},
    thread,
    time::Duration,
};
fn directory() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pp-durable-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}
fn fixture() -> (PathBuf, WriterOwner) {
    let path = directory();
    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert_eq!(ready.version, 40);
    (path, owner)
}
fn admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: JobKind::ALL.into_iter().map(|kind| (kind, 1)).collect(),
        total: 4,
        per_resource: 1,
        lease_seconds: 60,
    }
}
fn call(owner: &WriterOwner, operation: UserOperation) -> Result<Outcome> {
    owner
        .jobs(policy())?
        .submit(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()
}
fn job(outcome: Outcome) -> JobRecord {
    match outcome {
        Outcome::Job(job, _) => job,
        _ => panic!("Expected job"),
    }
}
fn job_error(outcome: Result<Outcome>) -> anyhow::Error {
    match outcome {
        Err(error) => error,
        Ok(_) => panic!("job error expected"),
    }
}
fn enqueue(owner: &WriterOwner, key: &str, payload: Payload) -> JobRecord {
    job(call(
        owner,
        UserOperation::Enqueue {
            key: key.into(),
            payload_version: 1,
            payload,
        },
    )
    .unwrap())
}
fn get(owner: &WriterOwner, id: &str) -> JobRecord {
    job(call(owner, UserOperation::Get { job_id: id.into() }).unwrap())
}
fn printer(name: &str) -> Payload {
    Payload::PrinterUpload {
        printer_id: name.into(),
        artifact_path: "exports/candidate.gcode".into(),
        filename: "candidate.gcode".into(),
        start: true,
        profile_id: None,
        host_name: None,
        checkoff_units: vec![],
        unlabeled_names: vec![],
    }
}
fn intent(operation: EffectOperation, target: &str) -> EffectIntent {
    EffectIntent {
        operation,
        basis_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        target: target.into(),
    }
}
fn receipt(target: &str) -> ResultArtifact {
    ResultArtifact {
        receipt_id: "receipt-1".into(),
        content_hash: "b".repeat(64),
        target: target.into(),
    }
}
fn distinct_intent(operation: EffectOperation, target: &str, seed: u64) -> EffectIntent {
    EffectIntent {
        operation,
        basis_hash: format!("{:064x}", seed + 1),
        content_hash: format!("{:064x}", seed + 10_000),
        target: target.into(),
    }
}
fn distinct_receipt(intent: &EffectIntent, id: &str) -> ResultArtifact {
    ResultArtifact {
        receipt_id: id.into(),
        content_hash: intent.content_hash.clone(),
        target: intent.target.clone(),
    }
}
fn begin_and_confirm(
    worker: &ServerWorkerClient,
    lease: &mut AttemptLease,
    intent: EffectIntent,
    receipt_id: &str,
) -> ResultArtifact {
    let receipt = distinct_receipt(&intent, receipt_id);
    worker
        .update(lease, WorkerOperation::BeginEffect(intent))
        .unwrap();
    worker
        .update(lease, WorkerOperation::ConfirmEffect(receipt.clone()))
        .unwrap();
    receipt
}
fn reconciliations(owner: &WriterOwner, id: &str) -> Vec<ReconciliationRecord> {
    match call(
        owner,
        UserOperation::Reconciliations {
            job_id: id.into(),
            before_version: None,
            limit: 200,
        },
    )
    .unwrap()
    {
        Outcome::Reconciliations(records) => records,
        _ => panic!("reconciliations"),
    }
}
fn history(owner: &WriterOwner, id: &str) -> Vec<HistoryEntry> {
    match call(
        owner,
        UserOperation::History {
            job_id: id.into(),
            before_version: None,
            limit: 200,
        },
    )
    .unwrap()
    {
        Outcome::History(entries) => entries,
        _ => panic!("history"),
    }
}
fn reconcile(
    owner: &WriterOwner,
    record: &JobRecord,
    decision: Decision,
    receipt: Option<ResultArtifact>,
) -> Result<Outcome> {
    call(
        owner,
        UserOperation::Reconcile {
            job_id: record.job_id.clone(),
            expected_version: record.state_version,
            expected_generation: record.generation,
            effect_hash: record.effects.last().unwrap().intent.content_hash.clone(),
            decision,
            receipt,
        },
    )
}
fn enqueue_start(owner: &WriterOwner, key: &str, parent_id: &str) -> Result<Outcome> {
    call(
        owner,
        UserOperation::Enqueue {
            key: key.into(),
            payload_version: 1,
            payload: Payload::PrinterStart(PrinterStartRequest::new(parent_id)),
        },
    )
}
fn uploaded_only_parent(owner: &WriterOwner, key: &str, printer_id: &str) -> JobRecord {
    enqueue(owner, key, printer(printer_id));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, printer_id)),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    job(reconcile(
        owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(receipt(printer_id)),
    )
    .unwrap())
}
fn uploaded_only_spoolman_parent(owner: &WriterOwner, key: &str, printer_id: &str) -> JobRecord {
    enqueue(owner, key, printer(printer_id));
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    let upload = distinct_intent(EffectOperation::PrinterUpload, printer_id, 900);
    let upload_receipt = begin_and_confirm(&worker, &mut lease, upload, "observed-upload");
    let spoolman = distinct_intent(EffectOperation::SpoolmanDeduction, "spoolman:observed", 901);
    let spoolman_receipt = begin_and_confirm(&worker, &mut lease, spoolman, "observed-spoolman");
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let settled = job(reconcile(
        owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(spoolman_receipt),
    )
    .unwrap());
    assert_eq!(settled.result, Some(upload_receipt));
    settled
}
fn denied_start_parent(owner: &WriterOwner, key: &str, printer_id: &str, seed: u64) -> JobRecord {
    enqueue(owner, key, printer(printer_id));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload = distinct_intent(EffectOperation::PrinterUpload, printer_id, seed);
    begin_and_confirm(
        &worker,
        &mut lease,
        upload,
        &format!("denied-start-upload-{seed}"),
    );
    let start = distinct_intent(EffectOperation::PrinterStart, printer_id, seed + 1);
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(start))
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    job(reconcile(owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap())
}
fn readonly(path: &std::path::Path) -> Connection {
    Connection::open_with_flags(
        path.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
fn observe_effect(document: &mut serde_json::Value, index: usize) {
    document["state"] = "reconciliation_required".into();
    document["result"] = serde_json::Value::Null;
    document["effects"][index]["confirmed"] = false.into();
    document["effects"][index]
        .as_object_mut()
        .unwrap()
        .remove("no_effect");
    document["_authority_refusal"] = serde_json::json!({
        "version": 1,
        "reason": "credential_invalid",
        "phase": "worker_advance",
        "observed_at": 1,
        "generation": document["generation"]
    });
}
fn register(owner: &WriterOwner, email: &str) -> (auth::User, String) {
    let result = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            auth::Request::Register {
                email: email.into(),
                display_name: "Job test".into(),
                password: Secret::new("long-test-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    match result {
        auth::Outcome::Session { user, token } => (user, token.expose().into()),
        _ => panic!("Session expected"),
    }
}
fn session_call(
    owner: &WriterOwner,
    policy: AuthPolicy,
    token: &str,
    operation: UserOperation,
) -> Result<Outcome> {
    owner
        .jobs(policy)?
        .submit(
            Credential::Session(Secret::new(token.into())),
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()
}
#[test]
fn ticket_t_28_claims_duplicate_conflict_and_concurrent_claims() {
    let (path, owner) = fixture();
    let first = enqueue(&owner, "idempotent", Payload::CheckSourceUpdates {});
    let same = enqueue(&owner, "idempotent", Payload::CheckSourceUpdates {});
    assert_eq!(first.job_id, same.job_id);
    assert_eq!(first.state_version, same.state_version);
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "idempotent".into(),
                payload_version: 1,
                payload: Payload::ImportScan { project_id: 1 }
            }
        )
        .is_err()
    );
    assert_eq!(get(&owner, &first.job_id).state_version, 1);
    let worker = owner.job_worker(admission()).unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let worker = worker.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                worker.claim().unwrap()
            })
        })
        .collect();
    let mut claims: Vec<_> = handles
        .into_iter()
        .filter_map(|h| h.join().unwrap())
        .collect();
    assert_eq!(claims.len(), 1);
    let mut lease = claims.pop().unwrap().lease;
    let mut stale = lease.clone();
    worker
        .update(&mut lease, WorkerOperation::Progress(25))
        .unwrap();
    assert!(
        worker
            .update(&mut stale, WorkerOperation::Heartbeat)
            .is_err()
    );
    assert!(
        worker
            .update(&mut stale, WorkerOperation::Finish(None))
            .is_err()
    );
    assert_eq!(get(&owner, &first.job_id).progress, Some(25));
    let other = owner.job_worker(admission()).unwrap();
    assert!(
        other
            .update(&mut lease, WorkerOperation::Heartbeat)
            .is_err()
    );
    let serialized = serde_json::to_string(&get(&owner, &first.job_id)).unwrap();
    assert!(!serialized.contains("fence"));
    owner.shutdown().unwrap();
    let raw = readonly(&path);
    assert_eq!(
        raw.query_row("SELECT COUNT(*) FROM durable_jobs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn ticket_t_28_claims_real_auth_tenant_policy_and_revocation() {
    let (_, owner) = fixture();
    let (a, token_a) = register(&owner, "a@example.com");
    let (_, token_b) = register(&owner, "b@example.com");
    let first = job(session_call(
        &owner,
        policy(),
        &token_a,
        UserOperation::Enqueue {
            key: "tenant-job".into(),
            payload_version: 1,
            payload: Payload::CheckSourceUpdates {},
        },
    )
    .unwrap());
    assert_eq!(first.tenant, a.tenant_id);
    assert!(
        session_call(
            &owner,
            policy(),
            &token_b,
            UserOperation::Get {
                job_id: first.job_id.clone()
            }
        )
        .is_err()
    );
    assert!(
        session_call(
            &owner,
            policy(),
            &token_b,
            UserOperation::Cancel {
                job_id: first.job_id.clone()
            }
        )
        .is_err()
    );
    let mut single = policy();
    single.session_tenant = SessionTenantPolicy::SingleAccountDefault;
    assert!(
        session_call(
            &owner,
            single,
            &token_a,
            UserOperation::List(JobListQuery {
                limit: 10,
                ..Default::default()
            })
        )
        .is_err()
    );
    let keys = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            auth::Request::CreateKey {
                session: Secret::new(token_a.clone()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let key = match keys {
        auth::Outcome::KeyCreated { key, .. } => key.expose().to_owned(),
        _ => panic!("key expected"),
    };
    for (tenant, works) in [(a.tenant_id.as_str(), true), ("default", false)] {
        let result = owner
            .jobs(policy())
            .unwrap()
            .submit(
                Credential::RoutedKey {
                    tenant: tenant.into(),
                    key: Secret::new(key.clone()),
                },
                UserOperation::Get {
                    job_id: first.job_id.clone(),
                },
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap()
            .receive();
        assert_eq!(result.is_ok(), works);
    }
    owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            auth::Request::Logout {
                token: Secret::new(token_a.clone()),
            },
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    assert!(
        session_call(
            &owner,
            policy(),
            &token_a,
            UserOperation::Get {
                job_id: first.job_id
            }
        )
        .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_single_account_maps_default_and_physical_owner_is_opaque() {
    let (_, owner) = fixture();
    let (_, token) = register(&owner, "single@example.com");
    let mut single = policy();
    single.session_tenant = SessionTenantPolicy::SingleAccountDefault;
    let record = job(session_call(
        &owner,
        single,
        &token,
        UserOperation::Enqueue {
            key: "single".into(),
            payload_version: 1,
            payload: Payload::CheckSourceUpdates {},
        },
    )
    .unwrap());
    assert_eq!(record.tenant, "default");
    let (_, other) = fixture();
    assert!(
        other
            .jobs(policy())
            .unwrap()
            .submit(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                UserOperation::List(JobListQuery {
                    limit: 10,
                    ..Default::default()
                }),
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .unwrap()
            .receive()
            .is_err()
    );
    other.shutdown().unwrap();
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_cancel_before_admission_running_and_effect() {
    let (_, owner) = fixture();
    let client = owner.jobs(policy()).unwrap();
    assert!(
        client
            .submit(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                UserOperation::Enqueue {
                    key: "pre-cancel".into(),
                    payload_version: 1,
                    payload: Payload::CheckSourceUpdates {}
                },
                &AtomicBool::new(true),
                Duration::ZERO
            )
            .is_err()
    );
    let queued = enqueue(&owner, "queued", Payload::CheckSourceUpdates {});
    let cancelled = job(call(
        &owner,
        UserOperation::Cancel {
            job_id: queued.job_id,
        },
    )
    .unwrap());
    assert_eq!(cancelled.state, PersistentState::Cancelled);
    let worker = owner.job_worker(admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    let running = enqueue(&owner, "running", Payload::CheckSourceUpdates {});
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert_eq!(
        job(call(
            &owner,
            UserOperation::Cancel {
                job_id: running.job_id
            }
        )
        .unwrap())
        .state,
        PersistentState::Cancelled
    );
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(EffectOperation::SourceRefresh, "source:1"))
            )
            .is_err()
    );
    let effect = enqueue(&owner, "effect", printer("printer-a"));
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "printer-a")),
        )
        .unwrap();
    let cancelled = job(call(
        &owner,
        UserOperation::Cancel {
            job_id: effect.job_id,
        },
    )
    .unwrap());
    assert_eq!(cancelled.state, PersistentState::ReconciliationRequired);
    assert_eq!(cancelled.snapshot().status, "error");
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::ConfirmEffect(receipt("printer-a"))
            )
            .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_kind_resource_capacity_and_source_intent() {
    let (_, owner) = fixture();
    let mut limits = admission();
    for (_, cap) in &mut limits.kinds {
        *cap = 4;
    }
    let worker = owner.job_worker(limits.clone()).unwrap();
    enqueue(&owner, "pa1", printer("a"));
    enqueue(&owner, "pa2", printer("a"));
    enqueue(&owner, "pb1", printer("b"));
    let mut count = 0;
    while worker.claim().unwrap().is_some() {
        count += 1;
    }
    assert_eq!(count, 2);
    let source_id = source(&owner.local_source_catalog(), "Capacity source");
    enqueue(
        &owner,
        "source1",
        Payload::ImportScan {
            project_id: source_id as u64,
        },
    );
    enqueue(
        &owner,
        "source1-docs",
        Payload::ExtractSourceDocs {
            project_id: source_id as u64,
        },
    );
    assert!(worker.claim().unwrap().is_some());
    assert!(worker.claim().unwrap().is_none());
    limits.per_resource = 2;
    assert!(owner.job_worker(limits).is_err());
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_orderly_restart_and_subject_bound_reconciliation() {
    let (path, owner) = fixture();
    let record = enqueue(&owner, "uncertain", printer("printer-a"));
    let worker = owner.job_worker(admission()).unwrap();
    let mut old = worker.claim().unwrap().unwrap().lease;
    worker
        .update(
            &mut old,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterUploadAndStart,
                "printer-a",
            )),
        )
        .unwrap();
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let recovered = get(&owner, &record.job_id);
    assert_eq!(recovered.state, PersistentState::ReconciliationRequired);
    assert_eq!(recovered.snapshot().status, "error");
    let worker = owner.job_worker(admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    assert!(worker.update(&mut old, WorkerOperation::Heartbeat).is_err());
    let reconcile = |version, hash, receipt| UserOperation::Reconcile {
        job_id: record.job_id.clone(),
        expected_version: version,
        expected_generation: recovered.generation,
        effect_hash: hash,
        decision: Decision::ConfirmSucceeded,
        receipt,
    };
    assert!(
        call(
            &owner,
            reconcile(
                recovered.state_version - 1,
                "b".repeat(64),
                Some(receipt("printer-a"))
            )
        )
        .is_err()
    );
    assert!(
        call(
            &owner,
            reconcile(
                recovered.state_version,
                "c".repeat(64),
                Some(receipt("printer-a"))
            )
        )
        .is_err()
    );
    assert!(
        call(
            &owner,
            reconcile(recovered.state_version, "b".repeat(64), None)
        )
        .is_err()
    );
    let done = job(call(
        &owner,
        reconcile(
            recovered.state_version,
            "b".repeat(64),
            Some(receipt("printer-a")),
        ),
    )
    .unwrap());
    assert_eq!(done.state, PersistentState::Succeeded);
    assert!(done.snapshot().finished_at.unwrap().ends_with('Z'));
    let events = match call(
        &owner,
        UserOperation::History {
            job_id: done.job_id,
            before_version: None,
            limit: 200,
        },
    )
    .unwrap()
    {
        Outcome::History(events) => events,
        _ => panic!("history"),
    };
    assert!(
        events
            .iter()
            .any(|entry| entry.event.starts_with("reconciled:ConfirmSucceeded:"))
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_receipts_duplicate_effects_and_finish() {
    let (_, owner) = fixture();
    enqueue(&owner, "effects", printer("printer-a"));
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(EffectOperation::PrinterStart, "printer-a"))
            )
            .is_err()
    );
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "foreign"))
            )
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "printer-a")),
        )
        .unwrap();
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::ConfirmEffect(receipt("foreign"))
            )
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("printer-a")),
        )
        .unwrap();
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "printer-a"))
            )
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterStart, "printer-a")),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("printer-a")),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::SpoolmanDeduction, "spool:3")),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    assert_eq!(uncertain.state, PersistentState::ReconciliationRequired);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_lost_reply_drain_and_backup_committed_job() {
    let (path, owner) = fixture();
    let pending = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            UserOperation::Enqueue {
                key: "lost-reply".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    drop(pending);
    let same = enqueue(&owner, "lost-reply", Payload::CheckSourceUpdates {});
    let backup = path.with_extension("backup.db");
    owner.backup(&backup).unwrap();
    let copy = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        copy.query_row("SELECT id FROM durable_jobs", [], |r| r.get::<_, String>(0))
            .unwrap(),
        same.job_id
    );
    drop(copy);
    owner.shutdown().unwrap();
    let raw = readonly(&path);
    assert_eq!(
        raw.query_row("SELECT COUNT(*) FROM durable_job_keys", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn ticket_t_28_recovery_retention_preserves_uncertainty_and_idempotency() {
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    for index in 0..5 {
        enqueue(
            &owner,
            &format!("done-{index}"),
            Payload::CheckSourceUpdates {},
        );
        let mut lease = worker.claim().unwrap().unwrap().lease;
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap();
    }
    let uncertain = enqueue(&owner, "uncertain", printer("p"));
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "p")),
        )
        .unwrap();
    worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 4);
    assert_eq!(
        get(&owner, &uncertain.job_id).state,
        PersistentState::ReconciliationRequired
    );
    let repeated = enqueue(&owner, "done-0", Payload::CheckSourceUpdates {});
    assert_eq!(repeated.state, PersistentState::Succeeded);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_invalid_payloads_fail_before_writes() {
    let (path, owner) = fixture();
    for payload in [
        Payload::ImportScan { project_id: 0 },
        Payload::ExportDirect3mf {
            profile_id: 1,
            tokens: vec![],
        },
        Payload::ExportDirect3mf {
            profile_id: 1,
            tokens: vec!["bad-token".into()],
        },
    ] {
        assert!(
            call(
                &owner,
                UserOperation::Enqueue {
                    key: "invalid".into(),
                    payload_version: 1,
                    payload
                }
            )
            .is_err()
        );
    }
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "version".into(),
                payload_version: 2,
                payload: Payload::CheckSourceUpdates {}
            }
        )
        .is_err()
    );
    owner.shutdown().unwrap();
    assert_eq!(
        readonly(&path)
            .query_row("SELECT COUNT(*) FROM durable_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn ticket_t_28_claims_ordinary_transaction_error_rolls_back() {
    let (path, owner) = fixture();
    owner.shutdown().unwrap();
    let fixture = Connection::open(path.join("print-partner.db")).unwrap();
    fixture.execute_batch("CREATE TRIGGER reject_test_job BEFORE INSERT ON durable_job_keys WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT,'fixture constraint'); END;").unwrap();
    drop(fixture);
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "reject".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {}
            }
        )
        .is_err()
    );
    owner.shutdown().unwrap();
    let raw = readonly(&path);
    for table in ["durable_jobs", "durable_job_keys", "durable_job_history"] {
        assert_eq!(
            raw.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn ticket_t_28_recovery_every_existing_kind_has_incomplete_intent_policy() {
    let token = format!("ppu_{}", "a".repeat(32));
    let payloads = vec![
        Payload::Sync {
            project_ids: Some(vec![1]),
        },
        Payload::ImportScan { project_id: 1 },
        Payload::ExtractSourceDocs { project_id: 1 },
        Payload::CheckSourceUpdates {},
        Payload::ExportStlPack {
            profile_id: 1,
            missing_only: false,
            group_by: GroupBy::ColorDir,
            unit_tokens: vec![token.clone()],
            filename_grouping: None,
        },
        Payload::ExportKitBundle {
            profile_id: 1,
            include_print_progress: true,
        },
        Payload::ExportAcceptedPlate3mf {
            profile_id: 1,
            expected_plate_revision_id: 2,
        },
        Payload::ExportDirect3mf {
            profile_id: 1,
            tokens: vec![token],
        },
        printer("test-printer"),
    ];
    let existing = JobKind::ALL
        .into_iter()
        .filter(|kind| {
            !matches!(
                kind,
                JobKind::SuppliedSourceImport | JobKind::ExportChecklistHtml
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(payloads.len(), existing.len());
    for (payload, kind) in payloads.into_iter().zip(existing) {
        assert_eq!(payload.kind(), kind);
        let (path, owner) = fixture();
        if matches!(kind, JobKind::ImportScan | JobKind::ExtractSourceDocs) {
            assert_eq!(source(&owner.local_source_catalog(), "Kind source"), 1);
        }
        let queued = enqueue(&owner, "kind-coverage", payload);
        let worker = owner.job_worker(admission()).unwrap();
        let claim = worker.claim().unwrap().unwrap();
        assert_eq!(
            claim.source_work.is_some(),
            matches!(kind, JobKind::ImportScan | JobKind::ExtractSourceDocs)
        );
        let mut lease = claim.lease;
        let (operation, target) = match kind {
            JobKind::PrinterUpload => (EffectOperation::PrinterUploadAndStart, "test-printer"),
            JobKind::Sync
            | JobKind::ImportScan
            | JobKind::ExtractSourceDocs
            | JobKind::CheckSourceUpdates => (EffectOperation::SourceRefresh, "source:1"),
            _ => (EffectOperation::LocalArtifact, "exports/candidate"),
        };
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(operation, target)),
            )
            .unwrap();
        owner.shutdown().unwrap();
        let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
        let current = get(&owner, &queued.job_id);
        assert_eq!(
            current.state,
            PersistentState::ReconciliationRequired,
            "{kind:?}"
        );
        assert_eq!(current.effects.len(), 1);
        assert_eq!(current.effects[0].attempt, 1);
        assert!(!current.effects[0].confirmed);
        assert!(
            owner
                .job_worker(admission())
                .unwrap()
                .claim()
                .unwrap()
                .is_none()
        );
        owner.shutdown().unwrap();
    }
}
#[test]
fn ticket_t_28_recovery_confirmed_local_candidate_requires_exact_receipt() {
    use sha2::{Digest, Sha256};
    let (path, owner) = fixture();
    let bytes = b"documented local artifact fixture";
    let hash = hex::encode(Sha256::digest(bytes));
    let target = "exports/candidate.txt";
    std::fs::write(path.join(target), bytes).unwrap();
    let queued = enqueue(
        &owner,
        "local-artifact",
        Payload::ExportKitBundle {
            profile_id: 1,
            include_print_progress: false,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    let effect = EffectIntent {
        operation: EffectOperation::LocalArtifact,
        basis_hash: "a".repeat(64),
        content_hash: hash.clone(),
        target: target.into(),
    };
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(effect))
        .unwrap();
    let artifact = ResultArtifact {
        receipt_id: "fixture-receipt".into(),
        content_hash: hash.clone(),
        target: target.into(),
    };
    worker
        .update(&mut lease, WorkerOperation::ConfirmEffect(artifact.clone()))
        .unwrap();
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let recovered = get(&owner, &queued.job_id);
    assert_eq!(recovered.state, PersistentState::ReconciliationRequired);
    assert!(recovered.effects[0].confirmed);
    assert_eq!(
        hex::encode(Sha256::digest(std::fs::read(path.join(target)).unwrap())),
        artifact.content_hash
    );
    let mut wrong = artifact.clone();
    wrong.content_hash = "c".repeat(64);
    let make = |receipt| UserOperation::Reconcile {
        job_id: queued.job_id.clone(),
        expected_version: recovered.state_version,
        expected_generation: recovered.generation,
        effect_hash: hash.clone(),
        decision: Decision::ConfirmSucceeded,
        receipt: Some(receipt),
    };
    assert!(call(&owner, make(wrong)).is_err());
    assert_eq!(
        job(call(&owner, make(artifact)).unwrap()).state,
        PersistentState::Succeeded
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_abandon_keeps_uncertain_proof_and_resource_lock() {
    let (_, owner) = fixture();
    let queued = enqueue(&owner, "uncertain-abandon", printer("a"));
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "a")),
        )
        .unwrap();
    let pending = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let result = job(call(
        &owner,
        UserOperation::Reconcile {
            job_id: queued.job_id.clone(),
            expected_version: pending.state_version,
            expected_generation: pending.generation,
            effect_hash: "b".repeat(64),
            decision: Decision::Abandon,
            receipt: None,
        },
    )
    .unwrap());
    assert_eq!(result.state, PersistentState::ReconciliationRequired);
    owner.retain_jobs(1, 1).unwrap();
    assert_eq!(get(&owner, &queued.job_id).effects.len(), 1);
    enqueue(&owner, "another-a", printer("a"));
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_duplicate_concurrent_enqueue_and_no_handler_admission() {
    let (_, owner) = fixture();
    let client = owner.jobs(policy()).unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let client = client.clone();
            let credential = Credential::PhysicalOwner(owner.job_physical_owner());
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                job(client
                    .submit(
                        credential,
                        UserOperation::Enqueue {
                            key: "concurrent-intent".into(),
                            payload_version: 1,
                            payload: Payload::CheckSourceUpdates {},
                        },
                        &AtomicBool::new(false),
                        Duration::from_secs(5),
                    )
                    .unwrap()
                    .receive()
                    .unwrap())
                .job_id
            })
        })
        .collect();
    let ids: std::collections::HashSet<_> =
        handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(ids.len(), 1);
    let mut no_handlers = admission();
    no_handlers.kinds.clear();
    assert!(
        owner
            .job_worker(no_handlers)
            .unwrap()
            .claim()
            .unwrap()
            .is_none()
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_expired_lease_fences_old_worker() {
    let (path, owner) = fixture();
    let queued = enqueue(&owner, "expiry", Payload::CheckSourceUpdates {});
    let mut config = admission();
    config.lease_seconds = 1;
    let expired_worker = owner.job_worker(config).unwrap();
    let ClaimedAttempt {
        job: first,
        lease: mut old,
        source_work,
    } = expired_worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    thread::sleep(Duration::from_millis(1100));
    assert!(
        expired_worker
            .update(&mut old, WorkerOperation::Heartbeat)
            .is_err()
    );
    owner.shutdown().unwrap();

    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let current_worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: next,
        lease: mut current,
        source_work,
    } = current_worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(next.job_id, queued.job_id);
    assert_eq!(next.attempt, 2);
    assert!(next.generation > first.generation);
    assert!(
        expired_worker
            .update(&mut old, WorkerOperation::Fail)
            .is_err()
    );
    let finished = current_worker
        .update(&mut current, WorkerOperation::Finish(None))
        .unwrap();
    assert_eq!(finished.state, PersistentState::Succeeded);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_list_filters_pagination_and_history() {
    let (_, owner) = fixture();
    for id in 1..=3 {
        enqueue(
            &owner,
            &format!("profile-{id}"),
            Payload::ExportChecklistHtml { profile_id: id },
        );
    }
    let list = |query| match call(&owner, UserOperation::List(query)).unwrap() {
        Outcome::List(items) => items,
        _ => panic!("list"),
    };
    let first = list(JobListQuery {
        limit: 2,
        ..Default::default()
    });
    assert_eq!(first.len(), 2);
    let last = first.last().unwrap();
    let second = list(JobListQuery {
        limit: 2,
        before: Some((last.updated_at, last.job_id.clone())),
        ..Default::default()
    });
    assert_eq!(second.len(), 1);
    assert!(!first.iter().any(|job| job.job_id == second[0].job_id));
    let filtered = list(JobListQuery {
        profile_id: Some(2),
        status: Some("pending".into()),
        ..Default::default()
    });
    assert_eq!(filtered.len(), 1);
    let cancelled = job(call(
        &owner,
        UserOperation::Cancel {
            job_id: filtered[0].job_id.clone(),
        },
    )
    .unwrap());
    assert_eq!(
        list(JobListQuery {
            status: Some("cancelled".into()),
            ..Default::default()
        })
        .len(),
        1
    );
    assert!(
        list(JobListQuery {
            since: Some(cancelled.updated_at + 10),
            ..Default::default()
        })
        .is_empty()
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_schema35_corruption_and37_preserve_input_bytes() {
    for corruption in [
        "UPDATE app_settings SET value='41' WHERE tenant_id='default' AND key='schema_version'",
        "ALTER TABLE durable_jobs ADD COLUMN unintended TEXT",
        "UPDATE durable_jobs SET version=version+1",
    ] {
        let (path, owner) = fixture();
        enqueue(&owner, "retained", Payload::CheckSourceUpdates {});
        owner.shutdown().unwrap();
        let raw = Connection::open(path.join("print-partner.db")).unwrap();
        raw.execute_batch(corruption).unwrap();
        drop(raw);
        let db = path.join("print-partner.db");
        let before = std::fs::read(&db).unwrap();
        assert!(WriterOwner::open(&path, Limits::default()).is_err());
        assert_eq!(before, std::fs::read(&db).unwrap());
        assert!(!path.join(".desktop-owner.json").exists());
    }
}
#[test]
fn ticket_t_28_claims_wire_job_kinds_match_existing_contract() {
    assert_eq!(
        JobKind::ALL.map(JobKind::name),
        [
            "sync",
            "import-scan",
            "supplied-source-import",
            "extract-source-docs",
            "check-source-updates",
            "export-stl-pack",
            "export-checklist-html",
            "export-kit-bundle",
            "export-accepted-plate-3mf",
            "export-direct-3mf",
            "printer-upload"
        ]
    );
    for kind in JobKind::ALL {
        assert_eq!(
            serde_json::from_str::<JobKind>(&serde_json::to_string(&kind).unwrap()).unwrap(),
            kind
        );
    }
    assert!(
        serde_json::from_str::<Payload>(
            r#"{"kind":"import-scan","payload":{"project_id":1,"tenant_id":"foreign"}}"#
        )
        .is_err()
    );
}
#[test]
fn ticket_t_28_recovery_success_requires_effect_receipts() {
    let (_, owner) = fixture();
    enqueue(&owner, "no-fake-printer", printer("p"));
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "p")),
        )
        .unwrap();
    worker
        .update(&mut lease, WorkerOperation::ConfirmEffect(receipt("p")))
        .unwrap();
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterStart, "p")),
        )
        .unwrap();
    worker
        .update(&mut lease, WorkerOperation::ConfirmEffect(receipt("p")))
        .unwrap();
    assert_eq!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap()
            .state,
        PersistentState::Succeeded
    );
    enqueue(
        &owner,
        "no-fake-export",
        Payload::ExportKitBundle {
            profile_id: 1,
            include_print_progress: false,
        },
    );
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::LocalArtifact, "artifact")),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("artifact")),
        )
        .unwrap();
    assert_eq!(
        worker
            .update(
                &mut lease,
                WorkerOperation::Finish(Some(receipt("artifact")))
            )
            .unwrap()
            .state,
        PersistentState::Succeeded
    );
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_claims_schema35_migration_rollback_and_backup_restart() {
    let (path, owner) = fixture();
    owner.shutdown().unwrap();
    let fixture = Connection::open(path.join("print-partner.db")).unwrap();
    fixture.execute_batch("DROP INDEX source_scan_execution_receipt; DROP TABLE source_scan_executions; DROP TRIGGER trg_source_revision_observations_preclaim_cursor_insert; DROP TABLE source_preclaim_refusals; DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; DROP TABLE durable_job_reconciliations; DROP TABLE durable_job_history; DROP TABLE durable_job_keys; DROP TABLE durable_jobs; UPDATE app_settings SET value='34' WHERE tenant_id='default' AND key='schema_version'; CREATE TRIGGER reject_schema35 BEFORE UPDATE ON app_settings WHEN NEW.key='schema_version' AND NEW.value='35' BEGIN SELECT RAISE(ABORT,'fixture migration constraint'); END;").unwrap();
    drop(fixture);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    assert_eq!(
        raw.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'durable_job%'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        raw.query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "34"
    );
    raw.execute_batch("DROP TRIGGER reject_schema35;").unwrap();
    drop(raw);
    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 34);
    let backup = ready.backup.unwrap();
    let before = std::fs::read(&backup).unwrap();
    owner.shutdown().unwrap();
    let (owner, ready) = WriterOwner::open(&path, Limits::default()).unwrap();
    assert!(ready.backup.is_none());
    assert_eq!(before, std::fs::read(&backup).unwrap());
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_lost_claim_reply_is_fenced_on_orderly_restart() {
    let (path, owner) = fixture();
    let queued = enqueue(&owner, "lost-claim", Payload::CheckSourceUpdates {});
    let worker = owner.job_worker(admission()).unwrap();
    drop(
        worker
            .claim_pending(&AtomicBool::new(false), Duration::from_secs(5))
            .unwrap(),
    );
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let worker = owner.job_worker(admission()).unwrap();
    let recovered = worker.claim().unwrap().unwrap().job;
    assert_eq!(recovered.job_id, queued.job_id);
    assert_eq!(recovered.attempt, 2);
    assert_eq!(recovered.generation, 3);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_reconciliation_records_authenticated_subject() {
    let (_, owner) = fixture();
    let (identity, token) = register(&owner, "reconcile@example.com");
    let mut payload = printer("owned-printer");
    if let Payload::PrinterUpload { start, .. } = &mut payload {
        *start = false;
    }
    let queued = job(session_call(
        &owner,
        policy(),
        &token,
        UserOperation::Enqueue {
            key: "subject".into(),
            payload_version: 1,
            payload,
        },
    )
    .unwrap());
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "owned-printer")),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let resolved = job(session_call(
        &owner,
        policy(),
        &token,
        UserOperation::Reconcile {
            job_id: queued.job_id.clone(),
            expected_version: uncertain.state_version,
            expected_generation: uncertain.generation,
            effect_hash: "b".repeat(64),
            decision: Decision::ConfirmSucceeded,
            receipt: Some(receipt("owned-printer")),
        },
    )
    .unwrap());
    assert_eq!(resolved.state, PersistentState::Succeeded);
    match session_call(
        &owner,
        policy(),
        &token,
        UserOperation::Reconciliations {
            job_id: queued.job_id,
            before_version: None,
            limit: 10,
        },
    )
    .unwrap()
    {
        Outcome::Reconciliations(records) => {
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].subject, format!("user:{}", identity.user_id));
            assert_eq!(records[0].generation, uncertain.generation);
            assert_eq!(records[0].effect_hash, "b".repeat(64));
            assert_eq!(records[0].receipt, Some(receipt("owned-printer")));
        }
        _ => panic!("reconciliation"),
    }
    owner.shutdown().unwrap();
}
#[test]
fn split_printer_upload_reconciles_to_uploaded_only() {
    let (path, owner) = fixture();
    let queued = enqueue(&owner, "uploaded-only", printer("uploaded-only-printer"));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterUpload,
                "uploaded-only-printer",
            )),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("uploaded-only-printer")),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let mut changed_receipt = receipt("uploaded-only-printer");
    changed_receipt.receipt_id = "different-receipt".into();
    assert!(
        call(
            &owner,
            UserOperation::Reconcile {
                job_id: queued.job_id.clone(),
                expected_version: uncertain.state_version,
                expected_generation: uncertain.generation,
                effect_hash: "b".repeat(64),
                decision: Decision::ConfirmSucceeded,
                receipt: Some(changed_receipt),
            },
        )
        .is_err()
    );
    assert!(
        call(
            &owner,
            UserOperation::Reconcile {
                job_id: queued.job_id.clone(),
                expected_version: uncertain.state_version,
                expected_generation: uncertain.generation,
                effect_hash: "b".repeat(64),
                decision: Decision::ConfirmNoEffect,
                receipt: None,
            },
        )
        .is_err()
    );
    let resolved = job(call(
        &owner,
        UserOperation::Reconcile {
            job_id: queued.job_id.clone(),
            expected_version: uncertain.state_version,
            expected_generation: uncertain.generation,
            effect_hash: "b".repeat(64),
            decision: Decision::ConfirmSucceeded,
            receipt: Some(receipt("uploaded-only-printer")),
        },
    )
    .unwrap());
    assert!(resolved.state.terminal());
    assert_eq!(resolved.snapshot().status, "done");
    assert_eq!(
        resolved.snapshot().message,
        "Uploaded only; print not started"
    );
    assert_eq!(resolved.effects.len(), 1);
    assert!(resolved.effects[0].confirmed);
    assert_eq!(resolved.result, Some(receipt("uploaded-only-printer")));
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Heartbeat)
            .is_err()
    );

    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let recovered = get(&owner, &queued.job_id);
    assert!(recovered.state.terminal());
    assert_eq!(recovered.snapshot().status, "done");
    assert_eq!(recovered.effects, resolved.effects);
    assert_eq!(recovered.result, resolved.result);
    let listed = match call(
        &owner,
        UserOperation::List(JobListQuery {
            status: Some("done".into()),
            ..Default::default()
        }),
    )
    .unwrap()
    {
        Outcome::List(records) => records,
        _ => panic!("job list"),
    };
    assert!(listed.iter().any(|record| record.job_id == queued.job_id));
    let newer = enqueue(&owner, "newer-terminal", Payload::CheckSourceUpdates {});
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, newer.job_id);
    worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800, document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
        [&queued.job_id],
    )
    .unwrap();
    drop(raw);
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    assert!(
        call(
            &owner,
            UserOperation::Get {
                job_id: queued.job_id.clone(),
            },
        )
        .is_err()
    );
    let child = enqueue(
        &owner,
        "start-from-retained-parent",
        Payload::PrinterStart(PrinterStartRequest::new(queued.job_id)),
    );
    let Payload::PrinterStart(request) = child.payload else {
        panic!("printer start payload")
    };
    assert_eq!(request.printer_id(), Some("uploaded-only-printer"));
    owner.shutdown().unwrap();
}
#[test]
fn uploaded_only_parent_authorizes_one_bound_start_without_reupload() {
    let (path, owner) = fixture();
    let queued = enqueue(&owner, "uploaded-parent", printer("deliberate-printer"));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload_intent = intent(EffectOperation::PrinterUpload, "deliberate-printer");
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(upload_intent.clone()),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("deliberate-printer")),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let parent = job(call(
        &owner,
        UserOperation::Reconcile {
            job_id: queued.job_id.clone(),
            expected_version: uncertain.state_version,
            expected_generation: uncertain.generation,
            effect_hash: upload_intent.content_hash.clone(),
            decision: Decision::ConfirmSucceeded,
            receipt: Some(receipt("deliberate-printer")),
        },
    )
    .unwrap());
    let parent_before = serde_json::to_value(&parent).unwrap();
    let start_payload = || Payload::PrinterStart(PrinterStartRequest::new(&parent.job_id));
    let first = enqueue(&owner, "deliberate-start", start_payload());
    assert_eq!(first.kind, JobKind::PrinterUpload);
    assert_eq!(first.payload.kind(), JobKind::PrinterUpload);
    let Payload::PrinterStart(request) = &first.payload else {
        panic!("printer start payload")
    };
    assert_eq!(request.printer_id(), Some("deliberate-printer"));
    assert_eq!(request.upload_effect(), Some(&parent.effects[0]));
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "forged-start-binding".into(),
                payload_version: 1,
                payload: first.payload.clone(),
            },
        )
        .is_err()
    );
    let (_, foreign_token) = register(&owner, "foreign-start@example.com");
    assert!(
        session_call(
            &owner,
            policy(),
            &foreign_token,
            UserOperation::Enqueue {
                key: "foreign-start".into(),
                payload_version: 1,
                payload: start_payload(),
            },
        )
        .is_err()
    );
    let same = enqueue(&owner, "deliberate-start", start_payload());
    assert_eq!(same.job_id, first.job_id);
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "duplicate-deliberate-start".into(),
                payload_version: 1,
                payload: start_payload(),
            },
        )
        .is_err()
    );
    assert_eq!(
        serde_json::to_value(get(&owner, &parent.job_id)).unwrap(),
        parent_before
    );
    call(
        &owner,
        UserOperation::Cancel {
            job_id: first.job_id,
        },
    )
    .unwrap();
    let retry = enqueue(&owner, "retried-deliberate-start", start_payload());
    let ClaimedAttempt {
        job: claimed,
        lease: mut start_lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, retry.job_id);
    enqueue(&owner, "same-printer-upload", printer("deliberate-printer"));
    assert!(worker.claim().unwrap().is_none());
    for operation in [
        EffectOperation::PrinterUpload,
        EffectOperation::PrinterUploadAndStart,
        EffectOperation::SpoolmanDeduction,
        EffectOperation::LocalArtifact,
    ] {
        assert!(
            worker
                .update(
                    &mut start_lease,
                    WorkerOperation::BeginEffect(intent(operation, "deliberate-printer")),
                )
                .is_err()
        );
    }
    let mut wrong_content = intent(EffectOperation::PrinterStart, "deliberate-printer");
    wrong_content.content_hash = "c".repeat(64);
    assert!(
        worker
            .update(
                &mut start_lease,
                WorkerOperation::BeginEffect(wrong_content),
            )
            .is_err()
    );
    worker
        .update(
            &mut start_lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterStart,
                "deliberate-printer",
            )),
        )
        .unwrap();
    worker
        .update(
            &mut start_lease,
            WorkerOperation::ConfirmEffect(receipt("deliberate-printer")),
        )
        .unwrap();
    let done = worker
        .update(
            &mut start_lease,
            WorkerOperation::Finish(Some(receipt("deliberate-printer"))),
        )
        .unwrap();
    assert_eq!(done.state, PersistentState::Succeeded);
    assert_eq!(done.effects.len(), 1);
    assert_eq!(
        done.effects[0].intent.operation,
        EffectOperation::PrinterStart
    );
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "start-after-success".into(),
                payload_version: 1,
                payload: start_payload(),
            },
        )
        .is_err()
    );
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(
        enqueue(&owner, "retried-deliberate-start", start_payload()).job_id,
        retry.job_id
    );
    owner.shutdown().unwrap();
}
#[test]
fn admitted_unconfirmed_upload_reaches_uploaded_only() {
    let (_, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "unconfirmed-upload", "unconfirmed-printer");
    assert_eq!(parent.state, PersistentState::UploadedOnly);
    assert_eq!(parent.effects.len(), 1);
    assert!(parent.effects[0].confirmed);
    assert_eq!(parent.result, Some(receipt("unconfirmed-printer")));
    owner.shutdown().unwrap();
}
#[test]
fn start_child_rejects_wrong_target_and_basis() {
    let (_, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "effect-parent", "effect-printer");
    let child = job(enqueue_start(&owner, "effect-child", &parent.job_id).unwrap());
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, child.job_id);
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(
                    EffectOperation::PrinterStart,
                    "wrong-printer",
                )),
            )
            .is_err()
    );
    let mut wrong_basis = intent(EffectOperation::PrinterStart, "effect-printer");
    wrong_basis.basis_hash = "e".repeat(64);
    assert!(
        worker
            .update(&mut lease, WorkerOperation::BeginEffect(wrong_basis),)
            .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn start_child_cannot_finish_without_confirmed_start() {
    let (_, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "finish-parent", "finish-printer");
    let child = job(enqueue_start(&owner, "finish-child", &parent.job_id).unwrap());
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, child.job_id);
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    assert!(
        worker
            .update(
                &mut lease,
                WorkerOperation::Finish(Some(receipt("finish-printer"))),
            )
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterStart, "finish-printer")),
        )
        .unwrap();
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("finish-printer")),
        )
        .unwrap();
    assert!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn confirmed_combined_receipt_cannot_be_rewritten() {
    let (_, owner) = fixture();
    let queued = enqueue(&owner, "combined-receipt", printer("combined-printer"));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterUploadAndStart,
                "combined-printer",
            )),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("combined-printer")),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let mut forged = receipt("combined-printer");
    forged.receipt_id = "forged".into();
    assert!(reconcile(&owner, &uncertain, Decision::ConfirmSucceeded, Some(forged),).is_err());
    let resolved = job(reconcile(
        &owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(receipt("combined-printer")),
    )
    .unwrap());
    assert_eq!(resolved.state, PersistentState::Succeeded);
    assert_eq!(resolved.job_id, queued.job_id);
    owner.shutdown().unwrap();
}
#[test]
fn active_and_failed_parents_cannot_authorize_start() {
    let (_, owner) = fixture();
    let queued = enqueue(&owner, "wrong-state-parent", printer("wrong-state-printer"));
    assert!(enqueue_start(&owner, "from-queued", &queued.job_id).is_err());
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: running,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert!(enqueue_start(&owner, "from-running", &running.job_id).is_err());
    let admitted = worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterUpload,
                "wrong-state-printer",
            )),
        )
        .unwrap();
    assert!(enqueue_start(&owner, "from-admitted", &admitted.job_id).is_err());
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    assert!(enqueue_start(&owner, "from-uncertain", &uncertain.job_id).is_err());
    let failed = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
    assert_eq!(failed.state, PersistentState::Failed);
    assert!(enqueue_start(&owner, "from-failed", &failed.job_id).is_err());
    let cancelled = enqueue(&owner, "cancelled-parent", printer("cancelled-printer"));
    let cancelled = job(call(
        &owner,
        UserOperation::Cancel {
            job_id: cancelled.job_id,
        },
    )
    .unwrap());
    assert!(enqueue_start(&owner, "from-cancelled", &cancelled.job_id).is_err());
    assert!(enqueue_start(&owner, "from-missing", "missing-parent").is_err());
    owner.shutdown().unwrap();
}
#[test]
fn succeeded_and_nonprinter_parents_cannot_authorize_start() {
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    let mut no_start = printer("no-start-printer");
    let Payload::PrinterUpload { start, .. } = &mut no_start else {
        unreachable!()
    };
    *start = false;
    let queued = enqueue(&owner, "no-start-parent", no_start);
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterUpload,
                "no-start-printer",
            )),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("no-start-printer")),
        )
        .unwrap();
    let succeeded = worker
        .update(
            &mut lease,
            WorkerOperation::Finish(Some(receipt("no-start-printer"))),
        )
        .unwrap();
    assert!(enqueue_start(&owner, "from-succeeded", &succeeded.job_id).is_err());
    assert_eq!(succeeded.job_id, queued.job_id);
    let mut reconciled_no_start = printer("reconciled-no-start-printer");
    let Payload::PrinterUpload { start, .. } = &mut reconciled_no_start else {
        unreachable!()
    };
    *start = false;
    enqueue(&owner, "reconciled-no-start-parent", reconciled_no_start);
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::PrinterUpload,
                "reconciled-no-start-printer",
            )),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let reconciled = job(reconcile(
        &owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(receipt("reconciled-no-start-printer")),
    )
    .unwrap());
    assert_eq!(reconciled.state, PersistentState::Succeeded);
    assert!(enqueue_start(&owner, "from-reconciled", &reconciled.job_id).is_err());
    let parent = uploaded_only_parent(&owner, "child-parent", "child-parent-printer");
    let child = job(enqueue_start(&owner, "child-parent-child", &parent.job_id).unwrap());
    assert!(enqueue_start(&owner, "from-child", &child.job_id).is_err());
    let nonprinter = enqueue(&owner, "nonprinter-parent", Payload::CheckSourceUpdates {});
    assert!(enqueue_start(&owner, "from-nonprinter", &nonprinter.job_id).is_err());
    owner.shutdown().unwrap();
}
#[test]
fn uploaded_only_does_not_consume_active_queue_capacity() {
    let (_, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "cap-parent", "cap-printer");
    assert_eq!(parent.state, PersistentState::UploadedOnly);
    for index in 0..1024 {
        enqueue(
            &owner,
            &format!("active-cap-{index}"),
            Payload::CheckSourceUpdates {},
        );
    }
    assert!(
        call(
            &owner,
            UserOperation::Enqueue {
                key: "active-cap-overflow".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
        )
        .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn archived_started_child_blocks_new_key_and_replays_original_key() {
    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "archive-parent", "archive-printer");
    let child = job(enqueue_start(&owner, "archive-child", &parent.job_id).unwrap());
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterStart, "archive-printer")),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(receipt("archive-printer")),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::Finish(Some(receipt("archive-printer"))),
        )
        .unwrap();
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800, document=json_set(document,'$.updated_at',updated-172800)",
        [],
    )
    .unwrap();
    drop(raw);
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 2);
    assert_eq!(
        readonly(&path)
            .query_row("SELECT COUNT(*) FROM durable_jobs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(enqueue_start(&owner, "archive-new-key", &parent.job_id).is_err());
    assert_eq!(
        job(enqueue_start(&owner, "archive-child", &parent.job_id).unwrap()).job_id,
        child.job_id
    );
    owner.shutdown().unwrap();
}
#[test]
fn uploaded_only_parent_is_inert() {
    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "inert-parent", "inert-printer");
    let cancelled = job(call(
        &owner,
        UserOperation::Cancel {
            job_id: parent.job_id.clone(),
        },
    )
    .unwrap());
    assert_eq!(cancelled.state, PersistentState::UploadedOnly);
    assert_eq!(cancelled.state_version, parent.state_version);
    for decision in [
        Decision::ConfirmSucceeded,
        Decision::ConfirmNoEffect,
        Decision::Abandon,
    ] {
        assert!(reconcile(&owner, &parent, decision, None).is_err());
    }
    let worker = owner.job_worker(admission()).unwrap();
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(
        get(&owner, &parent.job_id).state,
        PersistentState::UploadedOnly
    );
    assert!(
        owner
            .job_worker(admission())
            .unwrap()
            .claim()
            .unwrap()
            .is_none()
    );
    owner.shutdown().unwrap();
}
#[test]
fn denied_start_settles_uploaded_only_and_authorizes_bound_child() {
    let (_, owner) = fixture();
    let queued = enqueue(
        &owner,
        "denied-start-parent",
        printer("denied-start-printer"),
    );
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload_intent = distinct_intent(EffectOperation::PrinterUpload, "denied-start-printer", 1);
    let upload_receipt = distinct_receipt(&upload_intent, "upload-receipt");
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(upload_intent.clone()),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(upload_receipt.clone()),
        )
        .unwrap();
    let upload_bytes = serde_json::to_vec(&get(&owner, &queued.job_id).effects[0]).unwrap();
    let start_intent = distinct_intent(EffectOperation::PrinterStart, "denied-start-printer", 2);
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(start_intent.clone()),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let settled = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
    assert_eq!(settled.state, PersistentState::UploadedOnly);
    assert_eq!(settled.snapshot().status, "done");
    assert_eq!(settled.result, Some(upload_receipt.clone()));
    assert_eq!(settled.effects.len(), 2);
    assert!(!settled.effects[0].no_effect);
    assert!(settled.effects[1].no_effect);
    assert_eq!(
        serde_json::to_vec(&settled.effects[0]).unwrap(),
        upload_bytes
    );
    let audit = reconciliations(&owner, &settled.job_id);
    assert_eq!(audit[0].decision, "ConfirmNoEffect");
    assert_eq!(audit[0].receipt, None);
    assert_eq!(audit[0].target, start_intent.target);
    let parent_bytes = serde_json::to_vec(&settled).unwrap();
    let child = job(enqueue_start(&owner, "denied-start-child", &settled.job_id).unwrap());
    let Payload::PrinterStart(request) = &child.payload else {
        panic!("printer start payload")
    };
    assert_eq!(request.upload_effect(), Some(&settled.effects[0]));
    assert_eq!(request.upload_effect().unwrap().receipt, settled.result);
    assert_eq!(
        serde_json::to_vec(&get(&owner, &settled.job_id)).unwrap(),
        parent_bytes
    );
    assert!(enqueue_start(&owner, "denied-start-second", &settled.job_id).is_err());
    let ClaimedAttempt {
        job: claimed,
        lease: mut child_lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, child.job_id);
    for operation in [
        EffectOperation::PrinterUpload,
        EffectOperation::PrinterUploadAndStart,
    ] {
        assert!(
            worker
                .update(
                    &mut child_lease,
                    WorkerOperation::BeginEffect(distinct_intent(
                        operation,
                        "denied-start-printer",
                        3,
                    )),
                )
                .is_err()
        );
    }
    let mut child_start = upload_intent;
    child_start.operation = EffectOperation::PrinterStart;
    worker
        .update(&mut child_lease, WorkerOperation::BeginEffect(child_start))
        .unwrap();
    worker
        .update(
            &mut child_lease,
            WorkerOperation::ConfirmEffect(upload_receipt.clone()),
        )
        .unwrap();
    worker
        .update(
            &mut child_lease,
            WorkerOperation::Finish(Some(upload_receipt)),
        )
        .unwrap();
    assert!(enqueue_start(&owner, "denied-start-third", &settled.job_id).is_err());
    owner.shutdown().unwrap();
}
#[test]
fn confirmed_spoolman_settles_to_upload_receipt_and_subject_audit() {
    let (_, owner) = fixture();
    let queued = enqueue(&owner, "spoolman-parent", printer("spoolman-printer"));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload_intent = distinct_intent(EffectOperation::PrinterUpload, "spoolman-printer", 10);
    let upload_receipt = distinct_receipt(&upload_intent, "upload-receipt-10");
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(upload_intent))
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(upload_receipt.clone()),
        )
        .unwrap();
    let spoolman_intent = distinct_intent(EffectOperation::SpoolmanDeduction, "spoolman:1", 11);
    let spoolman_receipt = distinct_receipt(&spoolman_intent, "spoolman-receipt-1");
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(spoolman_intent.clone()),
        )
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(spoolman_receipt.clone()),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let settled = job(reconcile(
        &owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(spoolman_receipt.clone()),
    )
    .unwrap());
    assert_eq!(settled.state, PersistentState::UploadedOnly);
    assert_eq!(settled.result, Some(upload_receipt));
    assert_eq!(settled.effects[1].receipt, Some(spoolman_receipt.clone()));
    assert!(settled.effects[1].confirmed);
    let audit = reconciliations(&owner, &queued.job_id);
    assert_eq!(audit[0].receipt, Some(spoolman_receipt));
    assert_eq!(audit[0].target, spoolman_intent.target);
    enqueue(&owner, "after-spoolman", printer("spoolman-printer"));
    assert!(worker.claim().unwrap().is_some());
    owner.shutdown().unwrap();
}
#[test]
fn confirmed_spoolman_rejects_changed_or_denied_outcome() {
    let (path, owner) = fixture();
    enqueue(
        &owner,
        "spoolman-reject",
        printer("spoolman-reject-printer"),
    );
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload = distinct_intent(
        EffectOperation::PrinterUpload,
        "spoolman-reject-printer",
        20,
    );
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(upload.clone()))
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(distinct_receipt(&upload, "upload-receipt-20")),
        )
        .unwrap();
    let spoolman = distinct_intent(EffectOperation::SpoolmanDeduction, "spoolman:20", 21);
    let spoolman_receipt = distinct_receipt(&spoolman, "spoolman-receipt-20");
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(spoolman.clone()))
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::ConfirmEffect(spoolman_receipt.clone()),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let raw = readonly(&path);
    let before: (String, i64, i64) = raw
        .query_row(
            "SELECT document,(SELECT COUNT(*) FROM durable_job_history WHERE job_id=?1),(SELECT COUNT(*) FROM durable_job_reconciliations WHERE job_id=?1) FROM durable_jobs WHERE id=?1",
            [&uncertain.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    drop(raw);
    let mut forged = spoolman_receipt.clone();
    forged.receipt_id = "forged-spoolman".into();
    assert!(reconcile(&owner, &uncertain, Decision::ConfirmSucceeded, Some(forged),).is_err());
    assert!(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).is_err());
    let raw = readonly(&path);
    let after: (String, i64, i64) = raw
        .query_row(
            "SELECT document,(SELECT COUNT(*) FROM durable_job_history WHERE job_id=?1),(SELECT COUNT(*) FROM durable_job_reconciliations WHERE job_id=?1) FROM durable_jobs WHERE id=?1",
            [&uncertain.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    drop(raw);
    let abandoned = job(reconcile(&owner, &uncertain, Decision::Abandon, None).unwrap());
    assert_eq!(abandoned.state, PersistentState::ReconciliationRequired);
    assert!(abandoned.effects.iter().all(|effect| !effect.no_effect));
    let audit = reconciliations(&owner, &abandoned.job_id);
    assert_eq!(audit[0].decision, "Abandon");
    assert_eq!(audit[0].receipt, None);
    let settled = job(reconcile(
        &owner,
        &abandoned,
        Decision::ConfirmSucceeded,
        Some(spoolman_receipt),
    )
    .unwrap());
    assert_eq!(settled.state, PersistentState::UploadedOnly);
    owner.shutdown().unwrap();
}
#[test]
fn unresolved_spoolman_settles_by_either_explicit_decision() {
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    for (index, decision) in [Decision::ConfirmNoEffect, Decision::ConfirmSucceeded]
        .into_iter()
        .enumerate()
    {
        let printer_id = format!("unresolved-spoolman-printer-{index}");
        enqueue(
            &owner,
            &format!("unresolved-spoolman-{index}"),
            printer(&printer_id),
        );
        let ClaimedAttempt {
            job: _,
            mut lease,
            source_work,
        } = worker.claim().unwrap().unwrap();
        assert!(source_work.is_none());
        let upload = distinct_intent(
            EffectOperation::PrinterUpload,
            &printer_id,
            30 + index as u64,
        );
        let upload_receipt = begin_and_confirm(
            &worker,
            &mut lease,
            upload,
            &format!("upload-receipt-3{index}"),
        );
        let spoolman = distinct_intent(
            EffectOperation::SpoolmanDeduction,
            &format!("spoolman:3{index}"),
            40 + index as u64,
        );
        let spoolman_receipt = distinct_receipt(&spoolman, &format!("spoolman-receipt-3{index}"));
        worker
            .update(&mut lease, WorkerOperation::BeginEffect(spoolman))
            .unwrap();
        let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
        let supplied = (decision == Decision::ConfirmSucceeded).then_some(spoolman_receipt.clone());
        let settled = job(reconcile(&owner, &uncertain, decision, supplied).unwrap());
        assert_eq!(settled.state, PersistentState::UploadedOnly);
        assert_eq!(settled.result, Some(upload_receipt));
        assert_eq!(
            settled.effects[1].no_effect,
            decision == Decision::ConfirmNoEffect
        );
        assert_eq!(
            settled.effects[1].receipt,
            (decision == Decision::ConfirmSucceeded).then_some(spoolman_receipt)
        );
    }
    owner.shutdown().unwrap();
}
#[test]
fn spoolman_before_upload_settles_without_order_dependence() {
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    for (index, confirm_upload) in [true, false].into_iter().enumerate() {
        let printer_id = format!("spoolman-first-printer-{index}");
        enqueue(
            &owner,
            &format!("spoolman-first-{index}"),
            printer(&printer_id),
        );
        let ClaimedAttempt {
            job: _,
            mut lease,
            source_work,
        } = worker.claim().unwrap().unwrap();
        assert!(source_work.is_none());
        let spoolman = distinct_intent(
            EffectOperation::SpoolmanDeduction,
            &format!("spoolman:first:{index}"),
            50 + index as u64,
        );
        begin_and_confirm(
            &worker,
            &mut lease,
            spoolman,
            &format!("spoolman-first-receipt-{index}"),
        );
        let upload = distinct_intent(
            EffectOperation::PrinterUpload,
            &printer_id,
            60 + index as u64,
        );
        let upload_receipt = distinct_receipt(&upload, &format!("upload-last-receipt-{index}"));
        worker
            .update(&mut lease, WorkerOperation::BeginEffect(upload))
            .unwrap();
        if confirm_upload {
            worker
                .update(
                    &mut lease,
                    WorkerOperation::ConfirmEffect(upload_receipt.clone()),
                )
                .unwrap();
        }
        let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
        let (decision, supplied) = if confirm_upload {
            (Decision::ConfirmSucceeded, Some(upload_receipt.clone()))
        } else {
            (Decision::ConfirmNoEffect, None)
        };
        let settled = job(reconcile(&owner, &uncertain, decision, supplied).unwrap());
        if confirm_upload {
            assert_eq!(settled.state, PersistentState::UploadedOnly);
            assert_eq!(settled.result, Some(upload_receipt));
        } else {
            assert_eq!(settled.state, PersistentState::Failed);
            assert!(settled.effects[1].no_effect);
            assert!(settled.effects[0].confirmed);
        }
    }
    owner.shutdown().unwrap();
}
#[test]
fn reconciliation_does_not_infer_start_or_combined_outcomes() {
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    enqueue(
        &owner,
        "combined-denied",
        printer("combined-denied-printer"),
    );
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let combined = distinct_intent(
        EffectOperation::PrinterUploadAndStart,
        "combined-denied-printer",
        70,
    );
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(combined))
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let failed = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
    assert_eq!(failed.state, PersistentState::Failed);
    assert!(failed.effects[0].no_effect);
    assert!(failed.result.is_none());

    enqueue(&owner, "unknown-start", printer("unknown-start-printer"));
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload = distinct_intent(EffectOperation::PrinterUpload, "unknown-start-printer", 71);
    begin_and_confirm(&worker, &mut lease, upload, "unknown-start-upload");
    let start = distinct_intent(EffectOperation::PrinterStart, "unknown-start-printer", 72);
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(start))
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let abandoned = job(reconcile(&owner, &uncertain, Decision::Abandon, None).unwrap());
    assert_eq!(abandoned.state, PersistentState::ReconciliationRequired);
    assert!(!abandoned.effects[1].no_effect);
    assert!(!abandoned.effects[1].confirmed);

    let mut no_start = printer("no-start-spoolman-printer");
    let Payload::PrinterUpload { start, .. } = &mut no_start else {
        unreachable!()
    };
    *start = false;
    enqueue(&owner, "no-start-spoolman", no_start);
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload = distinct_intent(
        EffectOperation::PrinterUpload,
        "no-start-spoolman-printer",
        73,
    );
    begin_and_confirm(&worker, &mut lease, upload, "no-start-upload");
    let spoolman = distinct_intent(EffectOperation::SpoolmanDeduction, "spoolman:no-start", 74);
    let spoolman_receipt =
        begin_and_confirm(&worker, &mut lease, spoolman, "no-start-spoolman-receipt");
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let succeeded = job(reconcile(
        &owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(spoolman_receipt),
    )
    .unwrap());
    assert_eq!(succeeded.state, PersistentState::Succeeded);
    owner.shutdown().unwrap();
}
#[test]
fn archived_uploaded_only_document_keeps_denied_and_confirmed_effect_facts() {
    let (path, owner) = fixture();
    enqueue(
        &owner,
        "archive-facts-parent",
        printer("archive-facts-printer"),
    );
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload = distinct_intent(EffectOperation::PrinterUpload, "archive-facts-printer", 80);
    let upload_receipt =
        begin_and_confirm(&worker, &mut lease, upload, "archive-facts-upload-receipt");
    let spoolman = distinct_intent(
        EffectOperation::SpoolmanDeduction,
        "spoolman:archive-facts",
        81,
    );
    begin_and_confirm(
        &worker,
        &mut lease,
        spoolman,
        "archive-facts-spoolman-receipt",
    );
    let start = distinct_intent(EffectOperation::PrinterStart, "archive-facts-printer", 82);
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(start))
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let parent = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
    assert_eq!(parent.state, PersistentState::UploadedOnly);
    assert_eq!(parent.result, Some(upload_receipt));
    assert!(parent.effects[1].confirmed);
    assert!(parent.effects[2].no_effect);
    let before: String = readonly(&path)
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let after: String = readonly(&path)
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, before);
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800, document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    assert_eq!(
        readonly(&path)
            .query_row(
                "SELECT COUNT(*) FROM durable_job_reconciliations WHERE job_id=?1",
                [&parent.job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    let child = job(enqueue_start(&owner, "archive-facts-child", &parent.job_id).unwrap());
    let Payload::PrinterStart(request) = child.payload else {
        panic!("printer start payload")
    };
    assert_eq!(request.upload_effect(), Some(&parent.effects[0]));
    assert_eq!(
        request.upload_effect().unwrap().receipt.as_ref(),
        parent.result.as_ref()
    );
    owner.shutdown().unwrap();
}
#[test]
fn effect_outcome_wire_is_legacy_compatible_and_omits_false() {
    let unresolved = r#"{"intent":{"operation":"printer_upload","basis_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target":"printer"},"attempt":1,"generation":1,"confirmed":false,"receipt":null}"#;
    let unresolved_effect: EffectReceipt = serde_json::from_str(unresolved).unwrap();
    assert!(!unresolved_effect.no_effect);
    assert_eq!(
        serde_json::to_string(&unresolved_effect).unwrap(),
        unresolved
    );
    let confirmed = r#"{"intent":{"operation":"printer_upload","basis_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target":"printer"},"attempt":1,"generation":1,"confirmed":true,"receipt":{"receipt_id":"legacy","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target":"printer"}}"#;
    let confirmed_effect: EffectReceipt = serde_json::from_str(confirmed).unwrap();
    assert!(!confirmed_effect.no_effect);
    assert_eq!(serde_json::to_string(&confirmed_effect).unwrap(), confirmed);
    assert!(
        !serde_json::to_string(&receipt("printer"))
            .unwrap()
            .contains("no_effect")
    );

    let (path, owner) = fixture();
    enqueue(&owner, "legacy-reconcile", printer("legacy-printer"));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "legacy-printer")),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    assert!(
        !serde_json::to_string(&uncertain)
            .unwrap()
            .contains("no_effect")
    );
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let recovered = get(&owner, &uncertain.job_id);
    let settled = job(reconcile(
        &owner,
        &recovered,
        Decision::ConfirmSucceeded,
        Some(receipt("legacy-printer")),
    )
    .unwrap());
    assert_eq!(settled.state, PersistentState::UploadedOnly);
    owner.shutdown().unwrap();
}
#[test]
fn invalid_persisted_effect_outcomes_fail_closed() {
    let (path, owner) = fixture();
    let parent = denied_start_parent(&owner, "tamper-unresolved", "tamper-unresolved-printer", 90);
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_remove(document,'$.effects[1].no_effect') WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());

    let (path, owner) = fixture();
    let parent = denied_start_parent(&owner, "tamper-conflict", "tamper-conflict-printer", 100);
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.effects[0].no_effect',json('true')) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());

    let (path, owner) = fixture();
    let parent = denied_start_parent(&owner, "tamper-running", "tamper-running-printer", 110);
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET state='running',document=json_set(document,'$.state','running') WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());

    for (index, operation) in ["printer_start", "printer_upload_and_start"]
        .into_iter()
        .enumerate()
    {
        let (path, owner) = fixture();
        let parent = denied_start_parent(
            &owner,
            &format!("tamper-confirmed-{index}"),
            &format!("tamper-confirmed-printer-{index}"),
            120 + index as u64,
        );
        owner.shutdown().unwrap();
        let raw = Connection::open(path.join("print-partner.db")).unwrap();
        raw.execute(
            "UPDATE durable_jobs SET document=json_set(json_remove(document,'$.effects[1].no_effect'),'$.effects[1].confirmed',json('true'),'$.effects[1].intent.operation',?2,'$.effects[1].receipt',json_object('receipt_id',?3,'content_hash',json_extract(document,'$.effects[1].intent.content_hash'),'target',json_extract(document,'$.effects[1].intent.target'))) WHERE id=?1",
            rusqlite::params![parent.job_id, operation, format!("tampered-confirmed-{index}")],
        )
        .unwrap();
        drop(raw);
        assert!(WriterOwner::open(&path, Limits::default()).is_err());
    }

    let (path, owner) = fixture();
    let parent = denied_start_parent(&owner, "tamper-receipt", "tamper-receipt-printer", 112);
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.effects[0].receipt.content_hash',?2) WHERE id=?1",
        rusqlite::params![parent.job_id, "f".repeat(64)],
    )
    .unwrap();
    drop(raw);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());

    let (path, owner) = fixture();
    let parent = denied_start_parent(&owner, "tamper-operation", "tamper-operation-printer", 115);
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.effects[1].intent.operation','local_artifact') WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
}
#[test]
fn uploaded_only_result_tamper_rejects_decode_and_child_binding() {
    let (path, owner) = fixture();
    enqueue(&owner, "tamper-result", printer("tamper-result-printer"));
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    let upload = distinct_intent(EffectOperation::PrinterUpload, "tamper-result-printer", 120);
    begin_and_confirm(&worker, &mut lease, upload, "tamper-upload-receipt");
    let spoolman = distinct_intent(
        EffectOperation::SpoolmanDeduction,
        "spoolman:tamper-result",
        121,
    );
    let spoolman_receipt =
        begin_and_confirm(&worker, &mut lease, spoolman, "tamper-spoolman-receipt");
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let parent = job(reconcile(
        &owner,
        &uncertain,
        Decision::ConfirmSucceeded,
        Some(spoolman_receipt),
    )
    .unwrap());
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.result',json_extract(document,'$.effects[1].receipt')) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "tampered-result-child", &parent.job_id).is_err());
    owner.shutdown().unwrap();
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
}
#[test]
fn retained_parent_rejects_embedded_job_id_mismatch_without_writes() {
    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "live-id-parent", "live-id-printer");
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.job_id','embedded-other-id') WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    let before: (String, i64, i64) = raw
        .query_row(
            "SELECT document,(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "live-id-child", &parent.job_id).is_err());
    let raw = readonly(&path);
    let after: (String, i64, i64) = raw
        .query_row(
            "SELECT document,(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    drop(raw);
    owner.shutdown().unwrap();

    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "archive-id-parent", "archive-id-printer");
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.job_id','embedded-other-id') WHERE job_id=?1",
        [&parent.job_id],
    )
    .unwrap();
    let before: (String, i64, i64) = raw
        .query_row(
            "SELECT archived_document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history) FROM durable_job_keys WHERE job_id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "archive-id-child", &parent.job_id).is_err());
    let raw = readonly(&path);
    let after: (String, i64, i64) = raw
        .query_row(
            "SELECT archived_document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history) FROM durable_job_keys WHERE job_id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    drop(raw);
    owner.shutdown().unwrap();
}
#[test]
fn denied_start_child_failure_allows_only_a_fresh_deliberate_key() {
    let (_, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "denied-child-parent", "denied-child-printer");
    let parent_before = serde_json::to_vec(&parent).unwrap();
    let child = job(enqueue_start(&owner, "denied-child", &parent.job_id).unwrap());
    let Payload::PrinterStart(request) = &child.payload else {
        panic!("printer start payload")
    };
    let upload = request.upload_effect().unwrap().clone();
    let mut start = upload.intent.clone();
    start.operation = EffectOperation::PrinterStart;
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        job: claimed,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, child.job_id);
    worker
        .update(&mut lease, WorkerOperation::BeginEffect(start))
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    assert!(enqueue_start(&owner, "denied-child-fresh", &parent.job_id).is_err());
    assert_eq!(
        job(enqueue_start(&owner, "denied-child", &parent.job_id).unwrap()).job_id,
        child.job_id
    );
    let failed = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
    assert_eq!(failed.state, PersistentState::Failed);
    assert_eq!(failed.effects.len(), 1);
    assert_eq!(
        failed.effects[0].intent.operation,
        EffectOperation::PrinterStart
    );
    assert!(failed.effects[0].no_effect);
    assert!(!failed.effects[0].confirmed);
    assert!(failed.effects[0].receipt.is_none());
    assert_eq!(
        job(enqueue_start(&owner, "denied-child", &parent.job_id).unwrap()).job_id,
        child.job_id
    );
    let retry = job(enqueue_start(&owner, "denied-child-fresh", &parent.job_id).unwrap());
    assert_ne!(retry.job_id, child.job_id);
    assert!(retry.effects.is_empty());
    assert_eq!(
        serde_json::to_vec(&get(&owner, &parent.job_id)).unwrap(),
        parent_before
    );
    owner.shutdown().unwrap();
}
#[test]
fn persisted_effect_outcome_truth_table_accepts_exactly_four_shapes() {
    let (path, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    let cases = [
        (false, false, false, true),
        (false, false, true, true),
        (false, true, false, true),
        (false, true, true, false),
        (true, false, false, false),
        (true, false, true, true),
        (true, true, false, false),
        (true, true, true, false),
    ];
    for (index, (confirmed, no_effect, has_receipt, valid)) in cases.into_iter().enumerate() {
        let printer_id = format!("outcome-printer-{index}");
        let queued = enqueue(&owner, &format!("outcome-{index}"), printer(&printer_id));
        let ClaimedAttempt {
            job: claimed,
            mut lease,
            source_work,
        } = worker.claim().unwrap().unwrap();
        assert!(source_work.is_none());
        assert_eq!(claimed.job_id, queued.job_id);
        let combined = distinct_intent(
            EffectOperation::PrinterUploadAndStart,
            &printer_id,
            300 + index as u64,
        );
        worker
            .update(&mut lease, WorkerOperation::BeginEffect(combined))
            .unwrap();
        let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
        let failed = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
        assert_eq!(failed.state, PersistentState::Failed);
        let raw = Connection::open(path.join("print-partner.db")).unwrap();
        let document: String = raw
            .query_row(
                "SELECT document FROM durable_jobs WHERE id=?1",
                [&failed.job_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut document: serde_json::Value = serde_json::from_str(&document).unwrap();
        document["effects"][0]["confirmed"] = confirmed.into();
        document["effects"][0]["no_effect"] = no_effect.into();
        document["effects"][0]["receipt"] = if has_receipt {
            serde_json::json!({
                "receipt_id": format!("outcome-receipt-{index}"),
                "content_hash": document["effects"][0]["intent"]["content_hash"],
                "target": document["effects"][0]["intent"]["target"]
            })
        } else {
            serde_json::Value::Null
        };
        if !confirmed && !no_effect && has_receipt {
            document["state"] = "reconciliation_required".into();
            document["_authority_refusal"] = serde_json::json!({
                "version": 1,
                "reason": "credential_invalid",
                "phase": "worker_advance",
                "observed_at": 1,
                "generation": document["generation"]
            });
        }
        raw.execute(
            "UPDATE durable_jobs SET state=json_extract(?2,'$.state'),document=?2 WHERE id=?1",
            rusqlite::params![failed.job_id, document.to_string()],
        )
        .unwrap();
        drop(raw);
        assert_eq!(
            call(
                &owner,
                UserOperation::Get {
                    job_id: failed.job_id,
                },
            )
            .is_ok(),
            valid,
            "outcome case {index}"
        );
    }
    owner.shutdown().unwrap();
}

#[test]
fn observed_receipt_mismatch_fails_live_and_archived_decode() {
    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "observed-live", "observed-live-printer");
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    let original: String = raw
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut observed: serde_json::Value = serde_json::from_str(&original).unwrap();
    observe_effect(&mut observed, 0);
    raw.execute(
        "UPDATE durable_jobs SET state='reconciliation_required',document=?2 WHERE id=?1",
        rusqlite::params![parent.job_id, observed.to_string()],
    )
    .unwrap();
    assert_eq!(
        get(&owner, &parent.job_id).state,
        PersistentState::ReconciliationRequired
    );
    for field in ["content_hash", "target"] {
        let mut malformed = observed.clone();
        malformed["effects"][0]["receipt"][field] = if field == "content_hash" {
            "f".repeat(64).into()
        } else {
            "mismatch".into()
        };
        raw.execute(
            "UPDATE durable_jobs SET document=?2 WHERE id=?1",
            rusqlite::params![parent.job_id, malformed.to_string()],
        )
        .unwrap();
        let error = job_error(call(
            &owner,
            UserOperation::Get {
                job_id: parent.job_id.clone(),
            },
        ));
        assert!(
            error.to_string().contains("Effect receipt mismatch"),
            "{error:?}"
        );
    }
    raw.execute(
        "UPDATE durable_jobs SET state='uploaded_only',document=?2 WHERE id=?1",
        rusqlite::params![parent.job_id, original],
    )
    .unwrap();
    assert_eq!(
        get(&owner, &parent.job_id).state,
        PersistentState::UploadedOnly
    );
    assert!(enqueue_start(&owner, "observed-live-valid-child", &parent.job_id).is_ok());
    owner.shutdown().unwrap();

    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "observed-archive", "observed-archive-printer");
    uploaded_only_parent(
        &owner,
        "observed-archive-newer",
        "observed-archive-newer-printer",
    );
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    let original: String = raw
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut observed: serde_json::Value = serde_json::from_str(&original).unwrap();
    observe_effect(&mut observed, 0);
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
        rusqlite::params![parent.job_id, observed.to_string()],
    )
    .unwrap();
    assert!(
        job_error(enqueue_start(
            &owner,
            "observed-archive-valid-shape",
            &parent.job_id,
        ))
        .to_string()
        .contains("Parent job is not an uploaded-only print")
    );
    for field in ["content_hash", "target"] {
        let mut malformed = observed.clone();
        malformed["effects"][0]["receipt"][field] = if field == "content_hash" {
            "f".repeat(64).into()
        } else {
            "mismatch".into()
        };
        raw.execute(
            "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
            rusqlite::params![parent.job_id, malformed.to_string()],
        )
        .unwrap();
        let error = job_error(enqueue_start(
            &owner,
            &format!("observed-archive-malformed-{field}"),
            &parent.job_id,
        ));
        assert!(
            error.to_string().contains("Effect receipt mismatch"),
            "{error:?}"
        );
    }
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
        rusqlite::params![parent.job_id, original],
    )
    .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "observed-archive-valid-child", &parent.job_id).is_ok());
    owner.shutdown().unwrap();
}

#[test]
fn observed_spoolman_cannot_be_read_or_bound_as_uploaded_only() {
    let (path, owner) = fixture();
    let parent = uploaded_only_spoolman_parent(
        &owner,
        "observed-spoolman-live",
        "observed-spoolman-live-printer",
    );
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    let original: String = raw
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut invalid: serde_json::Value = serde_json::from_str(&original).unwrap();
    invalid["effects"][1]["confirmed"] = false.into();
    invalid["_authority_refusal"] = serde_json::json!({
        "version": 1,
        "reason": "credential_invalid",
        "phase": "worker_advance",
        "observed_at": 1,
        "generation": invalid["generation"]
    });
    raw.execute(
        "UPDATE durable_jobs SET document=?2 WHERE id=?1",
        rusqlite::params![parent.job_id, invalid.to_string()],
    )
    .unwrap();
    assert!(
        call(
            &owner,
            UserOperation::Get {
                job_id: parent.job_id.clone(),
            },
        )
        .is_err()
    );
    assert!(enqueue_start(&owner, "observed-spoolman-live-child", &parent.job_id).is_err());
    raw.execute(
        "UPDATE durable_jobs SET document=?2 WHERE id=?1",
        rusqlite::params![parent.job_id, original],
    )
    .unwrap();
    assert_eq!(
        get(&owner, &parent.job_id).state,
        PersistentState::UploadedOnly
    );
    assert!(enqueue_start(&owner, "observed-spoolman-live-valid", &parent.job_id).is_ok());
    owner.shutdown().unwrap();

    let (path, owner) = fixture();
    let parent = uploaded_only_spoolman_parent(
        &owner,
        "observed-spoolman-archive",
        "observed-spoolman-archive-printer",
    );
    uploaded_only_parent(
        &owner,
        "observed-spoolman-archive-newer",
        "observed-spoolman-archive-newer-printer",
    );
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    let original: String = raw
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut invalid: serde_json::Value = serde_json::from_str(&original).unwrap();
    invalid["effects"][1]["confirmed"] = false.into();
    invalid["_authority_refusal"] = serde_json::json!({
        "version": 1,
        "reason": "credential_invalid",
        "phase": "worker_advance",
        "observed_at": 1,
        "generation": invalid["generation"]
    });
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
        rusqlite::params![parent.job_id, invalid.to_string()],
    )
    .unwrap();
    assert!(enqueue_start(&owner, "observed-spoolman-archive-child", &parent.job_id).is_err());
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
        rusqlite::params![parent.job_id, original],
    )
    .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "observed-spoolman-archive-valid", &parent.job_id).is_ok());
    owner.shutdown().unwrap();
}

#[test]
fn duplicate_confirmed_upload_parent_fails_read_bind_and_restart_without_writes() {
    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "duplicate-upload-parent", "duplicate-printer");
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_insert(document,'$.effects[#]',json_extract(document,'$.effects[0]')) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    let before: (String, i64, i64, i64) = raw
        .query_row(
            "SELECT document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    drop(raw);
    assert!(
        call(
            &owner,
            UserOperation::Get {
                job_id: parent.job_id.clone(),
            },
        )
        .is_err()
    );
    assert!(enqueue_start(&owner, "duplicate-upload-child", &parent.job_id).is_err());
    let after: (String, i64, i64, i64) = readonly(&path)
        .query_row(
            "SELECT document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    owner.shutdown().unwrap();
    assert!(WriterOwner::open(&path, Limits::default()).is_err());
}
#[test]
fn uploaded_only_persisted_proof_rejects_independent_corruptions() {
    let (path, owner) = fixture();
    let parent = denied_start_parent(
        &owner,
        "proof-corruption-parent",
        "proof-corruption-printer",
        400,
    );
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    let original: String = raw
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&parent.job_id],
            |row| row.get(0),
        )
        .unwrap();
    for case in 0..4 {
        let mut document: serde_json::Value = serde_json::from_str(&original).unwrap();
        match case {
            0 => {
                let denied_start = document["effects"][1].clone();
                document["effects"]
                    .as_array_mut()
                    .unwrap()
                    .push(denied_start);
            }
            1 => document["payload"]["payload"]["printer_id"] = "other-printer".into(),
            2 => document["effects"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "intent": {
                        "operation": "spoolman_deduction",
                        "basis_hash": "c".repeat(64),
                        "content_hash": "d".repeat(64),
                        "target": "spoolman:unresolved"
                    },
                    "attempt": 1,
                    "generation": 1,
                    "confirmed": false,
                    "receipt": null
                })),
            3 => document["payload"]["payload"]["start"] = false.into(),
            _ => unreachable!(),
        }
        raw.execute(
            "UPDATE durable_jobs SET document=?2 WHERE id=?1",
            rusqlite::params![parent.job_id, document.to_string()],
        )
        .unwrap();
        assert!(
            call(
                &owner,
                UserOperation::Get {
                    job_id: parent.job_id.clone(),
                },
            )
            .is_err(),
            "proof corruption {case}"
        );
        assert!(
            enqueue_start(
                &owner,
                &format!("proof-corruption-child-{case}"),
                &parent.job_id,
            )
            .is_err(),
            "proof binding {case}"
        );
    }
    raw.execute(
        "UPDATE durable_jobs SET document=?2 WHERE id=?1",
        rusqlite::params![parent.job_id, original],
    )
    .unwrap();
    drop(raw);
    assert_eq!(
        get(&owner, &parent.job_id).state,
        PersistentState::UploadedOnly
    );
    owner.shutdown().unwrap();
}
#[test]
fn non_uploaded_confirmed_receipt_mismatch_fails_get() {
    let (path, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    let mut no_start = printer("receipt-mismatch-printer");
    let Payload::PrinterUpload { start, .. } = &mut no_start else {
        unreachable!()
    };
    *start = false;
    let queued = enqueue(&owner, "receipt-mismatch", no_start);
    let ClaimedAttempt {
        job: claimed,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, queued.job_id);
    let upload = distinct_intent(
        EffectOperation::PrinterUpload,
        "receipt-mismatch-printer",
        500,
    );
    let upload_receipt = begin_and_confirm(&worker, &mut lease, upload, "receipt-mismatch");
    let succeeded = worker
        .update(&mut lease, WorkerOperation::Finish(Some(upload_receipt)))
        .unwrap();
    assert_eq!(succeeded.state, PersistentState::Succeeded);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.effects[0].receipt.content_hash',?2) WHERE id=?1",
        rusqlite::params![succeeded.job_id, "f".repeat(64)],
    )
    .unwrap();
    drop(raw);
    assert!(
        call(
            &owner,
            UserOperation::Get {
                job_id: succeeded.job_id,
            },
        )
        .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn denied_effect_on_running_fails_get() {
    let (path, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();

    let denied = enqueue(&owner, "running-denied", printer("running-denied-printer"));
    let ClaimedAttempt {
        job: claimed,
        mut lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert_eq!(claimed.job_id, denied.job_id);
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(distinct_intent(
                EffectOperation::PrinterUploadAndStart,
                "running-denied-printer",
                501,
            )),
        )
        .unwrap();
    let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    let failed = job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap());
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.state','running') WHERE id=?1",
        [&failed.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(
        call(
            &owner,
            UserOperation::Get {
                job_id: failed.job_id,
            },
        )
        .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn live_child_binding_corruption_fails_get() {
    let (path, owner) = fixture();

    let parent = uploaded_only_parent(&owner, "live-binding-parent", "live-binding-printer");
    let child = job(enqueue_start(&owner, "live-binding-child", &parent.job_id).unwrap());
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET document=json_set(document,'$.payload.payload.binding.upload_effect.no_effect',json('true')) WHERE id=?1",
        [&child.job_id],
    )
    .unwrap();
    drop(raw);
    assert!(
        call(
            &owner,
            UserOperation::Get {
                job_id: child.job_id,
            },
        )
        .is_err()
    );
    owner.shutdown().unwrap();
}
#[test]
fn archived_parent_tenant_and_child_binding_corruptions_fail_without_writes() {
    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "archive-tenant-parent", "archive-tenant-printer");
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
        [&parent.job_id],
    )
    .unwrap();
    drop(raw);
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.tenant','other-tenant') WHERE job_id=?1",
        [&parent.job_id],
    )
    .unwrap();
    let before: (String, i64, i64, i64) = raw
        .query_row(
            "SELECT archived_document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_job_keys WHERE job_id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "archive-tenant-child", &parent.job_id).is_err());
    let after: (String, i64, i64, i64) = readonly(&path)
        .query_row(
            "SELECT archived_document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_job_keys WHERE job_id=?1",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    owner.shutdown().unwrap();

    let (path, owner) = fixture();
    let parent = uploaded_only_parent(&owner, "archive-binding-parent", "archive-binding-printer");
    let child = job(enqueue_start(&owner, "archive-binding-child", &parent.job_id).unwrap());
    call(
        &owner,
        UserOperation::Cancel {
            job_id: child.job_id.clone(),
        },
    )
    .unwrap();
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800)",
        [],
    )
    .unwrap();
    drop(raw);
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 2);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    let valid_document: String = raw
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&child.job_id],
            |row| row.get(0),
        )
        .unwrap();
    drop(raw);
    assert_eq!(
        job(enqueue_start(&owner, "archive-binding-child", &parent.job_id).unwrap()).job_id,
        child.job_id
    );
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.payload.payload.binding.upload_effect.no_effect',json('true')) WHERE job_id=?1",
        [&child.job_id],
    )
    .unwrap();
    let before: (String, i64, i64, i64) = raw
        .query_row(
            "SELECT archived_document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_job_keys WHERE job_id=?1",
            [&child.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    drop(raw);
    assert!(enqueue_start(&owner, "archive-binding-child", &parent.job_id).is_err());
    let after: (String, i64, i64, i64) = readonly(&path)
        .query_row(
            "SELECT archived_document,(SELECT COUNT(*) FROM durable_jobs),(SELECT COUNT(*) FROM durable_job_history),(SELECT COUNT(*) FROM durable_job_keys) FROM durable_job_keys WHERE job_id=?1",
            [&child.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(after, before);
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute(
        "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
        rusqlite::params![child.job_id, valid_document],
    )
    .unwrap();
    drop(raw);
    assert_eq!(
        job(enqueue_start(&owner, "archive-binding-child", &parent.job_id).unwrap()).job_id,
        child.job_id
    );
    owner.shutdown().unwrap();
}
#[test]
fn reachable_printer_reconciliation_truth_table_has_no_stranded_shape() {
    fn sequences(
        prefix: &mut Vec<EffectOperation>,
        remaining: &mut Vec<EffectOperation>,
        result: &mut Vec<Vec<EffectOperation>>,
    ) {
        if !prefix.is_empty() {
            result.push(prefix.clone());
        }
        for index in 0..remaining.len() {
            let operation = remaining.remove(index);
            prefix.push(operation);
            sequences(prefix, remaining, result);
            prefix.pop();
            remaining.insert(index, operation);
        }
    }
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    let mut operation_sequences = Vec::new();
    sequences(
        &mut Vec::new(),
        &mut vec![
            EffectOperation::SpoolmanDeduction,
            EffectOperation::PrinterUpload,
            EffectOperation::PrinterStart,
            EffectOperation::PrinterUploadAndStart,
        ],
        &mut operation_sequences,
    );
    let mut reachable = 0;
    let mut saw_spoolman_only = [false; 2];
    let mut saw_spoolman_first_upload = false;
    for start in [false, true] {
        for last_confirmed in [false, true] {
            for (case, operations) in operation_sequences.iter().enumerate() {
                let printer_id =
                    format!("truth-printer-{}-{last_confirmed}-{case}", u8::from(start));
                let mut payload = printer(&printer_id);
                let Payload::PrinterUpload {
                    start: payload_start,
                    ..
                } = &mut payload
                else {
                    unreachable!()
                };
                *payload_start = start;
                enqueue(
                    &owner,
                    &format!("truth-{}-{last_confirmed}-{case}", u8::from(start)),
                    payload,
                );
                let ClaimedAttempt {
                    job: _,
                    mut lease,
                    source_work,
                } = worker.claim().unwrap().unwrap();
                assert!(source_work.is_none());
                let mut last_receipt = None;
                let mut valid = true;
                for (index, operation) in operations.iter().copied().enumerate() {
                    let target = if operation == EffectOperation::SpoolmanDeduction {
                        format!("spoolman:truth:{case}:{index}")
                    } else {
                        printer_id.clone()
                    };
                    let effect_intent = distinct_intent(
                        operation,
                        &target,
                        1_000_000
                            + (u64::from(start) * 100_000)
                            + (u64::from(last_confirmed) * 50_000)
                            + (case as u64 * 100)
                            + index as u64,
                    );
                    let effect_receipt =
                        distinct_receipt(&effect_intent, &format!("truth-receipt-{case}-{index}"));
                    if worker
                        .update(&mut lease, WorkerOperation::BeginEffect(effect_intent))
                        .is_err()
                    {
                        valid = false;
                        break;
                    }
                    if index + 1 < operations.len() || last_confirmed {
                        worker
                            .update(
                                &mut lease,
                                WorkerOperation::ConfirmEffect(effect_receipt.clone()),
                            )
                            .unwrap();
                    }
                    last_receipt = Some(effect_receipt);
                }
                if !valid {
                    worker.update(&mut lease, WorkerOperation::Fail).unwrap();
                    continue;
                }
                reachable += 1;
                let uncertain = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
                let succeeded =
                    reconcile(&owner, &uncertain, Decision::ConfirmSucceeded, last_receipt);
                let terminal = match succeeded {
                    Ok(outcome) => job(outcome),
                    Err(_) => {
                        job(reconcile(&owner, &uncertain, Decision::ConfirmNoEffect, None).unwrap())
                    }
                };
                assert!(terminal.state.terminal());
                let confirmed = |operation| {
                    terminal.effects.iter().any(|effect| {
                        effect.intent.operation == operation
                            && effect.confirmed
                            && !effect.no_effect
                    })
                };
                let unresolved = |operation| {
                    terminal.effects.iter().any(|effect| {
                        effect.intent.operation == operation
                            && !effect.confirmed
                            && !effect.no_effect
                    })
                };
                let confirmed_upload = terminal
                    .effects
                    .iter()
                    .filter(|effect| {
                        effect.intent.operation == EffectOperation::PrinterUpload
                            && effect.confirmed
                            && !effect.no_effect
                    })
                    .count()
                    == 1;
                let start_proven = confirmed(EffectOperation::PrinterStart)
                    || confirmed(EffectOperation::PrinterUploadAndStart);
                let ordinary_success = start_proven || (!start && confirmed_upload);
                let uploaded_only = start
                    && confirmed_upload
                    && !start_proven
                    && !unresolved(EffectOperation::PrinterStart)
                    && !unresolved(EffectOperation::PrinterUploadAndStart)
                    && !terminal.effects.iter().any(|effect| {
                        effect.intent.operation == EffectOperation::PrinterUploadAndStart
                    });
                assert!(!(ordinary_success && uploaded_only));
                assert_eq!(
                    terminal.state,
                    if ordinary_success {
                        PersistentState::Succeeded
                    } else if uploaded_only {
                        PersistentState::UploadedOnly
                    } else {
                        PersistentState::Failed
                    }
                );
                if operations == &[EffectOperation::SpoolmanDeduction] {
                    saw_spoolman_only[usize::from(start)] = true;
                    assert_eq!(terminal.state, PersistentState::Failed);
                }
                if operations.first() == Some(&EffectOperation::SpoolmanDeduction)
                    && operations.contains(&EffectOperation::PrinterUpload)
                {
                    saw_spoolman_first_upload = true;
                }
            }
        }
    }
    assert_eq!(reachable, 30);
    assert_eq!(saw_spoolman_only, [true, true]);
    assert!(saw_spoolman_first_upload);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_global_and_per_tenant_history_limits() {
    let (_, owner) = fixture();
    let (_, a) = register(&owner, "history-a@example.com");
    let (_, b) = register(&owner, "history-b@example.com");
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    for token in [&a, &b] {
        for index in 0..3 {
            session_call(
                &owner,
                policy(),
                token,
                UserOperation::Enqueue {
                    key: format!("history-{index}"),
                    payload_version: 1,
                    payload: Payload::CheckSourceUpdates {},
                },
            )
            .unwrap();
            let mut lease = worker.claim().unwrap().unwrap().lease;
            worker
                .update(&mut lease, WorkerOperation::Finish(None))
                .unwrap();
        }
    }
    assert_eq!(owner.retain_jobs(2, 3).unwrap(), 3);
    let mut total = 0;
    for token in [&a, &b] {
        match session_call(
            &owner,
            policy(),
            token,
            UserOperation::List(JobListQuery::default()),
        )
        .unwrap()
        {
            Outcome::List(records) => {
                assert!(records.len() <= 2);
                total += records.len();
            }
            _ => panic!("history list"),
        }
    }
    assert_eq!(total, 3);
    owner.shutdown().unwrap();
}
#[test]
fn ticket_t_28_recovery_old_completed_history_expires_but_uncertainty_survives() {
    let (path, owner) = fixture();
    let done = enqueue(&owner, "old-done", Payload::CheckSourceUpdates {});
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    let pending = enqueue(&owner, "old-uncertain", printer("p"));
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "p")),
        )
        .unwrap();
    worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    owner.shutdown().unwrap();
    let raw = Connection::open(path.join("print-partner.db")).unwrap();
    raw.execute_batch("UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800);").unwrap();
    drop(raw);
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    match call(&owner, UserOperation::List(JobListQuery::default())).unwrap() {
        Outcome::List(records) => {
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].job_id, pending.job_id);
        }
        _ => panic!("list"),
    };
    assert_eq!(
        enqueue(&owner, "old-done", Payload::CheckSourceUpdates {}).job_id,
        done.job_id
    );
    owner.shutdown().unwrap();
}

fn source(catalog: &pp_storage::catalog::SourceCatalogClient, name: &str) -> i64 {
    use pp_storage::catalog::{CreateSource, Outcome, Request};
    match catalog
        .execute(Request::Create {
            source: CreateSource {
                name: name.into(),
                ..Default::default()
            },
        })
        .unwrap()
    {
        Outcome::Source(Some(source)) => source.id,
        _ => panic!("Source required"),
    }
}

#[test]
fn rich_completed_result_survives_read_list_and_orderly_reopen() {
    let (path, owner) = fixture();
    let project_id = source(&owner.local_source_catalog(), "Rich result source") as u64;
    let queued = enqueue(
        &owner,
        "rich-completed-result",
        Payload::ExtractSourceDocs { project_id },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let ClaimedAttempt {
        mut lease,
        source_work,
        ..
    } = worker.claim().unwrap().unwrap();
    let mut source_work = source_work.expect("Source work lease required");
    source_work.release().unwrap();
    let expected = CompletedResult::SourceDocuments(SourceDocumentsResult {
        project_id,
        extracted: 1,
        errors: vec!["x".repeat(160 * 1024)],
    });
    worker
        .update(
            &mut lease,
            WorkerOperation::FinishPublic {
                artifact: None,
                result: Box::new(expected.clone()),
            },
        )
        .unwrap();

    assert_eq!(
        get(&owner, &queued.job_id).public_result,
        Some(expected.clone())
    );
    let Outcome::PublicList(listed) =
        call(&owner, UserOperation::ListRetained(Default::default())).unwrap()
    else {
        panic!("retained jobs expected")
    };
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].job_id, queued.job_id);
    assert_eq!(listed[0].result, Some(expected.clone()));
    owner.shutdown().unwrap();

    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    assert_eq!(
        get(&owner, &queued.job_id).public_result,
        Some(expected.clone())
    );
    let Outcome::PublicList(listed) =
        call(&owner, UserOperation::ListRetained(Default::default())).unwrap()
    else {
        panic!("retained jobs expected")
    };
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].job_id, queued.job_id);
    assert_eq!(listed[0].result, Some(expected));
    owner.shutdown().unwrap();
}

#[test]
fn checklist_generic_effect_and_success_operations_refuse_without_mutation() {
    let (path, owner) = fixture();
    let queued = enqueue(
        &owner,
        "checklist-generic-refusal",
        Payload::ExportChecklistHtml { profile_id: 7 },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    let running = get(&owner, &queued.job_id);
    let running_history = history(&owner, &queued.job_id);

    let begin = worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(
                EffectOperation::LocalArtifact,
                "checklists/7/result.html",
            )),
        )
        .unwrap_err();
    assert!(begin.to_string().contains("owning admission"));
    let finish = worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap_err();
    assert!(finish.to_string().contains("owning finalizer"));
    let finish_public = worker
        .update(
            &mut lease,
            WorkerOperation::FinishPublic {
                artifact: None,
                result: Box::new(CompletedResult::ChecklistHtml(ChecklistHtmlResult {
                    path: "checklists/7/result.html".into(),
                    download_url: None,
                    part_count: 0,
                    thumb_count: 0,
                    plan_version: None,
                    revision_id: None,
                })),
            },
        )
        .unwrap_err();
    assert!(finish_public.to_string().contains("owning finalizer"));
    let confirm = call(
        &owner,
        UserOperation::Reconcile {
            job_id: queued.job_id.clone(),
            expected_version: running.state_version,
            expected_generation: running.generation,
            effect_hash: "b".repeat(64),
            decision: Decision::ConfirmSucceeded,
            receipt: Some(receipt("checklists/7/result.html")),
        },
    )
    .err()
    .expect("checklist reconciliation should refuse without owning reconciler");
    assert!(confirm.to_string().contains("owning reconciler"));
    let after_refusals = get(&owner, &queued.job_id);
    assert_eq!(after_refusals.state, running.state);
    assert_eq!(after_refusals.state_version, running.state_version);
    assert_eq!(after_refusals.effects, running.effects);
    assert_eq!(after_refusals.result, running.result);
    assert_eq!(after_refusals.public_result, running.public_result);
    assert_eq!(
        serde_json::to_value(history(&owner, &queued.job_id)).unwrap(),
        serde_json::to_value(&running_history).unwrap()
    );
    owner.shutdown().unwrap();

    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let reopened = get(&owner, &queued.job_id);
    assert_eq!(reopened.state, PersistentState::Queued);
    assert_eq!(reopened.state_version, running.state_version + 1);
    assert_eq!(reopened.generation, running.generation + 1);
    assert_eq!(reopened.effects, running.effects);
    assert_eq!(reopened.result, running.result);
    assert_eq!(reopened.public_result, running.public_result);
    let reopened_history = history(&owner, &queued.job_id);
    assert_eq!(reopened_history.len(), running_history.len() + 1);
    assert_eq!(reopened_history[0].event, "attempt_recovered");
    assert_eq!(reopened_history[0].version, reopened.state_version);
    assert_eq!(
        serde_json::to_value(&reopened_history[1..]).unwrap(),
        serde_json::to_value(&running_history).unwrap()
    );
    owner.shutdown().unwrap();
}

#[test]
fn checklist_legacy_claimless_reconciliation_refuses_without_mutation() {
    let (path, owner) = fixture();
    let (_, token) = register(&owner, "legacy-checklist@example.com");
    let queued = job(
        session_call(
            &owner,
            policy(),
            &token,
            UserOperation::Enqueue {
                key: "legacy-checklist-reconciliation".into(),
                payload_version: 1,
                payload: Payload::ExportChecklistHtml { profile_id: 7 },
            },
        )
        .unwrap(),
    );
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let claimed = worker.claim().unwrap().unwrap().job;
    assert_eq!(claimed.job_id, queued.job_id);
    owner.shutdown().unwrap();

    let mut raw = Connection::open(path.join("print-partner.db")).unwrap();
    let stored: String = raw
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&queued.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: serde_json::Value = serde_json::from_str(&stored).unwrap();
    let state_version = document["state_version"].as_i64().unwrap() + 1;
    let updated_at = document["updated_at"].as_i64().unwrap() + 1;
    let generation = document["generation"].as_i64().unwrap();
    let attempt = document["attempt"].as_i64().unwrap();
    document["state"] = "reconciliation_required".into();
    document["state_version"] = state_version.into();
    document["updated_at"] = updated_at.into();
    document["lease_until"] = serde_json::Value::Null;
    document["recovery"] = "Legacy claimless effect requires inspection".into();
    document["_attempt_worker"] = serde_json::Value::Null;
    document["_attempt_fence"] = serde_json::Value::Null;
    document["effects"] = serde_json::json!([{
        "intent": {
            "operation": "local_artifact",
            "basis_hash": "a".repeat(64),
            "content_hash": "b".repeat(64),
            "target": "checklists/7/legacy.html"
        },
        "attempt": attempt,
        "generation": generation,
        "confirmed": false,
        "receipt": null
    }]);
    assert!(document["effects"][0].get("checklist_completion").is_none());
    let tx = raw.transaction().unwrap();
    tx.execute(
        "UPDATE durable_jobs SET state='reconciliation_required',version=?2,lease_until=NULL,updated=?3,document=?4 WHERE id=?1",
        rusqlite::params![queued.job_id, state_version, updated_at, document.to_string()],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO durable_job_history(job_id,version,at,state,event) VALUES(?1,?2,?3,'reconciliation_required','legacy_effect_retained')",
        rusqlite::params![queued.job_id, state_version, updated_at],
    )
    .unwrap();
    tx.commit().unwrap();
    drop(raw);

    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let before = job(
        session_call(
            &owner,
            policy(),
            &token,
            UserOperation::Get {
                job_id: queued.job_id.clone(),
            },
        )
        .unwrap(),
    );
    assert_eq!(before.state, PersistentState::ReconciliationRequired);
    assert_eq!(before.effects.len(), 1);
    let before_history = history(&owner, &queued.job_id);
    let error = session_call(
        &owner,
        policy(),
        &token,
        UserOperation::Reconcile {
            job_id: queued.job_id.clone(),
            expected_version: before.state_version,
            expected_generation: before.generation,
            effect_hash: before.effects[0].intent.content_hash.clone(),
            decision: Decision::ConfirmSucceeded,
            receipt: Some(ResultArtifact {
                receipt_id: "legacy-receipt".into(),
                content_hash: before.effects[0].intent.content_hash.clone(),
                target: before.effects[0].intent.target.clone(),
            }),
        },
    )
    .err()
    .expect("legacy checklist reconciliation should refuse without owning reconciler");
    assert!(error.to_string().contains("owning reconciler"));
    let after = job(
        session_call(
            &owner,
            policy(),
            &token,
            UserOperation::Get {
                job_id: queued.job_id.clone(),
            },
        )
        .unwrap(),
    );
    assert_eq!(after.state, before.state);
    assert_eq!(after.state_version, before.state_version);
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.effects, before.effects);
    assert_eq!(after.result, before.result);
    assert_eq!(after.public_result, before.public_result);
    assert_eq!(after.recovery, before.recovery);
    assert_eq!(
        serde_json::to_value(history(&owner, &queued.job_id)).unwrap(),
        serde_json::to_value(before_history).unwrap()
    );
    owner.shutdown().unwrap();
}
fn deletion(
    catalog: &pp_storage::catalog::SourceCatalogClient,
    id: i64,
) -> pp_storage::catalog::Deletion {
    match catalog
        .execute(pp_storage::catalog::Request::Delete { id })
        .unwrap()
    {
        pp_storage::catalog::Outcome::Deletion(value) => value,
        _ => panic!("Deletion required"),
    }
}
fn source_lease(
    worker: &ServerWorkerClient,
    lease: &AttemptLease,
    id: Option<i64>,
) -> Result<pp_storage::catalog::SourceWorkLease> {
    worker.begin_source_work(lease, id, &AtomicBool::new(false), Duration::from_secs(5))
}
#[test]
fn integration_source_id_reservations_and_live_lease_have_distinct_lifetimes() {
    use pp_storage::catalog::Deletion;
    let (_, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let id = source(&catalog, "Individual");
    let other = source(&catalog, "Other");
    let first = enqueue(
        &owner,
        "individual",
        Payload::ImportScan {
            project_id: id as u64,
        },
    );
    let second = enqueue(
        &owner,
        "same-source",
        Payload::ExtractSourceDocs {
            project_id: id as u64,
        },
    );
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    assert_eq!(
        deletion(&catalog, other),
        Deletion::Deleted { source_id: other }
    );
    let worker = owner.job_worker(admission()).unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    assert_eq!(claim.job.job_id, first.job_id);
    let mut live = claim.source_work.take().unwrap();
    let mut lease = claim.lease;
    assert!(source_lease(&worker, &lease, Some(id)).is_err());
    let duplicate = match source_lease(&worker, &lease, None) {
        Err(error) => error,
        Ok(_) => panic!("duplicate Source lease accepted"),
    };
    assert!(
        duplicate
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );
    let stale = lease.clone();
    worker
        .update(&mut lease, WorkerOperation::Heartbeat)
        .unwrap();
    assert!(source_lease(&worker, &stale, None).is_err());
    worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    assert!(source_lease(&worker, &lease, None).is_err());
    call(
        &owner,
        UserOperation::Cancel {
            job_id: second.job_id,
        },
    )
    .unwrap();
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    live.release().unwrap();
    assert_eq!(deletion(&catalog, id), Deletion::Deleted { source_id: id });
    owner.shutdown().unwrap();
}
#[test]
fn integration_drop_and_orderly_restart_keep_source_reservations() {
    use pp_storage::catalog::Deletion;
    let (path, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let id = source(&catalog, "Restart");
    let queued = enqueue(
        &owner,
        "restart-source",
        Payload::ImportScan {
            project_id: id as u64,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    let old = claim.lease;
    drop(claim.source_work.take().unwrap());
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let catalog = owner.local_source_catalog();
    assert_eq!(get(&owner, &queued.job_id).state, PersistentState::Queued);
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    let worker = owner.job_worker(admission()).unwrap();
    assert!(source_lease(&worker, &old, None).is_err());
    let mut claim = worker.claim().unwrap().unwrap();
    let _current = claim.lease;
    let mut live = claim.source_work.take().unwrap();
    live.release().unwrap();
    call(
        &owner,
        UserOperation::Cancel {
            job_id: queued.job_id,
        },
    )
    .unwrap();
    assert_eq!(deletion(&catalog, id), Deletion::Deleted { source_id: id });
    owner.shutdown().unwrap();
}
#[test]
fn integration_wildcard_uncertainty_and_abandon_guard_until_matching_resolution() {
    use pp_storage::catalog::Deletion;
    for payload in [
        Payload::Sync { project_ids: None },
        Payload::CheckSourceUpdates {},
    ] {
        let (path, owner) = fixture();
        let catalog = owner.local_source_catalog();
        let id = source(&catalog, "Wildcard");
        let another = source(&catalog, "Wildcard other");
        let queued = enqueue(&owner, "wildcard", payload);
        assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
        let worker = owner.job_worker(admission()).unwrap();
        let mut lease = worker.claim().unwrap().unwrap().lease;
        assert!(source_lease(&worker, &lease, None).is_err());
        let mut live = source_lease(&worker, &lease, Some(id)).unwrap();
        live.release().unwrap();
        worker
            .update(
                &mut lease,
                WorkerOperation::BeginEffect(intent(
                    EffectOperation::SourceRefresh,
                    "source-operation",
                )),
            )
            .unwrap();
        assert_eq!(deletion(&catalog, another), Deletion::ActiveWork);
        owner.shutdown().unwrap();
        let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
        let catalog = owner.local_source_catalog();
        let recovered = get(&owner, &queued.job_id);
        assert_eq!(recovered.state, PersistentState::ReconciliationRequired);
        assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
        let decide = |record: &JobRecord, hash: &str, decision| UserOperation::Reconcile {
            job_id: record.job_id.clone(),
            expected_version: record.state_version,
            expected_generation: record.generation,
            effect_hash: hash.into(),
            decision,
            receipt: None,
        };
        assert!(
            call(
                &owner,
                decide(&recovered, &"c".repeat(64), Decision::ConfirmNoEffect)
            )
            .is_err()
        );
        let abandoned = job(call(
            &owner,
            decide(&recovered, &"b".repeat(64), Decision::Abandon),
        )
        .unwrap());
        assert_eq!(deletion(&catalog, another), Deletion::ActiveWork);
        let additional = enqueue(
            &owner,
            "second-reservation",
            Payload::ImportScan {
                project_id: id as u64,
            },
        );
        call(
            &owner,
            decide(&abandoned, &"b".repeat(64), Decision::ConfirmNoEffect),
        )
        .unwrap();
        assert_eq!(
            deletion(&catalog, another),
            Deletion::Deleted { source_id: another }
        );
        assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
        call(
            &owner,
            UserOperation::Cancel {
                job_id: additional.job_id,
            },
        )
        .unwrap();
        assert_eq!(deletion(&catalog, id), Deletion::Deleted { source_id: id });
        owner.shutdown().unwrap();
    }
}
#[test]
fn integration_source_bridge_rejects_foreign_worker_missing_source_and_non_source_attempt() {
    let (_, owner) = fixture();
    let worker = owner.job_worker(admission()).unwrap();
    let foreign = owner.job_worker(admission()).unwrap();
    let missing = enqueue(&owner, "missing", Payload::ImportScan { project_id: 9876 });
    assert!(worker.claim().unwrap().is_none());
    let missing = get(&owner, &missing.job_id);
    assert_eq!(missing.state, PersistentState::Failed);
    assert_eq!(missing.attempt, 0);
    assert_eq!(missing.generation, 0);
    enqueue(&owner, "printer", printer("ordinary-fixture"));
    let lease = worker.claim().unwrap().unwrap().lease;
    assert!(source_lease(&worker, &lease, Some(1)).is_err());
    assert!(source_lease(&foreign, &lease, Some(1)).is_err());
    owner.shutdown().unwrap();
}
#[test]
fn integration_wildcard_lookup_and_reservations_are_tenant_owned() {
    use pp_storage::catalog::{Credentials, Deletion};
    let (_, owner) = fixture();
    let (_, token) = register(&owner, "source-tenant@example.test");
    let tenant_catalog = owner.source_catalog(Credentials::Session(Secret::new(token.clone())));
    let tenant_id = source(&tenant_catalog, "Tenant source");
    let local_catalog = owner.local_source_catalog();
    let local_id = source(&local_catalog, "Local source");
    let queued = job(session_call(
        &owner,
        policy(),
        &token,
        UserOperation::Enqueue {
            key: "tenant-wildcard".into(),
            payload_version: 1,
            payload: Payload::CheckSourceUpdates {},
        },
    )
    .unwrap());
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        job: _,
        lease,
        source_work,
    } = worker.claim().unwrap().unwrap();
    assert!(source_work.is_none());
    assert!(source_lease(&worker, &lease, Some(local_id)).is_err());
    let mut live = source_lease(&worker, &lease, Some(tenant_id)).unwrap();
    assert_eq!(deletion(&tenant_catalog, tenant_id), Deletion::ActiveWork);
    assert_eq!(
        deletion(&local_catalog, local_id),
        Deletion::Deleted {
            source_id: local_id
        }
    );
    live.release().unwrap();
    session_call(
        &owner,
        policy(),
        &token,
        UserOperation::Cancel {
            job_id: queued.job_id,
        },
    )
    .unwrap();
    assert_eq!(
        deletion(&tenant_catalog, tenant_id),
        Deletion::Deleted {
            source_id: tenant_id
        }
    );
    owner.shutdown().unwrap();
}
#[test]
fn integration_source_bridge_expiry_and_cancelled_admission() {
    let (_, owner) = fixture();
    let id = source(&owner.local_source_catalog(), "Expiry");
    enqueue(
        &owner,
        "expiry",
        Payload::ExtractSourceDocs {
            project_id: id as u64,
        },
    );
    let mut config = admission();
    config.lease_seconds = 1;
    let worker = owner.job_worker(config).unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    let lease = claim.lease;
    let source_work = claim.source_work.take().unwrap();
    assert!(
        worker
            .begin_source_work(&lease, None, &AtomicBool::new(true), Duration::ZERO)
            .is_err()
    );
    std::thread::sleep(Duration::from_millis(1100));
    assert!(source_lease(&worker, &lease, None).is_err());
    assert!(worker.claim().unwrap().is_none());
    assert_eq!(
        deletion(&owner.local_source_catalog(), id),
        pp_storage::catalog::Deletion::ActiveWork
    );
    drop(source_work);
    owner.shutdown().unwrap();
}

#[test]
fn individual_source_claim_skips_busy_head_without_mutating_it() {
    let (_, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let busy_id = source(&catalog, "Busy head");
    let free_id = source(&catalog, "Free tail");
    let first = enqueue(
        &owner,
        "busy-owner",
        Payload::ImportScan {
            project_id: busy_id as u64,
        },
    );
    let mut config = admission();
    for (_, capacity) in &mut config.kinds {
        *capacity = 2;
    }
    let worker = owner.job_worker(config).unwrap();
    let mut active = worker.claim().unwrap().unwrap();
    assert_eq!(active.job.job_id, first.job_id);
    let waiting = enqueue(
        &owner,
        "busy-waiting",
        Payload::ImportScan {
            project_id: busy_id as u64,
        },
    );
    let free = enqueue(
        &owner,
        "free-tail",
        Payload::ImportScan {
            project_id: free_id as u64,
        },
    );
    call(
        &owner,
        UserOperation::Cancel {
            job_id: first.job_id,
        },
    )
    .unwrap();
    let before = get(&owner, &waiting.job_id);
    let mut other = worker.claim().unwrap().unwrap();
    assert_eq!(other.job.job_id, free.job_id);
    let after = get(&owner, &waiting.job_id);
    assert_eq!(after.state_version, before.state_version);
    assert_eq!(after.attempt, before.attempt);
    assert_eq!(after.generation, before.generation);
    worker
        .update(&mut other.lease, WorkerOperation::Finish(None))
        .unwrap();
    drop(other.source_work.take());
    drop(active.source_work.take());
    let next = worker.claim().unwrap().unwrap();
    assert_eq!(next.job.job_id, waiting.job_id);
    owner.shutdown().unwrap();
}

#[test]
fn expired_attempt_keeps_source_authority_until_drop() {
    let (_, owner) = fixture();
    let id = source(&owner.local_source_catalog(), "Expired overlap");
    let queued = enqueue(
        &owner,
        "expired-overlap",
        Payload::ExtractSourceDocs {
            project_id: id as u64,
        },
    );
    let mut config = admission();
    config.lease_seconds = 1;
    let worker = owner.job_worker(config).unwrap();
    let mut first = worker.claim().unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(1100));
    assert!(worker.claim().unwrap().is_none());
    let recovered = get(&owner, &queued.job_id);
    assert_eq!(recovered.state, PersistentState::Queued);
    assert_eq!(recovered.attempt, 1);
    assert!(worker.claim().unwrap().is_none());
    let unchanged = get(&owner, &queued.job_id);
    assert_eq!(unchanged.state_version, recovered.state_version);
    assert_eq!(unchanged.attempt, recovered.attempt);
    assert_eq!(unchanged.generation, recovered.generation);
    drop(first.source_work.take());
    let second = worker.claim().unwrap().unwrap();
    assert_eq!(second.job.job_id, queued.job_id);
    assert_eq!(second.job.attempt, 2);
    owner.shutdown().unwrap();
}

#[test]
fn duplicate_direct_and_wildcard_source_leases_are_typed_busy() {
    let (_, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let id = source(&catalog, "Typed busy");
    let direct = catalog
        .begin_work(id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    let duplicate = match catalog.begin_work(id, &AtomicBool::new(false), Duration::from_secs(5)) {
        Err(error) => error,
        Ok(_) => panic!("duplicate direct Source lease accepted"),
    };
    assert!(
        duplicate
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );
    let queued = enqueue(&owner, "wildcard-busy", Payload::CheckSourceUpdates {});
    let worker = owner.job_worker(admission()).unwrap();
    let wildcard = worker.claim().unwrap().unwrap();
    assert!(wildcard.source_work.is_none());
    let duplicate = match source_lease(&worker, &wildcard.lease, Some(id)) {
        Err(error) => error,
        Ok(_) => panic!("duplicate wildcard Source lease accepted"),
    };
    assert!(
        duplicate
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );
    assert_eq!(get(&owner, &queued.job_id).state, PersistentState::Running);
    drop(direct);
    let mut released = source_lease(&worker, &wildcard.lease, Some(id)).unwrap();
    released.release().unwrap();
    owner.shutdown().unwrap();
}

#[test]
fn abandoned_claim_reply_releases_source_authority() {
    let (_, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let id = source(&catalog, "Abandoned claim");
    let queued = enqueue(
        &owner,
        "abandoned-claim",
        Payload::ImportScan {
            project_id: id as u64,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    drop(
        worker
            .claim_pending(&AtomicBool::new(false), Duration::from_secs(5))
            .unwrap(),
    );
    catalog
        .execute(pp_storage::catalog::Request::Get { id })
        .unwrap();
    assert_eq!(get(&owner, &queued.job_id).state, PersistentState::Running);
    let mut lease = catalog
        .begin_work(id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    lease.release().unwrap();
    owner.shutdown().unwrap();
}

#[test]
fn missing_source_job_fails_without_starving_healthy_work() {
    let (_, owner) = fixture();
    let valid_id = source(&owner.local_source_catalog(), "Healthy tail");
    let invalid = enqueue(
        &owner,
        "missing-head",
        Payload::ImportScan { project_id: 9876 },
    );
    std::thread::sleep(Duration::from_millis(1100));
    let valid = enqueue(
        &owner,
        "healthy-tail",
        Payload::ImportScan {
            project_id: valid_id as u64,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let claim = worker.claim().unwrap().unwrap();
    assert_eq!(claim.job.job_id, valid.job_id);
    let failed = get(&owner, &invalid.job_id);
    assert_eq!(failed.state, PersistentState::Failed);
    assert_eq!(failed.attempt, 0);
    assert_eq!(failed.generation, 0);
    assert_eq!(
        failed.recovery.as_deref(),
        Some("Source is unavailable for this job")
    );
    let history = match call(
        &owner,
        UserOperation::History {
            job_id: invalid.job_id,
            before_version: None,
            limit: 10,
        },
    )
    .unwrap()
    {
        Outcome::History(history) => history,
        _ => panic!("job history required"),
    };
    assert!(
        history
            .iter()
            .any(|entry| entry.event == "source_unavailable")
    );
    assert!(worker.claim().unwrap().is_none());
    owner.shutdown().unwrap();
}

#[test]
fn foreign_source_job_fails_without_tenant_leak_or_starvation() {
    use pp_storage::catalog::Credentials;
    let (_, owner) = fixture();
    let (_, token) = register(&owner, "foreign-source@example.test");
    let tenant_catalog = owner.source_catalog(Credentials::Session(Secret::new(token)));
    let foreign_id = source(&tenant_catalog, "Foreign Source");
    let local_id = source(&owner.local_source_catalog(), "Local tail");
    let invalid = enqueue(
        &owner,
        "foreign-head",
        Payload::ExtractSourceDocs {
            project_id: foreign_id as u64,
        },
    );
    std::thread::sleep(Duration::from_millis(1100));
    let valid = enqueue(
        &owner,
        "local-tail",
        Payload::ExtractSourceDocs {
            project_id: local_id as u64,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let claim = worker.claim().unwrap().unwrap();
    assert_eq!(claim.job.job_id, valid.job_id);
    let failed = get(&owner, &invalid.job_id);
    assert_eq!(failed.state, PersistentState::Failed);
    assert_eq!(failed.attempt, 0);
    assert_eq!(failed.generation, 0);
    assert_eq!(
        failed.recovery.as_deref(),
        Some("Source is unavailable for this job")
    );
    let mut tenant_work = tenant_catalog
        .begin_work(foreign_id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    tenant_work.release().unwrap();
    owner.shutdown().unwrap();
}

#[test]
fn source_release_does_not_wait_for_database_writer_lock() {
    let (path, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let id = source(&catalog, "Release under database lock");
    let lease = catalog
        .begin_work(id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    let blocker = Connection::open(path.join("print-partner.db")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    drop(lease);
    std::thread::sleep(Duration::from_millis(6500));
    blocker.execute_batch("COMMIT").unwrap();
    let mut next = catalog
        .begin_work(id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    next.release().unwrap();
    owner.shutdown().unwrap();
}

#[test]
fn integration_individual_uncertain_reservation_survives_restart_and_matching_success() {
    use pp_storage::catalog::Deletion;
    let (path, owner) = fixture();
    let catalog = owner.local_source_catalog();
    let id = source(&catalog, "Individual uncertain");
    let other = source(&catalog, "Unreserved individual");
    let queued = enqueue(
        &owner,
        "individual-effect",
        Payload::ImportScan {
            project_id: id as u64,
        },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    let mut live = claim.source_work.take().unwrap();
    let mut lease = claim.lease;
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::SourceRefresh, "source-effect")),
        )
        .unwrap();
    live.release().unwrap();
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let catalog = owner.local_source_catalog();
    let uncertain = get(&owner, &queued.job_id);
    assert_eq!(uncertain.state, PersistentState::ReconciliationRequired);
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    assert_eq!(
        deletion(&catalog, other),
        Deletion::Deleted { source_id: other }
    );
    let resolve = |receipt| UserOperation::Reconcile {
        job_id: queued.job_id.clone(),
        expected_version: uncertain.state_version,
        expected_generation: uncertain.generation,
        effect_hash: "b".repeat(64),
        decision: Decision::ConfirmSucceeded,
        receipt: Some(receipt),
    };
    assert!(call(&owner, resolve(receipt("wrong-source-effect"))).is_err());
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    call(&owner, resolve(receipt("source-effect"))).unwrap();
    assert_eq!(deletion(&catalog, id), Deletion::Deleted { source_id: id });
    owner.shutdown().unwrap();
}
