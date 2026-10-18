#![cfg(feature = "desktop_rebuild")]
//! Job stream authority and shutdown, ported from the reference
//! `job_transport.rs`. Node's runner keeps listeners until the job ends and
//! never revalidates the subscriber, so these cases test the reference
//! engine's behavior instead of a Node result. Authority changes go through
//! both writer paths: `auth_with_policy` and `rebuild_auth_with_policy`.
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/claimed_attempt.rs"
));
use pp_storage::jobs::ClaimedAttempt;
use pp_storage::{
    Limits, Setting, SettingCommand, WriterOwner,
    auth::{
        self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy,
        rebuild::AuthLifetimes,
    },
    jobs::{
        Credential, FrameAdmission, JobAccessFailure, JobKind, JobSnapshot, JobSubscription,
        NonblockingSend, Outcome, Payload, PreparedEvent, PreparedFrame, StreamClose,
        UserOperation, WorkerAdmission, WorkerOperation,
    },
};
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

const WAIT: Duration = Duration::from_secs(5);

enum TestStreamEvent {
    Snapshot(Box<JobSnapshot>),
    Closed(StreamClose),
    Pending,
}

fn next(subscription: &JobSubscription, wait: Duration) -> TestStreamEvent {
    match subscription
        .prepare(wait, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    {
        PreparedEvent::Frame(frame) => {
            let mut delivered = None;
            assert_eq!(
                subscription.admit(frame, |snapshot| {
                    delivered = Some(snapshot);
                    NonblockingSend::Accepted
                }),
                FrameAdmission::Admitted
            );
            TestStreamEvent::Snapshot(Box::new(delivered.expect("admitted snapshot")))
        }
        PreparedEvent::Closed(reason) => TestStreamEvent::Closed(reason),
        PreparedEvent::Pending => TestStreamEvent::Pending,
    }
}

fn prepared(subscription: &JobSubscription) -> PreparedFrame<JobSnapshot> {
    let PreparedEvent::Frame(frame) = subscription
        .prepare(WAIT, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    else {
        panic!("prepared frame expected")
    };
    frame
}

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-job-transport-{}",
        hex::encode(rand::random::<[u8; 12]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

fn single_account_policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
        first_user: FirstUserTenant::NewUser,
    }
}

/// Runs a request through the auth rebuild writer path.
fn auth_call(owner: &WriterOwner, policy: AuthPolicy, request: auth::Request) -> auth::Outcome {
    owner
        .rebuild_auth_with_policy(policy, AuthLifetimes::default())
        .unwrap()
        .submit(request, Arc::new(AtomicBool::new(false)), WAIT)
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}

/// Runs a request through the plain auth writer path.
fn legacy_auth_call(owner: &WriterOwner, request: auth::Request) -> auth::Outcome {
    owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(request, Arc::new(AtomicBool::new(false)), WAIT)
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}

fn register(owner: &WriterOwner) -> String {
    let auth::Outcome::Session { token, .. } = auth_call(
        owner,
        policy(),
        auth::Request::Register {
            email: "jobs@example.com".into(),
            display_name: "Jobs transport".into(),
            password: Secret::new("long-test-password".into()),
        },
    ) else {
        panic!("session expected")
    };
    token.expose().to_owned()
}

fn enqueue(owner: &WriterOwner, token: &str, key: &str) -> String {
    let outcome = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.to_owned())),
            UserOperation::Enqueue {
                key: key.to_owned(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap();
    let Outcome::Job(job, _) = outcome else {
        panic!("job expected")
    };
    job.job_id
}

fn subscribe(owner: &WriterOwner, credential: Credential, id: String) -> JobSubscription {
    owner
        .jobs(policy())
        .unwrap()
        .subscribe(credential, id, &AtomicBool::new(false), WAIT)
        .unwrap()
}

fn session(token: &str) -> Credential {
    Credential::Session(Secret::new(token.to_owned()))
}

fn worker(owner: &WriterOwner) -> pp_storage::jobs::ServerWorkerClient {
    owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::CheckSourceUpdates, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap()
}

fn key(owner: &WriterOwner, token: &str) -> (String, auth::KeyInfo, String) {
    let auth::Outcome::User(Some(user)) = auth_call(
        owner,
        policy(),
        auth::Request::ResolveSession {
            token: Secret::new(token.to_owned()),
        },
    ) else {
        panic!("user expected")
    };
    let auth::Outcome::KeyCreated { info, key } = auth_call(
        owner,
        policy(),
        auth::Request::CreateKey {
            session: Secret::new(token.to_owned()),
        },
    ) else {
        panic!("key expected")
    };
    (user.tenant_id, info, key.expose().to_owned())
}

#[test]
fn idle_subscription_closes_at_configured_session_expiry() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let auth::Outcome::Session { token, .. } = owner
        .rebuild_auth_with_policy(
            policy(),
            AuthLifetimes::shorter(Duration::from_secs(2), None).unwrap(),
        )
        .unwrap()
        .submit(
            auth::Request::Register {
                email: "expiry@example.com".into(),
                display_name: "Expiry".into(),
                password: Secret::new("long-test-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("session expected")
    };
    let token = token.expose().to_owned();
    let id = enqueue(&owner, &token, "expires-idle");
    let subscription = subscribe(&owner, session(&token), id);
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Snapshot(_)
    ));
    let started = std::time::Instant::now();
    assert!(matches!(
        next(&subscription, Duration::from_secs(4)),
        TestStreamEvent::Closed(StreamClose::Expired)
    ));
    assert!(started.elapsed() < Duration::from_secs(4));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn logout_after_next_before_dispatch_must_not_leave_sendable_snapshot() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "dispatch-gap");
    let subscription = subscribe(&owner, session(&token), id);
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Snapshot(_)
    ));

    let worker = worker(&owner);
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    worker
        .update(&mut lease, WorkerOperation::Progress(10))
        .unwrap();
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Snapshot(_)
    ));
    let progress = prepared(&subscription);

    assert!(matches!(
        legacy_auth_call(
            &owner,
            auth::Request::Logout {
                token: Secret::new(token),
            }
        ),
        auth::Outcome::Changed(true)
    ));
    assert_eq!(
        subscription.admit(progress, |_| NonblockingSend::Accepted),
        FrameAdmission::Closed(StreamClose::Revoked)
    );
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

fn assert_prepared_session_frame_revoked(revoke: impl FnOnce(&WriterOwner, &str)) {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "session-revocation");
    let subscription = subscribe(&owner, session(&token), id);
    let initial = prepared(&subscription);

    revoke(&owner, &token);
    let mut sent = false;
    assert_eq!(
        subscription.admit(initial, |_| {
            sent = true;
            NonblockingSend::Accepted
        }),
        FrameAdmission::Closed(StreamClose::Revoked)
    );
    assert!(!sent);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn logout_all_password_change_and_reset_revoke_prepared_frames() {
    assert_prepared_session_frame_revoked(|owner, token| {
        assert!(matches!(
            auth_call(
                owner,
                policy(),
                auth::Request::LogoutAll {
                    session: Secret::new(token.to_owned()),
                }
            ),
            auth::Outcome::Changed(true)
        ));
    });
    assert_prepared_session_frame_revoked(|owner, token| {
        assert!(matches!(
            auth_call(
                owner,
                policy(),
                auth::Request::ChangePassword {
                    session: Secret::new(token.to_owned()),
                    current: Secret::new("long-test-password".into()),
                    replacement: Secret::new("different-long-password".into()),
                }
            ),
            auth::Outcome::Session { .. }
        ));
    });
    assert_prepared_session_frame_revoked(|owner, _token| {
        let auth::Outcome::ResetToken(Some(reset)) = auth_call(
            owner,
            policy(),
            auth::Request::RequestReset {
                email: "jobs@example.com".into(),
            },
        ) else {
            panic!("reset token expected")
        };
        assert!(matches!(
            auth_call(
                owner,
                policy(),
                auth::Request::ResetPassword {
                    token: reset,
                    replacement: Secret::new("reset-long-password".into()),
                }
            ),
            auth::Outcome::Session { .. }
        ));
    });
}

/// The reference touches the key's metadata through `ResolveKey`, which main
/// does not have; creating a second key is the unrelated authority write here.
#[test]
fn unrelated_key_change_stays_healthy_then_rotation_revokes_prepared_frame() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "key-rotation");
    let (tenant, info, key_text) = key(&owner, &token);
    let routed = || Credential::RoutedKey {
        tenant: tenant.clone(),
        key: Secret::new(key_text.clone()),
    };
    let healthy = subscribe(&owner, routed(), id.clone());
    let initial = prepared(&healthy);
    key(&owner, &token);
    assert_eq!(
        healthy.admit(initial, |_| NonblockingSend::Accepted),
        FrameAdmission::Admitted
    );

    let rotated = subscribe(&owner, routed(), id);
    let initial = prepared(&rotated);
    assert!(matches!(
        auth_call(
            &owner,
            policy(),
            auth::Request::RotateKey {
                session: Secret::new(token),
                key_id: info.id,
            }
        ),
        auth::Outcome::KeyCreated { .. }
    ));
    assert_eq!(
        rotated.admit(initial, |_| NonblockingSend::Accepted),
        FrameAdmission::Closed(StreamClose::Revoked)
    );
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn account_count_policy_change_revokes_prepared_frame() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let auth::Outcome::Session { token, .. } = auth_call(
        &owner,
        single_account_policy(),
        auth::Request::Register {
            email: "single-account@example.com".into(),
            display_name: "Single account".into(),
            password: Secret::new("long-test-password".into()),
        },
    ) else {
        panic!("session expected")
    };
    let token = token.expose().to_owned();
    let jobs = owner.jobs(single_account_policy()).unwrap();
    let Outcome::Job(job, _) = jobs
        .submit(
            session(&token),
            UserOperation::Enqueue {
                key: "account-count".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap()
    else {
        panic!("job expected")
    };
    let subscription = jobs
        .subscribe(session(&token), job.job_id, &AtomicBool::new(false), WAIT)
        .unwrap();
    let initial = prepared(&subscription);
    assert!(matches!(
        auth_call(
            &owner,
            policy(),
            auth::Request::Register {
                email: "second-account@example.com".into(),
                display_name: "Second account".into(),
                password: Secret::new("long-test-password".into()),
            }
        ),
        auth::Outcome::Session { .. }
    ));
    assert_eq!(
        subscription.admit(initial, |_| NonblockingSend::Accepted),
        FrameAdmission::Closed(StreamClose::Revoked)
    );
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

/// Generic settings writes skip `authority_change`, so they must not replace
/// the key collection a live stream was admitted under.
#[test]
fn generic_settings_write_cannot_replace_key_collection() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "settings-key-collection");
    let (tenant, _, key_text) = key(&owner, &token);
    let routed = || Credential::RoutedKey {
        tenant: tenant.clone(),
        key: Secret::new(key_text.clone()),
    };
    let subscription = subscribe(&owner, routed(), id.clone());
    let initial = prepared(&subscription);
    let stored = || {
        owner
            .client()
            .reader(WAIT)
            .unwrap()
            .get_setting(&tenant, "api_keys_v1", None)
            .unwrap()
    };
    let before = stored();
    let refused = owner
        .client()
        .submit(
            SettingCommand::Set(Setting {
                tenant: tenant.clone(),
                key: "api_keys_v1".into(),
                value: "[]".into(),
            }),
            &AtomicBool::new(false),
            WAIT,
        )
        .expect_err("generic settings must not write the key collection");
    assert_eq!(
        refused.to_string(),
        "Setting api_keys_v1 is owned by auth and changes only through auth requests"
    );
    assert_eq!(stored(), before);
    drop(subscribe(&owner, routed(), id));
    assert_eq!(
        subscription.admit(initial, |_| NonblockingSend::Accepted),
        FrameAdmission::Admitted
    );
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn key_revocation_closes_stream_before_queued_initial_data() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "key-revocation");
    let (tenant, info, key) = key(&owner, &token);
    let subscription = subscribe(
        &owner,
        Credential::RoutedKey {
            tenant,
            key: Secret::new(key),
        },
        id,
    );
    assert!(matches!(
        legacy_auth_call(
            &owner,
            auth::Request::RevokeKey {
                session: Secret::new(token),
                key_id: info.id,
            }
        ),
        auth::Outcome::KeyChanged { changed: true, .. }
    ));
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Closed(StreamClose::Revoked)
    ));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn slow_consumer_gets_sticky_lag_and_can_reconnect_to_current_snapshot() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "lagged");
    let subscription = subscribe(&owner, session(&token), id.clone());
    let worker = worker(&owner);
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    for progress in 1..=16 {
        worker
            .update(&mut lease, WorkerOperation::Progress(progress))
            .unwrap();
    }
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Closed(StreamClose::Lagged)
    ));
    let reconnect = subscribe(&owner, session(&token), id);
    let TestStreamEvent::Snapshot(snapshot) = next(&reconnect, WAIT) else {
        panic!("current snapshot expected")
    };
    assert_eq!(snapshot.progress, Some(16));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn observation_is_atomic_ordered_terminal_and_revoked_before_queued_data() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "observed");
    let subscription = subscribe(&owner, session(&token), id);
    let worker = worker(&owner);
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    worker
        .update(&mut lease, WorkerOperation::Progress(10))
        .unwrap();
    worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    let snapshots = (0..4)
        .map(|_| match next(&subscription, WAIT) {
            TestStreamEvent::Snapshot(snapshot) => (snapshot.status, snapshot.progress),
            _ => panic!("snapshot expected"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        snapshots,
        vec![
            ("pending", Some(0)),
            ("running", None),
            ("running", Some(10)),
            ("done", Some(100)),
        ]
    );
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Closed(StreamClose::Finished)
    ));

    let second = enqueue(&owner, &token, "revoked");
    let revoked = subscribe(&owner, session(&token), second);
    assert!(matches!(
        legacy_auth_call(
            &owner,
            auth::Request::Logout {
                token: Secret::new(token),
            }
        ),
        auth::Outcome::Changed(true)
    ));
    assert!(matches!(
        next(&revoked, WAIT),
        TestStreamEvent::Closed(StreamClose::Revoked)
    ));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

/// An external write lock holds the writer inside the subscription's
/// transaction until shutdown has begun. The subscription commits after the
/// owner stopped, so registration is refused, and the live stream closes.
#[test]
fn shutdown_closes_live_streams_and_refuses_subscriptions_that_commit_after_it() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "shutdown");
    let live = subscribe(&owner, session(&token), id.clone());
    assert!(matches!(next(&live, WAIT), TestStreamEvent::Snapshot(_)));

    let lock = Connection::open(path.join("print-partner.db")).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let jobs = owner.jobs(policy()).unwrap();
    let late = std::thread::spawn(move || {
        jobs.subscribe(session(&token), id, &AtomicBool::new(false), WAIT)
    });
    std::thread::sleep(Duration::from_millis(300));
    let shutdown = std::thread::spawn(move || owner.shutdown());
    std::thread::sleep(Duration::from_millis(300));
    lock.execute_batch("ROLLBACK").unwrap();

    let refused = late.join().unwrap().err().expect("late subscription");
    assert_eq!(
        refused.downcast_ref::<JobAccessFailure>(),
        Some(&JobAccessFailure::Stopped)
    );
    shutdown.join().unwrap().unwrap();
    assert!(matches!(
        next(&live, Duration::ZERO),
        TestStreamEvent::Closed(StreamClose::OwnerStopped)
    ));
    drop(lock);
    std::fs::remove_dir_all(path).unwrap();
}
