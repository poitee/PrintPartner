use super::super::*;
use crate::{Queue, QueueClass, auth::Secret, required_units::AdmissionFailure};
use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    thread,
};

fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
fn client(capacity: usize) -> PublicationClient {
    PublicationClient {
        shared: Arc::new(Shared {
            queue: Mutex::new(Queue {
                auth_ready: VecDeque::new(),
                next: QueueClass::Normal,
                closed: false,
                pending: VecDeque::new(),
            }),
            changed: Condvar::new(),
            capacity,
            job_admission: Mutex::new(None),
            orphaned_source_leases: Mutex::new(Vec::new()),
            job_subscriptions: crate::jobs::JobSubscriptions::new(),
        }),
        policy: policy(),
    }
}
fn credential() -> Credential {
    Credential::Session(Secret::new("publication-test-session".into()))
}
fn input(case: &Value) -> Result<PublicationCommand> {
    PublicationCommand::new(
        serde_json::from_value(case["profile"].clone())?,
        serde_json::from_value(case["draft"].clone())?,
        serde_json::from_value(case["request"].clone())?,
        case["key"].as_str().unwrap_or("").into(),
        credential(),
    )
}
fn seed_session(c: &Connection, tenant: &str) {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(b"publication-test-session"));
    c.execute("INSERT INTO users(id,display_name,is_admin,created_at) VALUES(?1,'Publication test',0,'2026-09-06T00:00:00.000Z')", [tenant]).unwrap();
    c.execute("INSERT INTO sessions(id,user_id,expires_at,provider) VALUES(?1,?2,'2099-01-01T00:00:00.000Z','email')", params![digest,tenant]).unwrap();
}
struct Tokens(u128);
impl RequiredUnitTokenAllocator for Tokens {
    fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure> {
        self.0 += 1;
        Ok(self.0.to_be_bytes())
    }
}
fn queued(shared: &Shared) -> Envelope {
    let mut queue = shared.queue.lock().unwrap();
    while queue.pending.is_empty() {
        queue = shared.changed.wait(queue).unwrap();
    }
    let work = queue.pending.pop_front().unwrap();
    shared.changed.notify_all();
    work
}
fn run(
    client: &PublicationClient,
    input: PublicationCommand,
    c: &mut Connection,
    tokens: &mut Tokens,
) -> Result<Outcome> {
    thread::scope(|scope| {
        let caller = scope.spawn(|| client.apply(input, &AtomicBool::new(false), Duration::ZERO));
        let Envelope::Publication { command, reply } = queued(&client.shared) else {
            panic!("publication envelope")
        };
        reply
            .send(execute(
                c,
                command,
                tokens,
                crate::writer_admission::Deadline::at_dequeue(),
            ))
            .unwrap();
        caller.join().unwrap()
    })
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../../fixtures/parity/plan-publication/node.json"
    ))
    .unwrap()
}
fn database(data: &Value) -> Connection {
    super::transaction::database(
        &json!({"definitions": data["transactionSchema"]}),
        &data["transactions"][0],
    )
}

#[test]
fn client_matches_node_apply_route_keys_replay_context_and_error_text() {
    let data = fixture();
    let cases = data["clients"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for case in cases {
        let mut c = database(&data);
        seed_session(&c, case["tenant"].as_str().unwrap());
        if case["corrupt"] == true {
            c.execute_batch("CREATE TRIGGER reject_publication BEFORE INSERT ON plan_revisions BEGIN SELECT RAISE(ABORT,'Rust-only probe detail'); END").unwrap();
        }
        let client = client(1);
        let command = input(case);
        if case["status"] == 400 {
            assert_eq!(command.err().unwrap().to_string(), case["body"]["detail"]);
            continue;
        }
        let mut tokens = Tokens(0);
        let outcome = run(&client, command.unwrap(), &mut c, &mut tokens);
        if case["status"] == 500 {
            let error = outcome.err().unwrap();
            assert_eq!(error.to_string(), case["body"]["detail"]);
            assert!(
                error
                    .chain()
                    .any(|cause| cause.to_string().contains("Rust-only probe detail"))
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM plan_revisions", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            continue;
        }
        let outcome = serde_json::to_value(outcome.unwrap()).unwrap();
        if case["status"] == 404 {
            assert_eq!(outcome["kind"], "not_found");
            assert_eq!(
                case["body"],
                json!({"detail":"Plan not found","code":"profile_not_found"})
            );
            continue;
        }
        let mut receipt = outcome["receipt"].clone();
        let at = receipt["applied_at"].as_str().unwrap().to_owned();
        super::transaction::replace_time(&mut receipt, &at, &data["transactionAt"]);
        assert_eq!(receipt, case["body"], "{}", case["id"]);
        let stored: (String, String) = c
            .query_row(
                "SELECT idempotency_key,actor_id FROM plan_apply_requests",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            json!({"idempotency_key": stored.0, "actor_id": stored.1}),
            case["receipt"]
        );
        let again =
            serde_json::to_value(run(&client, input(case).unwrap(), &mut c, &mut tokens).unwrap())
                .unwrap();
        assert_eq!(again["receipt"], outcome["receipt"]);
        assert_eq!(case["replay"]["body"], receipt);
        assert_eq!(
            c.query_row("SELECT count(*) FROM plan_apply_requests", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn admission_matches_reference_cancel_full_stop_and_unknown_outcome() {
    let data = fixture();
    let case = &data["clients"][0];
    let cancelled = client(0);
    let failure = |result: Result<Outcome>| {
        result
            .err()
            .unwrap()
            .downcast::<AdmissionFailure>()
            .unwrap()
    };
    let result =
        failure(cancelled.apply(input(case).unwrap(), &AtomicBool::new(true), Duration::ZERO));
    assert!(matches!(result, AdmissionFailure::Cancelled), "{result:?}");
    assert!(cancelled.shared.queue.lock().unwrap().pending.is_empty());
    let client = client(1);
    let (reply, _receiver) = mpsc::channel();
    client
        .shared
        .queue
        .lock()
        .unwrap()
        .pending
        .push_back(Envelope::WriterControl {
            control: crate::WriterControl::PageCount,
            reply,
        });
    assert!(matches!(
        failure(client.apply(
            input(case).unwrap(),
            &AtomicBool::new(false),
            Duration::ZERO
        )),
        AdmissionFailure::QueueFull
    ));
    client.shared.queue.lock().unwrap().closed = true;
    assert!(matches!(
        failure(client.apply(input(case).unwrap(), &AtomicBool::new(true), Duration::ZERO)),
        AdmissionFailure::Stopped
    ));
    client.shared.queue.lock().unwrap().pending.clear();
    client.shared.queue.lock().unwrap().closed = false;
    thread::scope(|scope| {
        let caller = scope.spawn(|| {
            client.apply(
                input(case).unwrap(),
                &AtomicBool::new(false),
                Duration::ZERO,
            )
        });
        drop(queued(&client.shared));
        assert!(matches!(
            failure(caller.join().unwrap()),
            AdmissionFailure::OutcomeUnknown
        ));
    });
}

#[test]
fn cancellation_after_admission_does_not_retract_publication() {
    let data = fixture();
    let case = &data["clients"][0];
    let mut c = database(&data);
    seed_session(&c, "default");
    let client = client(1);
    let cancelled = AtomicBool::new(false);
    thread::scope(|scope| {
        let caller = scope.spawn(|| client.apply(input(case).unwrap(), &cancelled, Duration::ZERO));
        let Envelope::Publication { command, reply } = queued(&client.shared) else {
            panic!("publication envelope")
        };
        cancelled.store(true, Ordering::Release);
        reply
            .send(execute(
                &mut c,
                command,
                &mut Tokens(0),
                crate::writer_admission::Deadline::at_dequeue(),
            ))
            .unwrap();
        assert!(matches!(
            caller.join().unwrap().unwrap(),
            Outcome::Applied { .. }
        ));
    });
}

#[test]
fn owner_installs_schema_dispatches_random_tokens_and_drains_before_stop() {
    let data = fixture();
    let case = &data["clients"][0];
    let c = database(&data);
    seed_session(&c, "default");
    c.execute_batch("DROP TABLE plan_apply_admissions; UPDATE app_settings SET value='35' WHERE key='schema_version' AND tenant_id='default'").unwrap();
    let dir = crate::tests::directory("publication-owner");
    c.backup("main", dir.join("print-partner.db"), None)
        .unwrap();
    let before = std::fs::read(dir.join("print-partner.db")).unwrap();
    let (owner, ready) = WriterOwner::open(&dir, crate::Limits::default()).unwrap();
    assert_eq!(ready.version, crate::schema::CURRENT_VERSION);
    assert_eq!(ready.previous_version, 35);
    let backup = dir.join("backups/pre-schema37.db");
    assert_eq!(ready.backup.as_ref(), Some(&backup));
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    let saved =
        Connection::open_with_flags(&backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        saved
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        saved
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "35"
    );
    validate_schema(&saved, 35).unwrap();
    drop(saved);
    let client = owner.publication();
    let outcome = serde_json::to_value(
        client
            .apply(
                input(case).unwrap(),
                &AtomicBool::new(false),
                Duration::ZERO,
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(outcome["kind"], "applied");
    owner.shutdown().unwrap();
    assert!(matches!(
        client
            .apply(
                input(case).unwrap(),
                &AtomicBool::new(false),
                Duration::ZERO
            )
            .err()
            .unwrap()
            .downcast::<AdmissionFailure>()
            .unwrap(),
        AdmissionFailure::Stopped
    ));
    let c = Connection::open(dir.join("print-partner.db")).unwrap();
    validate_schema(&c, 37).unwrap();
    let token: String = c
        .query_row("SELECT token FROM required_units LIMIT 1", [], |r| r.get(0))
        .unwrap();
    ru::model::validate_token(&token).unwrap();
    let (owner, ready) = WriterOwner::open(&dir, crate::Limits::default()).unwrap();
    assert_eq!(ready.previous_version, crate::schema::CURRENT_VERSION);
    assert!(ready.backup.is_none());
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    let replay = serde_json::to_value(
        owner
            .publication()
            .apply(
                input(case).unwrap(),
                &AtomicBool::new(false),
                Duration::ZERO,
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(outcome["receipt"], replay["receipt"]);
    owner.shutdown().unwrap();
    drop(c);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn schema_validation_rejects_early_objects_drift_and_orphans() {
    let data = fixture();
    let c = database(&data);
    assert!(validate_schema(&c, 35).is_err());
    validate_schema(&c, 37).unwrap();
    c.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_update")
        .unwrap();
    assert!(validate_schema(&c, 37).is_err());
    c.execute_batch("DROP TABLE plan_apply_admissions").unwrap();
    validate_schema(&c, 35).unwrap();
    assert!(validate_schema(&c, 37).is_err());
    c.execute_batch(include_str!("../schema.sql")).unwrap();
    c.execute_batch("PRAGMA foreign_keys=OFF; INSERT INTO plan_apply_admissions VALUES(999,'plan-apply-request-v1','digest','snapshot',0,NULL,0)").unwrap();
    assert_eq!(
        validate_schema(&c, 37).unwrap_err().to_string(),
        "Orphan Plan Apply admission"
    );
}

#[test]
fn normalized_http_keeps_admission_separate_and_expired_writer_never_publishes() {
    let data = fixture();
    let case = &data["clients"][0];
    let admitted: ApplyRequest = serde_json::from_value(case["request"].clone()).unwrap();
    let mut execution = case["request"].clone();
    execution["expected_lifecycle_version"] = json!(17);
    let input = PublicationCommand::normalized_http(
        serde_json::from_value(case["profile"].clone()).unwrap(),
        serde_json::from_value(case["draft"].clone()).unwrap(),
        admitted.clone(),
        serde_json::from_value(execution.clone()).unwrap(),
        "key".into(),
        credential(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&input.admitted_request).unwrap(),
        serde_json::to_value(admitted).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&input.execution_request).unwrap(),
        execution
    );
    let mut c = database(&data);
    seed_session(&c, "default");
    let error = execute(
        &mut c,
        Command {
            input,
            policy: policy(),
        },
        &mut Tokens(0),
        crate::writer_admission::Deadline::expired(),
    )
    .unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<rusqlite::Error>()
            .unwrap()
            .sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    assert!(c.is_autocommit());
    assert_eq!(
        c.query_row("SELECT count(*) FROM plan_apply_requests", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn client_rejects_unauthenticated_publication_and_preserves_normalized_admission() {
    let data = fixture();
    let case = &data["clients"][0];
    let mut c = database(&data);
    let client = client(1);
    let error = run(&client, input(case).unwrap(), &mut c, &mut Tokens(0)).unwrap_err();
    assert!(matches!(
        error.downcast::<auth::AuthFailure>().unwrap(),
        auth::AuthFailure::SessionRequired
    ));
    assert_eq!(
        c.query_row("SELECT count(*) FROM plan_apply_requests", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    seed_session(&c, "default");
    let normalized = || {
        let mut admitted = case["request"].clone();
        admitted["expected_snapshot_digest"] = json!("0".repeat(64));
        PublicationCommand::normalized_http(
            serde_json::from_value(case["profile"].clone()).unwrap(),
            serde_json::from_value(case["draft"].clone()).unwrap(),
            serde_json::from_value(admitted).unwrap(),
            serde_json::from_value(case["request"].clone()).unwrap(),
            "normalized".into(),
            credential(),
        )
        .unwrap()
    };
    let outcome =
        serde_json::to_value(run(&client, normalized(), &mut c, &mut Tokens(0)).unwrap()).unwrap();
    assert_eq!(outcome["kind"], "applied");
    let admitted: String = c
        .query_row(
            "SELECT expected_snapshot_digest FROM plan_apply_admissions",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(admitted, "0".repeat(64));
    let replay =
        serde_json::to_value(run(&client, normalized(), &mut c, &mut Tokens(0)).unwrap()).unwrap();
    assert_eq!(replay["receipt"], outcome["receipt"]);
}
