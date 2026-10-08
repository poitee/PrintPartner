use pp_core::uploads::{SourceImports, Through};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::{self, CreateSource, SourcePatch},
    jobs::{self, Credential, JobKind, WorkerAdmission},
    uploads::{
        Admission, AdmissionLimits, CaptureId, CaptureJournalCorrelation, CapturedInputV2,
        CapturedPayloadV1, File, Input, Phase, Postprocessing, State, Target,
    },
};
use rusqlite::{Connection, OpenFlags};
use sha2::Digest;
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

#[test]
fn resolved_claim_rechecks_eleven_fields_before_attempt_mutation() {
    let (root, files_root, owner) = fixture();
    let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
    let bytes = std::fs::read(files_root.join("triangle.stl")).unwrap();
    let files = vec![File {
        path: "triangle.stl".into(),
        size: bytes.len() as u64,
        sha256: hex::encode(sha2::Sha256::digest(&bytes)),
        kind: "input".into(),
    }];
    let limits = AdmissionLimits {
        reserved_bytes: 3_506_438_144,
        max_input_bytes: 268_435_456,
        max_prepared_bytes: 1_073_741_824,
    };
    let preflight = client
        .preflight_capture(
            credential(&owner),
            "retained-claim".into(),
            create("Retained claim"),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits,
        )
        .unwrap();
    let prepared = preflight
        .prepare(
            CaptureId::new("ab".repeat(32)).unwrap(),
            "retained-claim".into(),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits,
            files.clone(),
        )
        .unwrap();
    let manifest = prepared.manifest().to_vec();
    let admitted = client
        .admit_prepared(prepared, 0, client.accounting_epoch())
        .unwrap();
    let before: (i64, i64, String, String) = read(&root)
        .query_row(
            "SELECT json_extract(document,'$.attempt'), json_extract(document,'$.generation'), COALESCE(json_extract(document,'$.lease_until'),'null'), COALESCE(json_extract(document,'$._attempt_fence'),'') FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    let fields = [
        "manifest_version",
        "capture_id",
        "operation_key",
        "actor",
        "target",
        "target_digest",
        "input",
        "admission_limits",
        "policy_digest",
        "requested_files",
        "requested_digest",
    ];
    for field in fields {
        let mut value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
        value[field] = serde_json::json!(null);
        let result =
            client.correlate_capture_manifest(serde_json::to_vec(&value).unwrap(), files.clone());
        assert!(
            result.is_err()
                || !matches!(result.unwrap(), CaptureJournalCorrelation::ExactAdmitted(_)),
            "{field} mutation produced a claim"
        );
        let after: (i64, i64, String, String) = read(&root)
            .query_row(
                "SELECT json_extract(document,'$.attempt'), json_extract(document,'$.generation'), COALESCE(json_extract(document,'$.lease_until'),'null'), COALESCE(json_extract(document,'$._attempt_fence'),'') FROM durable_jobs WHERE id=?1",
                [&admitted.job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(after, before, "{field} mutated claim state");
    }
    let resolved = match client
        .correlate_capture_manifest(manifest.clone(), files.clone())
        .unwrap()
    {
        CaptureJournalCorrelation::ExactAdmitted(resolved) => resolved,
        _ => panic!("exact manifest did not resolve"),
    };
    let correlation_before: (String, i64, String, String, String) = read(&root)
        .query_row(
            "SELECT j.state,j.version,j.document,o.state,o.document FROM durable_jobs j JOIN source_import_operations o ON o.job_id=j.id WHERE j.id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    let write = Connection::open(root.join("print-partner.db")).unwrap();
    write.busy_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        write
            .execute(
                "UPDATE projects SET tenant_id='foreign-retained-claim' WHERE tenant_id='default' AND id=?1",
                [admitted.source_id],
            )
            .unwrap(),
        1
    );
    drop(write);
    let correlation_after_move: (String, i64, String, String, String) = read(&root)
        .query_row(
            "SELECT j.state,j.version,j.document,o.state,o.document FROM durable_jobs j JOIN source_import_operations o ON o.job_id=j.id WHERE j.id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(correlation_after_move, correlation_before);
    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::SuppliedSourceImport, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let repair = match worker.claim_resolved_import(resolved) {
        Err(error) => error,
        Ok(_) => panic!("resolved claim accepted a Source owned by another tenant"),
    };
    assert_eq!(repair.to_string(), "Captured import requires repair");
    let correlation_after_claim: (String, i64, String, String, String) = read(&root)
        .query_row(
            "SELECT j.state,j.version,j.document,o.state,o.document FROM durable_jobs j JOIN source_import_operations o ON o.job_id=j.id WHERE j.id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(correlation_after_claim, correlation_before);
    let write = Connection::open(root.join("print-partner.db")).unwrap();
    write.busy_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        write
            .execute(
                "UPDATE projects SET tenant_id='default' WHERE tenant_id='foreign-retained-claim' AND id=?1",
                [admitted.source_id],
            )
            .unwrap(),
        1
    );
    drop(write);
    let resolved = match client
        .correlate_capture_manifest(manifest.clone(), files.clone())
        .unwrap()
    {
        CaptureJournalCorrelation::ExactAdmitted(resolved) => resolved,
        _ => panic!("restored manifest did not resolve"),
    };
    let claim = worker.claim_resolved_import(resolved).unwrap().unwrap();
    let claimed = &claim.job;
    let lease = &claim.lease;
    assert_eq!(claimed.attempt, 1);
    assert_eq!(claimed.generation, 1);
    assert!(claim.source_work.is_some());
    assert!(
        matches!(claimed.payload, jobs::Payload::SuppliedSourceImport { project_id, .. } if project_id as i64 == admitted.source_id)
    );
    let busy = match owner.local_source_catalog().begin_work(
        admitted.source_id,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    ) {
        Err(error) => error,
        Ok(_) => panic!("resolved claim must own its Source before core work begins"),
    };
    assert!(busy.downcast_ref::<catalog::SourceBusy>().is_some());
    let catalog::Outcome::Source(Some(unrelated)) = owner
        .local_source_catalog()
        .execute(catalog::Request::Create {
            source: CreateSource {
                name: "Unrelated retained Source".into(),
                source_kind: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("unrelated Source")
    };
    let mut unrelated_work = owner
        .local_source_catalog()
        .begin_work(
            unrelated.id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    unrelated_work.release().unwrap();
    worker
        .import_phase(
            lease,
            Phase::Owned(pp_storage::uploads::OwnedInput {
                locator: format!(".pp-imports/{}", admitted.job_id),
                digest: hex::encode(sha2::Sha256::digest(serde_json::to_vec(&files).unwrap())),
                files: files.clone(),
            }),
        )
        .unwrap();
    assert!(matches!(
        client
            .correlate_capture_manifest(manifest, files.clone())
            .unwrap(),
        CaptureJournalCorrelation::ExactOwnedOrLater
    ));
    let absent = client
        .preflight_capture(
            credential(&owner),
            "ordered-absent".into(),
            Target::Existing {
                source_id: admitted.source_id,
            },
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits,
        )
        .unwrap()
        .prepare(
            CaptureId::new("cd".repeat(32)).unwrap(),
            "ordered-absent".into(),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits,
            files.clone(),
        )
        .unwrap();
    assert!(matches!(
        client
            .correlate_capture_manifest(absent.manifest().to_vec(), files)
            .unwrap(),
        CaptureJournalCorrelation::Absent
    ));
    drop(claim);
    let mut released = owner
        .local_source_catalog()
        .begin_work(
            admitted.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    released.release().unwrap();
    drop(worker);
    drop(client);
    owner.shutdown().unwrap();
}

#[test]
fn resolved_revoked_authority_commits_before_busy_source_observation() {
    struct RefusalSnapshot {
        state: String,
        attempt: i64,
        generation: i64,
        refusal_generation: i64,
        fence: Option<String>,
        cursor: i64,
        admitted_generation: i64,
        cancel_requested: i64,
        operation_cursor: i64,
        observation_rows: i64,
        attempt_rows: i64,
        operation_state: String,
        preclaim_rows: i64,
    }

    let (root, files_root, owner) = fixture();
    let token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "resolved-busy@example.test".into(),
            display_name: "Resolved busy".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token.expose().to_owned(),
        _ => panic!("session"),
    };
    let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
    let bytes = std::fs::read(files_root.join("triangle.stl")).unwrap();
    let files = vec![File {
        path: "triangle.stl".into(),
        size: bytes.len() as u64,
        sha256: hex::encode(sha2::Sha256::digest(&bytes)),
        kind: "input".into(),
    }];
    let limits = AdmissionLimits {
        reserved_bytes: 3_506_438_144,
        max_input_bytes: 268_435_456,
        max_prepared_bytes: 1_073_741_824,
    };
    let credential = || Credential::Session(Secret::new(token.clone()));
    let prepared = client
        .preflight_capture(
            credential(),
            "resolved-authority-busy".into(),
            create("Resolved authority busy"),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits,
        )
        .unwrap()
        .prepare(
            CaptureId::new("ef".repeat(32)).unwrap(),
            "resolved-authority-busy".into(),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits,
            files.clone(),
        )
        .unwrap();
    let manifest = prepared.manifest().to_vec();
    let admitted = client
        .admit_prepared(prepared, 0, client.accounting_epoch())
        .unwrap();
    let authority: String = read(&root)
        .query_row(
            "SELECT json_type(document,'$._authority') FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(authority, "object", "original authority expected");
    let resolved = match client
        .correlate_capture_manifest(manifest.clone(), files.clone())
        .unwrap()
    {
        CaptureJournalCorrelation::ExactAdmitted(resolved) => resolved,
        _ => panic!("exact manifest did not resolve"),
    };
    let catalog = owner
        .source_catalog_with_policy(
            catalog::Credentials::Session(Secret::new(token.clone())),
            policy(),
        )
        .unwrap();
    let busy = catalog
        .begin_work(
            admitted.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    auth_call(
        &owner,
        policy(),
        auth::Request::Logout {
            token: Secret::new(token),
        },
    );
    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::SuppliedSourceImport, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let failure = match worker.claim_resolved_import(resolved) {
        Err(error) => error,
        Ok(_) => panic!("revoked resolved claim was accepted"),
    };
    assert!(
        matches!(
            failure.downcast_ref::<auth::AuthorityFailure>(),
            Some(auth::AuthorityFailure::CredentialInvalid)
        ),
        "{failure:?}"
    );
    assert!(failure.downcast_ref::<catalog::SourceBusy>().is_none());
    let refusal = read(&root)
        .query_row(
            "SELECT j.state,
                    json_extract(j.document,'$.attempt'),
                    json_extract(j.document,'$.generation'),
                    json_extract(j.document,'$._authority_refusal.generation'),
                    json_extract(j.document,'$._attempt_fence'),
                    p.cursor,p.admitted_generation,p.cancel_requested,
                    json_extract(o.document,'$.observation_cursor'),
                    (SELECT COUNT(*) FROM source_revision_observations r WHERE r.tenant_id=o.tenant AND r.operation_key=o.operation_key),
                    (SELECT COUNT(*) FROM source_revision_attempts a WHERE a.tenant_id=o.tenant AND a.operation_key=o.operation_key),
                    o.state,
                    (SELECT COUNT(*) FROM source_preclaim_refusals q WHERE q.tenant_id=o.tenant AND q.operation_key=o.operation_key)
               FROM durable_jobs j
               JOIN source_import_operations o ON o.job_id=j.id
               JOIN source_preclaim_refusals p ON p.tenant_id=o.tenant AND p.operation_key=o.operation_key
              WHERE j.id=?1",
            [&admitted.job_id],
            |row| {
                Ok(RefusalSnapshot {
                    state: row.get(0)?,
                    attempt: row.get(1)?,
                    generation: row.get(2)?,
                    refusal_generation: row.get(3)?,
                    fence: row.get(4)?,
                    cursor: row.get(5)?,
                    admitted_generation: row.get(6)?,
                    cancel_requested: row.get(7)?,
                    operation_cursor: row.get(8)?,
                    observation_rows: row.get(9)?,
                    attempt_rows: row.get(10)?,
                    operation_state: row.get(11)?,
                    preclaim_rows: row.get(12)?,
                })
            },
        )
        .unwrap();
    let RefusalSnapshot {
        state,
        attempt,
        generation,
        refusal_generation,
        fence,
        cursor,
        admitted_generation,
        cancel_requested,
        operation_cursor,
        observation_rows,
        attempt_rows,
        operation_state,
        preclaim_rows,
    } = refusal;
    assert_eq!((state, attempt, generation), ("failed".into(), 0, 1));
    assert_eq!((refusal_generation, fence), (0, None));
    assert_eq!((cursor, admitted_generation, cancel_requested), (1, 0, 0));
    assert_eq!(
        (operation_cursor, observation_rows, attempt_rows),
        (1, 0, 0)
    );
    assert_eq!((operation_state, preclaim_rows), ("admitted".into(), 1));

    let resolved_again = match client.correlate_capture_manifest(manifest, files).unwrap() {
        CaptureJournalCorrelation::ExactAdmitted(resolved) => resolved,
        _ => panic!("terminal preclaim refusal no longer correlated exactly"),
    };
    assert!(
        worker
            .claim_resolved_import(resolved_again)
            .unwrap()
            .is_none()
    );
    let repeated: (i64, i64) = read(&root)
        .query_row(
            "SELECT json_extract(document,'$.observation_cursor'),
                    (SELECT COUNT(*) FROM source_preclaim_refusals p WHERE p.tenant_id=o.tenant AND p.operation_key=o.operation_key)
               FROM source_import_operations o WHERE job_id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(repeated, (1, 1));
    drop(busy);
    drop(worker);
    drop(catalog);
    drop(client);
    owner.shutdown().unwrap();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 40);
    let reopened: (i64, i64, i64) = read(&root)
        .query_row(
            "SELECT p.cursor,p.admitted_generation,json_extract(j.document,'$.generation')
               FROM source_preclaim_refusals p
               JOIN source_import_operations o ON o.tenant=p.tenant_id AND o.operation_key=p.operation_key
               JOIN durable_jobs j ON j.id=o.job_id
              WHERE j.id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(reopened, (1, 0, 1));
    owner.shutdown().unwrap();
}

#[test]
fn preclaim_refusal_event_and_terminal_job_commit_atomically() {
    for fail_late in [false, true] {
        let (root, files_root, owner) = fixture();
        let token = match auth_call(
            &owner,
            policy(),
            auth::Request::Register {
                email: format!("preclaim-atomic-{fail_late}@example.test"),
                display_name: "Preclaim atomicity".into(),
                password: Secret::new("ordinary-password".into()),
            },
        ) {
            auth::Outcome::Session { token, .. } => token.expose().to_owned(),
            _ => panic!("session"),
        };
        let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
        let bytes = std::fs::read(files_root.join("triangle.stl")).unwrap();
        let files = vec![File {
            path: "triangle.stl".into(),
            size: bytes.len() as u64,
            sha256: hex::encode(sha2::Sha256::digest(&bytes)),
            kind: "input".into(),
        }];
        let limits = AdmissionLimits {
            reserved_bytes: 3_506_438_144,
            max_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
        };
        let prepared = client
            .preflight_capture(
                Credential::Session(Secret::new(token.clone())),
                format!("preclaim-atomic-{fail_late}"),
                create("Preclaim atomicity"),
                CapturedPayloadV1::files(vec!["triangle.stl".into()]),
                limits,
            )
            .unwrap()
            .prepare(
                CaptureId::new(if fail_late { "12" } else { "34" }.repeat(32)).unwrap(),
                format!("preclaim-atomic-{fail_late}"),
                CapturedPayloadV1::files(vec!["triangle.stl".into()]),
                limits,
                files.clone(),
            )
            .unwrap();
        let manifest = prepared.manifest().to_vec();
        let admitted = client
            .admit_prepared(prepared, 0, client.accounting_epoch())
            .unwrap();
        let before: (String, i64, String, String) = read(&root)
            .query_row(
                "SELECT j.state,j.version,j.document,o.document
                   FROM durable_jobs j JOIN source_import_operations o ON o.job_id=j.id
                  WHERE j.id=?1",
                [&admitted.job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let resolved = match client
            .correlate_capture_manifest(manifest.clone(), files.clone())
            .unwrap()
        {
            CaptureJournalCorrelation::ExactAdmitted(resolved) => resolved,
            _ => panic!("exact manifest did not resolve"),
        };
        auth_call(
            &owner,
            policy(),
            auth::Request::Logout {
                token: Secret::new(token),
            },
        );
        let trigger = if fail_late {
            format!(
                "CREATE TRIGGER fail_preclaim_atomicity BEFORE UPDATE ON durable_jobs
                 WHEN OLD.id='{}' AND NEW.generation=1
                 BEGIN SELECT RAISE(ABORT,'late preclaim fixture'); END;",
                admitted.job_id
            )
        } else {
            format!(
                "CREATE TRIGGER fail_preclaim_atomicity BEFORE INSERT ON source_preclaim_refusals
                 WHEN NEW.job_id='{}'
                 BEGIN SELECT RAISE(ABORT,'early preclaim fixture'); END;",
                admitted.job_id
            )
        };
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .execute_batch(&trigger)
            .unwrap();
        let worker = owner
            .job_worker_with_policy(
                policy(),
                WorkerAdmission {
                    kinds: vec![(JobKind::SuppliedSourceImport, 1)],
                    total: 1,
                    per_resource: 1,
                    lease_seconds: 3600,
                },
            )
            .unwrap();
        assert!(worker.claim_resolved_import(resolved).is_err());
        let after: (String, i64, String, String, i64, i64) = read(&root)
            .query_row(
                "SELECT j.state,j.version,j.document,o.document,
                        (SELECT COUNT(*) FROM source_preclaim_refusals p WHERE p.job_id=j.id),
                        (SELECT COUNT(*) FROM source_revision_observations r WHERE r.job_id=j.id)
                   FROM durable_jobs j JOIN source_import_operations o ON o.job_id=j.id
                  WHERE j.id=?1",
                [&admitted.job_id],
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
        assert_eq!((after.0, after.1, after.2, after.3), before);
        assert_eq!((after.4, after.5), (0, 0));
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .execute_batch("DROP TRIGGER fail_preclaim_atomicity")
            .unwrap();
        let resolved = match client.correlate_capture_manifest(manifest, files).unwrap() {
            CaptureJournalCorrelation::ExactAdmitted(resolved) => resolved,
            _ => panic!("rolled-back preclaim no longer correlated exactly"),
        };
        let failure = match worker.claim_resolved_import(resolved) {
            Err(error) => error,
            Ok(_) => panic!("rolled-back preclaim refusal was accepted"),
        };
        assert!(matches!(
            failure.downcast_ref::<auth::AuthorityFailure>(),
            Some(auth::AuthorityFailure::CredentialInvalid)
        ));
        let committed: (i64, i64) = read(&root)
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM source_preclaim_refusals p WHERE p.job_id=j.id),
                    json_extract(j.document,'$.generation')
                   FROM durable_jobs j WHERE j.id=?1",
                [&admitted.job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(committed, (1, 1));
        drop(worker);
        drop(client);
        owner.shutdown().unwrap();
    }
}

#[test]
fn targeted_claim_owns_source_before_core_work() {
    let (_root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("targeted-claim-owner", create("Targeted claim owner")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker(WorkerAdmission {
            kinds: vec![(JobKind::SuppliedSourceImport, 1), (JobKind::ImportScan, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let claim = worker.claim_import(&admitted.job_id).unwrap().unwrap();

    assert!(
        owner
            .local_source_catalog()
            .begin_work(
                admitted.source_id,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .is_err(),
        "targeted claim must own its Source before core work begins"
    );

    assert!(claim.source_work.is_some());
    drop(claim);
    let mut released = owner
        .local_source_catalog()
        .begin_work(
            admitted.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    released.release().unwrap();
    drop(svc);
    owner.shutdown().unwrap();
}

fn temp() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "source-import-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn fixture() -> (PathBuf, PathBuf, WriterOwner) {
    let root = temp();
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Ordinary Source\n").unwrap();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 40);
    (root, files, owner)
}
fn request(key: &str, target: Target) -> Admission {
    Admission {
        key: key.into(),
        target,
        input: Input::Files {
            paths: vec!["triangle.stl".into(), "README.md".into()],
        },
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 65536,
        max_prepared_bytes: 65536,
    }
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}
fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}
fn zip_bytes(name: &str, content: &[u8]) -> Vec<u8> {
    let name = name.as_bytes();
    let size = u32::try_from(content.len()).unwrap();
    let checksum = crc32(content);
    let mut output = Vec::new();
    push_u32(&mut output, 0x0403_4b50);
    push_u16(&mut output, 20);
    push_u16(&mut output, 0x0800);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, checksum);
    push_u32(&mut output, size);
    push_u32(&mut output, size);
    push_u16(&mut output, u16::try_from(name.len()).unwrap());
    push_u16(&mut output, 0);
    output.extend_from_slice(name);
    output.extend_from_slice(content);
    let central_offset = u32::try_from(output.len()).unwrap();
    push_u32(&mut output, 0x0201_4b50);
    push_u16(&mut output, 20);
    push_u16(&mut output, 20);
    push_u16(&mut output, 0x0800);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, checksum);
    push_u32(&mut output, size);
    push_u32(&mut output, size);
    push_u16(&mut output, u16::try_from(name.len()).unwrap());
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, 0);
    push_u32(&mut output, 0);
    output.extend_from_slice(name);
    let central_size = u32::try_from(output.len()).unwrap() - central_offset;
    push_u32(&mut output, 0x0605_4b50);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 1);
    push_u16(&mut output, 1);
    push_u32(&mut output, central_size);
    push_u32(&mut output, central_offset);
    push_u16(&mut output, 0);
    output
}
fn captured_zip_request(key: &str, target: Target, zip: &[u8]) -> Admission {
    let limits = AdmissionLimits {
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 65536,
        max_prepared_bytes: 65536,
    };
    let requested = vec![File {
        path: "upload.zip".into(),
        size: zip.len().try_into().unwrap(),
        sha256: hex::encode(sha2::Sha256::digest(zip)),
        kind: "input".into(),
    }];
    let input = Input::Captured(
        CapturedInputV2::bind(
            CaptureId::new(format!("capture-{key}")).unwrap(),
            CapturedPayloadV1::zip("upload.zip".into()),
            "physical-owner",
            key,
            &target,
            limits,
            &requested,
        )
        .unwrap(),
    );
    Admission {
        key: key.into(),
        target,
        input,
        reserved_bytes: limits.reserved_bytes,
        max_input_bytes: limits.max_input_bytes,
        max_prepared_bytes: limits.max_prepared_bytes,
    }
}
fn create(name: &str) -> Target {
    Target::Create {
        metadata: Box::new(CreateSource {
            name: name.into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            ..Default::default()
        }),
    }
}
fn credential(owner: &WriterOwner) -> Credential {
    Credential::PhysicalOwner(owner.job_physical_owner())
}
fn service(owner: &WriterOwner) -> SourceImports {
    SourceImports::new(owner, policy(), 128 * 1024 * 1024).unwrap()
}
fn read(root: &Path) -> Connection {
    Connection::open_with_flags(
        root.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
fn count(root: &Path, table: &str) -> i64 {
    read(root)
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
#[derive(Debug, PartialEq, Eq)]
struct SourceObservation {
    cursor: i64,
    phase: String,
    job_id: String,
    generation: i64,
    fence: Option<String>,
    revision_id: Option<i64>,
    activated: Option<bool>,
    cancelled: bool,
}

fn observations(root: &Path, key: &str) -> Vec<SourceObservation> {
    read(root)
        .prepare("SELECT cursor,phase,job_id,attempt_generation,attempt_fence,revision_id,receipt_activated,cancel_requested FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor")
        .unwrap()
        .query_map([key], |row| {
            Ok(SourceObservation {
                cursor: row.get(0)?,
                phase: row.get(1)?,
                job_id: row.get(2)?,
                generation: row.get(3)?,
                fence: row.get(4)?,
                revision_id: row.get(5)?,
                activated: row.get(6)?,
                cancelled: row.get(7)?,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn cancel(owner: &WriterOwner, id: String) {
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(owner),
            jobs::UserOperation::Cancel { job_id: id },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
}
fn durable_job(owner: &WriterOwner, id: &str) -> jobs::JobRecord {
    match owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(owner),
            jobs::UserOperation::Get { job_id: id.into() },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        jobs::Outcome::Job(job, _) => job,
        _ => panic!("job result required"),
    }
}
#[test]
fn create_update_exact_retry_never_repoints_and_preserves_originals() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(admitted.state, State::Admitted);
    let first = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(first.receipt.as_ref().unwrap().activated);
    assert!(first.cleanup_settled);
    assert_eq!(
        first.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert_eq!(count(&root, "source_docs"), 1);
    assert_eq!(count(&root, "source_revisions"), 1);
    assert_eq!(count(&root, "source_revision_attempts"), 1);
    assert_eq!(count(&root, "source_revision_artifacts"), 1);
    assert_eq!(count(&root, "source_revision_observations"), 4);
    assert_eq!(
        first.authority_revision.as_ref().unwrap().producer_version,
        "supplied-source-import-v1"
    );
    let old = first.artifact.as_ref().unwrap();
    let old_bytes =
        std::fs::read(root.join("repos").join(&old.locator).join("triangle.stl")).unwrap();
    assert_eq!(
        old_bytes,
        include_bytes!("fixtures/source-import/triangle.stl")
    );
    let retry = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(retry, first);
    let unchanged_admitted = svc
        .admit(
            credential(&owner),
            request(
                "unchanged",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let unchanged = svc
        .work_operation(
            &unchanged_admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        unchanged.receipt.as_ref().unwrap().revision_id,
        first.receipt.as_ref().unwrap().revision_id
    );
    assert_eq!(count(&root, "source_revisions"), 1);
    assert_eq!(count(&root, "source_revision_attempts"), 2);
    assert_eq!(count(&root, "source_revision_artifacts"), 1);
    std::fs::write(
        files.join("triangle.stl"),
        String::from_utf8(old_bytes.clone())
            .unwrap()
            .replace("vertex 1 0 0", "vertex 2 0 0"),
    )
    .unwrap();
    let second_admitted = svc
        .admit(
            credential(&owner),
            request(
                "two",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let second = svc
        .work_operation(
            &second_admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_ne!(
        second.artifact.as_ref().unwrap().upstream_key,
        old.upstream_key
    );
    assert_eq!(count(&root, "source_revisions"), 2);
    assert_eq!(count(&root, "source_revision_attempts"), 3);
    assert_eq!(count(&root, "source_revision_artifacts"), 2);
    assert_eq!(svc.get(credential(&owner), "one".into()).unwrap(), first);
    let current: i64 = read(&root)
        .query_row(
            "SELECT current_source_revision_id FROM projects WHERE id=?1",
            [first.source_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, second.receipt.unwrap().revision_id);
    assert_eq!(
        std::fs::read(root.join("repos").join(&old.locator).join("triangle.stl")).unwrap(),
        old_bytes
    );
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete {
                id: first.source_id
            })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::RetainedHistory)
    ));
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn restart_each_durable_fact_and_exact_activation_acknowledgement() {
    for through in [
        None,
        Some(Through::OwnedInput),
        Some(Through::Published),
        Some(Through::Activated),
    ] {
        let (root, files, owner) = fixture();
        let svc = service(&owner);
        let admitted = svc
            .admit(
                credential(&owner),
                request("restart", create("Restart")),
                &files,
                &AtomicBool::new(false),
            )
            .unwrap();
        let before = through.map(|t| {
            svc.work_operation(&admitted.job_id, Some(&files), t, &AtomicBool::new(false))
                .unwrap()
                .unwrap()
        });
        assert!(matches!(
            owner
                .local_source_catalog()
                .execute(catalog::Request::Delete {
                    id: admitted.source_id
                })
                .unwrap(),
            catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
        ));
        let prior_observations = observations(&root, &admitted.key);
        if !prior_observations.is_empty() {
            let context: (i64, String) = read(&root)
                .query_row(
                    "SELECT generation,json_extract(document,'$._attempt_fence') FROM durable_jobs WHERE id=?1",
                    [&admitted.job_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            for observation in &prior_observations {
                assert_eq!(observation.job_id, admitted.job_id);
                assert_eq!(observation.generation, context.0);
                assert_eq!(observation.fence.as_ref(), Some(&context.1));
                assert!(!observation.cancelled);
            }
        }
        drop(svc);
        owner.shutdown().unwrap();
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let svc = service(&owner);
        assert!(matches!(
            owner
                .local_source_catalog()
                .execute(catalog::Request::Delete {
                    id: admitted.source_id
                })
                .unwrap(),
            catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
        ));
        let resumed = if through.is_none() {
            svc.work_operation(
                &admitted.job_id,
                Some(&files),
                Through::Settled,
                &AtomicBool::new(false),
            )
        } else {
            svc.work_next(Through::Settled, &AtomicBool::new(false))
        }
        .unwrap()
        .unwrap();
        assert_eq!(resumed.source_id, admitted.source_id);
        assert!(resumed.cleanup_settled);
        let receipt = resumed.receipt.as_ref().unwrap();
        let job_context: (i64, Option<String>, i64) = read(&root)
            .query_row(
                "SELECT json_extract(document,'$.generation'),json_extract(document,'$._attempt_fence'),json_extract(document,'$.cancel_requested') FROM durable_jobs WHERE id=?1",
                [&admitted.job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let observation_context: (
            String,
            i64,
            Option<String>,
            Option<i64>,
            Option<i64>,
            i64,
            String,
        ) = read(&root)
            .query_row(
                "SELECT job_id,attempt_generation,attempt_fence,revision_id,receipt_activated,cancel_requested,phase FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor DESC LIMIT 1",
                [&admitted.key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        let observation_fence = observation_context.2.as_ref().unwrap();
        assert!(
            observation_fence.len() == 64
                && observation_fence
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert_eq!(
            read(&root)
                .query_row(
                    "SELECT COUNT(DISTINCT attempt_fence) FROM source_revision_observations WHERE operation_key=?1 AND attempt_generation=?2",
                    rusqlite::params![admitted.key, observation_context.1],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            (
                observation_context.0,
                observation_context.1,
                observation_context.3,
                observation_context.4,
                observation_context.5,
                observation_context.6,
            ),
            (
                admitted.job_id.clone(),
                job_context.0,
                Some(receipt.revision_id),
                Some(1),
                job_context.2,
                "cleanup".into(),
            )
        );
        let all_observations = observations(&root, &admitted.key);
        assert_eq!(
            all_observations[..prior_observations.len()],
            prior_observations
        );
        let resumed_fence = all_observations.last().unwrap().fence.as_ref().unwrap();
        if let Some(prior) = prior_observations.last() {
            assert!(job_context.0 > prior.generation);
            assert_ne!(Some(resumed_fence), prior.fence.as_ref());
        }
        for (index, observation) in all_observations.iter().enumerate() {
            assert_eq!(observation.cursor, index as i64 + 1);
            let has_receipt = matches!(observation.phase.as_str(), "activated" | "cleanup");
            assert_eq!(
                observation.revision_id,
                has_receipt.then_some(receipt.revision_id)
            );
            assert_eq!(observation.activated, has_receipt.then_some(true));
            if index >= prior_observations.len() {
                assert_eq!(observation.job_id, admitted.job_id);
                assert_eq!(observation.generation, job_context.0);
                assert_eq!(observation.fence.as_ref(), Some(resumed_fence));
                assert!(!observation.cancelled);
            }
        }
        if let Some(receipt) = before.and_then(|o| o.receipt) {
            assert_eq!(resumed.receipt.unwrap(), receipt);
        }
        assert_eq!(count(&root, "source_revisions"), 1);
        assert_eq!(
            read(&root)
                .query_row(
                    "SELECT SUM(reserved_bytes) FROM source_import_quota",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(svc);
        owner.shutdown().unwrap();
    }
}
#[test]
fn captured_zip_has_explicit_ready_only_ownership_and_nfc_replay() {
    let (root, files, owner) = fixture();
    let zip = zip_bytes(
        "cafe\u{301}.stl",
        include_bytes!("fixtures/source-import/triangle.stl"),
    );
    std::fs::write(files.join("upload.zip"), &zip).unwrap();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            captured_zip_request("captured-zip", create("Captured ZIP"), &zip),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(admitted.input_version, 2);
    let ordinary_worker = owner
        .job_worker_with_policy(
            policy(),
            jobs::WorkerAdmission {
                kinds: vec![
                    (jobs::JobKind::SuppliedSourceImport, 1),
                    (jobs::JobKind::ImportScan, 1),
                ],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    assert!(ordinary_worker.claim().unwrap().is_none());
    assert!(
        svc.work_next(Through::OwnedInput, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        svc.get(credential(&owner), admitted.key.clone())
            .unwrap()
            .state,
        State::Admitted
    );
    let settled = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(settled.cleanup_settled);
    assert!(
        settled
            .artifact
            .as_ref()
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == "caf\u{e9}.stl")
    );
    assert_eq!(
        settled.requested_digest,
        hex::encode(sha2::Sha256::digest(
            serde_json::to_vec(&settled.requested_files).unwrap()
        ))
    );
    let (quota_reserved, quota_settled): (i64, bool) = read(&root)
        .query_row(
            "SELECT reserved_bytes,settled FROM source_import_quota WHERE operation_key=?1",
            [&settled.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(quota_reserved, 0);
    assert!(quota_settled);
    assert_eq!(settled.reserved_bytes, 20 * 1024 * 1024);
    drop(svc);
    owner.shutdown().unwrap();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    assert_eq!(
        svc.get(credential(&owner), settled.key.clone()).unwrap(),
        settled
    );
    let legacy = svc
        .admit(
            credential(&owner),
            Admission {
                key: "legacy-strict-zip".into(),
                target: create("Legacy Strict ZIP"),
                input: Input::Zip {
                    path: "upload.zip".into(),
                },
                reserved_bytes: 20 * 1024 * 1024,
                max_input_bytes: 65536,
                max_prepared_bytes: 65536,
            },
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.work_operation(
            &legacy.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    assert_eq!(
        svc.get(credential(&owner), legacy.key).unwrap().state,
        State::Failed
    );
    drop(svc);
    owner.shutdown().unwrap();
}

#[test]
fn archived_captured_job_reopens_and_rejects_future_payload_version_without_mutation() {
    let (root, files, owner) = fixture();
    let zip = zip_bytes(
        "archived.stl",
        include_bytes!("fixtures/source-import/triangle.stl"),
    );
    std::fs::write(files.join("upload.zip"), &zip).unwrap();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            captured_zip_request("captured-archive", create("Captured Archive"), &zip),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let settled = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(settled.cleanup_settled);
    drop(svc);
    owner.shutdown().unwrap();

    let database = root.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut job: serde_json::Value = serde_json::from_str(&raw).unwrap();
    job["updated_at"] = serde_json::json!(0);
    connection
        .execute(
            "UPDATE durable_jobs SET updated=0,document=?2 WHERE id=?1",
            (&admitted.job_id, serde_json::to_string(&job).unwrap()),
        )
        .unwrap();
    drop(connection);

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    owner.shutdown().unwrap();
    let connection = Connection::open(&database).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM durable_jobs WHERE id=?1",
                [&admitted.job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert!(
        connection
            .query_row(
                "SELECT archived_document IS NOT NULL FROM durable_job_keys WHERE job_id=?1",
                [&admitted.job_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
    );
    drop(connection);

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(
        service(&owner)
            .get(credential(&owner), admitted.key.clone())
            .unwrap(),
        settled
    );
    owner.shutdown().unwrap();

    let connection = Connection::open(&database).unwrap();
    let archived: String = connection
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&admitted.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut future: serde_json::Value = serde_json::from_str(&archived).unwrap();
    future["payload_version"] = serde_json::json!(2);
    connection
        .execute(
            "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
            (&admitted.job_id, serde_json::to_string(&future).unwrap()),
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&database).unwrap();
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert!(!root.join(".desktop-owner.json").exists());
}
#[test]
fn changed_source_binding_refuses_registration_before_cas() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("conflict", create("Conflict")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    svc.work_operation(
        &op.job_id,
        Some(&files),
        Through::Published,
        &AtomicBool::new(false),
    )
    .unwrap();
    owner
        .local_source_catalog()
        .execute(catalog::Request::Update {
            id: op.source_id,
            patch: SourcePatch {
                branch: Some("newer".into()),
                ..Default::default()
            },
        })
        .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let error = svc
        .work_next(Through::Settled, &AtomicBool::new(false))
        .unwrap_err();
    assert!(error.to_string().contains("Source configuration changed"));
    assert_eq!(count(&root, "source_revisions"), 0);
    let row: (String, Option<i64>) = read(&root)
        .query_row(
            "SELECT branch,current_source_revision_id FROM projects WHERE id=?1",
            [op.source_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("newer".into(), None));
    assert_eq!(count(&root, "source_docs"), 0);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn active_pointer_competition_registers_inactive_revision_with_attempt_provenance() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let base = svc
        .import(
            credential(&owner),
            request("pointer-base", create("Pointer competition")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let first_files = root.join("pointer-first");
    let second_files = root.join("pointer-second");
    std::fs::create_dir(&first_files).unwrap();
    std::fs::create_dir(&second_files).unwrap();
    for directory in [&first_files, &second_files] {
        std::fs::copy(files.join("triangle.stl"), directory.join("triangle.stl")).unwrap();
        std::fs::copy(files.join("README.md"), directory.join("README.md")).unwrap();
    }
    std::fs::write(
        first_files.join("triangle.stl"),
        std::fs::read_to_string(first_files.join("triangle.stl"))
            .unwrap()
            .replace("vertex 1 0 0", "vertex 3 0 0"),
    )
    .unwrap();
    std::fs::write(
        second_files.join("triangle.stl"),
        std::fs::read_to_string(second_files.join("triangle.stl"))
            .unwrap()
            .replace("vertex 1 0 0", "vertex 2 0 0"),
    )
    .unwrap();
    let first = svc
        .admit(
            credential(&owner),
            request(
                "pointer-first",
                Target::Existing {
                    source_id: base.source_id,
                },
            ),
            &first_files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let second = svc
        .admit(
            credential(&owner),
            request(
                "pointer-second",
                Target::Existing {
                    source_id: base.source_id,
                },
            ),
            &second_files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(first.basis, second.basis);
    assert_eq!(
        first.basis.current_source_revision_id,
        base.receipt.as_ref().map(|receipt| receipt.revision_id)
    );
    let activated = svc
        .work_operation(
            &first.job_id,
            Some(&first_files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let after_first: i64 = read(&root)
        .query_row(
            "SELECT current_source_revision_id FROM projects WHERE id=?1",
            [base.source_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after_first, activated.receipt.as_ref().unwrap().revision_id);
    assert_ne!(after_first, first.basis.current_source_revision_id.unwrap());
    assert_eq!(
        svc.get(credential(&owner), second.key.clone())
            .unwrap()
            .basis,
        second.basis
    );
    let inactive = svc
        .work_operation(
            &second.job_id,
            Some(&second_files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_ne!(
        activated.artifact.as_ref().unwrap().upstream_key,
        inactive.artifact.as_ref().unwrap().upstream_key
    );
    assert!(activated.receipt.as_ref().unwrap().activated);
    assert_eq!(inactive.state, State::Conflict);
    assert!(!inactive.receipt.as_ref().unwrap().activated);
    assert_eq!(count(&root, "source_revisions"), 3);
    assert_eq!(count(&root, "source_revision_attempts"), 3);
    assert_eq!(count(&root, "source_revision_artifacts"), 3);
    let current: i64 = read(&root)
        .query_row(
            "SELECT current_source_revision_id FROM projects WHERE id=?1",
            [base.source_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(current, activated.receipt.unwrap().revision_id);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn quota_atomic_admission_missing_duplicate_cancelled_and_unsupported() {
    let (root, files, owner) = fixture();
    let tiny = SourceImports::new(&owner, policy(), 1024).unwrap();
    assert!(
        tiny.admit(
            credential(&owner),
            request("tiny", create("Tiny")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "projects"), 0);
    drop(tiny);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = SourceImports::new(&owner, policy(), 30 * 1024 * 1024).unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("missing", Target::Existing { source_id: 999 }),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.admit(
            credential(&owner),
            request("cancelled", create("Cancelled")),
            &files,
            &AtomicBool::new(true)
        )
        .is_err()
    );
    let one = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("two", create("Two")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let other_token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "other-tenant@example.test".into(),
            display_name: "Other tenant".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token,
        _ => panic!("session"),
    };
    assert!(
        svc.admit(
            Credential::Session(other_token),
            request("other-tenant", create("Other tenant")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "projects"), 1);
    assert_eq!(count(&root, "source_import_quota"), 1);
    assert_eq!(count(&root, "durable_jobs"), 1);
    let revisions = root
        .join("repos")
        .join(one.source_id.to_string())
        .join("revisions");
    for candidate in [
        ".pp-source-archives/.candidate",
        ".pp-source-media/.candidate",
        ".pp-source-candidate",
    ] {
        let path = revisions.join(candidate);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("ordinary.txt"), "ordinary pending staging").unwrap();
    }
    cancel(&owner, one.job_id.clone());
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: one.source_id })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    let cancelled = svc
        .work_operation(&one.job_id, None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert!(cancelled.cleanup_settled);
    assert!(cancelled.receipt.is_none());
    for candidate in [
        ".pp-source-archives/.candidate",
        ".pp-source-media/.candidate",
        ".pp-source-candidate",
    ] {
        assert!(!revisions.join(candidate).exists());
    }
    assert!(
        svc.admit(
            credential(&owner),
            request("duplicate", create("One")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    std::fs::write(files.join("notes.txt"), "ordinary unsupported text").unwrap();
    let mut unsupported = request("unsupported", create("Unsupported"));
    unsupported.input = Input::Files {
        paths: vec!["notes.txt".into()],
    };
    let op = svc
        .admit(
            credential(&owner),
            unsupported,
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.work_operation(
            &op.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    let failed = svc.get(credential(&owner), op.key).unwrap();
    assert_eq!(failed.state, State::Failed);
    assert!(failed.cleanup_settled);
    assert_eq!(
        std::fs::read_to_string(files.join("notes.txt")).unwrap(),
        "ordinary unsupported text"
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn stale_attempt_cannot_write_import_phases() {
    let (_root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("stale", create("Stale")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker_with_policy(
            policy(),
            jobs::WorkerAdmission {
                kinds: vec![
                    (jobs::JobKind::SuppliedSourceImport, 1),
                    (jobs::JobKind::ImportScan, 1),
                ],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let mut claim = worker.claim_import(&op.job_id).unwrap().unwrap();
    let lease = claim.lease;
    cancel(&owner, op.job_id.clone());
    assert!(worker.import_phase(&lease, Phase::Read).is_err());
    assert!(
        worker
            .begin_source_work(
                &lease,
                None,
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .is_err()
    );
    drop(claim.source_work.take());
    let done = svc
        .work_operation(&op.job_id, None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(done.state, State::Cancelled);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn cancelled_import_cannot_overlap_source_work() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("overlap", create("Overlap")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker(jobs::WorkerAdmission {
            kinds: vec![
                (jobs::JobKind::SuppliedSourceImport, 1),
                (jobs::JobKind::ImportScan, 1),
            ],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let first = worker.claim_import(&op.job_id).unwrap().unwrap();
    let source = first.source_work.unwrap();
    let owned = root.join("repos/.pp-imports").join(&op.job_id);
    std::fs::create_dir_all(&owned).unwrap();
    std::fs::write(owned.join("held.txt"), "held by the fenced attempt").unwrap();
    cancel(&owner, op.job_id.clone());
    let before = durable_job(&owner, &op.job_id);
    let error =
        match svc.work_operation(&op.job_id, None, Through::Settled, &AtomicBool::new(false)) {
            Err(error) => error,
            Ok(_) => panic!("cancelled import reclaimed an active Source"),
        };
    assert!(
        error
            .downcast_ref::<pp_storage::catalog::SourceBusy>()
            .is_some()
    );
    let after = durable_job(&owner, &op.job_id);
    assert_eq!(after.state_version, before.state_version);
    assert_eq!(after.attempt, before.attempt);
    assert_eq!(after.generation, before.generation);
    assert!(owned.join("held.txt").exists());
    drop(source);
    let cancelled = svc
        .work_operation(&op.job_id, None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert!(!owned.exists());
    drop(svc);
    owner.shutdown().unwrap();
}
fn auth_call(owner: &WriterOwner, p: AuthPolicy, r: auth::Request) -> auth::Outcome {
    owner
        .auth_with_policy(p)
        .unwrap()
        .submit(r, Arc::new(AtomicBool::new(false)), Duration::from_secs(5))
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}
#[test]
fn original_session_revocation_after_snapshot_keeps_source_inactive() {
    let (root, files, owner) = fixture();
    let strict = AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
        first_user: FirstUserTenant::NewUser,
    };
    let token = match auth_call(
        &owner,
        strict,
        auth::Request::Register {
            email: "source-revision-authority@example.test".into(),
            display_name: "Source revision authority".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token.expose().to_owned(),
        _ => panic!("session"),
    };
    let service = SourceImports::new(&owner, strict, 128 * 1024 * 1024).unwrap();
    let admitted = service
        .admit(
            Credential::Session(Secret::new(token.clone())),
            request(
                "source-revision-authority",
                create("Source revision authority"),
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let published = service
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Published,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(published.state, State::Published);
    assert_eq!(count(&root, "source_revisions"), 0);
    auth_call(
        &owner,
        strict,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    );
    drop(service);
    owner.shutdown().unwrap();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let resumed = SourceImports::new(&owner, strict, 128 * 1024 * 1024).unwrap();
    let error = resumed
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<auth::AuthorityFailure>(),
        Some(&auth::AuthorityFailure::CredentialInvalid)
    );
    assert_eq!(count(&root, "source_revisions"), 0);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT state FROM durable_jobs WHERE id=?1",
                [&admitted.job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "failed"
    );
    let refusal: (String, i64) = read(&root)
        .query_row(
            "SELECT json_extract(document,'$._authority_refusal.phase'),json_extract(document,'$._authority_refusal.generation') FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(refusal.0, "targeted_claim");
    assert!(refusal.1 > 0);
    let job_context: (i64, i64, Option<String>, i64) = read(&root)
        .query_row(
            "SELECT json_extract(document,'$.generation'),json_extract(document,'$._authority_refusal.generation'),json_extract(document,'$._attempt_fence'),json_extract(document,'$.cancel_requested') FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    let source = read(&root);
    let last_source_phase: String = source
        .query_row(
            "SELECT phase FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor DESC LIMIT 1",
            [&admitted.key],
            |row| row.get(0),
        )
        .unwrap();
    let source_context_columns = source
        .prepare("PRAGMA table_info(source_revision_observations)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let required_context = [
        "job_id",
        "attempt_generation",
        "attempt_fence",
        "revision_id",
        "receipt_activated",
        "cancel_requested",
    ];
    let has_context = required_context.iter().all(|expected| {
        source_context_columns
            .iter()
            .any(|actual| actual == expected)
    });
    let exact_refusal_context = if has_context {
        let row: (String, i64, Option<String>, Option<i64>, Option<i64>, i64) = source
            .query_row(
                "SELECT job_id,attempt_generation,attempt_fence,revision_id,receipt_activated,cancel_requested FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor DESC LIMIT 1",
                [&admitted.key],
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
        row == (admitted.job_id.clone(), refusal.1, None, None, None, 0)
    } else {
        false
    };
    eprintln!(
        "targeted refusal job_generation={} refusal_generation={} final_fence_present={} cancel_requested={} source_phase={} source_columns={source_context_columns:?}",
        job_context.0,
        job_context.1,
        job_context.2.is_some(),
        job_context.3,
        last_source_phase,
    );
    assert!(
        last_source_phase == "authority_refused" && exact_refusal_context,
        "targeted claim refusal did not emit a Source cursor with exact generation, fence, result, and cancellation context"
    );
    drop(resumed);
    owner.shutdown().unwrap();
}
#[test]
fn original_session_revocation_after_claim_commits_source_writer_refusal() {
    let (root, files, owner) = fixture();
    let strict = AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
        first_user: FirstUserTenant::NewUser,
    };
    let token = match auth_call(
        &owner,
        strict,
        auth::Request::Register {
            email: "source-writer-refusal@example.test".into(),
            display_name: "Source writer refusal".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token.expose().to_owned(),
        _ => panic!("session"),
    };
    let service = SourceImports::new(&owner, strict, 128 * 1024 * 1024).unwrap();
    let admitted = service
        .admit(
            Credential::Session(Secret::new(token.clone())),
            request("source-writer-refusal", create("Source writer refusal")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker_with_policy(
            strict,
            WorkerAdmission {
                kinds: vec![(JobKind::SuppliedSourceImport, 1), (JobKind::ImportScan, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let claim = worker.claim_import(&admitted.job_id).unwrap().unwrap();
    let claimed_context: (i64, String, i64) = read(&root)
        .query_row(
            "SELECT json_extract(document,'$.generation'),json_extract(document,'$._attempt_fence'),json_extract(document,'$.cancel_requested') FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    auth_call(
        &owner,
        strict,
        auth::Request::Logout {
            token: Secret::new(token),
        },
    );
    let error = worker.import_phase(&claim.lease, Phase::Read).unwrap_err();
    assert_eq!(
        error.downcast_ref::<auth::AuthorityFailure>(),
        Some(&auth::AuthorityFailure::CredentialInvalid)
    );
    assert_eq!(count(&root, "source_revisions"), 0);
    let refusal: String = read(&root)
        .query_row(
            "SELECT json_extract(document,'$._authority_refusal.phase') FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(refusal, "source_writer");
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT phase FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor DESC LIMIT 1",
                [&admitted.key],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "authority_refused"
    );
    let source_context: (String, i64, Option<String>, Option<i64>, Option<i64>, i64) = read(&root)
        .query_row(
            "SELECT job_id,attempt_generation,attempt_fence,revision_id,receipt_activated,cancel_requested FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor DESC LIMIT 1",
            [&admitted.key],
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
    assert_eq!(
        source_context,
        (
            admitted.job_id.clone(),
            claimed_context.0,
            Some(claimed_context.1),
            None,
            None,
            claimed_context.2,
        )
    );
    drop(claim.source_work);
    drop(worker);
    drop(service);
    owner.shutdown().unwrap();
}
#[test]
fn real_session_policy_key_actor_replay_revocation_and_atomic_audit() {
    let (root, files, owner) = fixture();
    let strict = AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
        first_user: FirstUserTenant::NewUser,
    };
    let (user, token) = match auth_call(
        &owner,
        strict,
        auth::Request::Register {
            email: "source@example.test".into(),
            display_name: "Source user".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { user, token } => (user, token.expose().to_owned()),
        _ => panic!("session"),
    };
    let svc = SourceImports::new(&owner, strict, 128 * 1024 * 1024).unwrap();
    let admitted = svc
        .admit(
            Credential::Session(Secret::new(token.clone())),
            request("session", create("Session")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let activated = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(activated.state, State::Activated);
    assert_eq!(admitted.tenant, "default");
    assert_eq!(admitted.actor, format!("user:{}", user.user_id));
    assert!(svc.get(credential(&owner), "session".into()).is_err());
    assert!(
        svc.admit(
            credential(&owner),
            request("session", create("Session")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.admit(
            Credential::Session(Secret::new(token.clone())),
            request("session", create("Different intent")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let neutral = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    assert!(
        neutral
            .get(
                Credential::Session(Secret::new(token.clone())),
                "session".into()
            )
            .is_err()
    );
    let (key_id, key) = match auth_call(
        &owner,
        strict,
        auth::Request::CreateKey {
            session: Secret::new(token.clone()),
        },
    ) {
        auth::Outcome::KeyCreated { info, key } => (info.id, key.expose().to_owned()),
        _ => panic!("key"),
    };
    let before: Option<String> = read(&root)
        .query_row(
            "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1' AND ?1 IS NOT NULL",
            [&key_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        svc.admit(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone())
            },
            request("bad-key-import", Target::Existing { source_id: 999 }),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let after: Option<String> = read(&root)
        .query_row(
            "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1' AND ?1 IS NOT NULL",
            [&key_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert!(
        svc.admit(
            Credential::RoutedKey {
                tenant: user.user_id.clone(),
                key: Secret::new(key.clone())
            },
            request("wrong-route", create("Wrong")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let keyed = svc
        .admit(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone()),
            },
            request("key", create("Key")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        svc.work_operation(
            &keyed.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false)
        )
        .unwrap()
        .unwrap()
        .state,
        State::Activated
    );
    assert_ne!(keyed.actor, admitted.actor);
    assert!(
        svc.get(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone())
            },
            "session".into()
        )
        .is_err()
    );
    auth_call(
        &owner,
        strict,
        auth::Request::RevokeKey {
            session: Secret::new(token.clone()),
            key_id,
        },
    );
    assert!(
        svc.get(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key)
            },
            "key".into()
        )
        .is_err()
    );
    auth_call(
        &owner,
        strict,
        auth::Request::Logout {
            token: Secret::new(token.clone()),
        },
    );
    assert!(
        svc.get(Credential::Session(Secret::new(token)), "session".into())
            .is_err()
    );
    drop(neutral);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn changed_content_replay_and_changed_during_capture_are_refused() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let first = svc
        .admit(
            credential(&owner),
            request("bound", create("Bound")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let original = std::fs::read(files.join("triangle.stl")).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        String::from_utf8(original.clone())
            .unwrap()
            .replace("vertex 1 0 0", "vertex 3 0 0"),
    )
    .unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("bound", create("Bound")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.work_operation(
            &first.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    let failed = svc.get(credential(&owner), first.key).unwrap();
    assert_eq!(failed.state, State::Failed);
    assert_eq!(count(&root, "source_revisions"), 0);
    assert!(failed.cleanup_settled);
    drop(svc);
    owner.shutdown().unwrap();
}

fn remove_schema40_and_39(connection: &Connection) {
    connection
        .execute_batch(
            "DROP INDEX source_scan_execution_receipt;
             DROP TABLE source_scan_executions;
             DROP TRIGGER trg_source_preclaim_refusals_immutable_update;
             DROP TRIGGER trg_source_preclaim_refusals_immutable_delete;
             DROP TRIGGER trg_source_preclaim_refusals_cursor_insert;
             DROP TRIGGER trg_source_revision_observations_preclaim_cursor_insert;
             DROP TABLE source_preclaim_refusals;",
        )
        .unwrap();
}

#[test]
fn schema37_backup_preserves35_and_future_or_corrupt_input_is_unchanged() {
    let (root, _files, owner) = fixture();
    owner.shutdown().unwrap();
    let db = root.join("print-partner.db");
    let conn = Connection::open(&db).unwrap();
    remove_schema40_and_39(&conn);
    conn.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    drop(conn);
    let before =
        graph(&Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap());
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(
        graph(
            &Connection::open_with_flags(ready.backup.unwrap(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap()
        ),
        before
    );
    owner.shutdown().unwrap();
    Connection::open(&db)
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let future = temp();
    std::fs::copy(&db, future.join("print-partner.db")).unwrap();
    let conn = Connection::open(future.join("print-partner.db")).unwrap();
    conn.execute(
        "UPDATE app_settings SET value='41' WHERE tenant_id='default' AND key='schema_version'",
        [],
    )
    .unwrap();
    drop(conn);
    let bytes = std::fs::read(future.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&future, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(future.join("print-partner.db")).unwrap(),
        bytes
    );
    assert!(!future.join(".desktop-owner.json").exists());
    let corrupt = temp();
    std::fs::copy(&db, corrupt.join("print-partner.db")).unwrap();
    let conn = Connection::open(corrupt.join("print-partner.db")).unwrap();
    conn.execute("DROP INDEX source_import_source", []).unwrap();
    drop(conn);
    let bytes = std::fs::read(corrupt.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&corrupt, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(corrupt.join("print-partner.db")).unwrap(),
        bytes
    );
    assert!(!corrupt.join(".desktop-owner.json").exists());
}

fn graph(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut query = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let n = query.column_count();
            let mut rows = query
                .query_map([], |r| {
                    let values = (0..n)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(format!("{values:?}"))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows.sort();
            (table, rows)
        })
        .collect()
}
#[test]
fn settlement_invalidates_stale_physical_usage_observation() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("first", create("First")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let stale = client.accounting_epoch();
    let old_bytes = pp_source::local_selection::stored_bytes(&root.join("repos")).unwrap();
    svc.work_operation(
        &admitted.job_id,
        Some(&files),
        Through::Settled,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        client
            .admit(
                credential(&owner),
                request("second", create("Second")),
                admitted.requested_files.clone(),
                old_bytes,
                stale,
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert_eq!(count(&root, "projects"), 1);
    let epoch = client.accounting_epoch();
    let bytes = pp_source::local_selection::stored_bytes(&root.join("repos")).unwrap();
    client
        .admit(
            credential(&owner),
            request("second", create("Second")),
            admitted.requested_files,
            bytes,
            epoch,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(count(&root, "projects"), 2);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn import_reads_do_not_invalidate_physical_usage_observation() {
    let (_root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("read-only", create("Read only")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let observed = client.accounting_epoch();

    svc.get(credential(&owner), admitted.key.clone()).unwrap();
    assert_eq!(client.accounting_epoch(), observed);

    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::SuppliedSourceImport, 1), (JobKind::ImportScan, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let claim = worker.claim_import(&admitted.job_id).unwrap().unwrap();
    let lease = claim.lease;
    worker.import_phase(&lease, Phase::Read).unwrap();
    assert_eq!(client.accounting_epoch(), observed);

    drop(claim.source_work);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn published_import_resumes_after_repaired_error_and_restart() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("published-retry", create("Published retry")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let published = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Published,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let artifact = published.artifact.as_ref().unwrap();
    let file = &artifact.files[0];
    let path = root.join("repos").join(&artifact.locator).join(&file.path);
    let contents = std::fs::read(&path).unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    std::fs::write(&path, b"damaged after publication").unwrap();

    assert!(
        svc.work_operation(
            &admitted.job_id,
            None,
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    std::fs::write(&path, contents).unwrap();
    let retained = svc.get(credential(&owner), admitted.key.clone()).unwrap();
    assert_eq!(retained.state, State::Published);
    assert!(!retained.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 0);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT reserved_bytes FROM source_import_quota WHERE operation_key=?1 AND settled=0",
                [&admitted.key],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        i64::try_from(admitted.reserved_bytes).unwrap()
    );

    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let resumed = svc
        .work_operation(
            &admitted.job_id,
            None,
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(resumed.state, State::Activated);
    assert!(resumed.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 1);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT reserved_bytes FROM source_import_quota WHERE operation_key=?1 AND settled=1",
                [&admitted.key],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn cancellation_after_activation_preserves_receipt_and_settles_cleanup() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("activated", create("Activated")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let activated = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Activated,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let before_cancel = observations(&root, &activated.key);
    cancel(&owner, activated.job_id.clone());
    let settled = svc
        .work_next(Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(settled.receipt, activated.receipt);
    assert_eq!(settled.state, State::Activated);
    assert!(settled.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 1);
    let after_cancel = observations(&root, &activated.key);
    assert_eq!(after_cancel[..before_cancel.len()], before_cancel);
    let cleanup = after_cancel.last().unwrap();
    assert_eq!(cleanup.phase, "cleanup");
    assert_eq!(cleanup.job_id, activated.job_id);
    assert!(cleanup.cancelled);
    assert!(cleanup.fence.is_some());
    let generation: i64 = read(&root)
        .query_row(
            "SELECT generation FROM durable_jobs WHERE id=?1",
            [&activated.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cleanup.generation, generation);
    assert_eq!(
        cleanup.revision_id,
        Some(activated.receipt.as_ref().unwrap().revision_id)
    );
    assert_eq!(cleanup.activated, Some(true));

    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn public_import_selects_its_own_job_and_directory_content() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let other = svc
        .admit(
            credential(&owner),
            request("other", create("Other")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let mut req = request("public", create("Public"));
    req.input = SourceImports::directory_input(&files).unwrap();
    let op = svc
        .import(credential(&owner), req, &files, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(op.key, "public");
    assert_eq!(op.state, State::Activated);
    let pending = svc.get(credential(&owner), other.key).unwrap();
    assert_eq!(pending.state, State::Admitted);
    assert_eq!(count(&root, "source_revisions"), 1);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn index_constraint_keeps_activation_receipt_and_previous_complete_doc_projection() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let first = svc
        .import(
            credential(&owner),
            request("initial", create("Docs")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let old_docs = read(&root)
        .prepare("SELECT id,path,content_hash FROM source_docs")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER ordinary_doc_constraint BEFORE INSERT ON source_docs WHEN NEW.path='README.md' BEGIN SELECT RAISE(ABORT,'ordinary document constraint'); END;").unwrap();
    drop(conn);
    std::fs::write(files.join("README.md"), "# Updated document\n").unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let op = svc
        .import(
            credential(&owner),
            request(
                "update",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(op.state, State::Activated);
    assert_eq!(
        op.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::IndexError
    );
    let docs = read(&root)
        .prepare("SELECT id,path,content_hash FROM source_docs")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(old_docs, docs);
    let document_columns = read(&root)
        .prepare("PRAGMA table_info(source_docs)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    eprintln!("source_docs columns after IndexError: {document_columns:?}");
    assert!(
        ["source_revision_id", "input_digest", "producer_version"]
            .iter()
            .all(|expected| document_columns.iter().any(|actual| actual == expected)),
        "preserved document rows lack immutable revision, full-input, and producer ownership"
    );
    let first_receipt = first.receipt.as_ref().unwrap();
    let first_authority = first_receipt.authority_revision.as_ref().unwrap();
    let preserved_provenance: (i64, String, String) = read(&root)
        .query_row(
            "SELECT source_revision_id,input_digest,producer_version FROM source_docs WHERE id=?1",
            [old_docs[0].0],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        preserved_provenance,
        (
            first_receipt.revision_id,
            first_authority.input_digest.clone(),
            first_authority.producer_version.clone(),
        )
    );
    assert_eq!(
        svc.get(credential(&owner), op.key.clone()).unwrap().receipt,
        op.receipt
    );
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .execute_batch("DROP TRIGGER ordinary_doc_constraint")
        .unwrap();
    std::fs::write(files.join("README.md"), "# Successful replacement\n").unwrap();
    let replacement = svc
        .import(
            credential(&owner),
            request(
                "replacement",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(replacement.state, State::Activated);
    let replacement_receipt = replacement.receipt.as_ref().unwrap();
    assert_eq!(
        replacement_receipt.postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    let replacement_authority = replacement_receipt.authority_revision.as_ref().unwrap();
    let replacement_provenance = read(&root)
        .prepare("SELECT source_revision_id,input_digest,producer_version FROM source_docs")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!replacement_provenance.is_empty());
    assert!(replacement_provenance.iter().all(|provenance| {
        provenance
            == &(
                replacement_receipt.revision_id,
                replacement_authority.input_digest.clone(),
                replacement_authority.producer_version.clone(),
            )
    }));
    drop(svc);
    owner.shutdown().unwrap();
}

#[test]
fn explicit_empty_import_selection_is_not_replaced_by_suggestions() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let initial = svc
        .import(
            credential(&owner),
            request("selection-initial", create("Selection")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        !initial
            .receipt
            .as_ref()
            .unwrap()
            .artifact
            .suggested_rules
            .is_empty()
    );
    let null_import_all_result: Vec<String> = serde_json::from_str(
        &read(&root)
            .query_row(
                "SELECT imported_paths FROM projects WHERE id=?1",
                [initial.source_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(!null_import_all_result.is_empty());

    owner
        .local_source_catalog()
        .execute(catalog::Request::SaveImportRules {
            id: initial.source_id,
            rules: Vec::new(),
        })
        .unwrap();
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT imported_paths FROM projects WHERE id=?1",
                [initial.source_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "[]"
    );

    std::fs::write(files.join("README.md"), "# Updated selection fixture\n").unwrap();
    let updated = svc
        .import(
            credential(&owner),
            request(
                "selection-update",
                Target::Existing {
                    source_id: initial.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(updated.state, State::Activated);
    assert!(
        !updated
            .receipt
            .as_ref()
            .unwrap()
            .artifact
            .suggested_rules
            .is_empty()
    );
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT imported_paths FROM projects WHERE id=?1",
                [initial.source_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "[]"
    );
    let explicit_subset = vec!["triangle.stl".to_owned()];
    owner
        .local_source_catalog()
        .execute(catalog::Request::SaveImportRules {
            id: initial.source_id,
            rules: explicit_subset.clone(),
        })
        .unwrap();
    std::fs::write(files.join("README.md"), "# Explicit subset fixture\n").unwrap();
    let subset = svc
        .import(
            credential(&owner),
            request(
                "selection-subset",
                Target::Existing {
                    source_id: initial.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(subset.state, State::Activated);
    let stored: String = read(&root)
        .query_row(
            "SELECT imported_paths FROM projects WHERE id=?1",
            [initial.source_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&stored).unwrap(),
        explicit_subset
    );
    drop(svc);
    owner.shutdown().unwrap();
}

#[test]
fn null_import_selection_accepts_first_import_suggestions() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let imported = svc
        .import(
            credential(&owner),
            request("null-selection-control", create("Null selection control")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let suggested = imported
        .receipt
        .as_ref()
        .unwrap()
        .artifact
        .suggested_rules
        .clone();
    assert!(!suggested.is_empty());
    let stored: Vec<String> = serde_json::from_str(
        &read(&root)
            .query_row(
                "SELECT imported_paths FROM projects WHERE id=?1",
                [imported.source_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stored, suggested);
    drop(svc);
    owner.shutdown().unwrap();
}

fn progress_history_fixture() -> (PathBuf, PathBuf, WriterOwner) {
    let root = temp();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("../../pp-storage/tests/fixtures/required-units/shrink.db"),
    )
    .unwrap();
    let repos = root.join("repos/1/revisions/fixture");
    std::fs::create_dir_all(&repos).unwrap();
    for name in ["bracket", "gear", "excluded"] {
        std::fs::write(repos.join(format!("{name}.stl")), format!("solid {name}")).unwrap();
    }
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Changed Source\n").unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    (root, files, owner)
}
fn progress_secret() -> Secret {
    Secret::new("required-unit-fixture-secret".into())
}
fn select_progress(owner: &WriterOwner) -> serde_json::Value {
    let case: serde_json::Value = serde_json::from_str(include_str!(
        "../../pp-storage/tests/fixtures/required-units/shrink.json"
    ))
    .unwrap();
    let command = pp_storage::required_units::ReconciliationCommand::new(
        serde_json::from_value(serde_json::json!(1)).unwrap(),
        serde_json::from_value(serde_json::json!(2)).unwrap(),
        serde_json::from_value(case["request"].clone()).unwrap(),
        "source-progress-selection".into(),
        pp_storage::read_model::Credential::Session(progress_secret()),
    )
    .unwrap();
    serde_json::to_value(
        owner
            .required_units()
            .reconcile(command, &AtomicBool::new(false), Duration::from_secs(5))
            .unwrap(),
    )
    .unwrap()
}
fn complete_progress(owner: &WriterOwner) {
    let response = owner
        .checkoff_progress()
        .apply(
            catalog::Credentials::Session(progress_secret()),
            pp_storage::checkoff_progress::Request::CompletionCoordinate {
                part_id: 1,
                body: serde_json::json!({"unit_index":1,"completed":true}),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(response.status, 200);
}
fn pinned_accepted(owner: &WriterOwner) -> Vec<u8> {
    let batch = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(progress_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matches!(
        batch.builds[0].accepted,
        pp_storage::read_model::AcceptedRead::Ready { .. }
    ));
    batch
        .builds
        .into_iter()
        .next()
        .unwrap()
        .accepted
        .into_json_body()
        .into_bytes()
}
#[test]
fn combined_pending_import_allows_progress_and_selection_then_preserves_pinned_history() {
    let (root, files, owner) = progress_history_fixture();
    let key = match auth_call(
        &owner,
        policy(),
        auth::Request::CreateKey {
            session: progress_secret(),
        },
    ) {
        auth::Outcome::KeyCreated { key, .. } => key.expose().to_owned(),
        _ => panic!("key"),
    };
    let key_credential = || Credential::RoutedKey {
        tenant: "default".into(),
        key: Secret::new(key.clone()),
    };
    let svc = service(&owner);
    let op = svc
        .admit(
            key_credential(),
            request("combined", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(op.actor.starts_with("key:"));
    assert!(!op.cleanup_settled);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    assert!(
        owner
            .jobs(policy())
            .unwrap()
            .submit(
                credential(&owner),
                jobs::UserOperation::Enqueue {
                    key: "generic-import".into(),
                    payload_version: 1,
                    payload: jobs::Payload::SuppliedSourceImport {
                        project_id: 1,
                        operation_key: "bypass".into(),
                        input_version: 1
                    },
                },
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .is_err()
    );
    complete_progress(&owner);
    let selected = select_progress(&owner);
    assert_eq!(selected["kind"], "ready");
    let accepted = pinned_accepted(&owner);
    let before = graph(&read(&root));
    let old_bytes = std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap();
    let completed = svc
        .work_operation(
            &op.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert!(completed.receipt.as_ref().unwrap().activated && completed.cleanup_settled);
    assert_ne!(completed.receipt.as_ref().unwrap().revision_id, 1);
    assert_eq!(pinned_accepted(&owner), accepted);
    assert_eq!(select_progress(&owner), selected);
    let after = graph(&read(&root));
    for (table, rows) in &before {
        if table.starts_with("plan_")
            || table.starts_with("accepted_")
            || ["parts", "required_units", "print_progress"].contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
    assert_eq!(
        std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap(),
        old_bytes
    );
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT COUNT(*) FROM source_docs WHERE project_id=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(read(&root).query_row("SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'", [], |r| r.get::<_,Option<String>>(0)).unwrap().is_some());
    assert_eq!(
        svc.get(key_credential(), "combined".into()).unwrap(),
        completed
    );
    drop(svc);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    assert_eq!(pinned_accepted(&owner), accepted);
    assert_eq!(select_progress(&owner), selected);
    let svc = service(&owner);
    assert_eq!(
        svc.get(key_credential(), "combined".into()).unwrap(),
        completed
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn combined_schema37_backup_preserves_selected_progress_and_jobs35_graph() {
    let (root, _, owner) = progress_history_fixture();
    complete_progress(&owner);
    let selected = select_progress(&owner);
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(&owner),
            jobs::UserOperation::Enqueue {
                key: "prior35".into(),
                payload_version: 1,
                payload: jobs::Payload::ImportScan { project_id: 1 },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    owner.shutdown().unwrap();
    let preparation_backup = root.join("fixture-preparation-backup.db");
    std::fs::rename(root.join("backups/pre-schema36.db"), &preparation_backup).unwrap();
    let preparation_bytes = std::fs::read(&preparation_backup).unwrap();
    let db = root.join("print-partner.db");
    let conn = Connection::open(&db).unwrap();
    remove_schema40_and_39(&conn);
    conn.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let before = graph(&conn);
    drop(conn);
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(ready.version, 40);
    let backup_copy = root.join("backup-copy.db");
    std::fs::copy(ready.backup.unwrap(), &backup_copy).unwrap();
    assert_eq!(graph(&Connection::open(backup_copy).unwrap()), before);
    assert_eq!(select_progress(&owner), selected);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    assert_eq!(count(&root, "source_import_operations"), 0);
    assert_eq!(count(&root, "durable_jobs"), 1);
    owner.shutdown().unwrap();
    assert_eq!(
        std::fs::read(preparation_backup).unwrap(),
        preparation_bytes
    );
}
#[test]
fn combined_obsolete_receipt_refuses_without_changing_progress_history() {
    let (root, files, owner) = progress_history_fixture();
    complete_progress(&owner);
    assert_eq!(select_progress(&owner)["kind"], "ready");
    let svc = service(&owner);
    svc.import(
        credential(&owner),
        request("obsolete", Target::Existing { source_id: 1 }),
        &files,
        &AtomicBool::new(false),
    )
    .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute("UPDATE source_import_operations SET document=json_set(document,'$.receipt.postprocessing','complete')", []).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(conn);
    let before = std::fs::read(root.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(root.join("print-partner.db")).unwrap(),
        before
    );
    assert!(!root.join(".desktop-owner.json").exists());
}

#[test]
fn combined_owner_quota_crosses_tenants_while_local_progress_remains_available() {
    let (root, files, owner) = progress_history_fixture();
    let svc = SourceImports::new(&owner, policy(), 30 * 1024 * 1024).unwrap();
    let token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "shared-capacity@example.test".into(),
            display_name: "Other tenant".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token.expose().to_owned(),
        _ => panic!("session"),
    };
    let foreign = || Credential::Session(Secret::new(token.clone()));
    let pending = svc
        .admit(
            credential(&owner),
            request("pending-default", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.admit(
            foreign(),
            request("foreign", create("Foreign")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "source_import_quota"), 1);
    complete_progress(&owner);
    let selected = select_progress(&owner);
    assert_eq!(selected["kind"], "ready");
    let first = svc
        .work_operation(
            &pending.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let reused = svc
        .import(
            credential(&owner),
            request("reuse", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        reused.receipt.as_ref().unwrap().revision_id,
        first.receipt.as_ref().unwrap().revision_id
    );
    let other = svc
        .admit(
            foreign(),
            request("foreign", create("Foreign")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_ne!(other.tenant, first.tenant);
    assert_eq!(select_progress(&owner), selected);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT SUM(reserved_bytes) FROM source_import_quota WHERE settled=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        20 * 1024 * 1024
    );
    assert!(svc.get(foreign(), "pending-default".into()).is_err());
    svc.work_operation(
        &other.job_id,
        Some(&files),
        Through::Settled,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(select_progress(&owner), selected);
    drop(svc);
    owner.shutdown().unwrap();
}

fn publication_secret() -> Secret {
    Secret::new("publication-fixture-secret".into())
}
fn publication_fixture() -> (PathBuf, PathBuf, WriterOwner, serde_json::Value) {
    let root = temp();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("fixtures/publication-source/node.db"),
    )
    .unwrap();
    let old = root.join("repos/1/revisions/fixture");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(
        old.join("bracket.stl"),
        include_bytes!("fixtures/publication-source/bracket.stl"),
    )
    .unwrap();
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Later Source\n").unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    let initial: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/publication-source/request.json")).unwrap();
    let response = owner
        .checkoff_progress()
        .apply(
            catalog::Credentials::Session(publication_secret()),
            pp_storage::checkoff_progress::Request::CompletionCoordinate {
                part_id: 1,
                body: serde_json::json!({"unit_index":2,"completed":true}),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(response.status, 200);
    let selected = owner.required_units().reconcile(
        pp_storage::required_units::ReconciliationCommand::new(
            serde_json::from_value(serde_json::json!(1)).unwrap(),
            serde_json::from_value(serde_json::json!(2)).unwrap(),
            serde_json::from_value(serde_json::json!({"expected_snapshot_digest":initial["expected_snapshot_digest"],"decisions":[]})).unwrap(),
            "publication-source-selection".into(),
            pp_storage::read_model::Credential::Session(publication_secret()),
        ).unwrap(), &AtomicBool::new(false), Duration::from_secs(5),
    ).unwrap();
    let selected = serde_json::to_value(selected).unwrap();
    assert_eq!(selected["kind"], "ready");
    let draft = &selected["workspace"]["draft"];
    let command = serde_json::json!({"expected_snapshot_digest":draft["snapshot_digest"],"expected_lifecycle_version":draft["lifecycle_version"],"expected_base":draft["base"],"remap_checkoff_links":true});
    assert_eq!(count(&root, "accepted_plate_revisions"), 1);
    assert_eq!(count(&root, "accepted_plates"), 1);
    assert!(count(&root, "accepted_plate_units") > 0);
    (root, files, owner, command)
}
fn publish_selected(owner: &WriterOwner, request: &serde_json::Value) -> serde_json::Value {
    serde_json::to_value(
        owner
            .publication()
            .apply(
                pp_storage::plan_publication::PublicationCommand::new(
                    serde_json::from_value(serde_json::json!(1)).unwrap(),
                    serde_json::from_value(serde_json::json!(2)).unwrap(),
                    serde_json::from_value(request.clone()).unwrap(),
                    "publication-source".into(),
                    pp_storage::read_model::Credential::Session(publication_secret()),
                )
                .unwrap(),
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap(),
    )
    .unwrap()
}
fn publication_foreign(root: &Path) -> Vec<(String, Vec<String>)> {
    let db = read(root);
    graph(&db)
        .into_iter()
        .filter_map(|(name, _)| {
            let mut query = db.prepare(&format!("SELECT * FROM {name}")).unwrap();
            let column = query
                .column_names()
                .iter()
                .position(|n| *n == "tenant_id" || *n == "tenant");
            column.map(|column| {
                let n = query.column_count();
                let rows = query
                    .query_map([], |r| {
                        let tenant: String = r.get(column)?;
                        let values = (0..n)
                            .map(|i| r.get::<_, rusqlite::types::Value>(i))
                            .collect::<Result<Vec<_>, _>>()?;
                        Ok((tenant, format!("{values:?}")))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
                    .into_iter()
                    .filter(|(tenant, _)| tenant == "foreign")
                    .map(|(_, row)| row)
                    .collect();
                (name, rows)
            })
        })
        .collect()
}
fn assert_publication_preserves_source(root: &Path, before: &[(String, Vec<String>)]) {
    let after = graph(&read(root));
    for (table, rows) in before {
        if [
            "projects",
            "source_revisions",
            "source_docs",
            "source_import_operations",
            "source_import_quota",
            "durable_jobs",
            "durable_job_keys",
            "durable_job_history",
            "durable_job_reconciliations",
            "accepted_plate_revisions",
            "accepted_plates",
            "accepted_plate_units",
            "required_units",
        ]
        .contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
    assert_eq!(
        std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap(),
        include_bytes!("fixtures/publication-source/bracket.stl")
    );
}
fn assert_source_preserves_publication(root: &Path, before: &[(String, Vec<String>)]) {
    let after = graph(&read(root));
    for (table, rows) in before {
        if table.starts_with("plan_")
            || table.starts_with("accepted_")
            || ["parts", "required_units", "print_progress"].contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
}
#[test]
fn publication_pending_supplied_import_preserves_owned_job_and_pinned_source() {
    let (root, files, owner, command) = publication_fixture();
    let svc = service(&owner);
    let pending = svc
        .admit(
            credential(&owner),
            request("pending-publication", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = graph(&read(&root));
    let foreign = publication_foreign(&root);
    assert!(foreign.iter().any(|(_, rows)| !rows.is_empty()));
    let applied = publish_selected(&owner, &command);
    assert_eq!(applied["kind"], "applied");
    assert_publication_preserves_source(&root, &before);
    assert_eq!(publication_foreign(&root), foreign);
    assert_eq!(
        svc.get(credential(&owner), pending.key.clone()).unwrap(),
        pending
    );
    assert_eq!(
        publish_selected(&owner, &command)["receipt"],
        applied["receipt"]
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn publication_active_supplied_claim_and_live_lease_remain_exact() {
    let (root, files, owner, command) = publication_fixture();
    let svc = service(&owner);
    let pending = svc
        .admit(
            credential(&owner),
            request("active-publication", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker_with_policy(
            policy(),
            jobs::WorkerAdmission {
                kinds: vec![
                    (jobs::JobKind::SuppliedSourceImport, 1),
                    (jobs::JobKind::ImportScan, 1),
                ],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            },
        )
        .unwrap();
    let mut claim = worker.claim_import(&pending.job_id).unwrap().unwrap();
    let mut live = claim.source_work.take().expect("claimed Source work");
    let active = worker.import_phase(&claim.lease, Phase::Read).unwrap();
    let before = graph(&read(&root));
    assert_eq!(claim.job.state, jobs::PersistentState::Running);
    assert_eq!(publish_selected(&owner, &command)["kind"], "applied");
    assert_publication_preserves_source(&root, &before);
    assert_eq!(
        worker.import_phase(&claim.lease, Phase::Read).unwrap(),
        active
    );
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    live.release().unwrap();
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn publication_then_source_activation_preserves_receipt_progress_and_plate_history() {
    let (root, files, owner, command) = publication_fixture();
    let svc = service(&owner);
    let pending = svc
        .admit(
            credential(&owner),
            request(
                "activate-after-publication",
                Target::Existing { source_id: 1 },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let published = publish_selected(&owner, &command);
    assert_eq!(published["kind"], "applied");
    let before = graph(&read(&root));
    let foreign = publication_foreign(&root);
    let accepted = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(publication_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matches!(
        accepted.builds[0].accepted,
        pp_storage::read_model::AcceptedRead::Ready { .. }
    ));
    let accepted = accepted
        .builds
        .into_iter()
        .next()
        .unwrap()
        .accepted
        .into_json_body()
        .into_bytes();
    let completed = svc
        .work_operation(
            &pending.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(completed.receipt.as_ref().unwrap().activated && completed.cleanup_settled);
    assert_eq!(
        completed.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert_source_preserves_publication(&root, &before);
    assert_eq!(publication_foreign(&root), foreign);
    assert_eq!(
        publish_selected(&owner, &command)["receipt"],
        published["receipt"]
    );
    drop(svc);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    let replay = publish_selected(&owner, &command);
    assert_eq!(replay["kind"], "existing");
    assert_eq!(replay["receipt"], published["receipt"]);
    let read = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(publication_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        read.builds
            .into_iter()
            .next()
            .unwrap()
            .accepted
            .into_json_body()
            .into_bytes(),
        accepted
    );
    let svc = service(&owner);
    assert_eq!(svc.get(credential(&owner), pending.key).unwrap(), completed);
    assert_source_preserves_publication(&root, &before);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn publication_source_schema37_backup_retains_full35_and_foreign_graph() {
    let (root, files, owner, command) = publication_fixture();
    owner.shutdown().unwrap();
    let backup = root.join("backups/pre-schema36.db");
    let preparation_backup = root.join("preparation-pre-schema36.db");
    let preparation_backup_bytes = std::fs::read(&backup).unwrap();
    std::fs::rename(&backup, &preparation_backup).unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    remove_schema40_and_39(&conn);
    conn.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let prior = graph(&conn);
    drop(conn);
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(ready.version, 40);
    let backup = root.join("publication-backup-copy.db");
    std::fs::copy(ready.backup.unwrap(), &backup).unwrap();
    assert_eq!(graph(&Connection::open(backup).unwrap()), prior);
    let foreign = publication_foreign(&root);
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("backup-publication", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(publish_selected(&owner, &command)["kind"], "applied");
    assert_eq!(publication_foreign(&root), foreign);
    let before = graph(&read(&root));
    let completed = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(completed.receipt.unwrap().activated);
    assert_source_preserves_publication(&root, &before);
    assert_eq!(publication_foreign(&root), foreign);
    drop(svc);
    owner.shutdown().unwrap();
    assert_eq!(
        std::fs::read(preparation_backup).unwrap(),
        preparation_backup_bytes
    );
}
