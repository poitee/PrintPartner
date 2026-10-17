#![cfg(feature = "desktop_rebuild")]
//! Replays the Node job runner golden in `fixtures/parity/jobs-engine`.
//! Regenerate it with `node fixtures/parity/jobs-engine/generate.mjs`.
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    jobs::{
        CompletedResult, Credential, JobAccessFailure, JobKind, LegacyListFilter,
        LegacyProfileFilter, LegacyStatusFilter, Outcome, Payload, UserOperation, WorkerAdmission,
        WorkerOperation,
    },
};
use std::{
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

fn session(owner: &WriterOwner, email: &str) -> Credential {
    let auth::Outcome::Session { token, .. } = owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::Register {
                email: email.into(),
                display_name: "Parity".into(),
                password: Secret::new("long-test-password".into()),
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
    Credential::Session(token)
}

fn golden() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/jobs-engine/jobs-engine.json"
    ))
    .unwrap()
}

fn open() -> WriterOwner {
    let path = std::env::temp_dir().join(format!(
        "pp-jobs-engine-parity-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    WriterOwner::open(&path, Limits::default()).unwrap().0
}

fn copy(credential: &Credential) -> Credential {
    match credential {
        Credential::Session(token) => Credential::Session(Secret::new(token.expose().into())),
        _ => unreachable!(),
    }
}

fn call(
    owner: &WriterOwner,
    credential: Credential,
    operation: UserOperation,
) -> anyhow::Result<Outcome> {
    owner
        .jobs(policy())?
        .submit(
            credential,
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()
}

/// Node starts a job and immediately reports it pending at progress 0, then
/// hides it from every other tenant. The durable engine stores the job, so its
/// queued message names worker admission ("Waiting for a compatible worker")
/// instead of Node's "Queued"; the reference model keeps that wording.
#[test]
fn enqueued_jobs_project_like_node_and_stay_tenant_private() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    let owner = open();
    let tenant_a = session(&owner, "parity-a@example.com");
    let tenant_b = session(&owner, "parity-b@example.com");
    for case in cases {
        let payload = match case["kind"].as_str().unwrap() {
            "check-source-updates" => Payload::CheckSourceUpdates {},
            "export-checklist-html" => Payload::ExportChecklistHtml { profile_id: 7 },
            other => panic!("unexpected kind {other}"),
        };
        let Outcome::Job(job, _) = call(
            &owner,
            copy(&tenant_a),
            UserOperation::Enqueue {
                key: case["id"].as_str().unwrap().into(),
                payload_version: 1,
                payload,
            },
        )
        .unwrap() else {
            panic!("job expected")
        };
        let Outcome::Job(read, _) = call(
            &owner,
            copy(&tenant_a),
            UserOperation::Get {
                job_id: job.job_id.clone(),
            },
        )
        .unwrap() else {
            panic!("job expected")
        };
        let snapshot = serde_json::to_value(read.snapshot()).unwrap();
        for field in ["kind", "status", "progress", "result", "error"] {
            assert_eq!(
                snapshot[field], case["queued"][field],
                "{} {field}",
                case["id"]
            );
        }

        assert!(case["other_tenant"].is_null() && case["other_tenant_stream"].is_null());
        let hidden = call(
            &owner,
            copy(&tenant_b),
            UserOperation::Get { job_id: job.job_id },
        )
        .err()
        .expect("other tenant read the job");
        assert_eq!(
            hidden.downcast_ref::<JobAccessFailure>(),
            Some(&JobAccessFailure::NotFound)
        );
        assert_eq!(hidden.to_string(), "Job not found");
    }
    owner.shutdown().unwrap();
}

fn enqueue(owner: &WriterOwner, credential: &Credential, key: &str, payload: Payload) {
    call(
        owner,
        copy(credential),
        UserOperation::Enqueue {
            key: key.into(),
            payload_version: 1,
            payload,
        },
    )
    .unwrap();
}

/// Node runs the update check to an empty result and fails the checklist
/// export, which finishes later. The durable worker finishes the first with
/// Node's literal result and fails the second a second later, because stored
/// times have whole-second precision. The public read and every retained list
/// filter then match Node's kinds, statuses and newest-first order.
#[test]
fn finished_and_retained_jobs_read_and_list_like_node() {
    let golden = golden();
    let finished = golden["finished"].as_array().unwrap();
    assert_eq!(finished.len(), 2);
    let owner = open();
    let tenant_a = session(&owner, "retained-a@example.com");
    let tenant_b = session(&owner, "retained-b@example.com");
    let client = owner.jobs(policy()).unwrap();
    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![
                    (JobKind::CheckSourceUpdates, 1),
                    (JobKind::ExportChecklistHtml, 1),
                ],
                total: 2,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();

    let done = &finished[0];
    assert_eq!(done["kind"], "check-source-updates");
    enqueue(
        &owner,
        &tenant_a,
        done["id"].as_str().unwrap(),
        Payload::CheckSourceUpdates {},
    );
    let (job, mut lease) = worker.claim().unwrap().unwrap();
    let result = serde_json::from_value(done["snapshot"]["result"].clone()).unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::FinishPublic {
                artifact: None,
                result: Box::new(CompletedResult::SourceUpdates(result)),
            },
        )
        .unwrap();
    let snapshot = client
        .read_public(
            copy(&tenant_a),
            job.job_id.clone(),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let snapshot = serde_json::to_value(snapshot).unwrap();
    for field in ["kind", "status", "message", "progress", "result", "error"] {
        assert_eq!(snapshot[field], done["snapshot"][field], "{field}");
    }
    let hidden = client
        .read_public(
            copy(&tenant_b),
            job.job_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(
        hidden.downcast_ref::<JobAccessFailure>(),
        Some(&JobAccessFailure::NotFound)
    );

    std::thread::sleep(Duration::from_millis(1100));
    let failed = &finished[1];
    assert_eq!(failed["kind"], "export-checklist-html");
    enqueue(
        &owner,
        &tenant_a,
        failed["id"].as_str().unwrap(),
        Payload::ExportChecklistHtml { profile_id: 7 },
    );
    let (_, mut lease) = worker.claim().unwrap().unwrap();
    let job = worker.update(&mut lease, WorkerOperation::Fail).unwrap();
    assert_eq!(job.snapshot().status, failed["status"]);

    let retained = golden["retained"].as_array().unwrap();
    assert_eq!(retained.len(), 9);
    for case in retained {
        let id = case["id"].as_str().unwrap();
        let (credential, filter) = match id {
            "all" => (&tenant_a, LegacyListFilter::default()),
            "done" => (
                &tenant_a,
                LegacyListFilter {
                    status: LegacyStatusFilter::Exact("done".into()),
                    ..Default::default()
                },
            ),
            "unknown_status" => (
                &tenant_a,
                LegacyListFilter {
                    status: LegacyStatusFilter::Exact("bogus".into()),
                    ..Default::default()
                },
            ),
            "profile_7" | "profile_8" => (
                &tenant_a,
                LegacyListFilter {
                    profile: LegacyProfileFilter::Exact(id[8..].parse().unwrap()),
                    ..Default::default()
                },
            ),
            "non_numeric_profile" => (
                &tenant_a,
                LegacyListFilter {
                    profile: LegacyProfileFilter::NoMatch,
                    ..Default::default()
                },
            ),
            "since_epoch" => (
                &tenant_a,
                LegacyListFilter {
                    since_millis: Some(0),
                    ..Default::default()
                },
            ),
            "since_future" => (
                &tenant_a,
                LegacyListFilter {
                    since_millis: Some(4_102_444_800_000),
                    ..Default::default()
                },
            ),
            "other_tenant" => (&tenant_b, LegacyListFilter::default()),
            other => panic!("unexpected list case {other}"),
        };
        let jobs = client
            .list_retained(
                copy(credential),
                filter,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap()
            .iter()
            .map(|job| serde_json::json!({"kind": job.kind, "status": job.status}))
            .collect::<Vec<_>>();
        assert_eq!(serde_json::Value::from(jobs), case["jobs"], "{id}");
    }
    owner.shutdown().unwrap();
}
