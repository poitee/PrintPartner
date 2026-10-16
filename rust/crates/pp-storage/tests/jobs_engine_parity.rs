#![cfg(feature = "desktop_rebuild")]
//! Replays the Node job runner golden in `fixtures/parity/jobs-engine`.
//! Regenerate it with `node fixtures/parity/jobs-engine/generate.mjs`.
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    jobs::{Credential, JobAccessFailure, Outcome, Payload, UserOperation},
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
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/jobs-engine/jobs-engine.json"
    ))
    .unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    let path = std::env::temp_dir().join(format!(
        "pp-jobs-engine-parity-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
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
