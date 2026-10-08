use pp_storage::{
    Limits, WriterOwner,
    auth::{
        self, AuthLifetimes, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret,
        SessionTenantPolicy,
    },
    jobs::{
        Credential, FrameAdmission, JobKind, JobSnapshot, LegacyListFilter, NonblockingSend,
        Outcome, Payload, PreparedEvent, StreamClose, UserOperation, WorkerAdmission,
        WorkerOperation,
    },
};
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

fn next(subscription: &pp_storage::jobs::JobSubscription, wait: Duration) -> TestStreamEvent {
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

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-job-transport-{}",
        hex::encode(rand::random::<[u8; 12]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn idle_subscription_closes_at_configured_session_expiry() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let auth = owner
        .auth_with_policy_and_lifetimes(
            policy(),
            AuthLifetimes::shorter(Duration::from_secs(1), Some(Duration::from_secs(1))).unwrap(),
        )
        .unwrap();
    let auth::Outcome::Session { token, .. } = auth
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
    let subscription = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::Session(Secret::new(token)),
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Snapshot(_)
    ));
    let started = std::time::Instant::now();
    assert!(matches!(
        next(&subscription, Duration::from_secs(3)),
        TestStreamEvent::Closed(StreamClose::Expired)
    ));
    assert!(started.elapsed() < Duration::from_secs(3));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
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

fn register(owner: &WriterOwner) -> String {
    let auth::Outcome::Session { token, .. } = owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::Register {
                email: "jobs@example.com".into(),
                display_name: "Jobs transport".into(),
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
    token.expose().to_owned()
}

#[test]
fn logout_after_next_before_dispatch_must_not_leave_sendable_snapshot() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let job_id = enqueue(&owner, &token, "dispatch-gap");
    let subscription = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::Session(Secret::new(token.clone())),
            job_id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();

    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Snapshot(_)
    ));

    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::CheckSourceUpdates, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(&mut lease, WorkerOperation::Progress(10))
        .unwrap();

    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Snapshot(_)
    ));
    let prepared = match subscription
        .prepare(WAIT, |snapshot| {
            assert_eq!(snapshot.progress, Some(10));
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    {
        PreparedEvent::Frame(frame) => frame,
        _ => panic!("queued progress frame expected"),
    };

    let auth::Outcome::Changed(true) = owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::Logout {
                token: Secret::new(token),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("logout expected")
    };

    assert!(matches!(
        subscription.admit(prepared, |_| NonblockingSend::Accepted),
        FrameAdmission::Closed(StreamClose::Revoked)
    ));

    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
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

fn auth_call(owner: &WriterOwner, policy: AuthPolicy, request: auth::Request) -> auth::Outcome {
    owner
        .auth_with_policy(policy)
        .unwrap()
        .submit(request, Arc::new(AtomicBool::new(false)), WAIT)
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}

fn assert_prepared_session_frame_revoked(revoke: impl FnOnce(&WriterOwner, &str)) {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "session-revocation");
    let subscription = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::Session(Secret::new(token.clone())),
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let PreparedEvent::Frame(prepared) = subscription
        .prepare(WAIT, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    else {
        panic!("prepared initial frame expected")
    };

    revoke(&owner, &token);
    let mut sent = false;
    assert_eq!(
        subscription.admit(prepared, |_| {
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

#[test]
fn key_metadata_touch_stays_healthy_then_rotation_revokes_prepared_frame() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "key-rotation");
    let auth::Outcome::User(Some(user)) = auth_call(
        &owner,
        policy(),
        auth::Request::ResolveSession {
            token: Secret::new(token.clone()),
        },
    ) else {
        panic!("user expected")
    };
    let auth::Outcome::KeyCreated { info, key } = auth_call(
        &owner,
        policy(),
        auth::Request::CreateKey {
            session: Secret::new(token.clone()),
        },
    ) else {
        panic!("key expected")
    };
    let key_text = key.expose().to_owned();
    let jobs = owner.jobs(policy()).unwrap();
    let healthy = jobs
        .subscribe(
            Credential::RoutedKey {
                tenant: user.tenant_id.clone(),
                key: Secret::new(key_text.clone()),
            },
            id.clone(),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let PreparedEvent::Frame(prepared) = healthy
        .prepare(WAIT, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    else {
        panic!("prepared initial frame expected")
    };
    assert!(matches!(
        auth_call(
            &owner,
            policy(),
            auth::Request::ResolveKey {
                tenant_id: user.tenant_id.clone(),
                key: Secret::new(key_text.clone()),
            }
        ),
        auth::Outcome::KeyResolved {
            principal: Some(_),
            ..
        }
    ));
    assert_eq!(
        healthy.admit(prepared, |_| NonblockingSend::Accepted),
        FrameAdmission::Admitted
    );

    let rotated = jobs
        .subscribe(
            Credential::RoutedKey {
                tenant: user.tenant_id,
                key: Secret::new(key_text),
            },
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let PreparedEvent::Frame(prepared) = rotated
        .prepare(WAIT, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    else {
        panic!("prepared initial frame expected")
    };
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
        rotated.admit(prepared, |_| NonblockingSend::Accepted),
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
    let outcome = owner
        .jobs(single_account_policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
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
        .unwrap();
    let Outcome::Job(job, _) = outcome else {
        panic!("job expected")
    };
    let subscription = owner
        .jobs(single_account_policy())
        .unwrap()
        .subscribe(
            Credential::Session(Secret::new(token)),
            job.job_id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let PreparedEvent::Frame(prepared) = subscription
        .prepare(WAIT, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    else {
        panic!("prepared initial frame expected")
    };
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
        subscription.admit(prepared, |_| NonblockingSend::Accepted),
        FrameAdmission::Closed(StreamClose::Revoked)
    );
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn persisted_key_expiry_blocks_prepared_frame_without_writer_traffic() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let auth = owner
        .auth_with_policy_and_lifetimes(
            policy(),
            AuthLifetimes::shorter(Duration::from_secs(10), Some(Duration::from_secs(1))).unwrap(),
        )
        .unwrap();
    let auth::Outcome::Session { token, user } = auth
        .submit(
            auth::Request::Register {
                email: "key-expiry@example.com".into(),
                display_name: "Key expiry".into(),
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
    let id = enqueue(&owner, &token, "key-expiry");
    let auth::Outcome::KeyCreated { key, .. } = auth
        .submit(
            auth::Request::CreateKey {
                session: Secret::new(token),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("key expected")
    };
    let subscription = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::RoutedKey {
                tenant: user.tenant_id,
                key,
            },
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let PreparedEvent::Frame(prepared) = subscription
        .prepare(WAIT, |snapshot| {
            Ok::<_, std::convert::Infallible>(snapshot.clone())
        })
        .unwrap()
    else {
        panic!("prepared initial frame expected")
    };
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        subscription.admit(prepared, |_| NonblockingSend::Accepted),
        FrameAdmission::Closed(StreamClose::Expired)
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
    let auth = owner.auth_with_policy(policy()).unwrap();
    let auth::Outcome::User(Some(user)) = auth
        .submit(
            auth::Request::ResolveSession {
                token: Secret::new(token.clone()),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("user expected")
    };
    let auth::Outcome::KeyCreated { info, key } = auth
        .submit(
            auth::Request::CreateKey {
                session: Secret::new(token.clone()),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("key expected")
    };
    let subscription = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::RoutedKey {
                tenant: user.tenant_id,
                key,
            },
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let auth::Outcome::KeyChanged { changed: true, .. } = auth
        .submit(
            auth::Request::RevokeKey {
                session: Secret::new(token),
                key_id: info.id,
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("key revocation expected")
    };
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
    let jobs = owner.jobs(policy()).unwrap();
    let subscription = jobs
        .subscribe(
            Credential::Session(Secret::new(token.clone())),
            id.clone(),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::CheckSourceUpdates, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    for progress in 1..=16 {
        worker
            .update(&mut lease, WorkerOperation::Progress(progress))
            .unwrap();
    }
    assert!(matches!(
        next(&subscription, WAIT),
        TestStreamEvent::Closed(StreamClose::Lagged)
    ));
    let reconnect = jobs
        .subscribe(
            Credential::Session(Secret::new(token)),
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let TestStreamEvent::Snapshot(snapshot) = next(&reconnect, WAIT) else {
        panic!("current snapshot expected")
    };
    assert_eq!(snapshot.progress, Some(16));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn complete_retained_list_exceeds_two_hundred_and_keeps_insertion_ties() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let ids = (0..206)
        .map(|index| enqueue(&owner, &token, &format!("job-{index}")))
        .collect::<Vec<_>>();
    let listed = owner
        .jobs(policy())
        .unwrap()
        .list_retained(
            Credential::Session(Secret::new(token)),
            LegacyListFilter::default(),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    assert_eq!(listed.len(), 206);
    let insertion = ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<std::collections::HashMap<_, _>>();
    assert!(listed.windows(2).all(|pair| {
        pair[0].updated_at > pair[1].updated_at
            || (pair[0].updated_at == pair[1].updated_at
                && insertion[pair[0].job_id.as_str()] < insertion[pair[1].job_id.as_str()])
    }));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn observation_is_atomic_ordered_terminal_and_revoked_before_queued_data() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner);
    let id = enqueue(&owner, &token, "observed");
    let subscription = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::Session(Secret::new(token.clone())),
            id,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::CheckSourceUpdates, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
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
    let revoked = owner
        .jobs(policy())
        .unwrap()
        .subscribe(
            Credential::Session(Secret::new(token.clone())),
            second,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let auth::Outcome::Changed(true) = owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::Logout {
                token: Secret::new(token),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("logout expected")
    };
    assert!(matches!(
        next(&revoked, WAIT),
        TestStreamEvent::Closed(StreamClose::Revoked)
    ));
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}
