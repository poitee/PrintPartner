#![cfg(feature = "desktop_rebuild")]
//! Supplied-import phases over the upload journal. Node writes supplied files in
//! one call and has no journal, attempts or Source observations, so these cases
//! port the reference `source_import_operation.rs` storage assertions.
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        self, AuthPolicy, AuthorityFailure, FirstUserTenant, RegistrationPolicy, Secret,
        SessionTenantPolicy,
    },
    catalog::{CreateSource, Credentials, Deletion, Outcome as CatalogOutcome, Request},
    jobs::{
        AttemptLease, ClaimedAttempt, Credential, JobKind, Outcome, ServerWorkerClient,
        UserOperation, WorkerAdmission,
    },
    uploads::{
        Admission, Artifact, File, ImportClient, Input, Operation, OwnedInput, Phase,
        Postprocessing, State, Target,
    },
};
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

const RESERVED: u64 = 3_506_438_144;
const QUOTA: u64 = 16 * 1024 * 1024 * 1024;

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

struct Fixture {
    root: PathBuf,
    owner: WriterOwner,
    imports: ImportClient,
    worker: ServerWorkerClient,
}

impl Fixture {
    fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-import-phases-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        Self::with(root, owner)
    }

    fn with(root: PathBuf, owner: WriterOwner) -> Self {
        let imports = owner.imports(policy(), QUOTA).unwrap();
        let admission = WorkerAdmission {
            kinds: JobKind::ALL.into_iter().map(|kind| (kind, 2)).collect(),
            total: 4,
            per_resource: 1,
            lease_seconds: 60,
        };
        let worker = owner.job_worker_with_policy(policy(), admission).unwrap();
        Self {
            root,
            owner,
            imports,
            worker,
        }
    }

    fn reopen(self) -> Self {
        let Self { root, owner, .. } = self;
        owner.shutdown().unwrap();
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        Self::with(root, owner)
    }

    fn physical(&self) -> Credential {
        Credential::PhysicalOwner(self.owner.job_physical_owner())
    }

    fn auth(&self, request: auth::Request) -> auth::Outcome {
        self.owner
            .auth_with_policy(policy())
            .unwrap()
            .submit(
                request,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(5),
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
    }

    fn register(&self) -> String {
        let auth::Outcome::Session { token, .. } = self.auth(auth::Request::Register {
            email: "importer@example.test".into(),
            display_name: "Importer".into(),
            password: Secret::new("long-test-password".into()),
        }) else {
            panic!("session expected")
        };
        token.expose().into()
    }

    fn login(&self) -> String {
        let auth::Outcome::Session { token, .. } = self.auth(auth::Request::Login {
            email: "importer@example.test".into(),
            password: Secret::new("long-test-password".into()),
        }) else {
            panic!("session expected")
        };
        token.expose().into()
    }

    fn logout(&self, token: &str) {
        self.auth(auth::Request::Logout {
            token: Secret::new(token.into()),
        });
    }

    fn admit(&self, credential: Credential, key: &str) -> Operation {
        self.try_admit(credential, key, RESERVED).unwrap()
    }

    fn try_admit(
        &self,
        credential: Credential,
        key: &str,
        reserved: u64,
    ) -> anyhow::Result<Operation> {
        let files = vec![file("part.stl", "input", 'a')];
        let request = Admission {
            key: key.into(),
            target: Target::Create {
                metadata: Box::new(CreateSource {
                    name: key.into(),
                    source_kind: Some("local".into()),
                    source_type: Some("local".into()),
                    ..Default::default()
                }),
            },
            input: Input::Files {
                paths: vec!["part.stl".into()],
            },
            reserved_bytes: reserved,
            max_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
        };
        let epoch = self.imports.accounting_epoch();
        let cancelled = AtomicBool::new(false);
        self.imports
            .admit(credential, request, files, 0, epoch, &cancelled)
    }

    fn claim(&self, op: &Operation) -> AttemptLease {
        let ClaimedAttempt { lease, .. } = self.worker.claim_import(&op.job_id).unwrap().unwrap();
        lease
    }

    fn phase(&self, lease: &AttemptLease, phase: Phase) -> anyhow::Result<Operation> {
        self.worker.import_phase(lease, phase)
    }

    fn cancel(&self, token: &str, op: &Operation) -> pp_storage::jobs::JobRecord {
        let Outcome::Job(job, _) = self
            .owner
            .jobs(policy())
            .unwrap()
            .submit(
                Credential::Session(Secret::new(token.into())),
                UserOperation::Cancel {
                    job_id: op.job_id.clone(),
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

    fn delete_source(&self, token: &str, op: &Operation) -> Deletion {
        let catalog = self
            .owner
            .source_catalog_with_policy(Credentials::Session(Secret::new(token.into())), policy())
            .unwrap();
        let CatalogOutcome::Deletion(deletion) = catalog
            .execute(Request::Delete { id: op.source_id })
            .unwrap()
        else {
            panic!("deletion expected")
        };
        deletion
    }

    /// The import's quota row as (reserved, retained, settled).
    fn quota(&self, op: &Operation) -> (i64, i64, bool) {
        self.connection()
            .query_row(
                "SELECT reserved_bytes,retained_bytes,settled FROM source_import_quota WHERE operation_key=?1",
                [&op.key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    fn document(&self, op: &Operation) -> String {
        self.connection()
            .query_row(
                "SELECT document FROM source_import_operations WHERE operation_key=?1",
                [&op.key],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn connection(&self) -> Connection {
        Connection::open(self.root.join("print-partner.db")).unwrap()
    }

    fn job(&self, op: &Operation) -> (String, Option<String>, i64) {
        self.connection()
            .query_row(
                "SELECT state,json_extract(document,'$._authority_refusal.phase'),json_extract(document,'$.generation') FROM durable_jobs WHERE id=?1",
                [&op.job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    /// Each observation as (cursor, phase, generation, fence, revision,
    /// activated, cancel).
    fn observations(&self, op: &Operation) -> Vec<Observation> {
        self.connection()
            .prepare("SELECT cursor,phase,attempt_generation,attempt_fence,revision_id,receipt_activated,cancel_requested FROM source_revision_observations WHERE operation_key=?1 ORDER BY cursor")
            .unwrap()
            .query_map([&op.key], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
}

type Observation = (
    i64,
    String,
    i64,
    Option<String>,
    Option<i64>,
    Option<bool>,
    bool,
);

fn file(path: &str, kind: &str, byte: char) -> File {
    File {
        path: path.into(),
        size: 3,
        sha256: byte.to_string().repeat(64),
        kind: kind.into(),
    }
}

fn owned(op: &Operation) -> Phase {
    Phase::Owned(OwnedInput {
        locator: format!(".pp-imports/{}", op.job_id),
        digest: op.requested_digest.clone(),
        files: op.requested_files.clone(),
    })
}

fn published(op: &Operation) -> Phase {
    let upstream_key = "c".repeat(64);
    Phase::Published(Artifact {
        tenant: op.tenant.clone(),
        source_id: op.source_id,
        locator: format!("{}/revisions/{upstream_key}", op.source_id),
        upstream_key,
        manifest_digest: "d".repeat(64),
        stored_bytes: 9,
        files: vec![
            file("parts/b.stl", "stl", 'e'),
            file("guide.pdf", "pdf", 'f'),
            file("README.md", "readme", '1'),
        ],
        suggested_rules: vec!["parts/".into()],
    })
}

fn authority(error: &anyhow::Error) -> Option<&AuthorityFailure> {
    error.downcast_ref::<AuthorityFailure>()
}

#[test]
fn phases_carry_an_admitted_import_to_a_settled_activation() {
    let fixture = Fixture::open();
    let op = fixture.admit(fixture.physical(), "activate");
    let lease = fixture.claim(&op);
    let epoch = fixture.imports.accounting_epoch();
    assert_eq!(fixture.phase(&lease, Phase::Read).unwrap(), op);
    assert_eq!(fixture.imports.accounting_epoch(), epoch);
    assert_eq!(
        fixture
            .phase(&lease, published(&op))
            .unwrap_err()
            .to_string(),
        "Input not ready"
    );
    assert_eq!(
        fixture
            .phase(&lease, Phase::Cleanup)
            .unwrap_err()
            .to_string(),
        "Import is not settled"
    );
    let ready = fixture.phase(&lease, owned(&op)).unwrap();
    assert_eq!(ready.state, State::OwnedInputReady);
    assert_eq!(fixture.imports.accounting_epoch(), epoch + 1);
    assert_eq!(
        fixture.phase(&lease, owned(&op)).unwrap_err().to_string(),
        "Input already captured"
    );
    assert_eq!(
        fixture.phase(&lease, published(&op)).unwrap().state,
        State::Published
    );
    let activated = fixture.phase(&lease, Phase::Activate).unwrap();
    let receipt = activated.receipt.clone().unwrap();
    assert_eq!(
        (&activated.state, receipt.activated, receipt.postprocessing),
        (
            &State::Activated,
            true,
            Postprocessing::DocumentMetadataIndexedPdfPending
        )
    );
    let settled = fixture.phase(&lease, Phase::Cleanup).unwrap();
    assert!(settled.cleanup_settled);
    assert_eq!(settled.observation_cursor, Some(4));
    assert_eq!(
        fixture.phase(&lease, Phase::Read).unwrap_err().to_string(),
        "Stale attempt fence"
    );

    let db = fixture.connection();
    let source: (i64, String, String, String) = db
        .query_row(
            "SELECT current_source_revision_id,last_commit_sha,imported_paths,json_extract(metadata_json,'$.remote_update_status') FROM projects WHERE id=?1",
            [op.source_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        source,
        (
            receipt.revision_id,
            "c".repeat(64),
            "[\"parts/\"]".into(),
            "up_to_date".into()
        )
    );
    let docs: Vec<(String, String, i64)> = db
        .prepare("SELECT path,extract_status,source_revision_id FROM source_docs WHERE project_id=?1 ORDER BY id")
        .unwrap()
        .query_map([op.source_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let id = receipt.revision_id;
    assert_eq!(
        docs,
        [
            ("README.md".into(), "na".into(), id),
            ("guide.pdf".into(), "pending".into(), id)
        ]
    );
    let quota: (i64, i64, bool, bool) = db
        .query_row(
            "SELECT q.reserved_bytes,q.retained_bytes,q.settled,a.activated FROM source_import_quota q, source_revision_attempts a WHERE q.operation_key=?1 AND a.operation_key=?1",
            [&op.key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(quota, (0, 9, true, true));
    assert_eq!(fixture.job(&op).0, "succeeded");
    let fence = Some(
        db.query_row(
            "SELECT attempt_fence FROM source_revision_attempts WHERE operation_key=?1",
            [&op.key],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
    );
    let observed = |cursor, phase: &str, receipt| {
        let (revision, activated) = receipt;
        (
            cursor,
            phase.into(),
            1,
            fence.clone(),
            revision,
            activated,
            false,
        )
    };
    assert_eq!(
        fixture.observations(&op),
        [
            observed(1, "owned", (None, None)),
            observed(2, "published", (None, None)),
            observed(3, "activated", (Some(id), Some(true))),
            observed(4, "cleanup", (Some(id), Some(true))),
        ]
    );
    drop(db);
    fixture.reopen();
}

#[test]
fn a_changed_source_conflicts_and_a_cancelled_import_settles_as_cancelled() {
    let fixture = Fixture::open();
    let op = fixture.admit(fixture.physical(), "conflict");
    let lease = fixture.claim(&op);
    fixture.phase(&lease, owned(&op)).unwrap();
    fixture.phase(&lease, published(&op)).unwrap();
    fixture
        .connection()
        .execute(
            "UPDATE projects SET last_commit_sha='moved' WHERE id=?1",
            [op.source_id],
        )
        .unwrap();
    let conflict = fixture.phase(&lease, Phase::Activate).unwrap();
    let receipt = conflict.receipt.clone().unwrap();
    assert_eq!(
        (&conflict.state, receipt.activated, receipt.postprocessing),
        (&State::Conflict, false, Postprocessing::NotActivated)
    );
    assert_eq!(
        fixture.phase(&lease, Phase::Fail).unwrap_err().to_string(),
        "Import already completed"
    );
    fixture.phase(&lease, Phase::Cleanup).unwrap();
    assert_eq!(fixture.job(&op).0, "failed");
    let current: Option<i64> = fixture
        .connection()
        .query_row(
            "SELECT current_source_revision_id FROM projects WHERE id=?1",
            [op.source_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(current, None);

    let op = fixture.admit(fixture.physical(), "cancel");
    let lease = fixture.claim(&op);
    let Outcome::Job(..) = fixture
        .owner
        .jobs(policy())
        .unwrap()
        .submit(
            fixture.physical(),
            UserOperation::Cancel {
                job_id: op.job_id.clone(),
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
    assert_eq!(
        fixture.phase(&lease, Phase::Read).unwrap_err().to_string(),
        "Stale attempt fence"
    );
    let lease = fixture.claim(&op);
    assert_eq!(
        fixture.phase(&lease, owned(&op)).unwrap_err().to_string(),
        "Import cancelled"
    );
    assert_eq!(
        fixture.phase(&lease, Phase::Fail).unwrap().state,
        State::Cancelled
    );
    fixture.phase(&lease, Phase::Cleanup).unwrap();
    assert_eq!(fixture.job(&op).0, "cancelled");
    let phases: Vec<_> = fixture
        .observations(&op)
        .into_iter()
        .map(|(cursor, phase, generation, .., cancel)| (cursor, phase, generation, cancel))
        .collect();
    assert_eq!(
        phases,
        [
            (1, "failed".into(), 3, true),
            (2, "cleanup".into(), 3, true)
        ]
    );
    fixture.reopen();
}

#[test]
fn generic_claims_leave_admitted_imports_to_their_owner() {
    let fixture = Fixture::open();
    let op = fixture.admit(fixture.physical(), "owner-only");
    assert!(fixture.worker.claim().unwrap().is_none());
    assert!(
        fixture
            .worker
            .claim_kind(JobKind::SuppliedSourceImport)
            .unwrap()
            .is_none()
    );
    let lease = fixture.claim(&op);
    assert_eq!(lease.job_id(), op.job_id);
    fixture.reopen();
}

#[test]
fn a_revoked_owner_fails_the_phase_and_commits_a_source_writer_refusal() {
    let fixture = Fixture::open();
    let token = fixture.register();
    let op = fixture.admit(Credential::Session(Secret::new(token.clone())), "revoked");
    let lease = fixture.claim(&op);
    fixture.phase(&lease, owned(&op)).unwrap();
    fixture.logout(&token);
    let error = fixture.phase(&lease, published(&op)).unwrap_err();
    assert_eq!(
        authority(&error),
        Some(&AuthorityFailure::CredentialInvalid)
    );
    assert_eq!(
        fixture.job(&op),
        ("failed".into(), Some("source_writer".into()), 2)
    );
    let fence: String = fixture
        .connection()
        .query_row(
            "SELECT attempt_fence FROM source_revision_observations WHERE cursor=1 AND operation_key=?1",
            [&op.key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        fixture.observations(&op)[1],
        (
            2,
            "authority_refused".into(),
            1,
            Some(fence),
            None,
            None,
            false
        )
    );
    let stored: (String, i64) = fixture
        .connection()
        .query_row(
            "SELECT state,json_extract(document,'$.observation_cursor') FROM source_import_operations WHERE operation_key=?1",
            [&op.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, ("owned_input_ready".into(), 2));
    fixture.reopen();
}

#[test]
fn a_targeted_refusal_after_an_attempt_records_its_prior_generation() {
    let fixture = Fixture::open();
    let token = fixture.register();
    let op = fixture.admit(Credential::Session(Secret::new(token.clone())), "prior");
    let lease = fixture.claim(&op);
    fixture.phase(&lease, owned(&op)).unwrap();
    fixture.phase(&lease, published(&op)).unwrap();
    fixture.logout(&token);
    let fixture = fixture.reopen();
    let error = fixture.worker.claim_import(&op.job_id).err().unwrap();
    assert_eq!(
        authority(&error),
        Some(&AuthorityFailure::CredentialInvalid)
    );
    assert_eq!(
        fixture.job(&op),
        ("failed".into(), Some("targeted_claim".into()), 3)
    );
    assert_eq!(
        fixture.observations(&op)[2],
        (3, "authority_refused".into(), 2, None, None, None, false)
    );
    fixture.reopen();
}

#[test]
fn a_preclaim_refusal_is_journaled_and_checked_at_startup() {
    for (mutation, refused) in [
        ("", false),
        (
            "UPDATE durable_jobs SET document=json_set(document,'$._authority_refusal.phase','claim')",
            true,
        ),
        (
            "UPDATE durable_jobs SET document=json_set(document,'$.cancel_requested',json('true'))",
            true,
        ),
    ] {
        let fixture = Fixture::open();
        let token = fixture.register();
        let op = fixture.admit(Credential::Session(Secret::new(token.clone())), "preclaim");
        fixture.logout(&token);
        let error = fixture.worker.claim_import(&op.job_id).err().unwrap();
        assert_eq!(
            authority(&error),
            Some(&AuthorityFailure::CredentialInvalid)
        );
        assert_eq!(
            fixture.job(&op),
            ("failed".into(), Some("targeted_claim".into()), 1)
        );
        let refusal: (i64, String, bool, i64) = fixture
            .connection()
            .query_row(
                "SELECT p.cursor,p.job_id,p.cancel_requested,json_extract(o.document,'$.observation_cursor') FROM source_preclaim_refusals p JOIN source_import_operations o ON o.tenant=p.tenant_id AND o.operation_key=p.operation_key",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(refusal, (1, op.job_id.clone(), false, 1));
        assert!(fixture.observations(&op).is_empty());
        let Fixture { root, owner, .. } = fixture;
        owner.shutdown().unwrap();
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .execute_batch(mutation)
            .unwrap();
        match WriterOwner::open(&root, Limits::default()) {
            Ok((owner, _)) => {
                assert!(!refused, "{mutation}");
                owner.shutdown().unwrap();
            }
            Err(error) => assert!(
                refused && format!("{error:#}").contains("Invalid Source preclaim refusal binding"),
                "{mutation}: {error:#}"
            ),
        }
    }
}

/// Revokes the owner's session after `Owned`, so `Published` fails the job and
/// leaves its import holding the whole quota.
fn refused_after_owned(fixture: &Fixture) -> Operation {
    let token = fixture.register();
    let session = Credential::Session(Secret::new(token.clone()));
    let op = fixture.try_admit(session, "refused", QUOTA).unwrap();
    let lease = fixture.claim(&op);
    fixture.phase(&lease, owned(&op)).unwrap();
    fixture.logout(&token);
    let error = fixture.phase(&lease, published(&op)).unwrap_err();
    assert_eq!(
        authority(&error),
        Some(&AuthorityFailure::CredentialInvalid)
    );
    assert_eq!(
        fixture
            .phase(&lease, Phase::Cleanup)
            .unwrap_err()
            .to_string(),
        "Stale attempt fence"
    );
    assert_eq!(fixture.quota(&op), (QUOTA as i64, 0, false));
    op
}

#[test]
fn the_owner_settles_a_refused_import_and_frees_its_quota() {
    let fixture = Fixture::open();
    let op = refused_after_owned(&fixture);
    let token = fixture.login();
    let session = || Credential::Session(Secret::new(token.clone()));
    assert_eq!(
        fixture
            .try_admit(session(), "blocked", RESERVED)
            .unwrap_err()
            .to_string(),
        "Owner import quota exceeded"
    );
    let job = fixture.cancel(&token, &op);
    assert_eq!(job.state, pp_storage::jobs::PersistentState::Failed);
    assert_eq!(fixture.quota(&op), (0, 0, true));
    let settled = fixture.imports.get(session(), op.key.clone()).unwrap();
    assert_eq!(
        (settled.state, settled.cleanup_settled),
        (State::Failed, true)
    );
    assert_eq!(settled.observation_cursor, Some(2));
    let document = fixture.document(&op);
    fixture.cancel(&token, &op);
    assert_eq!(fixture.document(&op), document);
    assert_eq!(fixture.job(&op).0, "failed");
    fixture.try_admit(session(), "next", RESERVED).unwrap();
    fixture.reopen();
}

#[test]
fn startup_settles_a_refused_import() {
    let fixture = Fixture::open();
    let token = fixture.register();
    let session = Credential::Session(Secret::new(token.clone()));
    let op = fixture.try_admit(session, "preclaim", QUOTA).unwrap();
    fixture.logout(&token);
    assert!(fixture.worker.claim_import(&op.job_id).is_err());
    assert_eq!(fixture.quota(&op), (QUOTA as i64, 0, false));
    let fixture = fixture.reopen();
    assert_eq!(fixture.quota(&op), (0, 0, true));
    let stored: (String, bool) = fixture
        .connection()
        .query_row(
            "SELECT state,json_extract(document,'$.cleanup_settled') FROM source_import_operations WHERE operation_key=?1",
            [&op.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, ("failed".into(), true));
    fixture
        .try_admit(fixture.physical(), "next", RESERVED)
        .unwrap();
    fixture.reopen();
}

#[test]
fn a_source_with_an_unsettled_import_is_not_deleted() {
    let fixture = Fixture::open();
    let op = refused_after_owned(&fixture);
    let token = fixture.login();
    assert_eq!(fixture.delete_source(&token, &op), Deletion::ActiveWork);
    fixture.cancel(&token, &op);
    assert_eq!(
        fixture.delete_source(&token, &op),
        Deletion::Deleted {
            source_id: op.source_id
        }
    );
    fixture.reopen();
}

#[test]
fn startup_rejects_an_unsettled_import_without_its_source() {
    let fixture = Fixture::open();
    let op = refused_after_owned(&fixture);
    let Fixture { root, owner, .. } = fixture;
    owner.shutdown().unwrap();
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .execute("DELETE FROM projects WHERE id=?1", [op.source_id])
        .unwrap();
    let error = WriterOwner::open(&root, Limits::default())
        .err()
        .expect("a dangling import must be refused");
    assert!(
        format!("{error:#}").contains("Unsettled import Source missing"),
        "{error:#}"
    );
}

#[test]
fn postprocessing_keeps_its_durable_wire_values() {
    for (state, wire) in [
        (Postprocessing::NotActivated, "not_activated"),
        (
            Postprocessing::DocumentMetadataIndexed,
            "document_metadata_indexed",
        ),
        (
            Postprocessing::DocumentMetadataIndexedPdfPending,
            "document_metadata_indexed_pdf_pending",
        ),
        (Postprocessing::IndexError, "index_error"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<Postprocessing>(wire.into()).unwrap(),
            state
        );
    }
    for wire in ["complete", "unknown", "", "DocumentMetadataIndexed"] {
        assert!(serde_json::from_value::<Postprocessing>(wire.into()).is_err());
    }
}
