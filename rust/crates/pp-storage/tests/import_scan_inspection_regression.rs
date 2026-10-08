use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy,
        Request as AuthRequest, Secret, SessionTenantPolicy,
    },
    catalog::{CreateSource, Credentials, Outcome as CatalogOutcome, Request as CatalogRequest},
    jobs::{
        ClaimedAttempt, Credential, JobKind, Outcome as JobOutcome, Payload, PersistentState,
        UserOperation, WorkerAdmission,
    },
    source_scan::{HeldLocalScanInspection, LocalCompletionInspection},
};
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
        kinds: vec![(JobKind::SuppliedSourceImport, 1), (JobKind::ImportScan, 1)],
        total: 1,
        per_resource: 1,
        lease_seconds: 60,
    }
}

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-import-scan-inspection-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn register(owner: &WriterOwner) -> String {
    let AuthOutcome::Session { token, .. } = owner
        .auth(FirstUserTenant::NewUser)
        .submit(
            AuthRequest::Register {
                email: "inspection@example.com".into(),
                display_name: "Inspection".into(),
                password: Secret::new("long-inspection-password".into()),
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

#[test]
fn observed_local_scan_inspection_is_not_committed() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let CatalogOutcome::Source(Some(source)) = owner
        .source_catalog_with_policy(Credentials::Session(Secret::new(token.clone())), policy())
        .unwrap()
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Inspection source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    let JobOutcome::Job(_, _) = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token)),
            UserOperation::Enqueue {
                key: "inspection-before-settlement".into(),
                payload_version: 1,
                payload: Payload::ImportScan {
                    project_id: source.id.try_into().unwrap(),
                },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("job expected")
    };
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        lease, source_work, ..
    } = worker.claim_kind(JobKind::ImportScan).unwrap().unwrap();
    let source_work = source_work.unwrap();
    worker.observe_local_scan(&lease, &source_work).unwrap();

    assert!(matches!(
        worker.inspect_local_scan_completion(&lease).unwrap(),
        LocalCompletionInspection::NotCommitted
    ));
}

#[test]
fn settled_scan_is_adopted_while_held_and_completed_inspection_is_durable() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let CatalogOutcome::Source(Some(source)) = owner
        .source_catalog_with_policy(Credentials::Session(Secret::new(token.clone())), policy())
        .unwrap()
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Held inspection source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    let JobOutcome::Job(_, _) = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token)),
            UserOperation::Enqueue {
                key: "held-inspection".into(),
                payload_version: 1,
                payload: Payload::ImportScan {
                    project_id: source.id.try_into().unwrap(),
                },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("job expected")
    };
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        mut lease,
        source_work,
        ..
    } = worker.claim_kind(JobKind::ImportScan).unwrap().unwrap();
    let mut source_work = source_work.unwrap();
    let observation = worker.observe_local_scan(&lease, &source_work).unwrap();
    worker
        .settle_local_scan(&mut lease, &source_work, observation.settlement(Vec::new()))
        .unwrap();
    assert!(matches!(
        worker.inspect_local_scan_completion(&lease).unwrap(),
        LocalCompletionInspection::NotCommitted
    ));
    let foreign = owner.job_worker_with_policy(policy(), admission()).unwrap();
    assert!(foreign.inspect_local_scan_completion(&lease).is_err());
    let HeldLocalScanInspection::Applied(_, applied) = worker
        .inspect_local_scan_while_held(&mut lease, &source_work)
        .unwrap()
    else {
        panic!("settlement should be adoptable")
    };
    let result = applied.local_source_scan_result().unwrap();
    assert!(matches!(
        worker
            .complete_local_scan(&mut lease, &mut source_work, applied, result)
            .unwrap(),
        LocalCompletionInspection::Completed(_)
    ));
    assert!(matches!(
        worker.inspect_local_scan_completion(&lease).unwrap(),
        LocalCompletionInspection::Completed(_)
    ));
}

#[test]
fn cancelled_settled_scan_records_job_and_journal_reconciliation() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let CatalogOutcome::Source(Some(source)) = owner
        .source_catalog_with_policy(Credentials::Session(Secret::new(token.clone())), policy())
        .unwrap()
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Cancelled settled source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    let JobOutcome::Job(job, _) = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
            UserOperation::Enqueue {
                key: "cancelled-settled".into(),
                payload_version: 1,
                payload: Payload::ImportScan {
                    project_id: source.id.try_into().unwrap(),
                },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("job expected")
    };
    let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
    let ClaimedAttempt {
        mut lease,
        source_work,
        ..
    } = worker.claim_kind(JobKind::ImportScan).unwrap().unwrap();
    let mut source_work = source_work.unwrap();
    let observation = worker.observe_local_scan(&lease, &source_work).unwrap();
    let applied = worker
        .settle_local_scan(&mut lease, &source_work, observation.settlement(Vec::new()))
        .unwrap();
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token)),
            UserOperation::Cancel {
                job_id: job.job_id.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    assert!(
        worker
            .complete_local_scan(
                &mut lease,
                &mut source_work,
                applied.clone(),
                applied.local_source_scan_result().unwrap(),
            )
            .is_err()
    );
    let reconciled = worker
        .record_local_scan_reconciliation(
            &lease,
            &mut source_work,
            applied,
            "cancelled after confirmed settlement".into(),
        )
        .unwrap();
    assert_eq!(reconciled.state, PersistentState::ReconciliationRequired);
    let database = rusqlite::Connection::open(root.join("print-partner.db")).unwrap();
    assert_eq!(
        database
            .query_row(
                "SELECT phase FROM source_scan_executions WHERE job_id=?1",
                [job.job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "reconciliation_required"
    );
}
