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
    assert_eq!(ready.version, 38);
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
fn readonly(path: &std::path::Path) -> Connection {
    Connection::open_with_flags(
        path.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
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
    let (_, mut lease) = claims.pop().unwrap();
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    enqueue(&owner, "source1", Payload::ImportScan { project_id: 1 });
    enqueue(
        &owner,
        "source1-docs",
        Payload::ExtractSourceDocs { project_id: 1 },
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
    let (_, mut old) = worker.claim().unwrap().unwrap();
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
        let (_, mut lease) = worker.claim().unwrap().unwrap();
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap();
    }
    let uncertain = enqueue(&owner, "uncertain", printer("p"));
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
        Payload::ExportChecklistHtml { profile_id: 1 },
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
        .filter(|kind| *kind != JobKind::SuppliedSourceImport)
        .collect::<Vec<_>>();
    assert_eq!(payloads.len(), existing.len());
    for (payload, kind) in payloads.into_iter().zip(existing) {
        assert_eq!(payload.kind(), kind);
        let (path, owner) = fixture();
        let queued = enqueue(&owner, "kind-coverage", payload);
        let worker = owner.job_worker(admission()).unwrap();
        let (_, mut lease) = worker.claim().unwrap().unwrap();
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
        Payload::ExportChecklistHtml { profile_id: 1 },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    let (first, mut old) = expired_worker.claim().unwrap().unwrap();
    thread::sleep(Duration::from_millis(1100));
    assert!(
        expired_worker
            .update(&mut old, WorkerOperation::Heartbeat)
            .is_err()
    );
    owner.shutdown().unwrap();

    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let current_worker = owner.job_worker(admission()).unwrap();
    let (next, mut current) = current_worker.claim().unwrap().unwrap();
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
        "UPDATE app_settings SET value='39' WHERE tenant_id='default' AND key='schema_version'",
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
        Payload::ExportChecklistHtml { profile_id: 1 },
    );
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    fixture.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; DROP TABLE durable_job_reconciliations; DROP TABLE durable_job_history; DROP TABLE durable_job_keys; DROP TABLE durable_jobs; UPDATE app_settings SET value='34' WHERE tenant_id='default' AND key='schema_version'; CREATE TRIGGER reject_schema35 BEFORE UPDATE ON app_settings WHEN NEW.key='schema_version' AND NEW.value='35' BEGIN SELECT RAISE(ABORT,'fixture migration constraint'); END;").unwrap();
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
    let (recovered, _) = worker.claim().unwrap().unwrap();
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
            let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
    worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    let pending = enqueue(&owner, "old-uncertain", printer("p"));
    let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    let (claimed, mut lease) = worker.claim().unwrap().unwrap();
    assert_eq!(claimed.job_id, first.job_id);
    assert!(source_lease(&worker, &lease, Some(id)).is_err());
    let mut live = source_lease(&worker, &lease, None).unwrap();
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
    let (_, old) = worker.claim().unwrap().unwrap();
    drop(source_lease(&worker, &old, None).unwrap());
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
    let catalog = owner.local_source_catalog();
    assert_eq!(get(&owner, &queued.job_id).state, PersistentState::Queued);
    assert_eq!(deletion(&catalog, id), Deletion::ActiveWork);
    let worker = owner.job_worker(admission()).unwrap();
    assert!(source_lease(&worker, &old, None).is_err());
    let (_, current) = worker.claim().unwrap().unwrap();
    let mut live = source_lease(&worker, &current, None).unwrap();
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
        let (_, mut lease) = worker.claim().unwrap().unwrap();
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
    let (_, lease) = worker.claim().unwrap().unwrap();
    assert!(source_lease(&worker, &lease, None).is_err());
    assert!(source_lease(&foreign, &lease, None).is_err());
    call(
        &owner,
        UserOperation::Cancel {
            job_id: missing.job_id,
        },
    )
    .unwrap();
    enqueue(&owner, "printer", printer("ordinary-fixture"));
    let (_, lease) = worker.claim().unwrap().unwrap();
    assert!(source_lease(&worker, &lease, Some(1)).is_err());
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
    let (_, lease) = worker.claim().unwrap().unwrap();
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
    let (_, lease) = worker.claim().unwrap().unwrap();
    assert!(
        worker
            .begin_source_work(&lease, None, &AtomicBool::new(true), Duration::ZERO)
            .is_err()
    );
    std::thread::sleep(Duration::from_millis(1100));
    assert!(source_lease(&worker, &lease, None).is_err());
    assert_eq!(
        deletion(&owner.local_source_catalog(), id),
        pp_storage::catalog::Deletion::ActiveWork
    );
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
    let (_, mut lease) = worker.claim().unwrap().unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::BeginEffect(intent(EffectOperation::SourceRefresh, "source-effect")),
        )
        .unwrap();
    let mut live = source_lease(&worker, &lease, None).unwrap();
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
