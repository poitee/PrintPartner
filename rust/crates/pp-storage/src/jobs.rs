mod filename;
mod model;
use crate::{
    Envelope, SettingsClient, WriterOwner,
    auth::{self, AuthPolicy, Secret},
};
use anyhow::{Result, anyhow, ensure};
pub use filename::*;
pub use model::*;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub struct PhysicalOwner {
    storage: Arc<crate::Shared>,
}
pub enum Credential {
    Session(Secret),
    RoutedKey { tenant: String, key: Secret },
    PhysicalOwner(PhysicalOwner),
}
#[derive(Clone)]
pub struct AtomicJobClient {
    storage: SettingsClient,
    policy: AuthPolicy,
}
#[derive(Clone)]
pub struct ServerWorkerClient {
    storage: SettingsClient,
    identity: String,
    admission: Arc<WorkerAdmission>,
}
#[derive(Clone)]
pub struct AttemptLease {
    job_id: String,
    tenant: String,
    generation: i64,
    version: i64,
    fence: String,
    worker: String,
}
impl AttemptLease {
    pub fn job_id(&self) -> &str {
        &self.job_id
    }
}
#[derive(Clone, PartialEq, Eq)]
pub struct WorkerAdmission {
    pub kinds: Vec<(JobKind, usize)>,
    pub total: usize,
    pub per_resource: usize,
    pub lease_seconds: u32,
}
impl WorkerAdmission {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.total > 0
                && self.total <= 128
                && self.per_resource > 0
                && self.per_resource <= self.total
                && (1..=3600).contains(&self.lease_seconds),
            "Invalid worker admission"
        );
        let mut kinds = std::collections::HashSet::new();
        for (kind, limit) in &self.kinds {
            ensure!(
                *limit > 0 && *limit <= self.total && kinds.insert(kind.name()),
                "Invalid kind admission"
            );
        }
        Ok(())
    }
}
pub enum UserOperation {
    Enqueue {
        key: String,
        payload_version: u32,
        payload: Payload,
    },
    Get {
        job_id: String,
    },
    List(JobListQuery),
    History {
        job_id: String,
        before_version: Option<i64>,
        limit: u16,
    },
    Reconciliations {
        job_id: String,
        before_version: Option<i64>,
        limit: u16,
    },
    Cancel {
        job_id: String,
    },
    Reconcile {
        job_id: String,
        expected_version: i64,
        expected_generation: i64,
        effect_hash: String,
        decision: Decision,
        receipt: Option<ResultArtifact>,
    },
}
pub enum WorkerOperation {
    Heartbeat,
    Progress(u8),
    BeginEffect(EffectIntent),
    ConfirmEffect(ResultArtifact),
    Finish(Option<ResultArtifact>),
    Fail,
}
pub enum Outcome {
    Job(JobRecord, LocalCommit),
    List(Vec<JobRecord>),
    History(Vec<HistoryEntry>),
    Reconciliations(Vec<ReconciliationRecord>),
    Claimed(Option<(JobRecord, AttemptLease)>),
    Retained(usize),
}
pub(crate) enum Command {
    User {
        credential: Credential,
        policy: AuthPolicy,
        operation: UserOperation,
        storage: Arc<crate::Shared>,
    },
    Claim {
        worker: String,
        admission: Arc<WorkerAdmission>,
    },
    Worker {
        lease: AttemptLease,
        operation: WorkerOperation,
        admission: Arc<WorkerAdmission>,
    },
    Retain {
        per_tenant: usize,
        global: usize,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobFailure {
    CommitUnknown,
    JobDocTooLarge { size: usize, limit: usize },
}
impl std::fmt::Display for JobFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CommitUnknown => f.write_str("Job commit outcome unknown"),
            Self::JobDocTooLarge { size, limit } => write!(
                f,
                "Durable job document is {size} bytes, exceeding the {limit}-byte limit"
            ),
        }
    }
}
impl std::error::Error for JobFailure {}
pub struct PendingClaim(Pending);
impl PendingClaim {
    pub fn receive(self) -> Result<Option<(JobRecord, AttemptLease)>> {
        match self.0.receive()? {
            Outcome::Claimed(value) => Ok(value),
            _ => unreachable!(),
        }
    }
}
pub struct Pending(mpsc::Receiver<Result<Outcome>>);
impl Pending {
    pub fn receive(self) -> Result<Outcome> {
        self.0
            .recv()
            .map_err(|_| anyhow!(JobFailure::CommitUnknown))?
    }
}
fn submit(
    storage: &SettingsClient,
    command: Command,
    cancelled: &AtomicBool,
    wait: Duration,
) -> Result<Pending> {
    let deadline = Instant::now() + wait;
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
            let (reply, receiver) = mpsc::channel();
            queue.pending.push_back(Envelope::Jobs { command, reply });
            storage.shared.changed.notify_all();
            return Ok(Pending(receiver));
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
impl WriterOwner {
    pub fn jobs(&self, policy: AuthPolicy) -> Result<AtomicJobClient> {
        self.auth_with_policy(policy)?;
        Ok(AtomicJobClient {
            storage: self.client(),
            policy,
        })
    }
    pub fn job_physical_owner(&self) -> PhysicalOwner {
        PhysicalOwner {
            storage: self.client.shared.clone(),
        }
    }
    pub fn job_worker(&self, admission: WorkerAdmission) -> Result<ServerWorkerClient> {
        admission.validate()?;
        let mut configured = self
            .client
            .shared
            .job_admission
            .lock()
            .map_err(|_| anyhow!("Worker admission poisoned"))?;
        if let Some(existing) = configured.as_ref() {
            ensure!(
                existing.as_ref() == &admission,
                "Worker admission already configured"
            );
        }
        let admission = configured
            .get_or_insert_with(|| Arc::new(admission))
            .clone();
        Ok(ServerWorkerClient {
            storage: self.client(),
            identity: random(),
            admission,
        })
    }
    pub fn retain_jobs(&self, per_tenant: usize, global: usize) -> Result<usize> {
        ensure!(
            per_tenant > 0 && global >= per_tenant && global <= 10000,
            "Invalid retention bounds"
        );
        match submit(
            &self.client,
            Command::Retain { per_tenant, global },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
        {
            Outcome::Retained(n) => Ok(n),
            _ => unreachable!(),
        }
    }
}
impl AtomicJobClient {
    pub fn submit(
        &self,
        credential: Credential,
        mut operation: UserOperation,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<Pending> {
        if let UserOperation::Enqueue {
            key,
            payload_version,
            payload,
        } = &mut operation
        {
            model::text(key, 128)?;
            ensure!(*payload_version == 1, "Unsupported payload version");
            if let Payload::ExportStlPack {
                filename_grouping: Some(grouping),
                ..
            } = payload
            {
                grouping.normalize();
            }
            payload.validate()?;
        }
        submit(
            &self.storage,
            Command::User {
                credential,
                policy: self.policy,
                operation,
                storage: self.storage.shared.clone(),
            },
            cancelled,
            wait,
        )
    }
}
impl ServerWorkerClient {
    pub fn begin_source_work(
        &self,
        lease: &AttemptLease,
        source_id: Option<i64>,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<crate::catalog::SourceWorkLease> {
        ensure!(lease.worker == self.identity, "Foreign worker lease");
        crate::catalog::begin_job_work(&self.storage, lease.clone(), source_id, cancelled, wait)
    }

    pub fn claim_pending(&self, cancelled: &AtomicBool, wait: Duration) -> Result<PendingClaim> {
        Ok(PendingClaim(submit(
            &self.storage,
            Command::Claim {
                worker: self.identity.clone(),
                admission: self.admission.clone(),
            },
            cancelled,
            wait,
        )?))
    }
    pub fn claim(&self) -> Result<Option<(JobRecord, AttemptLease)>> {
        self.claim_pending(&AtomicBool::new(false), Duration::from_secs(5))?
            .receive()
    }
    pub fn update(
        &self,
        lease: &mut AttemptLease,
        operation: WorkerOperation,
    ) -> Result<JobRecord> {
        ensure!(lease.worker == self.identity, "Foreign worker lease");
        match submit(
            &self.storage,
            Command::Worker {
                lease: lease.clone(),
                operation,
                admission: self.admission.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
        {
            Outcome::Job(record, _) => {
                lease.version = record.state_version;
                Ok(record)
            }
            _ => unreachable!(),
        }
    }
}
fn random() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
pub const JOB_DOC_SIZE_LIMIT: usize = 131072;

fn check_document_size(size: usize) -> Result<()> {
    ensure!(
        size <= JOB_DOC_SIZE_LIMIT,
        JobFailure::JobDocTooLarge {
            size,
            limit: JOB_DOC_SIZE_LIMIT
        }
    );
    Ok(())
}

fn decode_row(id: &str, document: &str) -> Option<JobRecord> {
    match decode(document) {
        Ok(job) => Some(job),
        Err(error) => {
            eprintln!("Skipping invalid durable job row {id}: {error}");
            None
        }
    }
}

fn encode(job: &JobRecord) -> Result<String> {
    let mut document = serde_json::to_value(job)?;
    document["_attempt_worker"] = serde_json::to_value(&job.worker)?;
    document["_attempt_fence"] = serde_json::to_value(&job.fence)?;
    let document = serde_json::to_string(&document)?;
    check_document_size(document.len())?;
    Ok(document)
}
fn decode(document: &str) -> Result<JobRecord> {
    check_document_size(document.len())?;
    let value: serde_json::Value = serde_json::from_str(document)?;
    let mut job: JobRecord = serde_json::from_value(value.clone())?;
    job.fence = serde_json::from_value(
        value
            .get("_attempt_fence")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )?;
    job.worker = serde_json::from_value(
        value
            .get("_attempt_worker")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )?;
    for timestamp in [
        Some(job.created_at),
        Some(job.updated_at),
        job.finished_at,
        job.lease_until,
    ]
    .into_iter()
    .flatten()
    {
        ensure!(
            time::OffsetDateTime::from_unix_timestamp(timestamp).is_ok(),
            "Invalid job timestamp"
        );
    }
    job.payload.validate_stored()?;
    job.validate_state()?;
    Ok(job)
}
fn load(tx: &Transaction<'_>, id: &str) -> Result<Option<JobRecord>> {
    let document: Option<String> = tx
        .query_row("SELECT document FROM durable_jobs WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    document.map(|v| decode(&v)).transpose()
}
fn owned(tx: &Transaction<'_>, id: &str, tenant: &str) -> Result<JobRecord> {
    let record = load(tx, id)?.ok_or_else(|| anyhow!("Job not found"))?;
    ensure!(record.tenant == tenant, "Job not found");
    Ok(record)
}
fn retained_owned(tx: &Transaction<'_>, id: &str, tenant: &str) -> Result<JobRecord> {
    if let Some(record) = load(tx, id)? {
        ensure!(
            record.tenant == tenant && record.job_id == id,
            "Job not found"
        );
        return Ok(record);
    }
    let document: Option<String> = tx
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE tenant=?1 AND job_id=?2 AND archived_document IS NOT NULL LIMIT 1",
            params![tenant, id],
            |row| row.get(0),
        )
        .optional()?;
    document
        .map(|value| decode(&value))
        .transpose()?
        .map(|record| {
            ensure!(
                record.tenant == tenant && record.job_id == id,
                "Job not found"
            );
            Ok(record)
        })
        .transpose()?
        .ok_or_else(|| anyhow!("Job not found"))
}
fn bind_printer_start(tx: &Transaction<'_>, tenant: &str, mut payload: Payload) -> Result<Payload> {
    let Payload::PrinterStart(request) = &payload else {
        return Ok(payload);
    };
    let parent_id = request.uploaded_job_id.clone();
    let parent = retained_owned(tx, &parent_id, tenant)?;
    ensure!(
        parent.state == PersistentState::UploadedOnly,
        "Parent job is not an uploaded-only print"
    );
    let proof = parent
        .uploaded_only_proof()
        .ok_or_else(|| anyhow!("Parent job is not an uploaded-only print"))?;
    let upload = proof.upload.clone();
    let printer_id = proof.printer_id.to_owned();
    let documents = tx
        .prepare(
            "SELECT document FROM durable_jobs WHERE tenant=?1 AND json_extract(document,'$.payload.payload.uploaded_job_id')=?2
             UNION ALL
             SELECT archived_document FROM durable_job_keys WHERE tenant=?1 AND archived_document IS NOT NULL AND json_extract(archived_document,'$.payload.payload.uploaded_job_id')=?2",
        )?
        .query_map(params![tenant, parent_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for document in documents {
        let existing = decode(&document)?;
        if matches!(
            &existing.payload,
            Payload::PrinterStart(value) if value.uploaded_job_id == parent_id
        ) && !matches!(
            existing.state,
            PersistentState::Failed | PersistentState::Cancelled
        ) {
            return Err(anyhow!("Printer start already requested"));
        }
    }
    payload.bind_printer_start(printer_id, upload)?;
    Ok(payload)
}
fn save(tx: &Transaction<'_>, job: &mut JobRecord, event: &str) -> Result<()> {
    job.payload.validate_stored()?;
    job.state_version += 1;
    job.updated_at = now();
    if job.state.terminal() {
        job.finished_at = Some(job.updated_at);
        job.lease_until = None;
        job.fence = None;
        job.worker = None;
    }
    job.validate_state()?;
    tx.execute("INSERT INTO durable_jobs(id,tenant,kind,state,resource,version,generation,lease_until,created,updated,document) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET state=excluded.state,version=excluded.version,generation=excluded.generation,lease_until=excluded.lease_until,updated=excluded.updated,document=excluded.document",params![job.job_id,job.tenant,job.kind.name(),job.state.name(),job.payload.resource(),job.state_version,job.generation,job.lease_until,job.created_at,job.updated_at,encode(job)?])?;
    tx.execute("DELETE FROM durable_job_history WHERE job_id=?1 AND event IN ('heartbeat','progress') AND version<?2",params![job.job_id,job.state_version-128])?;
    tx.execute(
        "INSERT INTO durable_job_history(job_id,version,at,state,event) VALUES(?1,?2,?3,?4,?5)",
        params![
            job.job_id,
            job.state_version,
            job.updated_at,
            job.state.name(),
            event
        ],
    )?;
    Ok(())
}
fn recover_in(tx: &Transaction<'_>, all: bool) -> Result<()> {
    let documents=tx.prepare("SELECT id,document FROM durable_jobs WHERE state IN ('running','effect_admitted') AND (?1 OR lease_until<=?2)")?.query_map(params![all,now()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, document) in documents {
        let Some(mut job) = decode_row(&id, &document) else {
            continue;
        };
        job.generation += 1;
        job.fence = None;
        job.worker = None;
        job.lease_until = None;
        if job.effects.iter().any(|effect| !effect.confirmed) {
            job.state = PersistentState::ReconciliationRequired;
            job.recovery = Some("Inspect effect receipts and reconcile explicitly".into());
        } else if !job.effects.is_empty() {
            job.state = PersistentState::ReconciliationRequired;
            job.recovery =
                Some("Resume from confirmed receipts requires handler reconciliation".into());
        } else if job.cancel_requested {
            job.state = PersistentState::Cancelled;
        } else if job.attempt >= 100 {
            job.state = PersistentState::Failed;
            job.recovery = Some("Attempt limit reached".into());
        } else {
            job.state = PersistentState::Queued;
        }
        save(tx, &mut job, "attempt_recovered")?;
    }
    Ok(())
}
pub(crate) fn recover(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    recover_in(&tx, true)?;
    tx.commit()?;
    Ok(())
}
pub(crate) fn execute(connection: &mut Connection, command: Command) -> Result<Outcome> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let outcome = match command {
        Command::User {
            credential,
            policy,
            operation,
            storage,
        } => {
            let auth_committed = matches!(&credential, Credential::RoutedKey { .. });
            let (tenant, subject) = match credential {
                Credential::Session(token) => auth::job_session_actor(&tx, token.expose(), policy)?,
                Credential::RoutedKey { tenant, key } => auth::job_key_actor(&tx, &tenant, key)?,
                Credential::PhysicalOwner(owner) => {
                    ensure!(
                        Arc::ptr_eq(&storage, &owner.storage),
                        "Foreign physical owner"
                    );
                    ("default".into(), "physical-owner".into())
                }
            };
            let mut outcome = user(&tx, &tenant, &subject, operation)?;
            if auth_committed && let Outcome::Job(_, commit) = &mut outcome {
                *commit = LocalCommit::Committed;
            }
            outcome
        }
        Command::Claim { worker, admission } => claim(&tx, &worker, &admission)?,
        Command::Worker {
            lease,
            operation,
            admission,
        } => advance(&tx, lease, operation, &admission)?,
        Command::Retain { per_tenant, global } => {
            Outcome::Retained(prune(&tx, per_tenant, global)?)
        }
    };
    if matches!(&outcome,Outcome::Job(job,LocalCommit::Committed) if job.state.terminal()) {
        prune(&tx, 1000, 10000)?;
    }
    tx.commit()
        .map_err(|_| anyhow!(JobFailure::CommitUnknown))?;
    Ok(outcome)
}
fn prune(tx: &Transaction<'_>, per_tenant: usize, global: usize) -> Result<usize> {
    let mut statement=tx.prepare(
        "WITH ranked AS (
            SELECT id,document,updated,rowid AS sequence,
                   ROW_NUMBER() OVER(PARTITION BY tenant ORDER BY updated DESC,rowid DESC) AS local_rank
            FROM durable_jobs WHERE state IN ('uploaded_only','succeeded','failed','cancelled')
         )
         SELECT id,document FROM ranked
         WHERE updated<=?3 OR local_rank>?1 OR id NOT IN (
             SELECT id FROM ranked WHERE local_rank<=?1 AND updated>?3
             ORDER BY updated DESC,sequence DESC LIMIT ?2
         )")?;
    let removed = statement
        .query_map(
            params![per_tenant as i64, global as i64, now() - 86400],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, document) in &removed {
        tx.execute(
            "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
            params![id, document],
        )?;
        tx.execute("DELETE FROM durable_jobs WHERE id=?1", [id])?;
    }
    Ok(removed.len())
}
fn user(
    tx: &Transaction<'_>,
    tenant: &str,
    subject: &str,
    operation: UserOperation,
) -> Result<Outcome> {
    match operation {
        UserOperation::Enqueue {
            key,
            payload_version,
            mut payload,
        } => {
            model::text(&key, 128)?;
            ensure!(payload_version == 1, "Unsupported payload version");
            payload.validate()?;
            let intent = hex::encode(Sha256::digest(serde_json::to_vec(&(
                payload_version,
                &payload,
            ))?));
            let prior: Option<(String, String)> = tx
                .query_row(
                    "SELECT intent,job_id FROM durable_job_keys WHERE tenant=?1 AND key=?2",
                    params![tenant, key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((hash, id)) = prior {
                ensure!(hash == intent, "Idempotency conflict");
                return Ok(Outcome::Job(
                    retained_owned(tx, &id, tenant)?,
                    LocalCommit::ReadOnly,
                ));
            }
            payload = bind_printer_start(tx, tenant, payload)?;
            let active:i64=tx.query_row("SELECT COUNT(*) FROM durable_jobs WHERE state NOT IN ('uploaded_only','succeeded','failed','cancelled')",[],|r|r.get(0))?;
            ensure!(active < 1024, "Durable queue full");
            let mut job = JobRecord {
                job_id: random(),
                tenant: tenant.into(),
                kind: payload.kind(),
                payload_version,
                payload,
                state: PersistentState::Queued,
                state_version: 0,
                attempt: 0,
                generation: 0,
                lease_until: None,
                created_at: now(),
                updated_at: now(),
                finished_at: None,
                cancel_requested: false,
                progress: None,
                effects: vec![],
                result: None,
                recovery: None,
                fence: None,
                worker: None,
            };
            save(tx, &mut job, "enqueued")?;
            tx.execute(
                "INSERT INTO durable_job_keys(tenant,key,intent,job_id) VALUES(?1,?2,?3,?4)",
                params![tenant, key, intent, job.job_id],
            )?;
            Ok(Outcome::Job(job, LocalCommit::Committed))
        }
        UserOperation::Get { job_id } => Ok(Outcome::Job(
            owned(tx, &job_id, tenant)?,
            LocalCommit::ReadOnly,
        )),
        UserOperation::List(query) => {
            prune(tx, 1000, 10000)?;
            ensure!((1..=200).contains(&query.limit), "Invalid list limit");
            if let Some(status) = &query.status {
                ensure!(
                    ["pending", "running", "done", "error", "cancelled"].contains(&status.as_str()),
                    "Invalid job status"
                );
            }
            if let Some(id) = query.profile_id {
                ensure!(
                    id > 0 && id <= 9_007_199_254_740_991,
                    "Invalid profile identifier"
                );
            }
            if let Some((_, id)) = &query.before {
                model::text(id, 128)?;
            }
            let documents=tx.prepare("SELECT id,document FROM durable_jobs WHERE tenant=?1 AND (?2 IS NULL OR CASE state WHEN 'queued' THEN 'pending' WHEN 'running' THEN 'running' WHEN 'effect_admitted' THEN 'running' WHEN 'uploaded_only' THEN 'done' WHEN 'succeeded' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'error' END=?2) AND (?3 IS NULL OR updated>=?3) AND (?4 IS NULL OR json_extract(document,'$.payload.payload.profile_id')=?4) AND (?5 IS NULL OR updated<?5 OR (updated=?5 AND id<?6)) ORDER BY updated DESC,id DESC LIMIT ?7")?.query_map(params![tenant,query.status,query.since,query.profile_id.map(|v|v as i64),query.before.as_ref().map(|c|c.0),query.before.as_ref().map(|c|c.1.as_str()),query.limit],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Outcome::List(
                documents
                    .iter()
                    .filter_map(|(id, document)| decode_row(id, document))
                    .collect(),
            ))
        }
        UserOperation::History {
            job_id,
            before_version,
            limit,
        } => {
            owned(tx, &job_id, tenant)?;
            ensure!((1..=200).contains(&limit), "Invalid history limit");
            let entries=tx.prepare("SELECT version,at,state,event FROM durable_job_history WHERE job_id=?1 AND (?2 IS NULL OR version<?2) ORDER BY version DESC LIMIT ?3")?.query_map(params![job_id,before_version,limit],|r|Ok(HistoryEntry{version:r.get(0)?,at:r.get(1)?,state:r.get(2)?,event:r.get(3)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Outcome::History(entries))
        }
        UserOperation::Reconciliations {
            job_id,
            before_version,
            limit,
        } => {
            owned(tx, &job_id, tenant)?;
            ensure!((1..=200).contains(&limit), "Invalid reconciliation limit");
            let entries=tx.prepare("SELECT version,subject,generation,effect_hash,basis_hash,target,decision,receipt,at FROM durable_job_reconciliations WHERE job_id=?1 AND (?2 IS NULL OR version<?2) ORDER BY version DESC LIMIT ?3")?.query_map(params![job_id,before_version,limit],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,i64>(8)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Outcome::Reconciliations(
                entries
                    .into_iter()
                    .map(
                        |(
                            version,
                            subject,
                            generation,
                            effect_hash,
                            basis_hash,
                            target,
                            decision,
                            receipt,
                            at,
                        )| {
                            Ok(ReconciliationRecord {
                                version,
                                subject,
                                generation,
                                effect_hash,
                                basis_hash,
                                target,
                                decision,
                                receipt: serde_json::from_str(&receipt)?,
                                at,
                            })
                        },
                    )
                    .collect::<Result<_>>()?,
            ))
        }
        UserOperation::Cancel { job_id } => {
            let mut job = owned(tx, &job_id, tenant)?;
            if job.state.terminal() || job.cancel_requested {
                return Ok(Outcome::Job(job, LocalCommit::ReadOnly));
            }
            job.cancel_requested = true;
            if job.effects.is_empty() {
                job.state = PersistentState::Cancelled;
                job.generation += 1;
            } else {
                job.state = PersistentState::ReconciliationRequired;
                job.generation += 1;
                job.fence = None;
                job.worker = None;
                job.lease_until = None;
                job.recovery = Some("Cancellation cannot undo an admitted effect".into());
            }
            save(tx, &mut job, "cancellation_requested")?;
            Ok(Outcome::Job(job, LocalCommit::Committed))
        }
        UserOperation::Reconcile {
            job_id,
            expected_version,
            expected_generation,
            effect_hash,
            decision,
            receipt,
        } => {
            let mut job = owned(tx, &job_id, tenant)?;
            ensure!(
                job.state == PersistentState::ReconciliationRequired
                    && job.state_version == expected_version
                    && job.generation == expected_generation,
                "Stale reconciliation"
            );
            let effect_index = job
                .effects
                .len()
                .checked_sub(1)
                .ok_or_else(|| anyhow!("Missing effect"))?;
            ensure!(
                job.effects[effect_index].intent.content_hash == effect_hash,
                "Wrong reconciliation subject"
            );
            if let Some(receipt) = &receipt {
                receipt.validate()?;
                ensure!(
                    receipt.content_hash == job.effects[effect_index].intent.content_hash
                        && receipt.target == job.effects[effect_index].intent.target,
                    "Receipt mismatch"
                );
            }
            let prior_result = job.result.clone();
            let mut subject_receipt = None;
            match decision {
                Decision::ConfirmSucceeded => {
                    let receipt =
                        receipt.ok_or_else(|| anyhow!("Confirmation receipt required"))?;
                    let effect = &mut job.effects[effect_index];
                    match effect.outcome()? {
                        EffectOutcome::Confirmed(stored) => {
                            ensure!(stored == &receipt, "Receipt mismatch")
                        }
                        EffectOutcome::Unresolved => effect.confirm(receipt.clone())?,
                        EffectOutcome::Denied => return Err(anyhow!("Effect already resolved")),
                    }
                    subject_receipt = Some(receipt.clone());
                    job.result = Some(receipt);
                    if let Some(primary) = proven_primary_printer_receipt(&job).cloned() {
                        job.result = Some(primary);
                        job.state = PersistentState::Succeeded;
                    } else if completion_proven(&job, job.result.as_ref()) {
                        job.state = PersistentState::Succeeded;
                    } else if !settle_uploaded_only(&mut job) {
                        if resolved_printer_failure(&job) {
                            job.result = prior_result;
                            job.state = PersistentState::Failed;
                        } else {
                            return Err(anyhow!(
                                "Remaining job effects require an explicit decision"
                            ));
                        }
                    }
                }
                Decision::ConfirmNoEffect => {
                    ensure!(receipt.is_none(), "No-effect decision cannot carry receipt");
                    job.effects[effect_index].deny()?;
                    if let Some(primary) = proven_primary_printer_receipt(&job).cloned() {
                        job.result = Some(primary);
                        job.state = PersistentState::Succeeded;
                    } else if !settle_uploaded_only(&mut job) {
                        job.result = prior_result;
                        job.state = PersistentState::Failed;
                    }
                }
                Decision::Abandon => {
                    job.state = PersistentState::ReconciliationRequired;
                }
            }
            let effect = job.effects.last().expect("reconciliation effect");
            tx.execute("INSERT INTO durable_job_reconciliations(job_id,version,subject,generation,effect_hash,basis_hash,target,decision,receipt,at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![job.job_id,job.state_version+1,subject,expected_generation,effect_hash,effect.intent.basis_hash,effect.intent.target,format!("{decision:?}"),serde_json::to_string(&subject_receipt)?,now()])?;
            job.recovery = Some(format!("User reconciliation: {decision:?}"));
            save(
                tx,
                &mut job,
                &format!(
                    "reconciled:{decision:?}:{}:{}",
                    expected_generation, effect_hash
                ),
            )?;
            Ok(Outcome::Job(job, LocalCommit::Committed))
        }
    }
}
fn claim(tx: &Transaction<'_>, worker: &str, admission: &WorkerAdmission) -> Result<Outcome> {
    recover_in(tx, false)?;
    let active: i64 = tx.query_row(
        "SELECT COUNT(*) FROM durable_jobs WHERE state IN ('running','effect_admitted')",
        [],
        |r| r.get(0),
    )?;
    if active >= admission.total as i64 {
        return Ok(Outcome::Claimed(None));
    }
    for (kind, capacity) in &admission.kinds {
        let count:i64=tx.query_row("SELECT COUNT(*) FROM durable_jobs WHERE kind=?1 AND state IN ('running','effect_admitted')",[kind.name()],|r|r.get(0))?;
        if count >= *capacity as i64 {
            continue;
        }
        let documents=tx.prepare("SELECT id,document FROM durable_jobs WHERE state='queued' AND kind=?1 ORDER BY created,id")?.query_map([kind.name()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, document) in documents {
            let Some(mut job) = decode_row(&id, &document) else {
                continue;
            };
            let resource = job.payload.resource();
            if !resource.is_empty() {
                let count:i64=tx.query_row("SELECT COUNT(*) FROM durable_jobs WHERE tenant=?1 AND state IN ('running','effect_admitted','reconciliation_required') AND (resource=?2 OR (?2 LIKE 'source:%' AND resource='source:*') OR (?2='source:*' AND resource LIKE 'source:%'))",params![job.tenant,resource],|r|r.get(0))?;
                if count >= admission.per_resource as i64 {
                    continue;
                }
            }
            ensure!(job.attempt < 100, "Job attempt limit reached");
            job.state = PersistentState::Running;
            job.attempt += 1;
            job.generation += 1;
            job.lease_until = Some(now() + i64::from(admission.lease_seconds));
            job.fence = Some(random());
            job.worker = Some(worker.into());
            save(tx, &mut job, "claimed")?;
            let lease = AttemptLease {
                job_id: job.job_id.clone(),
                tenant: job.tenant.clone(),
                generation: job.generation,
                version: job.state_version,
                fence: job.fence.clone().expect("claim fence"),
                worker: worker.into(),
            };
            return Ok(Outcome::Claimed(Some((job, lease))));
        }
    }
    Ok(Outcome::Claimed(None))
}
fn proven_primary_printer_receipt(job: &JobRecord) -> Option<&ResultArtifact> {
    match &job.payload {
        Payload::PrinterUpload {
            printer_id, start, ..
        } => {
            let confirmed = |operation| {
                job.effects.iter().find_map(|effect| {
                    if effect.intent.operation != operation || effect.intent.target != *printer_id {
                        return None;
                    }
                    match effect.outcome().ok()? {
                        EffectOutcome::Confirmed(receipt) => Some(receipt),
                        EffectOutcome::Unresolved | EffectOutcome::Denied => None,
                    }
                })
            };
            if let Some(receipt) = confirmed(EffectOperation::PrinterUploadAndStart) {
                return Some(receipt);
            }
            let upload = confirmed(EffectOperation::PrinterUpload)?;
            if *start {
                confirmed(EffectOperation::PrinterStart)
            } else {
                Some(upload)
            }
        }
        Payload::PrinterStart(request) => {
            let upload = request.upload_effect()?;
            job.effects.iter().find_map(|effect| {
                if effect.intent.operation != EffectOperation::PrinterStart
                    || effect.intent.basis_hash != upload.intent.basis_hash
                    || effect.intent.content_hash != upload.intent.content_hash
                    || effect.intent.target != upload.intent.target
                {
                    return None;
                }
                match effect.outcome().ok()? {
                    EffectOutcome::Confirmed(receipt) => Some(receipt),
                    EffectOutcome::Unresolved | EffectOutcome::Denied => None,
                }
            })
        }
        _ => None,
    }
}
fn completion_proven(job: &JobRecord, result: Option<&ResultArtifact>) -> bool {
    match &job.payload {
        Payload::PrinterUpload { .. } => {
            proven_primary_printer_receipt(job).is_some_and(|primary| result == Some(primary))
        }
        Payload::PrinterStart(request) => request.upload_effect().is_some_and(|upload| {
            job.effects.iter().any(|effect| {
                effect.intent.operation == EffectOperation::PrinterStart
                    && effect.intent.basis_hash == upload.intent.basis_hash
                    && effect.intent.content_hash == upload.intent.content_hash
                    && effect.intent.target == upload.intent.target
                    && effect.confirmed
                    && effect.receipt.as_ref() == result
            })
        }),
        Payload::ExportStlPack { .. }
        | Payload::ExportChecklistHtml { .. }
        | Payload::ExportKitBundle { .. }
        | Payload::ExportAcceptedPlate3mf { .. }
        | Payload::ExportDirect3mf { .. } => result.is_some(),
        _ => true,
    }
}
fn settle_uploaded_only(job: &mut JobRecord) -> bool {
    let prior = job.result.clone();
    job.result = job
        .effects
        .iter()
        .find(|effect| effect.intent.operation == EffectOperation::PrinterUpload)
        .and_then(|effect| match effect.outcome().ok()? {
            EffectOutcome::Confirmed(receipt) => Some(receipt.clone()),
            _ => None,
        });
    if job.uploaded_only_proof().is_some() {
        job.state = PersistentState::UploadedOnly;
        true
    } else {
        job.result = prior;
        false
    }
}
fn resolved_printer_failure(job: &JobRecord) -> bool {
    matches!(job.payload, Payload::PrinterUpload { .. })
        && !job.effects.is_empty()
        && job.effects.iter().all(|effect| {
            matches!(
                effect.intent.operation,
                EffectOperation::PrinterUpload
                    | EffectOperation::PrinterStart
                    | EffectOperation::PrinterUploadAndStart
                    | EffectOperation::SpoolmanDeduction
            ) && !matches!(effect.outcome(), Ok(EffectOutcome::Unresolved) | Err(_))
        })
        && !job.effects.iter().any(|effect| {
            matches!(effect.outcome(), Ok(EffectOutcome::Confirmed(_)))
                && matches!(
                    effect.intent.operation,
                    EffectOperation::PrinterUpload
                        | EffectOperation::PrinterStart
                        | EffectOperation::PrinterUploadAndStart
                )
        })
}
fn claimed_job(tx: &Transaction<'_>, lease: &AttemptLease) -> Result<JobRecord> {
    let job = owned(tx, &lease.job_id, &lease.tenant)?;
    ensure!(
        job.worker.as_deref() == Some(lease.worker.as_str())
            && job.generation == lease.generation
            && job.state_version == lease.version
            && job.fence.as_deref() == Some(&lease.fence)
            && job.lease_until.is_some_and(|until| until > now())
            && matches!(
                job.state,
                PersistentState::Running | PersistentState::EffectAdmitted
            ),
        "Stale attempt fence"
    );
    Ok(job)
}
pub(crate) fn claimed_source(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    source_id: Option<i64>,
) -> Result<(String, i64)> {
    let job = claimed_job(tx, lease)?;
    let id = match job.payload {
        Payload::ImportScan { project_id } | Payload::ExtractSourceDocs { project_id } => {
            ensure!(
                source_id.is_none(),
                "Individual Source attempt uses its stored Source"
            );
            i64::try_from(project_id)?
        }
        Payload::Sync { project_ids } => {
            let id = source_id.ok_or_else(|| anyhow!("Wildcard Source attempt requires Source"))?;
            if let Some(ids) = project_ids {
                ensure!(
                    ids.iter()
                        .any(|project_id| i64::try_from(*project_id).ok() == Some(id)),
                    "Source is outside Sync scope"
                );
            }
            id
        }
        Payload::CheckSourceUpdates {} => {
            source_id.ok_or_else(|| anyhow!("Wildcard Source attempt requires Source"))?
        }
        _ => return Err(anyhow!("Attempt is not Source work")),
    };
    Ok((job.tenant, id))
}
pub(crate) fn source_reserved(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<bool> {
    let documents = tx
        .prepare(
            "SELECT id,document FROM durable_jobs WHERE tenant=?1 AND resource IN (?2,'source:*') AND state IN ('queued','running','effect_admitted','reconciliation_required')",
        )?
        .query_map(params![tenant, format!("source:{id}")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (job_id, document) in documents {
        let Some(job) = decode_row(&job_id, &document) else {
            continue;
        };
        match &job.payload {
            Payload::Sync {
                project_ids: Some(ids),
            } => {
                if ids
                    .iter()
                    .any(|project_id| i64::try_from(*project_id).ok() == Some(id))
                {
                    return Ok(true);
                }
            }
            _ => return Ok(true),
        }
    }
    Ok(false)
}
fn advance(
    tx: &Transaction<'_>,
    lease: AttemptLease,
    operation: WorkerOperation,
    admission: &WorkerAdmission,
) -> Result<Outcome> {
    let mut job = claimed_job(tx, &lease)?;
    let event = match operation {
        WorkerOperation::Heartbeat => "heartbeat",
        WorkerOperation::Progress(progress) => {
            ensure!(progress <= 100, "Invalid progress");
            job.progress = Some(progress);
            "progress"
        }
        WorkerOperation::BeginEffect(intent) => {
            ensure!(
                !job.cancel_requested
                    && job.state == PersistentState::Running
                    && job.effects.len() < 16,
                "Effect admission denied"
            );
            model::digest(&intent.basis_hash)?;
            model::digest(&intent.content_hash)?;
            model::text(&intent.target, 1024)?;
            let allowed = match intent.operation {
                EffectOperation::PrinterUpload
                | EffectOperation::PrinterUploadAndStart
                | EffectOperation::PrinterStart
                | EffectOperation::SpoolmanDeduction => job.kind == JobKind::PrinterUpload,
                EffectOperation::SourceRefresh => matches!(
                    job.kind,
                    JobKind::Sync
                        | JobKind::ImportScan
                        | JobKind::ExtractSourceDocs
                        | JobKind::CheckSourceUpdates
                ),
                EffectOperation::LocalArtifact => job.kind != JobKind::PrinterUpload,
            };
            ensure!(allowed, "Effect does not belong to job kind");
            if let Payload::PrinterStart(request) = &job.payload {
                let upload = request
                    .upload_effect()
                    .ok_or_else(|| anyhow!("Missing printer start binding"))?;
                ensure!(
                    intent.operation == EffectOperation::PrinterStart
                        && intent.basis_hash == upload.intent.basis_hash
                        && intent.content_hash == upload.intent.content_hash
                        && intent.target == upload.intent.target,
                    "Effect does not match uploaded artifact"
                );
            }
            ensure!(
                !job.effects
                    .iter()
                    .any(|e| e.intent.operation == intent.operation
                        && e.intent.target == intent.target),
                "Effect already admitted"
            );
            if let Payload::PrinterUpload {
                printer_id, start, ..
            } = &job.payload
            {
                if matches!(
                    intent.operation,
                    EffectOperation::PrinterUpload
                        | EffectOperation::PrinterUploadAndStart
                        | EffectOperation::PrinterStart
                ) {
                    ensure!(&intent.target == printer_id, "Effect target mismatch");
                }
                if intent.operation == EffectOperation::PrinterUploadAndStart {
                    ensure!(*start, "Combined start not requested");
                    ensure!(
                        !job.effects.iter().any(|e| matches!(
                            e.intent.operation,
                            EffectOperation::PrinterUpload | EffectOperation::PrinterStart
                        )),
                        "Printer transfer already admitted"
                    );
                }
                if matches!(
                    intent.operation,
                    EffectOperation::PrinterUpload | EffectOperation::PrinterStart
                ) {
                    ensure!(
                        !job.effects
                            .iter()
                            .any(|e| e.intent.operation == EffectOperation::PrinterUploadAndStart),
                        "Combined printer transfer already admitted"
                    );
                }
                if intent.operation == EffectOperation::PrinterStart {
                    ensure!(
                        *start
                            && job
                                .effects
                                .iter()
                                .any(|e| e.intent.operation == EffectOperation::PrinterUpload
                                    && e.confirmed),
                        "Printer start requires confirmed upload"
                    );
                }
            }
            job.effects.push(EffectReceipt {
                intent,
                attempt: job.attempt,
                generation: job.generation,
                confirmed: false,
                no_effect: false,
                receipt: None,
            });
            job.state = PersistentState::EffectAdmitted;
            "effect_intent"
        }
        WorkerOperation::ConfirmEffect(receipt) => {
            ensure!(
                job.state == PersistentState::EffectAdmitted,
                "No admitted effect"
            );
            receipt.validate()?;
            let effect = job
                .effects
                .last_mut()
                .ok_or_else(|| anyhow!("No effect intent"))?;
            ensure!(
                !effect.confirmed
                    && receipt.content_hash == effect.intent.content_hash
                    && receipt.target == effect.intent.target,
                "Receipt mismatch"
            );
            effect.confirm(receipt)?;
            job.state = PersistentState::Running;
            "effect_confirmed"
        }
        WorkerOperation::Finish(result) => {
            ensure!(
                job.state == PersistentState::Running && !job.cancel_requested,
                "Job cannot finish"
            );
            let result = result.or_else(|| proven_primary_printer_receipt(&job).cloned());
            if let Some(result) = &result {
                result.validate()?;
                ensure!(
                    job.effects
                        .iter()
                        .any(|e| e.confirmed && e.receipt.as_ref() == Some(result)),
                    "Result requires confirmed artifact receipt"
                );
            }
            ensure!(
                completion_proven(&job, result.as_ref()),
                "Completion requires effect receipts"
            );
            job.result = result;
            job.progress = Some(100);
            job.state = PersistentState::Succeeded;
            "finished"
        }
        WorkerOperation::Fail => {
            if job.state == PersistentState::EffectAdmitted {
                job.state = PersistentState::ReconciliationRequired;
                job.recovery = Some("Effect outcome unknown".into());
                job.fence = None;
                job.worker = None;
                job.lease_until = None;
            } else if !job.effects.is_empty() {
                job.state = PersistentState::ReconciliationRequired;
                job.recovery = Some("Confirmed effects require reconciliation".into());
                job.fence = None;
                job.worker = None;
                job.lease_until = None;
            } else {
                job.state = PersistentState::Failed;
            }
            "failed"
        }
    };
    if matches!(
        job.state,
        PersistentState::Running | PersistentState::EffectAdmitted
    ) {
        job.lease_until = Some(now() + i64::from(admission.lease_seconds));
    }
    save(tx, &mut job, event)?;
    Ok(Outcome::Job(job, LocalCommit::Committed))
}

pub(crate) fn validate_schema(connection: &Connection, version: u64) -> Result<()> {
    let objects = |connection: &Connection| -> Result<Vec<(String, Option<String>)>> {
        Ok(connection.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'durable_job%' OR name LIKE 'sqlite_autoindex_durable_job%' ORDER BY name")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
    };
    let actual = objects(connection)?;
    if version < 35 {
        ensure!(actual.is_empty(), "Unversioned durable job objects");
        return Ok(());
    }
    let legacy = Connection::open_in_memory()?;
    legacy.execute_batch(include_str!("jobs/schema.sql"))?;
    let indexed = Connection::open_in_memory()?;
    indexed.execute_batch(include_str!("jobs/schema.sql"))?;
    indexed.execute_batch(include_str!("jobs/printer-start-indexes.sql"))?;
    ensure!(
        actual == objects(&legacy)? || actual == objects(&indexed)?,
        "Durable job schema mismatch"
    );
    let mut query=connection.prepare("SELECT id,tenant,kind,state,resource,version,generation,lease_until,created,updated,document FROM durable_jobs")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let Some(job) = decode_row(&row.get::<_, String>(0)?, &row.get::<_, String>(10)?) else {
            continue;
        };
        job.payload.validate_stored()?;
        ensure!(
            job.payload_version == 1
                && job.kind == job.payload.kind()
                && job.job_id == row.get::<_, String>(0)?
                && job.tenant == row.get::<_, String>(1)?
                && job.kind.name() == row.get::<_, String>(2)?
                && job.state.name() == row.get::<_, String>(3)?
                && job.payload.resource() == row.get::<_, String>(4)?
                && job.state_version == row.get::<_, i64>(5)?
                && job.generation == row.get::<_, i64>(6)?
                && job.lease_until == row.get::<_, Option<i64>>(7)?
                && job.created_at == row.get::<_, i64>(8)?
                && job.updated_at == row.get::<_, i64>(9)?,
            "Durable job record mismatch"
        );
        let running = matches!(
            job.state,
            PersistentState::Running | PersistentState::EffectAdmitted
        );
        ensure!(
            job.state_version > 0
                && job.attempt >= 0
                && job.generation >= job.attempt
                && running == job.fence.is_some()
                && running == job.lease_until.is_some()
                && job.effects.len() <= 16,
            "Invalid durable job state"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> JobRecord {
        JobRecord {
            job_id: "size-boundary".into(),
            tenant: "default".into(),
            kind: JobKind::CheckSourceUpdates,
            payload_version: 1,
            payload: Payload::CheckSourceUpdates {},
            state: PersistentState::Queued,
            state_version: 0,
            attempt: 0,
            generation: 0,
            lease_until: None,
            created_at: now(),
            updated_at: now(),
            finished_at: None,
            cancel_requested: false,
            progress: None,
            effects: vec![],
            result: None,
            recovery: Some(String::new()),
            fence: None,
            worker: None,
        }
    }

    fn sized_record(size: usize) -> JobRecord {
        let mut job = record();
        let padding = size - encode(&job).unwrap().len();
        // Non-ASCII text makes the boundary a byte count, not a character count.
        job.recovery = Some("é".repeat(padding / 2) + &"a".repeat(padding % 2));
        job
    }

    #[test]
    fn job_document_exact_size_limit_saves_and_decodes() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("jobs/schema.sql"))
            .unwrap();
        let tx = connection.transaction().unwrap();
        let mut job = sized_record(JOB_DOC_SIZE_LIMIT);
        save(&tx, &mut job, "enqueued").unwrap();
        tx.commit().unwrap();
        let document: String = connection
            .query_row("SELECT document FROM durable_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(document.len(), JOB_DOC_SIZE_LIMIT);
        assert_eq!(decode(&document).unwrap().recovery, job.recovery);
        validate_schema(&connection, 35).unwrap();
    }

    #[test]
    fn job_document_over_size_limit_rejects_without_any_writes() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("jobs/schema.sql"))
            .unwrap();
        let tx = connection.transaction().unwrap();
        let mut job = sized_record(JOB_DOC_SIZE_LIMIT + 1);
        let error = save(&tx, &mut job, "enqueued").unwrap_err();
        assert_eq!(
            error.downcast_ref::<JobFailure>(),
            Some(&JobFailure::JobDocTooLarge {
                size: JOB_DOC_SIZE_LIMIT + 1,
                limit: JOB_DOC_SIZE_LIMIT,
            })
        );
        // Even committing after the error cannot persist a document or history row.
        tx.commit().unwrap();
        for table in ["durable_jobs", "durable_job_history", "durable_job_keys"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }

        let tx = connection.transaction().unwrap();
        let mut job = record();
        save(&tx, &mut job, "enqueued").unwrap();
        let original = encode(&job).unwrap();
        job.recovery = sized_record(JOB_DOC_SIZE_LIMIT + 1).recovery;
        assert!(save(&tx, &mut job, "progress").is_err());
        tx.commit().unwrap();
        let stored: String = connection
            .query_row("SELECT document FROM durable_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, original);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM durable_job_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
