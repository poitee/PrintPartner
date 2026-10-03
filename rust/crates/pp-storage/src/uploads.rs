use crate::{
    Envelope, SettingsClient, WriterOwner,
    auth::{self, AuthPolicy},
    catalog, jobs,
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Existing {
        source_id: i64,
    },
    Create {
        metadata: Box<catalog::CreateSource>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Files { paths: Vec<String> },
    Zip { path: String },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub key: String,
    pub target: Target,
    pub input: Input,
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Basis {
    pub current_source_revision_id: Option<i64>,
    pub url: String,
    pub branch: String,
    pub tag: Option<String>,
    pub source_kind: String,
    pub source_type: String,
    pub local_path: Option<String>,
    pub last_commit_sha: Option<String>,
    pub legacy_manifest_cutover: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Admitted,
    OwnedInputReady,
    Published,
    Activated,
    Conflict,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OwnedInput {
    pub locator: String,
    pub digest: String,
    pub files: Vec<File>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub tenant: String,
    pub source_id: i64,
    pub upstream_key: String,
    pub manifest_digest: String,
    pub locator: String,
    pub stored_bytes: u64,
    pub files: Vec<File>,
    pub suggested_rules: Vec<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Postprocessing {
    NotActivated,
    DocumentMetadataIndexed,
    DocumentMetadataIndexedPdfPending,
    IndexError,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub tenant: String,
    pub operation_key: String,
    pub job_id: String,
    pub source_id: i64,
    pub revision_id: i64,
    pub artifact: Artifact,
    pub basis: Basis,
    pub activated: bool,
    pub applied_at: String,
    pub postprocessing: Postprocessing,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub tenant: String,
    pub actor: String,
    pub key: String,
    pub intent_digest: String,
    pub source_id: i64,
    pub job_id: String,
    pub input_version: u32,
    pub input: Input,
    pub requested_files: Vec<File>,
    pub requested_digest: String,
    pub state: State,
    pub basis: Basis,
    pub default_rules: bool,
    pub original_rules: Option<String>,
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
    pub owned: Option<OwnedInput>,
    pub artifact: Option<Artifact>,
    pub receipt: Option<Receipt>,
    pub cleanup_settled: bool,
}
#[derive(Clone, Debug)]
pub enum Phase {
    Read,
    Owned(OwnedInput),
    Published(Artifact),
    Activate,
    Cleanup,
    Fail,
}
pub(crate) enum Command {
    Admit {
        credential: jobs::Credential,
        policy: AuthPolicy,
        storage: Arc<crate::Shared>,
        request: Admission,
        expected_files: Vec<File>,
        disk_bytes: u64,
        accounting_epoch: u64,
        quota: u64,
    },
    Get {
        credential: jobs::Credential,
        policy: AuthPolicy,
        storage: Arc<crate::Shared>,
        key: String,
    },
    Phase {
        lease: jobs::AttemptLease,
        phase: Phase,
    },
}
pub struct ImportClient {
    storage: SettingsClient,
    policy: AuthPolicy,
    quota: u64,
}
impl WriterOwner {
    pub fn imports(&self, policy: AuthPolicy, quota: u64) -> Result<ImportClient> {
        ensure!(
            quota > 0 && quota <= 64 * 1024 * 1024 * 1024,
            "Invalid desktop quota"
        );
        self.auth_with_policy(policy)?;
        let mut configured = self
            .client
            .shared
            .import_quota
            .lock()
            .map_err(|_| anyhow!("Import quota poisoned"))?;
        ensure!(
            configured.is_none_or(|q| q == quota),
            "Import quota already configured"
        );
        *configured = Some(quota);
        Ok(ImportClient {
            storage: self.client(),
            policy,
            quota,
        })
    }
    pub fn import_repos_root(&self) -> Result<std::path::PathBuf> {
        Ok(self
            .lease
            .as_ref()
            .ok_or_else(|| anyhow!("Storage stopped"))?
            .data_dir()
            .join("repos"))
    }
}
impl ImportClient {
    pub fn accounting_epoch(&self) -> u64 {
        self.storage.shared.import_epoch.load(Ordering::Acquire)
    }
    pub fn admit(
        &self,
        credential: jobs::Credential,
        request: Admission,
        expected_files: Vec<File>,
        disk_bytes: u64,
        accounting_epoch: u64,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Admit {
                credential,
                policy: self.policy,
                storage: self.storage.shared.clone(),
                request,
                expected_files,
                disk_bytes,
                accounting_epoch,
                quota: self.quota,
            },
            cancelled,
        )
    }
    pub fn get(&self, credential: jobs::Credential, key: String) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Get {
                credential,
                policy: self.policy,
                storage: self.storage.shared.clone(),
                key,
            },
            &AtomicBool::new(false),
        )
    }
}
pub(crate) fn submit(
    storage: &SettingsClient,
    command: Command,
    cancelled: &AtomicBool,
) -> Result<Operation> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut queue = storage
        .shared
        .queue
        .lock()
        .map_err(|_| anyhow!("Writer admission poisoned"))?;
    loop {
        ensure!(!queue.closed, "Storage stopped");
        ensure!(
            !cancelled.load(Ordering::Acquire),
            "Cancelled before admission"
        );
        if queue.pending.len() < storage.shared.capacity {
            let (reply, rx) = mpsc::channel();
            queue
                .pending
                .push_back(Envelope::Uploads { command, reply });
            storage.shared.changed.notify_all();
            drop(queue);
            return rx
                .recv()
                .map_err(|_| anyhow!("Import commit outcome unknown"))?;
        }
        ensure!(Instant::now() < deadline, "Writer queue full");
        queue = storage
            .shared
            .changed
            .wait_timeout(queue, Duration::from_millis(5))
            .map_err(|_| anyhow!("Writer admission poisoned"))?
            .0;
    }
}
fn load(tx: &Transaction<'_>, tenant: &str, key: &str) -> Result<Option<Operation>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT document FROM source_import_operations WHERE tenant=?1 AND operation_key=?2",
            params![tenant, key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| {
        let op: Operation = serde_json::from_str(&s)?;
        validate_operation(&op)?;
        Ok(op)
    })
    .transpose()
}
fn store(tx: &Transaction<'_>, op: &Operation) -> Result<()> {
    validate_operation(op)?;
    let state = serde_json::to_value(&op.state)?
        .as_str()
        .unwrap()
        .to_owned();
    tx.execute("UPDATE source_import_operations SET state=?3,document=?4 WHERE tenant=?1 AND operation_key=?2",params![op.tenant,op.key,state,serde_json::to_string(op)?])?;
    Ok(())
}
fn basis(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<Basis> {
    Ok(tx.query_row("SELECT current_source_revision_id,url,branch,tag,source_kind,source_type,local_path,last_commit_sha,legacy_manifest_cutover FROM projects WHERE tenant_id=?1 AND id=?2",params![tenant,id],|r|Ok(Basis{current_source_revision_id:r.get(0)?,url:r.get(1)?,branch:r.get(2)?,tag:r.get(3)?,source_kind:r.get(4)?,source_type:r.get(5)?,local_path:r.get(6)?,last_commit_sha:r.get(7)?,legacy_manifest_cutover:r.get(8)?}))?)
}
fn digest(s: &str) -> Result<()> {
    ensure!(
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "Invalid digest"
    );
    Ok(())
}
fn path(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s.len() <= 4096
            && !s.contains(['\\', ':', '\0'])
            && !s.starts_with('/')
            && s.split('/').all(|p| !p.is_empty() && p != "." && p != ".."),
        "Invalid relative path"
    );
    Ok(())
}
fn files(files: &[File], max: u64) -> Result<()> {
    ensure!(!files.is_empty() && files.len() <= 10000, "Invalid files");
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    for f in files {
        path(&f.path)?;
        digest(&f.sha256)?;
        ensure!(names.insert(&f.path), "Duplicate file");
        total = total
            .checked_add(f.size)
            .ok_or_else(|| anyhow!("Input size overflow"))?;
    }
    ensure!(total <= max, "Input limit");
    Ok(())
}
pub(crate) fn execute(
    conn: &mut Connection,
    catalog_state: &catalog::State,
    command: Command,
) -> Result<Operation> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let op = match command {
        Command::Get {
            credential,
            policy,
            storage,
            key,
        } => {
            let (tenant, actor) = jobs::actor(&tx, credential, policy, &storage)?;
            let op = load(&tx, &tenant, &key)?.ok_or_else(|| anyhow!("Import not found"))?;
            ensure!(op.actor == actor, "Import belongs to another actor");
            op
        }
        Command::Admit {
            credential,
            policy,
            storage,
            request,
            expected_files,
            disk_bytes,
            accounting_epoch,
            quota,
        } => {
            ensure!(
                storage.import_epoch.load(Ordering::Acquire) == accounting_epoch,
                "Import accounting changed; retry admission"
            );
            let (tenant, actor) = jobs::actor(&tx, credential, policy, &storage)?;
            ensure!(
                !request.key.is_empty()
                    && request.key.len() <= 128
                    && !request.key.chars().any(char::is_control),
                "Invalid operation key"
            );
            files(&expected_files, request.max_input_bytes)?;
            let requested_digest =
                hex::encode(Sha256::digest(serde_json::to_vec(&expected_files)?));
            let intent_digest = hex::encode(Sha256::digest(serde_json::to_vec(&(
                &request,
                &expected_files,
            ))?));
            if let Some(prior) = load(&tx, &tenant, &request.key)? {
                ensure!(
                    prior.actor == actor && prior.intent_digest == intent_digest,
                    "Import idempotency conflict"
                );
                prior
            } else {
                ensure!(
                    request.max_input_bytes > 0
                        && request.max_input_bytes <= 256 * 1024 * 1024
                        && request.max_prepared_bytes > 0
                        && request.max_prepared_bytes <= 1024 * 1024 * 1024,
                    "Invalid import limits"
                );
                let minimum = request
                    .max_input_bytes
                    .checked_add(3 * request.max_prepared_bytes)
                    .and_then(|v| v.checked_add(16 * 1024 * 1024))
                    .ok_or_else(|| anyhow!("Quota overflow"))?;
                ensure!(
                    request.reserved_bytes >= minimum && request.reserved_bytes <= quota,
                    "Import quota exceeded"
                );
                let pending:i64=tx.query_row("SELECT COALESCE(SUM(reserved_bytes),0) FROM source_import_quota WHERE settled=0",[],|r|r.get(0))?;
                ensure!(
                    disk_bytes
                        .checked_add(pending as u64)
                        .and_then(|v| v.checked_add(request.reserved_bytes))
                        .is_some_and(|v| v <= quota),
                    "Owner import quota exceeded"
                );
                let paths = match &request.input {
                    Input::Files { paths } => paths.clone(),
                    Input::Zip { path } => vec![path.clone()],
                };
                ensure!(
                    !paths.is_empty() && paths.len() <= 10000,
                    "Invalid supplied input"
                );
                for p in paths {
                    path(&p)?;
                }
                let id = match request.target {
                    Target::Existing { source_id } => source_id,
                    Target::Create { metadata } => match catalog::run(
                        &tx,
                        catalog_state,
                        &tenant,
                        catalog::Request::Create { source: *metadata },
                    )? {
                        catalog::Outcome::Source(Some(s)) => s.id,
                        _ => unreachable!(),
                    },
                };
                let basis = basis(&tx, &tenant, id)?;
                let original_rules: Option<String> = tx.query_row(
                    "SELECT imported_paths FROM projects WHERE tenant_id=?1 AND id=?2",
                    params![tenant, id],
                    |r| r.get(0),
                )?;
                let default_rules = original_rules
                    .as_ref()
                    .is_none_or(|s| s.trim().is_empty() || s.trim() == "[]");
                let payload = jobs::Payload::SuppliedSourceImport {
                    project_id: id.try_into()?,
                    operation_key: request.key.clone(),
                    input_version: 1,
                };
                let job = match jobs::user(
                    &tx,
                    &tenant,
                    &actor,
                    jobs::UserOperation::Enqueue {
                        key: format!(
                            "source-import:{}",
                            hex::encode(Sha256::digest(request.key.as_bytes()))
                        ),
                        payload_version: 1,
                        payload,
                    },
                )? {
                    jobs::Outcome::Job(job, _) => job,
                    _ => unreachable!(),
                };
                let op = Operation {
                    tenant,
                    actor,
                    key: request.key,
                    intent_digest,
                    source_id: id,
                    job_id: job.job_id,
                    input_version: 1,
                    input: request.input,
                    requested_files: expected_files,
                    requested_digest,
                    state: State::Admitted,
                    basis,
                    default_rules,
                    original_rules,
                    reserved_bytes: request.reserved_bytes,
                    max_input_bytes: request.max_input_bytes,
                    max_prepared_bytes: request.max_prepared_bytes,
                    owned: None,
                    artifact: None,
                    receipt: None,
                    cleanup_settled: false,
                };
                tx.execute("INSERT INTO source_import_operations(tenant,operation_key,actor,intent_digest,source_id,job_id,state,document_version,document) VALUES(?1,?2,?3,?4,?5,?6,'admitted',1,?7)",params![op.tenant,op.key,op.actor,op.intent_digest,op.source_id,op.job_id,serde_json::to_string(&op)?])?;
                tx.execute(
                    "INSERT INTO source_import_quota VALUES(?1,?2,?3,0,0)",
                    params![op.tenant, op.key, i64::try_from(op.reserved_bytes)?],
                )?;
                op
            }
        }
        Command::Phase { lease, phase } => {
            let mut job = jobs::claimed_job(&tx, &lease)?;
            let (source_id, key) = match &job.payload {
                jobs::Payload::SuppliedSourceImport {
                    project_id,
                    operation_key,
                    input_version: 1,
                } => (*project_id as i64, operation_key.clone()),
                _ => return Err(anyhow!("Not supplied Source import")),
            };
            let mut op =
                load(&tx, &job.tenant, &key)?.ok_or_else(|| anyhow!("Missing import operation"))?;
            ensure!(
                op.job_id == job.job_id && op.source_id == source_id,
                "Import job binding mismatch"
            );
            ensure!(
                !job.cancel_requested
                    || matches!(phase, Phase::Cleanup | Phase::Fail | Phase::Read),
                "Import cancelled"
            );
            match phase {
                Phase::Read => {}
                Phase::Owned(owned) => {
                    ensure!(op.state == State::Admitted, "Input already captured");
                    ensure!(
                        owned.locator == format!(".pp-imports/{}", op.job_id),
                        "Owned locator mismatch"
                    );
                    digest(&owned.digest)?;
                    files(&owned.files, op.max_input_bytes)?;
                    ensure!(
                        owned.files == op.requested_files && owned.digest == op.requested_digest,
                        "Supplied input changed after admission"
                    );
                    op.owned = Some(owned);
                    op.state = State::OwnedInputReady;
                }
                Phase::Published(artifact) => {
                    ensure!(op.state == State::OwnedInputReady, "Input not ready");
                    ensure!(
                        artifact.tenant == op.tenant
                            && artifact.source_id == op.source_id
                            && artifact.locator
                                == format!("{}/revisions/{}", op.source_id, artifact.upstream_key),
                        "Artifact binding mismatch"
                    );
                    digest(&artifact.upstream_key)?;
                    digest(&artifact.manifest_digest)?;
                    files(&artifact.files, op.max_prepared_bytes)?;
                    ensure!(
                        artifact.stored_bytes <= op.reserved_bytes,
                        "Artifact quota exceeded"
                    );
                    op.artifact = Some(artifact);
                    op.state = State::Published;
                }
                Phase::Activate => {
                    ensure!(op.state == State::Published, "Artifact not published");
                    activate(&tx, catalog_state, &mut op)?;
                }
                Phase::Fail => {
                    ensure!(op.receipt.is_none(), "Import already completed");
                    op.state = if job.cancel_requested {
                        State::Cancelled
                    } else {
                        State::Failed
                    };
                }
                Phase::Cleanup => {
                    ensure!(
                        matches!(
                            op.state,
                            State::Activated | State::Conflict | State::Failed | State::Cancelled
                        ),
                        "Import is not settled"
                    );
                    op.cleanup_settled = true;
                    tx.execute("UPDATE source_import_quota SET reserved_bytes=0,retained_bytes=?3,settled=1 WHERE tenant=?1 AND operation_key=?2",params![op.tenant,op.key,i64::try_from(op.artifact.as_ref().map_or(0,|a|a.stored_bytes))?])?;
                    job.state = match op.state {
                        State::Activated => jobs::PersistentState::Succeeded,
                        State::Cancelled => jobs::PersistentState::Cancelled,
                        _ => jobs::PersistentState::Failed,
                    };
                    jobs::save(&tx, &mut job, "source_import_settled")?;
                }
            }
            store(&tx, &op)?;
            op
        }
    };
    tx.commit()?;
    Ok(op)
}
fn activate(tx: &Transaction<'_>, state: &catalog::State, op: &mut Operation) -> Result<()> {
    let a = op
        .artifact
        .as_ref()
        .ok_or_else(|| anyhow!("Missing artifact"))?;
    let now = auth::catalog_timestamp();
    tx.execute("INSERT INTO source_revisions(tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at,completeness) VALUES(?1,?2,?3,?4,?5,?6,'complete') ON CONFLICT DO NOTHING",params![op.tenant,op.source_id,a.upstream_key,a.manifest_digest,a.locator,now])?;
    let(id,digest,locator,synced):(i64,String,String,String)=tx.query_row("SELECT id,manifest_digest,snapshot_locator,synced_at FROM source_revisions WHERE tenant_id=?1 AND project_id=?2 AND upstream_revision_key=?3 AND completeness='complete'",params![op.tenant,op.source_id,a.upstream_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    ensure!(
        digest == a.manifest_digest && locator == a.locator,
        "Accepted revision identity mismatch"
    );
    let b = &op.basis;
    let local = state
        .directory
        .join("repos")
        .join(&a.locator)
        .to_string_lossy()
        .into_owned();
    let version = a.upstream_key.clone();
    let changed=tx.execute("UPDATE projects SET current_source_revision_id=?3,local_path=?4,last_commit_sha=?5,last_synced_at=?6 WHERE tenant_id=?1 AND id=?2 AND current_source_revision_id IS ?7 AND url=?8 AND branch=?9 AND tag IS ?10 AND source_kind=?11 AND source_type=?12 AND local_path IS ?13 AND last_commit_sha IS ?14 AND legacy_manifest_cutover=?15",params![op.tenant,op.source_id,id,local,version,synced,b.current_source_revision_id,b.url,b.branch,b.tag,b.source_kind,b.source_type,b.local_path,b.last_commit_sha,b.legacy_manifest_cutover])?;
    let activated = changed == 1;
    let mut postprocessing = Postprocessing::NotActivated;
    if activated {
        let raw: Option<String> = tx.query_row(
            "SELECT metadata_json FROM projects WHERE tenant_id=?1 AND id=?2",
            params![op.tenant, op.source_id],
            |r| r.get(0),
        )?;
        let mut metadata = raw
            .and_then(|s| {
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok()
            })
            .unwrap_or_default();
        metadata.insert(
            "remote_update_status".into(),
            serde_json::json!("up_to_date"),
        );
        metadata.insert("remote_checked_at".into(), serde_json::json!(now));
        metadata.remove("sync_error");
        metadata.remove("sync_required");
        tx.execute(
            "UPDATE projects SET metadata_json=?3 WHERE tenant_id=?1 AND id=?2",
            params![op.tenant, op.source_id, serde_json::to_string(&metadata)?],
        )?;
        let current_rules: Option<String> = tx.query_row(
            "SELECT imported_paths FROM projects WHERE tenant_id=?1 AND id=?2",
            params![op.tenant, op.source_id],
            |r| r.get(0),
        )?;
        if op.default_rules && current_rules == op.original_rules && !a.suggested_rules.is_empty() {
            catalog::run(
                tx,
                state,
                &op.tenant,
                catalog::Request::SaveImportRules {
                    id: op.source_id,
                    rules: a.suggested_rules.clone(),
                },
            )?;
        }
        tx.execute_batch("SAVEPOINT import_docs")?;
        let docs = (|| -> Result<()> {
            tx.execute(
                "DELETE FROM source_docs WHERE tenant_id=?1 AND project_id=?2",
                params![op.tenant, op.source_id],
            )?;
            let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
                .map_err(|e| anyhow!("{e}"))?;
            let mut ordered = a.files.iter().collect::<Vec<_>>();
            ordered.sort_by(|a, b| {
                (a.kind != "readme")
                    .cmp(&(b.kind != "readme"))
                    .then_with(|| collator.compare(&a.path, &b.path))
            });
            for f in ordered {
                if ["readme", "md", "pdf"].contains(&f.kind.as_str()) {
                    tx.execute("INSERT INTO source_docs(tenant_id,project_id,path,kind,size_bytes,content_hash,extract_status,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![op.tenant,op.source_id,f.path,f.kind,i64::try_from(f.size)?,&f.sha256[..24],if f.kind=="pdf"{"pending"}else{"na"},now])?;
                }
            }
            Ok(())
        })();
        postprocessing = if docs.is_ok() {
            tx.execute_batch("RELEASE import_docs")?;
            if a.files.iter().any(|f| f.kind == "pdf") {
                Postprocessing::DocumentMetadataIndexedPdfPending
            } else {
                Postprocessing::DocumentMetadataIndexed
            }
        } else {
            tx.execute_batch("ROLLBACK TO import_docs; RELEASE import_docs")?;
            Postprocessing::IndexError
        };
    }
    op.state = if activated {
        State::Activated
    } else {
        State::Conflict
    };
    op.receipt = Some(Receipt {
        tenant: op.tenant.clone(),
        operation_key: op.key.clone(),
        job_id: op.job_id.clone(),
        source_id: op.source_id,
        revision_id: id,
        artifact: a.clone(),
        basis: op.basis.clone(),
        activated,
        applied_at: now,
        postprocessing,
    });
    Ok(())
}
pub(crate) fn source_reserved(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM source_import_operations o JOIN source_import_quota q USING(tenant,operation_key) WHERE o.tenant=?1 AND o.source_id=?2 AND q.settled=0)",params![tenant,id],|r|r.get(0))?)
}
pub(crate) fn validate_schema(conn: &Connection, version: u64) -> Result<()> {
    let names = [
        "source_import_operations",
        "source_import_source",
        "source_import_quota",
        "source_import_quota_pending",
    ];
    if version < 36 {
        for name in names {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [name],
                |r| r.get(0),
            )?;
            ensure!(!present, "Unexpected Source import schema");
        }
        return Ok(());
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(include_str!("uploads/schema.sql"))?;
    for name in names {
        let sql: String =
            conn.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })?;
        let canonical: String =
            expected.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })?;
        ensure!(sql == canonical, "Source import schema mismatch");
    }
    let orphans:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM source_import_quota q LEFT JOIN source_import_operations o USING(tenant,operation_key) WHERE o.tenant IS NULL)",[],|r|r.get(0))?;
    ensure!(!orphans, "Orphan Source quota");
    let rows=conn.prepare("SELECT tenant,operation_key,actor,intent_digest,source_id,job_id,state,document_version,document FROM source_import_operations")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,u32>(7)?,r.get::<_,String>(8)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (t, k, a, d, s, j, state, v, raw) in rows {
        let op: Operation = serde_json::from_str(&raw)?;
        ensure!(
            v == 1
                && op.input_version == 1
                && t == op.tenant
                && k == op.key
                && a == op.actor
                && d == op.intent_digest
                && s == op.source_id
                && j == op.job_id
                && serde_json::to_value(&op.state)? == state,
            "Corrupt Source import journal"
        );
        validate_operation(&op)?;
        let document: String = conn.query_row("SELECT document FROM durable_jobs WHERE id=?1 UNION ALL SELECT archived_document FROM durable_job_keys WHERE job_id=?1 AND archived_document IS NOT NULL LIMIT 1",[&j],|r|r.get(0))?;
        let job: jobs::JobRecord = serde_json::from_str(&document)?;
        ensure!(
            job.job_id == j
                && job.tenant == t
                && job.payload
                    == jobs::Payload::SuppliedSourceImport {
                        project_id: s.try_into()?,
                        operation_key: k.clone(),
                        input_version: 1
                    },
            "Import job binding mismatch"
        );
        ensure!(
            !op.cleanup_settled || job.state.terminal(),
            "Import completion job mismatch"
        );
        let retained: i64 = conn.query_row(
            "SELECT retained_bytes FROM source_import_quota WHERE tenant=?1 AND operation_key=?2",
            params![t, k],
            |r| r.get(0),
        )?;
        ensure!(
            retained
                == if op.cleanup_settled {
                    i64::try_from(op.artifact.as_ref().map_or(0, |a| a.stored_bytes))?
                } else {
                    0
                },
            "Retained quota mismatch"
        );
        digest(&d)?;
        let(q,settled):(i64,bool)=conn.query_row("SELECT reserved_bytes,settled FROM source_import_quota WHERE tenant=?1 AND operation_key=?2",params![t,k],|r|Ok((r.get(0)?,r.get(1)?)))?;
        ensure!(
            settled == op.cleanup_settled
                && q == if settled {
                    0
                } else {
                    i64::try_from(op.reserved_bytes)?
                },
            "Corrupt Source quota journal"
        );
    }
    Ok(())
}

fn validate_operation(op: &Operation) -> Result<()> {
    ensure!(
        op.input_version == 1
            && op.source_id > 0
            && !op.key.is_empty()
            && op.key.len() <= 128
            && !op.actor.is_empty(),
        "Invalid import identity"
    );
    digest(&op.job_id)?;
    digest(&op.intent_digest)?;
    digest(&op.requested_digest)?;
    files(&op.requested_files, op.max_input_bytes)?;
    ensure!(
        hex::encode(Sha256::digest(serde_json::to_vec(&op.requested_files)?))
            == op.requested_digest,
        "Input digest mismatch"
    );
    let paths = match &op.input {
        Input::Files { paths } => paths.clone(),
        Input::Zip { path } => vec![path.clone()],
    };
    ensure!(
        paths
            == op
                .requested_files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
            && op.requested_files.iter().all(|f| f.kind == "input"),
        "Input binding mismatch"
    );
    if let Some(owned) = &op.owned {
        ensure!(
            owned.locator == format!(".pp-imports/{}", op.job_id)
                && owned.digest == op.requested_digest
                && owned.files == op.requested_files,
            "Owned input binding mismatch"
        );
    }
    if let Some(a) = &op.artifact {
        digest(&a.upstream_key)?;
        digest(&a.manifest_digest)?;
        files(&a.files, op.max_prepared_bytes)?;
        ensure!(
            a.tenant == op.tenant
                && a.source_id == op.source_id
                && a.locator == format!("{}/revisions/{}", op.source_id, a.upstream_key)
                && a.stored_bytes <= op.reserved_bytes
                && a.files
                    .iter()
                    .all(|f| ["stl", "artifact", "readme", "md", "pdf"].contains(&f.kind.as_str())),
            "Artifact binding mismatch"
        );
    }
    if let Some(r) = &op.receipt {
        ensure!(
            r.tenant == op.tenant
                && r.source_id == op.source_id
                && r.operation_key == op.key
                && r.job_id == op.job_id
                && r.revision_id > 0
                && r.basis == op.basis
                && Some(&r.artifact) == op.artifact.as_ref()
                && r.activated == (op.state == State::Activated),
            "Receipt binding mismatch"
        );
        ensure!(
            match r.postprocessing {
                Postprocessing::NotActivated => !r.activated && op.state == State::Conflict,
                Postprocessing::DocumentMetadataIndexed =>
                    r.activated && !r.artifact.files.iter().any(|f| f.kind == "pdf"),
                Postprocessing::DocumentMetadataIndexedPdfPending =>
                    r.activated && r.artifact.files.iter().any(|f| f.kind == "pdf"),
                Postprocessing::IndexError => r.activated,
            },
            "Receipt postprocessing mismatch"
        );
    }
    ensure!(
        match op.state {
            State::Admitted => op.owned.is_none() && op.artifact.is_none() && op.receipt.is_none(),
            State::OwnedInputReady =>
                op.owned.is_some() && op.artifact.is_none() && op.receipt.is_none(),
            State::Published => op.owned.is_some() && op.artifact.is_some() && op.receipt.is_none(),
            State::Activated | State::Conflict =>
                op.owned.is_some() && op.artifact.is_some() && op.receipt.is_some(),
            State::Failed | State::Cancelled => op.receipt.is_none(),
        },
        "Invalid import state"
    );
    ensure!(
        !op.cleanup_settled
            || matches!(
                op.state,
                State::Activated | State::Conflict | State::Failed | State::Cancelled
            ),
        "Unsettled import cleanup"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Postprocessing;

    #[test]
    fn postprocessing_preserves_all_durable_wire_values() {
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
            let encoded = serde_json::to_string(&state).unwrap();
            assert_eq!(encoded, format!("\"{wire}\""));
            assert_eq!(
                serde_json::from_str::<Postprocessing>(&encoded).unwrap(),
                state
            );
        }
    }

    #[test]
    fn postprocessing_rejects_obsolete_and_unknown_values() {
        for wire in ["complete", "unknown", "", "DocumentMetadataIndexed"] {
            assert!(serde_json::from_value::<Postprocessing>(serde_json::json!(wire)).is_err());
        }
    }
}
