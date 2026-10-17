use super::*;
use crate::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog::{self, SourceWorkLease},
    jobs::{self, Credential, JobKind, ServerWorkerClient, UserOperation, WorkerAdmission},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

struct Scan {
    owner: WriterOwner,
    catalog: catalog::SourceCatalogClient,
    root: PathBuf,
    source_id: i64,
    worker: ServerWorkerClient,
    lease: AttemptLease,
    source_work: SourceWorkLease,
}

impl Scan {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pp-source-scan-{}", rand::random::<u64>()));
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let connection = Connection::open(root.join("print-partner.db")).unwrap();
        // #553 installs these columns. D17 (b) installs the journal at schema 40.
        for (table, column, sql) in [
            (
                "projects",
                "source_configuration_version",
                "ALTER TABLE projects ADD COLUMN source_configuration_version INTEGER NOT NULL DEFAULT 1",
            ),
            (
                "source_docs",
                "source_revision_id",
                "ALTER TABLE source_docs ADD COLUMN source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT",
            ),
            (
                "source_docs",
                "input_digest",
                "ALTER TABLE source_docs ADD COLUMN input_digest TEXT",
            ),
            (
                "source_docs",
                "producer_version",
                "ALTER TABLE source_docs ADD COLUMN producer_version TEXT CHECK ((source_revision_id IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_revision_id IS NOT NULL AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL))",
            ),
        ] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                    params![table, column],
                    |row| row.get(0),
                )
                .unwrap();
            if !exists {
                connection.execute_batch(sql).unwrap();
            }
        }
        connection
            .execute_batch(include_str!("schema.sql"))
            .unwrap();
        let policy = AuthPolicy {
            registration: RegistrationPolicy::Open,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        };
        let auth::Outcome::Session { token, .. } = owner
            .auth(FirstUserTenant::NewUser)
            .submit(
                auth::Request::Register {
                    email: "source-scan@example.com".into(),
                    display_name: "Scan".into(),
                    password: auth::Secret::new("source-scan-test-password".into()),
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
        let catalog = owner
            .source_catalog_with_policy(
                catalog::Credentials::Session(auth::Secret::new(token.expose().to_owned())),
                policy,
            )
            .unwrap();
        let catalog::Outcome::Source(Some(source)) = catalog
            .execute(catalog::Request::Create {
                source: catalog::CreateSource {
                    name: "Scan".into(),
                    source_kind: Some("local".into()),
                    source_type: Some("local".into()),
                    ..Default::default()
                },
            })
            .unwrap()
        else {
            panic!("Source expected")
        };
        connection
            .execute(
                "UPDATE projects SET local_path='/local/docs',metadata_json=?2 WHERE id=?1",
                params![
                    source.id,
                    r#"{"sync_error":"old","sync_required":true,"keep":7}"#
                ],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO source_docs(tenant_id,project_id,path,kind,size_bytes,content_hash,extract_status,updated_at)
             SELECT tenant_id,id,'old.md','md',3,?2,'na','0' FROM projects WHERE id=?1",
            params![source.id, "b".repeat(64)],
        ).unwrap();
        owner
            .jobs(policy)
            .unwrap()
            .submit(
                Credential::Session(auth::Secret::new(token.expose().to_owned())),
                UserOperation::Enqueue {
                    key: "scan".into(),
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
            .unwrap();
        let worker = owner
            .job_worker_with_policy(
                policy,
                WorkerAdmission {
                    kinds: vec![(JobKind::ImportScan, 1)],
                    total: 1,
                    per_resource: 1,
                    lease_seconds: 60,
                },
            )
            .unwrap();
        let jobs::ClaimedAttempt {
            lease, source_work, ..
        } = worker.claim_kind(JobKind::ImportScan).unwrap().unwrap();
        Self {
            owner,
            catalog,
            root,
            source_id: source.id,
            worker,
            lease,
            source_work: source_work.unwrap(),
        }
    }

    fn connection(&self) -> Connection {
        Connection::open(self.root.join("print-partner.db")).unwrap()
    }

    fn observation(&self) -> LocalScanObservation {
        self.worker
            .observe_local_scan(&self.lease, &self.source_work)
            .unwrap()
    }

    fn settle(&mut self, settlement: LocalScanSettlement) -> Result<LocalScanApplied> {
        self.worker
            .settle_local_scan(&mut self.lease, &self.source_work, settlement)
    }

    fn snapshot(&self) -> Value {
        let connection = self.connection();
        let docs = connection
            .prepare("SELECT path,content_hash FROM source_docs ORDER BY path")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let project: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT last_synced_at,metadata_json FROM projects WHERE id=?1",
                [self.source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let journal: (String, i64, Option<String>) = connection
            .query_row(
                "SELECT phase,effect_applied,receipt_id FROM source_scan_executions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let job: String = connection
            .query_row(
                "SELECT document FROM durable_jobs WHERE id=?1",
                [self.lease.job_id()],
                |row| row.get(0),
            )
            .unwrap();
        let history: i64 = connection
            .query_row("SELECT count(*) FROM durable_job_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        json!([docs, project, journal, job, history])
    }
}

impl Drop for Scan {
    fn drop(&mut self) {
        if self.source_work.proof().is_ok() {
            self.source_work.release().unwrap();
        }
    }
}

fn document(path: &str) -> LocalDocumentRecord {
    LocalDocumentRecord {
        relative_path: path.into(),
        kind: LocalDocumentKind::Markdown,
        size_bytes: 3,
        content_sha256: "a".repeat(64),
    }
}

#[test]
fn settlement_matches_literal_node_document_index() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/source-scan/source-scan.json"
    ))
    .unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let mut scan = Scan::new();
        let observation = scan.observation();
        assert_eq!(observation.source_id(), scan.source_id);
        assert_eq!(observation.local_path(), Some("/local/docs"));
        let documents = serde_json::from_value(case["documents"].clone()).unwrap();
        let applied = scan
            .settle(observation.clone().settlement(documents))
            .unwrap();
        assert_eq!(
            applied.local_source_scan_result().unwrap().doc_count,
            case["result"]["doc_count"].as_u64().unwrap()
        );
        let connection = scan.connection();
        let mut rows = connection.prepare("SELECT path,kind,size_bytes,content_hash,extract_status,page_count FROM source_docs WHERE project_id=?1").unwrap()
            .query_map([scan.source_id], |row| {
                let hash: String = row.get(3)?;
                Ok(json!({"path":row.get::<_,String>(0)?, "kind":row.get::<_,String>(1)?,
                    "sizeBytes":row.get::<_,i64>(2)?, "contentHash":&hash[..24],
                    "extractStatus":row.get::<_,String>(4)?, "pageCount":row.get::<_,Option<i64>>(5)?}))
            }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        rows.sort_by(|a, b| {
            a["path"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .cmp(b["path"].as_str().unwrap().encode_utf16())
        });
        assert_eq!(json!(rows), case["rows"], "{}", case["id"]);
        assert_eq!(
            rows.iter()
                .filter(|row| row["extractStatus"] == "pending")
                .count() as u64,
            case["result"]["pending_pdfs"].as_u64().unwrap()
        );
        let (phase, effect, receipt, inventory, index): (String, i64, String, String, String) = connection.query_row(
            "SELECT phase,effect_applied,receipt_id,inventory_digest,index_digest FROM source_scan_executions", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).unwrap();
        assert_eq!((phase.as_str(), effect), ("local_settled", 1));
        assert_eq!(receipt, applied.receipt.receipt_id);
        assert_eq!(inventory, case["inventory_digest"]);
        assert_eq!(index, case["index_digest"]);
        let job = jobs::load(
            &connection.unchecked_transaction().unwrap(),
            scan.lease.job_id(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(job.effects.len(), 1);
        assert!(job.effects[0].confirmed);
        assert_eq!(job.effects[0].receipt.as_ref(), Some(&applied.receipt));
        let metadata: String = connection
            .query_row(
                "SELECT metadata_json FROM projects WHERE id=?1",
                [scan.source_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&metadata).unwrap(),
            json!({"keep":7})
        );
        let before = scan.snapshot();
        assert!(scan.settle(observation.settlement(vec![])).is_err());
        assert_eq!(scan.snapshot(), before);
    }
}

#[test]
fn settlement_rejects_changed_observation_without_writes() {
    for change in [
        "UPDATE projects SET local_path='/different'",
        "UPDATE projects SET source_configuration_version=source_configuration_version+1",
        "UPDATE projects SET source_kind='git'",
    ] {
        let mut scan = Scan::new();
        let observation = scan.observation();
        scan.connection().execute_batch(change).unwrap();
        let before = scan.snapshot();
        let error = scan
            .settle(observation.settlement(vec![document("new.md")]))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Local Source observation changed"),
            "{error}"
        );
        assert_eq!(scan.snapshot(), before);
    }
}

#[test]
fn settlement_revalidates_revoked_authority_without_writes() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    scan.connection()
        .execute("DELETE FROM sessions", [])
        .unwrap();
    let before = scan.snapshot();
    let error = scan
        .settle(observation.settlement(vec![document("new.md")]))
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<auth::AuthorityFailure>(),
        Some(auth::AuthorityFailure::CredentialInvalid)
    ));
    assert_eq!(scan.snapshot(), before);
}

#[test]
fn settlement_rolls_back_document_replacement_on_journal_failure() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    scan.connection().execute_batch(
        "CREATE TRIGGER fail_scan_settlement BEFORE UPDATE ON source_scan_executions BEGIN SELECT RAISE(ABORT,'settlement failure'); END;"
    ).unwrap();
    let before = scan.snapshot();
    let error = scan
        .settle(observation.clone().settlement(vec![document("new.md")]))
        .unwrap_err();
    assert!(error.to_string().contains("settlement failure"));
    assert_eq!(scan.snapshot(), before);
    scan.connection()
        .execute_batch("DROP TRIGGER fail_scan_settlement")
        .unwrap();
    scan.settle(observation.settlement(vec![document("retry.md")]))
        .unwrap();
}

#[test]
fn settlement_rejects_invalid_documents_without_writes() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    let before = scan.snapshot();
    let mut invalid_hash = document("a.md");
    invalid_hash.content_sha256 = "A".repeat(64);
    for documents in [
        vec![document("../outside.md")],
        vec![document("a\\b.md")],
        vec![invalid_hash],
        vec![document("b.md"), document("a.md")],
        vec![document("a.md"), document("a.md")],
        vec![document("a.md"); 10_001],
        vec![LocalDocumentRecord {
            size_bytes: u64::MAX,
            ..document("huge.md")
        }],
    ] {
        assert!(
            scan.settle(observation.clone().settlement(documents))
                .is_err()
        );
        assert_eq!(scan.snapshot(), before);
    }
}

#[test]
fn settlement_requires_the_claimed_source_reservation() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    let before = scan.snapshot();
    let mut wrong = observation.clone();
    wrong.source_id += 1;
    assert!(
        scan.settle(wrong.settlement(vec![]))
            .unwrap_err()
            .to_string()
            .contains("Source mismatch")
    );
    assert_eq!(scan.snapshot(), before);
    scan.source_work.release().unwrap();
    assert!(
        scan.settle(observation.settlement(vec![]))
            .unwrap_err()
            .to_string()
            .contains("Lease already released")
    );
    assert_eq!(scan.snapshot(), before);
}

#[test]
fn observation_rejects_forged_tokens_and_holds_source_until_release() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    let before = scan.snapshot();
    for wrong_incarnation in [false, true] {
        let mut proof = scan.source_work.proof().unwrap();
        proof.token += 1;
        if wrong_incarnation {
            proof.incarnation = "0".repeat(64);
        }
        let forged = catalog::lease(scan.owner.client(), proof);
        let error = scan
            .worker
            .observe_local_scan(&scan.lease, &forged)
            .unwrap_err();
        assert!(error.to_string().contains(if wrong_incarnation {
            "Wrong Source writer incarnation"
        } else {
            "Never-issued Source reservation"
        }));
        assert_eq!(scan.snapshot(), before);
    }
    scan.settle(observation.settlement(vec![])).unwrap();
    assert!(matches!(
        scan.catalog
            .execute(catalog::Request::Delete { id: scan.source_id })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    scan.source_work.release().unwrap();
    let mut next = scan
        .catalog
        .begin_work(
            scan.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    next.release().unwrap();
}
