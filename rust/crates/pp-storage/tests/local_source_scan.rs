#[allow(dead_code)]
#[path = "support/schema.rs"]
mod schema_fixture;

use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog::{CreateSource, Outcome as CatalogOutcome, Request as CatalogRequest},
    jobs::{Credential, JobKind, Outcome as JobOutcome, Payload, UserOperation, WorkerAdmission},
};
use rusqlite::{Connection, OpenFlags};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::atomic::AtomicBool, time::Duration};

fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-{name}-{}",
        hex::encode(rand::random::<[u8; 8]>())
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

fn physical_family(root: &std::path::Path) -> Vec<(String, u32, Option<Vec<u8>>)> {
    let mut entries = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    entries.sort();
    entries
        .into_iter()
        .map(|path| {
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                metadata.permissions().mode(),
                metadata.is_file().then(|| std::fs::read(path).unwrap()),
            )
        })
        .collect()
}

#[test]
fn schema39_wal_migrates_atomically_to_42_and_keeps_the_exact_backup() {
    let root = directory("source-scan-schema40");
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    let database = root.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    schema_fixture::remove_schema42(&connection);
    connection
        .execute_batch(
            "DROP TABLE source_scan_executions;
             UPDATE app_settings SET value='39' WHERE tenant_id='default' AND key='schema_version';
             PRAGMA wal_checkpoint(TRUNCATE);
             PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             INSERT INTO app_settings(tenant_id,key,value) VALUES('default','schema40_wal','present');",
        )
        .unwrap();
    assert!(root.join("print-partner.db-wal").metadata().unwrap().len() > 32);

    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    drop(connection);
    assert_eq!(ready.previous_version, 39);
    assert_eq!(ready.version, 42);
    let backup = ready.backup.unwrap();
    assert_eq!(backup.file_name().unwrap(), "pre-schema40.db");
    let snapshot = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        snapshot
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "39"
    );
    assert_eq!(
        snapshot
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema40_wal'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "present"
    );
    owner.shutdown().unwrap();
    let (_, reopened) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(reopened.previous_version, 42);
    assert_eq!(reopened.version, 42);
    assert!(reopened.backup.is_none());
}

#[test]
fn schema40_failure_rolls_back_to_39_and_future_43_is_refused() {
    let root = directory("source-scan-schema40-rollback");
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    let database = root.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    schema_fixture::remove_schema42(&connection);
    connection
        .execute_batch(
            "DROP TABLE source_scan_executions;
             CREATE TABLE source_scan_executions(unexpected TEXT);
             UPDATE app_settings SET value='39' WHERE tenant_id='default' AND key='schema_version';",
        )
        .unwrap();
    drop(connection);
    let before_failure = physical_family(&root);
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(physical_family(&root), before_failure);
    let connection = Connection::open(&database).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM app_settings WHERE tenant_id='default' AND key='schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "39"
    );
    connection
        .execute(
            "UPDATE app_settings SET value='43' WHERE tenant_id='default' AND key='schema_version'",
            [],
        )
        .unwrap();
    drop(connection);
    let before_future = physical_family(&root);
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(physical_family(&root), before_future);
}

#[test]
fn malformed_schema40_journal_is_refused_without_original_family_mutation() {
    let root = directory("source-scan-malformed40");
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    owner.shutdown().unwrap();
    let database = root.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch("ALTER TABLE source_scan_executions ADD COLUMN unexpected TEXT;")
        .unwrap();
    drop(connection);
    let before = physical_family(&root);
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(physical_family(&root), before);
}

#[test]
fn claim_kind_filters_before_claiming_an_admitted_public_scan() {
    let root = directory("source-scan-claim-kind");
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let CatalogOutcome::Source(Some(source)) = owner
        .local_source_catalog()
        .execute(CatalogRequest::Create {
            source: CreateSource {
                name: "Claim filter".into(),
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
            Credential::PhysicalOwner(owner.job_physical_owner()),
            UserOperation::Enqueue {
                key: "claim-filter".into(),
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
    let worker = owner
        .job_worker(WorkerAdmission {
            kinds: vec![(JobKind::SuppliedSourceImport, 1), (JobKind::ImportScan, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 60,
        })
        .unwrap();
    assert!(
        worker
            .claim_kind(JobKind::SuppliedSourceImport)
            .unwrap()
            .is_none()
    );
    let claimed = worker.claim_kind(JobKind::ImportScan).unwrap().unwrap();
    assert_eq!(claimed.job.job_id, job.job_id);
    assert!(claimed.source_work.is_some());
    drop(claimed);
    drop(worker);
    owner.shutdown().unwrap();
}
