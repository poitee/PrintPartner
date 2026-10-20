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
    policy: AuthPolicy,
    token: String,
}

impl Scan {
    fn new() -> Self {
        Self::with_key(false)
    }

    fn with_key(use_key: bool) -> Self {
        let root = std::env::temp_dir().join(format!("pp-source-scan-{}", rand::random::<u64>()));
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let connection = Connection::open(root.join("print-partner.db")).unwrap();
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
        let credential = if use_key {
            let auth::Outcome::KeyCreated { key, .. } = owner
                .auth(FirstUserTenant::NewUser)
                .submit(
                    auth::Request::CreateKey {
                        session: auth::Secret::new(token.expose().to_owned()),
                    },
                    Arc::new(AtomicBool::new(false)),
                    Duration::from_secs(5),
                )
                .unwrap()
                .recv()
                .unwrap()
                .unwrap()
            else {
                panic!("key expected")
            };
            let tenant_id: String = connection
                .query_row(
                    "SELECT tenant_id FROM projects WHERE id=?1",
                    [source.id],
                    |row| row.get(0),
                )
                .unwrap();
            Credential::RoutedKey {
                tenant: tenant_id,
                key,
            }
        } else {
            Credential::Session(auth::Secret::new(token.expose().to_owned()))
        };
        owner
            .jobs(policy)
            .unwrap()
            .submit(
                credential,
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
            policy,
            token: token.expose().to_owned(),
        }
    }

    fn cancel(&self) -> JobRecord {
        let jobs::Outcome::Job(job, _) = self
            .owner
            .jobs(self.policy)
            .unwrap()
            .submit(
                Credential::Session(auth::Secret::new(self.token.clone())),
                UserOperation::Cancel {
                    job_id: self.lease.job_id().into(),
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
        job
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
        let result = applied.local_source_scan_result().unwrap();
        let LocalCompletionInspection::Completed(completed) = scan
            .worker
            .complete_local_scan(&mut scan.lease, &mut scan.source_work, applied, result)
            .unwrap()
        else {
            panic!("completion expected")
        };
        let Some(CompletedResult::SourceScan(result)) = completed.job.public_result else {
            panic!("scan result expected")
        };
        assert_eq!(
            result.stl_count,
            case["completion"]["stl_count"].as_u64().unwrap()
        );
        assert_eq!(
            result.downloaded,
            case["completion"]["downloaded"].as_u64().unwrap()
        );
        assert_eq!(
            result.doc_count,
            case["completion"]["doc_count"].as_u64().unwrap()
        );
        assert_eq!(
            result.docs_downloaded,
            case["completion"]["docs_downloaded"].as_u64().unwrap()
        );
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

#[test]
fn settlement_binds_to_the_observed_reservation() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    scan.source_work.release().unwrap();
    scan.source_work = scan
        .catalog
        .begin_work(
            scan.source_id,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let before = scan.snapshot();
    let error = scan
        .settle(observation.settlement(vec![document("new.md")]))
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Local scan observation reservation mismatch"),
        "{error}"
    );
    assert_eq!(scan.snapshot(), before);
}

#[test]
fn server_rejects_retired_proofs_and_cancel_after_observe() {
    for (cancel, real) in [(false, false), (true, false), (true, true)] {
        let mut scan = Scan::new();
        let observation = scan.observation();
        let mut proof = catalog::lease(scan.owner.client(), scan.source_work.proof().unwrap());
        if real {
            let job = scan.cancel();
            assert_eq!(job.state, PersistentState::Cancelled);
            assert_eq!(job.generation, scan.lease.generation() + 1);
        } else if cancel {
            scan.connection().execute("UPDATE durable_jobs SET document=json_set(document,'$.cancel_requested',json('true'))", []).unwrap();
        } else {
            scan.source_work.release().unwrap();
        }
        let before = scan.snapshot();
        for settle in [false, true] {
            let error = if settle {
                scan.worker
                    .settle_local_scan(
                        &mut scan.lease,
                        &proof,
                        observation.clone().settlement(vec![]),
                    )
                    .unwrap_err()
            } else {
                scan.worker
                    .observe_local_scan(&scan.lease, &proof)
                    .unwrap_err()
            };
            assert!(
                error.to_string().contains(if real {
                    "Stale attempt fence"
                } else if cancel {
                    "ImportScan was cancelled"
                } else {
                    "Source reservation already retired"
                }),
                "{error}"
            );
            assert_eq!(scan.snapshot(), before);
        }
        proof.release().unwrap();
    }
}

#[test]
fn duplicate_observation_returns_a_typed_error_without_writes() {
    let scan = Scan::new();
    scan.observation();
    let before = scan.snapshot();
    let error = scan
        .worker
        .observe_local_scan(&scan.lease, &scan.source_work)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<LocalScanFailure>(),
        Some(&LocalScanFailure::AlreadyObserved)
    );
    assert_eq!(scan.snapshot(), before);
}

#[test]
fn repeated_local_scan_completion_adopts_the_exact_terminal_result() {
    let mut scan = Scan::new();
    let proof = scan.source_work.proof().unwrap();
    let observation = scan.observation();
    let applied = scan
        .settle(observation.settlement(vec![document("new.md")]))
        .unwrap();
    let result = applied.local_source_scan_result().unwrap();
    let LocalCompletionInspection::Completed(first) = scan
        .worker
        .complete_local_scan(
            &mut scan.lease,
            &mut scan.source_work,
            applied.clone(),
            result.clone(),
        )
        .unwrap()
    else {
        panic!("completion expected")
    };
    assert_eq!(first.job.state, PersistentState::Succeeded);
    assert_eq!(
        first.job.public_result,
        Some(CompletedResult::SourceScan(result.clone()))
    );
    assert_eq!(
        first.result_digest,
        digest_bytes(serde_json::to_vec(first.job.public_result.as_ref().unwrap()).unwrap())
    );
    assert!(scan.source_work.proof().is_err());
    assert!(matches!(
        scan.worker
            .inspect_local_scan_completion(&scan.lease)
            .unwrap(),
        LocalCompletionInspection::Completed(_)
    ));
    scan.connection()
        .execute(
            "UPDATE source_scan_executions SET result_digest=?1",
            ["0".repeat(64)],
        )
        .unwrap();
    assert!(
        scan.worker
            .inspect_local_scan_completion(&scan.lease)
            .is_err()
    );
    scan.connection()
        .execute(
            "UPDATE source_scan_executions SET result_digest=?1",
            [&first.result_digest],
        )
        .unwrap();
    let before = scan.snapshot();
    let mut repeated_work = catalog::lease(scan.owner.client(), proof.clone());
    let LocalCompletionInspection::Completed(repeated) = scan
        .worker
        .complete_local_scan(
            &mut scan.lease,
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
    assert!(repeated_work.proof().is_err());
    assert_eq!(scan.snapshot(), before);
    for change in ["result", "receipt", "token", "incarnation", "job"] {
        let mut wrong_result = result.clone();
        let mut wrong_applied = applied.clone();
        let mut wrong_proof = proof.clone();
        match change {
            "result" => wrong_result.doc_count += 1,
            "receipt" => wrong_applied.receipt.receipt_id = "wrong-receipt".into(),
            "token" => wrong_proof.token += 1,
            "incarnation" => wrong_proof.incarnation = "0".repeat(64),
            "job" => {
                scan.connection().execute("UPDATE durable_jobs SET document=json_set(document,'$.job_id','wrong-job')", []).unwrap();
            }
            _ => unreachable!(),
        }
        let mismatch_before = scan.snapshot();
        let mut work = catalog::lease(scan.owner.client(), wrong_proof);
        assert!(
            scan.worker
                .complete_local_scan(&mut scan.lease, &mut work, wrong_applied, wrong_result)
                .is_err()
        );
        assert_eq!(scan.snapshot(), mismatch_before);
        if change == "job" {
            assert!(
                scan.worker
                    .inspect_local_scan_completion(&scan.lease)
                    .is_err()
            );
        }
        work.consume_retired().unwrap();
    }
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

#[test]
fn completion_refuses_revoked_key_without_writes() {
    let mut scan = Scan::with_key(true);
    let observation = scan.observation();
    let applied = scan
        .settle(observation.settlement(vec![document("new.md")]))
        .unwrap();
    scan.connection()
        .execute("DELETE FROM app_settings WHERE key='api_keys_v1'", [])
        .unwrap();
    let before = scan.snapshot();
    let error = scan
        .worker
        .complete_local_scan(
            &mut scan.lease,
            &mut scan.source_work,
            applied.clone(),
            applied.local_source_scan_result().unwrap(),
        )
        .err()
        .expect("revoked key must refuse completion");
    assert_eq!(
        error.downcast_ref::<auth::AuthorityFailure>(),
        Some(&auth::AuthorityFailure::CredentialInvalid)
    );
    assert_eq!(scan.snapshot(), before);
    assert!(scan.source_work.proof().is_ok());
    assert!(matches!(
        scan.catalog
            .execute(catalog::Request::Delete { id: scan.source_id })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
}

#[test]
fn completion_refuses_changed_settlement_and_rolls_back_journal_failure() {
    for change in [
        "UPDATE projects SET local_path='/changed'",
        "UPDATE source_scan_executions SET reservation_token='000000000000ffff'",
        "UPDATE source_scan_executions SET inventory_digest='0000000000000000000000000000000000000000000000000000000000000000'",
        "UPDATE durable_jobs SET document=json_set(document,'$.cancel_requested',json('true'))",
        "CREATE TRIGGER abort_completion BEFORE UPDATE ON source_scan_executions WHEN NEW.phase='completed' BEGIN SELECT RAISE(ABORT,'completion aborted'); END",
    ] {
        let mut scan = Scan::new();
        let observation = scan.observation();
        let applied = scan
            .settle(observation.settlement(vec![document("new.md")]))
            .unwrap();
        scan.connection().execute_batch(change).unwrap();
        let before = scan.snapshot();
        assert!(
            scan.worker
                .complete_local_scan(
                    &mut scan.lease,
                    &mut scan.source_work,
                    applied.clone(),
                    applied.local_source_scan_result().unwrap()
                )
                .is_err()
        );
        assert_eq!(scan.snapshot(), before);
        assert!(scan.source_work.proof().is_ok());
    }
}

#[test]
fn held_scan_inspection_recovers_a_lost_settlement_reply_and_reconciles() {
    let mut scan = Scan::new();
    assert!(matches!(
        scan.worker
            .inspect_local_scan_completion(&scan.lease)
            .unwrap(),
        LocalCompletionInspection::NotCommitted
    ));
    let observation = scan.observation();
    assert!(matches!(
        scan.worker
            .inspect_local_scan_while_held(&mut scan.lease, &scan.source_work)
            .unwrap(),
        HeldLocalScanInspection::NotApplied(_)
    ));
    let old_lease = scan.lease.clone();
    let applied = scan
        .settle(observation.settlement(vec![document("new.md")]))
        .unwrap();
    scan.lease = old_lease;
    let LocalCompletionInspection::NotCommitted = scan
        .worker
        .inspect_local_scan_completion(&scan.lease)
        .unwrap()
    else {
        panic!("not completed")
    };
    let HeldLocalScanInspection::Applied(job, recovered) = scan
        .worker
        .inspect_local_scan_while_held(&mut scan.lease, &scan.source_work)
        .unwrap()
    else {
        panic!("applied expected")
    };
    assert_eq!(scan.lease.version(), job.state_version);
    assert_eq!(recovered.receipt, applied.receipt);
    assert_eq!(recovered.inventory_digest, applied.inventory_digest);
    assert_eq!(recovered.index_digest, applied.index_digest);
    assert_eq!(recovered.doc_count, 1);
    let before = scan.snapshot();
    assert!(
        scan.worker
            .record_local_scan_reconciliation(
                &scan.lease,
                &mut scan.source_work,
                recovered.clone(),
                String::new()
            )
            .is_err()
    );
    assert_eq!(scan.snapshot(), before);
    let job = scan
        .worker
        .record_local_scan_reconciliation(
            &scan.lease,
            &mut scan.source_work,
            recovered,
            "completion reply lost".into(),
        )
        .unwrap();
    assert_eq!(job.state, PersistentState::ReconciliationRequired);
    assert!(job.worker.is_none() && job.fence.is_none());
    assert!(scan.source_work.proof().is_err());
    let journal: (String, String) = scan
        .connection()
        .query_row(
            "SELECT phase,reconciliation_reason FROM source_scan_executions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        journal,
        (
            "reconciliation_required".into(),
            "completion reply lost".into()
        )
    );
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

#[test]
fn cancelled_settled_scan_records_job_and_journal_reconciliation() {
    let mut scan = Scan::new();
    let observation = scan.observation();
    let unsettled = LocalScanApplied {
        source_id: scan.source_id,
        receipt: ResultArtifact {
            receipt_id: "unsettled".into(),
            content_hash: "0".repeat(64),
            target: String::new(),
        },
        inventory_digest: String::new(),
        index_digest: String::new(),
        doc_count: 0,
    };
    let before = scan.snapshot();
    let error = scan
        .worker
        .record_local_scan_reconciliation(
            &scan.lease,
            &mut scan.source_work,
            unsettled,
            "early".into(),
        )
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<LocalScanFailure>(),
        Some(&LocalScanFailure::NotSettled)
    );
    assert_eq!(scan.snapshot(), before);
    let old_lease = scan.lease.clone();
    let applied = scan
        .settle(observation.settlement(vec![document("new.md")]))
        .unwrap();
    scan.lease = old_lease;
    let cancelled = scan.cancel();
    assert_eq!(cancelled.state, PersistentState::ReconciliationRequired);
    assert_eq!(cancelled.generation, scan.lease.generation() + 1);
    assert!(cancelled.worker.is_none() && cancelled.fence.is_none());
    let mut retry = catalog::lease(scan.owner.client(), scan.source_work.proof().unwrap());
    let job = scan
        .worker
        .record_local_scan_reconciliation(
            &scan.lease,
            &mut scan.source_work,
            applied.clone(),
            "cancelled after settle".into(),
        )
        .unwrap();
    assert_eq!(job.state, PersistentState::ReconciliationRequired);
    assert_eq!(job.generation, cancelled.generation);
    assert_eq!(
        job.recovery.as_deref(),
        Some("Cancellation cannot undo an admitted effect")
    );
    assert!(scan.source_work.proof().is_err());
    let journal: (String, String, String) = scan
        .connection()
        .query_row(
            "SELECT phase,primary_failure,reconciliation_reason FROM source_scan_executions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        journal,
        (
            "reconciliation_required".into(),
            "cancelled after settle".into(),
            "cancelled after settle".into()
        )
    );
    let before = scan.snapshot();
    let error = scan
        .worker
        .record_local_scan_reconciliation(&scan.lease, &mut retry, applied.clone(), "other".into())
        .unwrap_err();
    assert!(error.to_string().contains("reason mismatch"), "{error}");
    assert_eq!(scan.snapshot(), before);
    let again = scan
        .worker
        .record_local_scan_reconciliation(
            &scan.lease,
            &mut retry,
            applied,
            "cancelled after settle".into(),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&again).unwrap(),
        serde_json::to_value(&job).unwrap()
    );
    assert!(retry.proof().is_err());
    assert_eq!(scan.snapshot(), before);
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

#[test]
fn scan_schema_validation_rejects_partial_or_unexpected_installations() {
    let connection = Connection::open_in_memory().unwrap();
    validate_schema(&connection, 39).unwrap();
    assert!(validate_schema(&connection, 40).is_err());
    connection
        .execute_batch("CREATE TABLE durable_jobs(id TEXT PRIMARY KEY);")
        .unwrap();
    connection
        .execute_batch(include_str!("schema.sql"))
        .unwrap();
    validate_schema(&connection, 40).unwrap();
    assert!(validate_schema(&connection, 39).is_err());
    connection
        .execute_batch("DROP INDEX source_scan_execution_receipt")
        .unwrap();
    assert!(validate_schema(&connection, 40).is_err());
}

#[test]
fn failure_metadata_matches_node_and_rolls_back() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/source-scan/source-scan.json"
    ))
    .unwrap();
    let scan = Scan::new();
    for case in golden["failures"].as_array().unwrap() {
        let mut connection = scan.connection();
        let raw = case["metadata"].as_str();
        connection
            .execute(
                "UPDATE projects SET metadata_json=?1 WHERE id=?2",
                params![raw, scan.source_id],
            )
            .unwrap();
        let tx = connection.transaction().unwrap();
        mark_local_failure(
            &tx,
            scan.lease.tenant(),
            scan.source_id,
            case["detail"].as_str().unwrap(),
        )
        .unwrap_or_else(|error| panic!("{}: {error}", case["id"]));
        assert!(mark_local_failure(&tx, "wrong-tenant", scan.source_id, "failure").is_err());
        let actual: String = tx
            .query_row(
                "SELECT metadata_json FROM projects WHERE id=?1",
                [scan.source_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(actual, case["stored"], "{}", case["id"]);
        assert_eq!(case["error"], case["detail"]);
        tx.rollback().unwrap();
        let restored: Option<String> = connection
            .query_row(
                "SELECT metadata_json FROM projects WHERE id=?1",
                [scan.source_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored.as_deref(), raw, "{}", case["id"]);

        let tx = connection.transaction().unwrap();
        mark_local_failure(
            &tx,
            scan.lease.tenant(),
            scan.source_id,
            case["detail"].as_str().unwrap(),
        )
        .unwrap();
        tx.commit().unwrap();
        let persisted: String = connection
            .query_row(
                "SELECT metadata_json FROM projects WHERE id=?1",
                [scan.source_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted, case["stored"], "{}", case["id"]);
    }
}

#[test]
fn source_writer_authority_refusal_records_once_and_preserves_effects() {
    let mut scan = Scan::with_key(true);
    let observation = scan.observation();
    scan.settle(observation.settlement(vec![])).unwrap();
    let mut connection = scan.connection();
    let tx = connection.transaction().unwrap();
    let mut job = jobs::claimed_job(&tx, &scan.lease).unwrap();
    let policy = AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    };
    jobs::revalidate_source_authority(&tx, &job, policy).unwrap();
    assert!(
        !jobs::commit_source_authority_refusal(&tx, &mut job, &anyhow!("storage error")).unwrap()
    );
    tx.execute("DELETE FROM app_settings WHERE key='api_keys_v1'", [])
        .unwrap();
    let error = jobs::revalidate_source_authority(&tx, &job, policy).unwrap_err();
    let version = job.state_version;
    let generation = job.generation;
    let effects = job.effects.clone();
    assert!(jobs::commit_source_authority_refusal(&tx, &mut job, &error).unwrap());
    assert_eq!(job.state_version, version + 1);
    assert_eq!(job.generation, generation + 1);
    assert_eq!(job.state, PersistentState::ReconciliationRequired);
    assert_eq!(job.effects, effects);
    assert_eq!(
        job.authority_refusal.as_ref().unwrap().phase,
        jobs::AuthorityRefusalPhase::SourceWriter
    );
    assert_eq!(
        job.authority_refusal.as_ref().unwrap().reason,
        jobs::AuthorityRefusalReason::CredentialInvalid
    );
    assert!(job.worker.is_none() && job.fence.is_none());
    tx.rollback().unwrap();
}
