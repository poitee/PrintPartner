use pp_core::{
    import_scan::ImportScanWorker,
    uploads::{SourceImports, Through},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy,
        Request as AuthRequest, Secret, SessionTenantPolicy,
    },
    catalog::{
        CreateSource, Credentials, Deletion, Outcome as CatalogOutcome, Request as CatalogRequest,
    },
    jobs::{CompletedResult, Credential, Outcome as JobOutcome, Payload, UserOperation},
};
use rusqlite::{Connection, OpenFlags};
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

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-import-scan-{}",
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
                email: "local-scan@example.com".into(),
                display_name: "Local scan".into(),
                password: Secret::new("long-local-scan-password".into()),
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

fn create_local_source(owner: &WriterOwner, token: &str, name: &str) -> i64 {
    let CatalogOutcome::Source(Some(source)) = owner
        .source_catalog_with_policy(Credentials::Session(Secret::new(token.into())), policy())
        .unwrap()
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: name.into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            },
        })
        .unwrap()
    else {
        panic!("source expected")
    };
    source.id
}

fn enqueue(owner: &WriterOwner, token: &str, key: &str, source_id: i64) -> String {
    let JobOutcome::Job(job, _) = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.into())),
            UserOperation::Enqueue {
                key: key.into(),
                payload_version: 1,
                payload: Payload::ImportScan {
                    project_id: source_id.try_into().unwrap(),
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
    job.job_id
}

fn read(path: &Path) -> Connection {
    Connection::open_with_flags(
        path.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}

#[test]
fn local_scan_claims_original_reservation_settles_documents_and_reopens_result() {
    let root = directory();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 40);
    let token = register(&owner);
    let source_id = create_local_source(&owner, &token, "Local documentation");
    let local = root.join("repos").join(source_id.to_string());
    std::fs::create_dir_all(local.join("docs")).unwrap();
    std::fs::write(local.join("README.md"), b"# Read me\n").unwrap();
    std::fs::write(local.join("docs/guide.md"), b"guide\n").unwrap();
    std::fs::write(local.join("manual.pdf"), b"%PDF-local-scan\n").unwrap();
    std::fs::write(local.join("ignored.stl"), b"solid ignored\n").unwrap();
    let job_id = enqueue(&owner, &token, "local-scan", source_id);
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .execute(
            "UPDATE projects SET metadata_json=?1 WHERE id=?2",
            (
                r#"{"sync_error":"old","sync_required":true,"custom":"retained"}"#,
                source_id,
            ),
        )
        .unwrap();

    let worker = ImportScanWorker::new(&owner, policy()).unwrap();
    let completed = worker.run_one().unwrap().unwrap();
    let Some(CompletedResult::SourceScan(result)) = completed.job.public_result else {
        panic!("SourceScan result expected")
    };
    assert_eq!(result.project_id, Some(source_id as u64));
    assert_eq!(result.doc_count, 3);
    assert_eq!(result.stl_count, 0);
    assert_eq!(result.downloaded, 0);
    assert_eq!(result.docs_downloaded, 0);
    assert!(result.pdf_extract_job_id.is_none());
    assert!(result.postprocess_warning.is_none());
    drop(worker);

    let database = read(&root);
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM source_docs WHERE project_id=?1",
                [source_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        3
    );
    let journal: (String, String, i64) = database
        .query_row(
            "SELECT phase,reservation_token,effect_applied FROM source_scan_executions WHERE job_id=?1",
            [&job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(journal.0, "completed");
    assert_eq!(journal.1.len(), 16);
    assert_eq!(journal.2, 1);
    let metadata: String = database
        .query_row(
            "SELECT metadata_json FROM projects WHERE id=?1 AND last_synced_at IS NOT NULL",
            [source_id],
            |row| row.get(0),
        )
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["custom"], "retained");
    assert!(metadata.get("sync_error").is_none());
    assert!(metadata.get("sync_required").is_none());
    drop(database);

    let CatalogOutcome::Deletion(Deletion::Deleted { source_id: deleted }) = owner
        .source_catalog_with_policy(Credentials::Session(Secret::new(token.clone())), policy())
        .unwrap()
        .execute(CatalogRequest::Delete { id: source_id })
        .unwrap()
    else {
        panic!("completed Local Source should be deletable")
    };
    assert_eq!(deleted, source_id);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_scan_executions WHERE job_id=?1",
                [&job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );

    owner.shutdown().unwrap();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 40);
    let snapshot = owner
        .jobs(policy())
        .unwrap()
        .read_public(
            Credential::Session(Secret::new(token)),
            job_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(matches!(
        snapshot.result,
        Some(CompletedResult::SourceScan(_))
    ));
    owner.shutdown().unwrap();
}

#[test]
fn normalized_document_collision_is_rejected_before_settlement() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let source_id = create_local_source(&owner, &token, "Colliding documentation");
    let local = root.join("repos").join(source_id.to_string());
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("README.md"), b"upper").unwrap();
    std::fs::write(local.join("readme.md"), b"lower").unwrap();
    enqueue(&owner, &token, "colliding-local-scan", source_id);
    let worker = ImportScanWorker::new(&owner, policy()).unwrap();
    assert!(worker.run_one().is_err());
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_docs WHERE project_id=?1",
                [source_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn internal_source_import_worker_does_not_take_public_scan() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let source_id = create_local_source(&owner, &token, "Shared admission");
    enqueue(&owner, &token, "public-scan-only", source_id);
    let internal = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    assert!(
        internal
            .work_next(Through::Settled, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert!(
        ImportScanWorker::new(&owner, policy())
            .unwrap()
            .run_one()
            .unwrap()
            .is_some()
    );
    drop(internal);
    owner.shutdown().unwrap();
}

#[test]
fn local_scan_completion_runs_owning_job_retention_and_cascades_journal() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let source_id = create_local_source(&owner, &token, "Retention source");
    let old_job = enqueue(&owner, &token, "old-local-scan", source_id);
    let worker = ImportScanWorker::new(&owner, policy()).unwrap();
    worker.run_one().unwrap().unwrap();
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .execute("UPDATE durable_jobs SET updated=0 WHERE id=?1", [&old_job])
        .unwrap();
    let current_job = enqueue(&owner, &token, "current-local-scan", source_id);
    worker.run_one().unwrap().unwrap();
    let database = read(&root);
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM source_scan_executions WHERE job_id=?1",
                [&old_job],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM source_scan_executions WHERE job_id=?1",
                [&current_job],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    drop(database);
    drop(worker);
    owner.shutdown().unwrap();
}

#[test]
fn missing_local_path_completes_with_the_canonical_empty_result() {
    let root = directory();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let token = register(&owner);
    let source_id = create_local_source(&owner, &token, "Missing documentation");
    enqueue(&owner, &token, "missing-local-scan", source_id);
    let worker = ImportScanWorker::new(&owner, policy()).unwrap();
    let completed = worker.run_one().unwrap().unwrap();
    let Some(CompletedResult::SourceScan(result)) = completed.job.public_result else {
        panic!("SourceScan result expected")
    };
    assert_eq!(result.project_id, Some(source_id as u64));
    assert_eq!(result.doc_count, 0);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT count(*) FROM source_docs WHERE project_id=?1",
                [source_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    drop(worker);
    owner.shutdown().unwrap();
}
