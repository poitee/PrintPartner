use super::*;
use crate::{Queue, ReaderPool, ReaderState, Shared, jobs};
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex},
};

#[test]
fn ticket_t_59_catalog_private_full_queue_retains_unreleased_work() {
    let (reply, _) = mpsc::channel();
    let shared = Arc::new(Shared {
        queue: Mutex::new(Queue {
            closed: false,
            pending: VecDeque::from([Envelope::Catalog {
                command: Command::End(999),
                reply,
            }]),
        }),
        changed: Condvar::new(),
        capacity: 1,
        orphaned_source_leases: Mutex::new(Vec::new()),
        job_admission: Mutex::new(None),
        import_epoch: std::sync::atomic::AtomicU64::new(0),
        import_quota: Mutex::new(None),
        job_subscriptions: crate::jobs::JobSubscriptions::new(),
    });
    let readers = Arc::new(ReaderPool {
        state: Mutex::new(ReaderState {
            closed: false,
            idle: vec![],
            active: 0,
        }),
        changed: Condvar::new(),
    });
    let client = SettingsClient {
        shared: shared.clone(),
        readers,
    };
    let lease = SourceWorkLease {
        client: client.clone(),
        proof: Some(SourceWorkProof {
            incarnation: "a".repeat(64),
            token: 17,
        }),
    };
    assert!(
        enqueue(
            &client,
            Command::End(17),
            &AtomicBool::new(false),
            Duration::ZERO
        )
        .is_err()
    );
    drop(lease);
    assert_eq!(
        shared.orphaned_source_leases.lock().unwrap().as_slice(),
        &[17]
    );
    let mut state = State {
        issued_high_water: 17,
        ..Default::default()
    };
    state.active.insert(
        17,
        SourceBinding {
            tenant: "default".into(),
            id: 1,
        },
    );
    let orphaned = std::mem::take(&mut *shared.orphaned_source_leases.lock().unwrap());
    state.reap(orphaned).unwrap();
    assert!(!state.active.contains_key(&17));
    let mut queue = shared.queue.lock().unwrap();
    assert_eq!(queue.pending.len(), 1);
    let Envelope::Catalog {
        command: Command::End(token),
        ..
    } = queue.pending.pop_front().unwrap()
    else {
        panic!("existing queued work must survive")
    };
    assert_eq!(token, 999);
    drop(queue);
    let lease = SourceWorkLease {
        client,
        proof: Some(SourceWorkProof {
            incarnation: "a".repeat(64),
            token: 17,
        }),
    };
    drop(lease);
    let Envelope::Catalog {
        command: Command::End(token),
        ..
    } = shared.queue.lock().unwrap().pending.pop_front().unwrap()
    else {
        panic!("release must be serialized")
    };
    assert_eq!(token, 17);
}

#[test]
fn issued_source_tokens_cover_full_u64_bounds_and_retire_idempotently() {
    let mut state = State {
        issued_high_water: u64::MAX - 1,
        ..Default::default()
    };
    assert_eq!(state.next_token().unwrap(), u64::MAX);
    state.activate(u64::MAX, "tenant".into(), 9);
    assert!(state.next_token().is_err());
    let proof = state.proof(u64::MAX).unwrap();
    let binding = SourceBinding {
        tenant: "tenant".into(),
        id: 9,
    };
    assert!(matches!(
        state.retire_issued(&proof, &binding).unwrap(),
        Retirement::RetiredNow
    ));
    assert!(matches!(
        state.retire_issued(&proof, &binding).unwrap(),
        Retirement::AlreadyRetired
    ));
    assert!(matches!(
        state.classify_issued(&proof.incarnation, 0),
        IssuedTokenState::NeverIssued
    ));
}

#[test]
fn repeated_local_scan_completion_adopts_the_exact_terminal_result() {
    let root = std::env::temp_dir().join(format!(
        "pp-repeat-local-completion-{}",
        rand::random::<u64>()
    ));
    let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
    let policy = auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    };
    let auth::Outcome::Session { token, .. } = owner
        .auth(auth::FirstUserTenant::NewUser)
        .submit(
            auth::Request::Register {
                email: "repeat-local-completion@example.com".into(),
                display_name: "Repeat completion".into(),
                password: auth::Secret::new("long-repeat-completion-password".into()),
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
    let Outcome::Source(Some(source)) = owner
        .source_catalog_with_policy(
            Credentials::Session(auth::Secret::new(token.expose().to_owned())),
            policy,
        )
        .unwrap()
        .execute(Request::Create {
            source: CreateSource {
                name: "Repeat completion source".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    owner
        .jobs(policy)
        .unwrap()
        .submit(
            jobs::Credential::Session(auth::Secret::new(token.expose().to_owned())),
            jobs::UserOperation::Enqueue {
                key: "repeat-local-completion".into(),
                payload_version: 1,
                payload: jobs::Payload::ImportScan {
                    project_id: source.id.try_into().unwrap(),
                },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    let worker = owner
        .job_worker_with_policy(
            policy,
            jobs::WorkerAdmission {
                kinds: vec![(jobs::JobKind::ImportScan, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let jobs::ClaimedAttempt {
        mut lease,
        source_work,
        ..
    } = worker
        .claim_kind(jobs::JobKind::ImportScan)
        .unwrap()
        .unwrap();
    let mut source_work = source_work.unwrap();
    let mut repeated_work = SourceWorkLease {
        client: source_work.client.clone(),
        proof: source_work.proof.clone(),
    };
    let mut wrong_result_work = SourceWorkLease {
        client: source_work.client.clone(),
        proof: source_work.proof.clone(),
    };
    let mut wrong_receipt_work = SourceWorkLease {
        client: source_work.client.clone(),
        proof: source_work.proof.clone(),
    };
    let mut wrong_reservation_work = SourceWorkLease {
        client: source_work.client.clone(),
        proof: source_work.proof.clone(),
    };
    let mut mismatched_job_work = SourceWorkLease {
        client: source_work.client.clone(),
        proof: source_work.proof.clone(),
    };
    wrong_reservation_work.proof.as_mut().unwrap().token += 1;
    let observation = worker.observe_local_scan(&lease, &source_work).unwrap();
    let applied = worker
        .settle_local_scan(&mut lease, &source_work, observation.settlement(Vec::new()))
        .unwrap();
    let result = applied.local_source_scan_result().unwrap();
    let crate::source_scan::LocalCompletionInspection::Completed(first) = worker
        .complete_local_scan(
            &mut lease,
            &mut source_work,
            applied.clone(),
            result.clone(),
        )
        .unwrap()
    else {
        panic!("first completion expected")
    };
    let history_before: i64 = Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT count(*) FROM durable_job_history WHERE job_id=?1",
            [&first.job.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let document_before: String = Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&first.job.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let source_facts_before: (i64, i64, String, String, String, String) =
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .query_row(
                "SELECT (SELECT count(*) FROM source_docs WHERE project_id=?1),source_id,phase,inventory_digest,index_digest,result_digest FROM source_scan_executions WHERE job_id=?2 AND generation=?3",
                params![source.id, first.job.job_id, first.job.generation],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
    let crate::source_scan::LocalCompletionInspection::Completed(repeated) = worker
        .complete_local_scan(
            &mut lease,
            &mut repeated_work,
            applied.clone(),
            result.clone(),
        )
        .unwrap()
    else {
        panic!("repeated completion expected")
    };
    assert_eq!(repeated.job.state_version, first.job.state_version);
    assert_eq!(repeated.result_digest, first.result_digest);
    let mut wrong_result = result.clone();
    wrong_result.doc_count += 1;
    assert!(
        worker
            .complete_local_scan(
                &mut lease,
                &mut wrong_result_work,
                applied.clone(),
                wrong_result,
            )
            .is_err()
    );
    let wrong_receipt = applied.with_receipt_id_for_test("wrong-receipt".into());
    assert!(
        worker
            .complete_local_scan(
                &mut lease,
                &mut wrong_receipt_work,
                wrong_receipt,
                result.clone(),
            )
            .is_err()
    );
    assert!(
        worker
            .complete_local_scan(
                &mut lease,
                &mut wrong_reservation_work,
                applied.clone(),
                result.clone(),
            )
            .is_err()
    );
    wrong_reservation_work.proof = None;
    let history_after: i64 = Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT count(*) FROM durable_job_history WHERE job_id=?1",
            [&first.job.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(history_after, history_before);
    let document_after: String = Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&first.job.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(document_after, document_before);
    let mut mismatched_document: serde_json::Value =
        serde_json::from_str(&document_before).unwrap();
    mismatched_document["job_id"] = serde_json::Value::String("stored-other-job".into());
    let mismatched_document = serde_json::to_string(&mismatched_document).unwrap();
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE durable_jobs SET document=?2 WHERE id=?1",
            params![first.job.job_id, &mismatched_document],
        )
        .unwrap();
    assert!(
        worker
            .complete_local_scan(
                &mut lease,
                &mut mismatched_job_work,
                applied.clone(),
                result.clone(),
            )
            .is_err()
    );
    assert!(worker.inspect_local_scan_completion(&lease).is_err());
    mismatched_job_work.release().unwrap();
    assert!(mismatched_job_work.proof.is_none());
    let (history_after_mismatch, document_after_mismatch, source_facts_after): (
        i64,
        String,
        (i64, i64, String, String, String, String),
    ) =
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .query_row(
                "SELECT (SELECT count(*) FROM durable_job_history WHERE job_id=?2),(SELECT document FROM durable_jobs WHERE id=?2),(SELECT count(*) FROM source_docs WHERE project_id=?1),source_id,phase,inventory_digest,index_digest,result_digest FROM source_scan_executions WHERE job_id=?2 AND generation=?3",
                params![source.id, first.job.job_id, first.job.generation],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        (
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ),
                    ))
                },
            )
            .unwrap();
    assert_eq!(history_after_mismatch, history_before);
    assert_eq!(document_after_mismatch, mismatched_document);
    assert_eq!(source_facts_after, source_facts_before);
    drop(worker);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_token_incarnation_prevents_restart_aliasing() {
    let mut first = State::default();
    let token = first.next_token().unwrap();
    first.activate(token, "tenant".into(), 9);
    let proof = first.proof(token).unwrap();
    let mut restarted = State::default();
    let reused = restarted.next_token().unwrap();
    restarted.activate(reused, "tenant".into(), 9);
    assert_eq!(token, reused);
    assert!(matches!(
        restarted.classify_issued(&proof.incarnation, proof.token),
        IssuedTokenState::WrongIncarnation
    ));
}

#[test]
fn source_work_release_acknowledges_idempotent_retirement_and_preserves_stopped_proof() {
    let root =
        std::env::temp_dir().join(format!("pp-source-release-ack-{}", rand::random::<u64>()));
    let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
    let catalog = owner.local_source_catalog();
    let Outcome::Source(Some(source)) = catalog
        .execute(Request::Create {
            source: CreateSource {
                name: "Release acknowledgement".into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    let mut first = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    let mut repeated = SourceWorkLease {
        client: first.client.clone(),
        proof: first.proof.clone(),
    };
    first.release().unwrap();
    assert!(first.proof.is_none());
    repeated.release().unwrap();
    assert!(repeated.proof.is_none());
    let mut stopped = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(5))
        .unwrap();
    owner.shutdown().unwrap();
    assert!(stopped.release().is_err());
    assert!(stopped.proof.is_some());
    assert!(stopped.release().is_err());
    assert!(stopped.proof.is_some());
    stopped.proof = None;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unknown_source_work_lease_is_rejected_without_database_work() {
    let mut connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut state = State::default();
    let error = match execute(&mut connection, &mut state, Command::End(17)) {
        Err(error) => error,
        Ok(_) => panic!("unknown Source lease released"),
    };
    assert!(matches!(
        error.downcast_ref::<CatalogFailure>(),
        Some(CatalogFailure::Storage)
    ));
    assert_eq!(error.root_cause().to_string(), "Unknown work lease");
    connection.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn build_graph_envelope_reaps_orphaned_source_work_before_dispatch() {
    let root = std::env::temp_dir().join(format!(
        "pp-build-source-orphan-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
    let catalog = owner.local_source_catalog();
    let Outcome::Source(Some(source)) = catalog
        .execute(Request::Create {
            source: CreateSource {
                name: "Build orphan control".into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    let mut lease = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(2))
        .unwrap();
    let busy = match catalog.begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(2))
    {
        Ok(_) => panic!("live Source lease must exclude overlap"),
        Err(error) => error,
    };
    assert!(busy.downcast_ref::<SourceBusy>().is_some());
    let token = lease.proof.take().unwrap().token;
    let shared = lease.client.shared.clone();
    drop(lease);
    shared.orphaned_source_leases.lock().unwrap().push(token);
    assert_eq!(
        shared.orphaned_source_leases.lock().unwrap().as_slice(),
        &[token]
    );
    let builds = owner
        .build_graph_with_policy(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            first_user: auth::FirstUserTenant::NewUser,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
        })
        .unwrap();
    let error = builds
        .execute(
            crate::read_model::Credential::Session(auth::Secret::new("missing-session".into())),
            crate::build_graph::BuildCommand::List,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<auth::AuthFailure>(),
        Some(auth::AuthFailure::SessionRequired)
    ));
    assert!(shared.orphaned_source_leases.lock().unwrap().is_empty());
    let mut acquired = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(2))
        .unwrap();
    acquired.release().unwrap();
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_secrets_envelope_reaps_orphaned_source_work_before_dispatch() {
    let root = std::env::temp_dir().join(format!(
        "pp-native-secrets-source-orphan-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
    let catalog = owner.local_source_catalog();
    let Outcome::Source(Some(source)) = catalog
        .execute(Request::Create {
            source: CreateSource {
                name: "Native secret orphan control".into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("Source expected")
    };
    let mut lease = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(2))
        .unwrap();
    let token = lease.proof.take().unwrap().token;
    let shared = lease.client.shared.clone();
    drop(lease);
    shared.orphaned_source_leases.lock().unwrap().push(token);
    assert_eq!(
        shared.orphaned_source_leases.lock().unwrap().as_slice(),
        &[token]
    );
    let preparation = owner
        .native_secret_migration()
        .prepare(&AtomicBool::new(false), Duration::from_secs(2))
        .unwrap();
    assert!(matches!(
        preparation,
        crate::native_secrets::MigrationPreparation::Absent
    ));
    assert!(shared.orphaned_source_leases.lock().unwrap().is_empty());
    let mut acquired = catalog
        .begin_work(source.id, &AtomicBool::new(false), Duration::from_secs(2))
        .unwrap();
    acquired.release().unwrap();
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

struct CapturedClaimFixture {
    root: PathBuf,
    owner: WriterOwner,
    client: crate::uploads::ImportClient,
    operation: crate::uploads::Operation,
    manifest: Vec<u8>,
    files: Vec<crate::uploads::File>,
}
impl CapturedClaimFixture {
    fn new() -> Self {
        use crate::uploads::{AdmissionLimits, CaptureId, CapturedPayloadV1, Target};
        let root =
            std::env::temp_dir().join(format!("pp-captured-claim-{}", rand::random::<u64>()));
        let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
        let client = owner
            .imports(
                auth::AuthPolicy {
                    registration: auth::RegistrationPolicy::Open,
                    first_user: auth::FirstUserTenant::NewUser,
                    session_tenant: auth::SessionTenantPolicy::AccountTenant,
                },
                8 * 1024 * 1024 * 1024,
            )
            .unwrap();
        let limits = AdmissionLimits {
            reserved_bytes: 3_506_438_144,
            max_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
        };
        let files = vec![crate::uploads::File {
            path: "triangle.stl".into(),
            size: 1,
            sha256: "ab".repeat(32),
            kind: "input".into(),
        }];
        let payload = CapturedPayloadV1::files(vec!["triangle.stl".into()]);
        let prepared = client
            .preflight_capture(
                jobs::Credential::PhysicalOwner(owner.job_physical_owner()),
                "capture-claim".into(),
                Target::Create {
                    metadata: Box::new(CreateSource {
                        name: "Capture claim".into(),
                        source_kind: Some("local".into()),
                        source_type: Some("local".into()),
                        ..Default::default()
                    }),
                },
                payload.clone(),
                limits,
            )
            .unwrap()
            .prepare(
                CaptureId::new("ab".repeat(32)).unwrap(),
                "capture-claim".into(),
                payload,
                limits,
                files.clone(),
            )
            .unwrap();
        let manifest = prepared.manifest().to_vec();
        let operation = client
            .admit_prepared(prepared, 0, client.accounting_epoch())
            .unwrap();
        Self {
            root,
            owner,
            client,
            operation,
            manifest,
            files,
        }
    }
    fn resolved(&self) -> crate::uploads::ResolvedCapturedClaim {
        match self
            .client
            .correlate_capture_manifest(self.manifest.clone(), self.files.clone())
            .unwrap()
        {
            crate::uploads::CaptureJournalCorrelation::ExactAdmitted(claim) => claim,
            _ => panic!("capture must resolve"),
        }
    }
    fn admission() -> Arc<jobs::WorkerAdmission> {
        Arc::new(jobs::WorkerAdmission {
            kinds: vec![
                (jobs::JobKind::SuppliedSourceImport, 2),
                (jobs::JobKind::ImportScan, 2),
                (jobs::JobKind::PrinterUpload, 2),
            ],
            total: 4,
            per_resource: 2,
            lease_seconds: 3600,
        })
    }
    fn command(&self) -> jobs::Command {
        jobs::Command::ClaimResolved {
            claim: self.resolved(),
            worker: "capture-worker".into(),
            admission: Self::admission(),
            policy: None,
            storage: self.owner.client(),
        }
    }
    fn snapshot(&self, connection: &Connection) -> (String, i64, String, i64, i64) {
        connection.query_row("SELECT j.document,j.version,o.document,o.document_version,(SELECT COUNT(*) FROM durable_job_history WHERE job_id=j.id AND event='claimed') FROM durable_jobs j JOIN source_import_operations o ON o.job_id=j.id WHERE j.id=?1", [&self.operation.job_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap()
    }
    fn finish(self) {
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[test]
fn captured_claim_validation_and_sql_abort_activate_no_source() {
    for failure in ["binding", "missing", "foreign", "sql-abort"] {
        let fixture = CapturedClaimFixture::new();
        let command = fixture.command();
        let mut connection = Connection::open(fixture.root.join("print-partner.db")).unwrap();
        match failure {
            "binding" => {
                connection.execute("UPDATE durable_jobs SET document=json_set(document,'$.payload.payload.operation_key','different') WHERE id=?1", [&fixture.operation.job_id]).unwrap();
            }
            "missing" => {
                connection
                    .execute(
                        "DELETE FROM projects WHERE id=?1",
                        [fixture.operation.source_id],
                    )
                    .unwrap();
            }
            "foreign" => {
                connection
                    .execute(
                        "UPDATE projects SET tenant_id='foreign-tenant' WHERE id=?1",
                        [fixture.operation.source_id],
                    )
                    .unwrap();
            }
            "sql-abort" => {
                connection.execute_batch("CREATE TRIGGER capture_claim_abort BEFORE UPDATE ON durable_jobs WHEN OLD.state='queued' AND NEW.state='running' BEGIN SELECT RAISE(ABORT,'capture claim abort'); END;").unwrap();
            }
            _ => unreachable!(),
        }
        let before = fixture.snapshot(&connection);
        let mut state = State::default();
        let subscriptions = jobs::JobSubscriptions::new();
        let error = match jobs::execute(&mut connection, &mut state, command, &subscriptions) {
            Err(error) => error,
            Ok(_) => panic!("invalid captured claim accepted"),
        };
        if failure != "sql-abort" {
            assert_eq!(error.to_string(), "Captured import requires repair");
        }
        assert_eq!(
            fixture.snapshot(&connection),
            before,
            "{failure} changed journals"
        );
        assert!(state.active.is_empty(), "{failure} activated Source");
        assert_eq!(state.issued_high_water, 0);
        if failure == "sql-abort" {
            connection
                .execute_batch("DROP TRIGGER capture_claim_abort")
                .unwrap();
            let jobs::Outcome::Claimed(Some(claim)) = jobs::execute(
                &mut connection,
                &mut state,
                fixture.command(),
                &subscriptions,
            )
            .unwrap() else {
                panic!("claim after abort")
            };
            assert_eq!(claim.job.attempt, 1);
            assert!(claim.source_work.is_some());
            drop(claim);
        }
        drop(connection);
        fixture.finish();
    }
}

#[test]
fn captured_claim_token_overflow_rolls_back_recovery_and_allows_sourceless_work() {
    let fixture = CapturedClaimFixture::new();
    let mut connection = Connection::open(fixture.root.join("print-partner.db")).unwrap();
    let mut state = State::default();
    let subscriptions = jobs::JobSubscriptions::new();
    let jobs::Outcome::Claimed(Some(old)) = jobs::execute(
        &mut connection,
        &mut state,
        fixture.command(),
        &subscriptions,
    )
    .unwrap() else {
        panic!("initial claim")
    };
    state.active.clear();
    state.issued_high_water = u64::MAX;
    connection.execute("UPDATE durable_jobs SET lease_until=0,document=json_set(document,'$.lease_until',0) WHERE id=?1", [&fixture.operation.job_id]).unwrap();
    let before = fixture.snapshot(&connection);
    let error = match jobs::execute(
        &mut connection,
        &mut state,
        fixture.command(),
        &subscriptions,
    ) {
        Err(error) => error,
        Ok(_) => panic!("overflow claim accepted"),
    };
    assert_eq!(error.to_string(), "Work lease overflow");
    assert_eq!(fixture.snapshot(&connection), before);
    assert!(state.active.is_empty());
    assert_eq!(state.issued_high_water, u64::MAX);
    let queued = fixture
        .owner
        .jobs(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            first_user: auth::FirstUserTenant::NewUser,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
        })
        .unwrap()
        .submit(
            jobs::Credential::PhysicalOwner(fixture.owner.job_physical_owner()),
            jobs::UserOperation::Enqueue {
                key: "no-source".into(),
                payload_version: 1,
                payload: jobs::Payload::PrinterUpload {
                    printer_id: "printer".into(),
                    artifact_path: "exports/candidate.gcode".into(),
                    filename: "candidate.gcode".into(),
                    start: false,
                    profile_id: None,
                    host_name: None,
                    checkoff_units: vec![],
                    unlabeled_names: vec![],
                },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    let jobs::Outcome::Job(queued, _) = queued else {
        panic!("queued job")
    };
    let jobs::Outcome::Claimed(Some(claim)) = jobs::execute(
        &mut connection,
        &mut state,
        jobs::Command::Claim {
            job_id: None,
            kind: None,
            worker: "no-source-worker".into(),
            admission: CapturedClaimFixture::admission(),
            policy: None,
            storage: fixture.owner.client(),
        },
        &subscriptions,
    )
    .unwrap() else {
        panic!("Source-less claim must remain available")
    };
    assert_eq!(claim.job.job_id, queued.job_id);
    assert!(claim.source_work.is_none());
    assert!(state.active.is_empty());
    drop(old);
    drop(claim);
    drop(connection);
    fixture.finish();
}

#[test]
fn resolved_and_targeted_expiry_and_cancellation_keep_old_source_authority_until_drop() {
    for (resolved, cancelled) in [(false, false), (true, false), (false, true), (true, true)] {
        let fixture = CapturedClaimFixture::new();
        let mut admission = (*CapturedClaimFixture::admission()).clone();
        admission.lease_seconds = 1;
        let worker = fixture.owner.job_worker(admission).unwrap();
        let old = worker
            .claim_resolved_import(fixture.resolved())
            .unwrap()
            .unwrap();
        if cancelled {
            fixture
                .owner
                .jobs(auth::AuthPolicy {
                    registration: auth::RegistrationPolicy::Open,
                    first_user: auth::FirstUserTenant::NewUser,
                    session_tenant: auth::SessionTenantPolicy::AccountTenant,
                })
                .unwrap()
                .submit(
                    jobs::Credential::PhysicalOwner(fixture.owner.job_physical_owner()),
                    jobs::UserOperation::Cancel {
                        job_id: fixture.operation.job_id.clone(),
                    },
                    &AtomicBool::new(false),
                    Duration::from_secs(5),
                )
                .unwrap()
                .receive()
                .unwrap();
        } else {
            std::thread::sleep(Duration::from_millis(1100));
        }
        let claim_again = || {
            if resolved {
                worker.claim_resolved_import(fixture.resolved())
            } else {
                worker.claim_import(&fixture.operation.job_id)
            }
        };
        let error = match claim_again() {
            Err(error) => error,
            Ok(_) => panic!("old Source authority ignored"),
        };
        assert!(error.downcast_ref::<SourceBusy>().is_some());
        let connection = Connection::open(fixture.root.join("print-partner.db")).unwrap();
        let before = fixture.snapshot(&connection);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&before.0).unwrap()["state"],
            "queued"
        );
        let error = match claim_again() {
            Err(error) => error,
            Ok(_) => panic!("old Source authority ignored"),
        };
        assert!(error.downcast_ref::<SourceBusy>().is_some());
        assert_eq!(fixture.snapshot(&connection), before);
        let catalog = fixture.owner.local_source_catalog();
        let error = match catalog.begin_work(
            fixture.operation.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        ) {
            Err(error) => error,
            Ok(_) => panic!("old packet released Source"),
        };
        assert!(error.downcast_ref::<SourceBusy>().is_some());
        drop(old);
        catalog
            .execute(Request::Get {
                id: fixture.operation.source_id,
            })
            .unwrap();
        let next = claim_again().unwrap().unwrap();
        assert_eq!(next.job.attempt, 2);
        assert!(next.source_work.is_some());
        drop(next);
        drop(connection);
        drop(worker);
        fixture.finish();
    }
}

#[test]
fn dropped_resolved_pending_releases_source_at_catalog_fifo_barrier() {
    let fixture = CapturedClaimFixture::new();
    drop(
        jobs::submit(
            &fixture.owner.client(),
            fixture.command(),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap(),
    );
    let catalog = fixture.owner.local_source_catalog();
    catalog
        .execute(Request::Get {
            id: fixture.operation.source_id,
        })
        .unwrap();
    let connection = Connection::open(fixture.root.join("print-partner.db")).unwrap();
    let document: String = connection
        .query_row(
            "SELECT state FROM durable_jobs WHERE id=?1",
            [&fixture.operation.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(document, "running");
    let mut direct = catalog
        .begin_work(
            fixture.operation.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    direct.release().unwrap();
    drop(connection);
    fixture.finish();
}
