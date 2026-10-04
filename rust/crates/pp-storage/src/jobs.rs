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
    CapturePreflighted(Box<crate::uploads::PreflightedCapture>),
    CaptureCorrelation(crate::uploads::CaptureJournalCorrelation),
}
pub(crate) enum Command {
    User {
        credential: Credential,
        policy: AuthPolicy,
        operation: UserOperation,
        storage: Arc<crate::Shared>,
    },
    Claim {
        job_id: Option<String>,
        worker: String,
        admission: Arc<WorkerAdmission>,
    },
    ClaimResolved {
        claim: crate::uploads::ResolvedCapturedClaim,
        worker: String,
        admission: Arc<WorkerAdmission>,
    },
    PreflightCapture {
        credential: Credential,
        operation_key: String,
        target: crate::uploads::Target,
        payload: crate::uploads::CapturedPayloadV1,
        limits: crate::uploads::AdmissionLimits,
        policy: AuthPolicy,
        storage: Arc<crate::Shared>,
    },
    CorrelateCapture {
        manifest: Vec<u8>,
        inventory: Vec<crate::uploads::File>,
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

pub(crate) struct CapturePreflightRequest {
    pub(crate) credential: Credential,
    pub(crate) operation_key: String,
    pub(crate) target: crate::uploads::Target,
    pub(crate) payload: crate::uploads::CapturedPayloadV1,
    pub(crate) limits: crate::uploads::AdmissionLimits,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobFailure {
    CommitUnknown,
}
impl std::fmt::Display for JobFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Job commit outcome unknown")
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
pub(crate) fn submit(
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
        operation: UserOperation,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<Pending> {
        if let UserOperation::Enqueue {
            key,
            payload_version,
            payload,
        } = &operation
        {
            model::text(key, 128)?;
            ensure!(*payload_version == 1, "Unsupported payload version");
            payload.validate()?;
            ensure!(
                !matches!(payload, Payload::SuppliedSourceImport { .. }),
                "Supplied imports require atomic domain admission"
            );
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
                job_id: None,
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
fn encode(job: &JobRecord) -> Result<String> {
    let mut document = serde_json::to_value(job)?;
    document["_attempt_worker"] = serde_json::to_value(&job.worker)?;
    document["_attempt_fence"] = serde_json::to_value(&job.fence)?;
    Ok(serde_json::to_string(&document)?)
}
fn decode(document: &str) -> Result<JobRecord> {
    ensure!(document.len() <= 131072, "Durable job document too large");
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

pub(crate) fn load_for_capture_claim(tx: &Transaction<'_>, id: &str) -> Result<JobRecord> {
    load(tx, id)?.ok_or_else(|| anyhow!("Captured import job requires repair"))
}
fn owned(tx: &Transaction<'_>, id: &str, tenant: &str) -> Result<JobRecord> {
    let record = load(tx, id)?.ok_or_else(|| anyhow!("Job not found"))?;
    ensure!(record.tenant == tenant, "Job not found");
    Ok(record)
}
pub(crate) fn save(tx: &Transaction<'_>, job: &mut JobRecord, event: &str) -> Result<()> {
    job.state_version += 1;
    job.updated_at = now();
    if job.state.terminal() {
        job.finished_at = Some(job.updated_at);
        job.lease_until = None;
        job.fence = None;
        job.worker = None;
    }
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
    let documents=tx.prepare("SELECT document FROM durable_jobs WHERE state IN ('running','effect_admitted') AND (?1 OR lease_until<=?2)")?.query_map(params![all,now()],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for document in documents {
        let mut job: JobRecord = decode(&document)?;
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
        } else if job.cancel_requested && job.kind != JobKind::SuppliedSourceImport {
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
            let (tenant, subject) = actor(&tx, credential, policy, &storage)?;
            let mut outcome = user(&tx, &tenant, &subject, operation)?;
            if auth_committed && let Outcome::Job(_, commit) = &mut outcome {
                *commit = LocalCommit::Committed;
            }
            outcome
        }
        Command::Claim {
            worker,
            admission,
            job_id,
        } => claim(&tx, &worker, &admission, job_id.as_deref())?,
        Command::ClaimResolved {
            claim: resolved,
            worker,
            admission,
        } => {
            let job_id = crate::uploads::validate_resolved_claim(&tx, &resolved)?.to_owned();
            claim(&tx, &worker, &admission, Some(&job_id))?
        }
        Command::PreflightCapture {
            credential,
            operation_key,
            mut target,
            payload,
            limits,
            policy,
            storage,
        } => {
            let (tenant, actor) = actor_ref(&tx, &credential, policy, &storage)?;
            let replay = crate::uploads::preflight_capture_target(
                &tx,
                &tenant,
                &actor,
                &operation_key,
                &mut target,
                &payload,
                limits,
            )?;
            Outcome::CapturePreflighted(Box::new(crate::uploads::PreflightedCapture {
                credential,
                tenant,
                actor,
                target,
                replay,
            }))
        }
        Command::CorrelateCapture {
            manifest,
            inventory,
        } => Outcome::CaptureCorrelation(crate::uploads::correlate_capture(
            &tx, manifest, inventory,
        )?),
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
            FROM durable_jobs WHERE state IN ('succeeded','failed','cancelled')
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
pub(crate) fn user(
    tx: &Transaction<'_>,
    tenant: &str,
    subject: &str,
    operation: UserOperation,
) -> Result<Outcome> {
    match operation {
        UserOperation::Enqueue {
            key,
            payload_version,
            payload,
        } => {
            model::text(&key, 128)?;
            ensure!(payload_version == 1, "Unsupported payload version");
            payload.validate()?;
            let intent = hex::encode(Sha256::digest(serde_json::to_vec(&(
                payload_version,
                &payload,
            ))?));
            let prior: Option<(String, String, Option<String>)> = tx
                .query_row(
                    "SELECT intent,job_id,archived_document FROM durable_job_keys WHERE tenant=?1 AND key=?2",
                    params![tenant, key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((hash, id, archived)) = prior {
                ensure!(hash == intent, "Idempotency conflict");
                return Ok(Outcome::Job(
                    match load(tx, &id)? {
                        Some(job) => job,
                        None => {
                            decode(&archived.ok_or_else(|| anyhow!("Missing retained receipt"))?)?
                        }
                    },
                    LocalCommit::ReadOnly,
                ));
            }
            let active:i64=tx.query_row("SELECT COUNT(*) FROM durable_jobs WHERE state NOT IN ('succeeded','failed','cancelled')",[],|r|r.get(0))?;
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
            let documents=tx.prepare("SELECT document FROM durable_jobs WHERE tenant=?1 AND (?2 IS NULL OR CASE state WHEN 'queued' THEN 'pending' WHEN 'running' THEN 'running' WHEN 'effect_admitted' THEN 'running' WHEN 'succeeded' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'error' END=?2) AND (?3 IS NULL OR updated>=?3) AND (?4 IS NULL OR json_extract(document,'$.payload.payload.profile_id')=?4) AND (?5 IS NULL OR updated<?5 OR (updated=?5 AND id<?6)) ORDER BY updated DESC,id DESC LIMIT ?7")?.query_map(params![tenant,query.status,query.since,query.profile_id.map(|v|v as i64),query.before.as_ref().map(|c|c.0),query.before.as_ref().map(|c|c.1.as_str()),query.limit],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Outcome::List(
                documents.iter().map(|s| decode(s)).collect::<Result<_>>()?,
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
            if job.kind == JobKind::SuppliedSourceImport {
                job.state = PersistentState::Queued;
                job.generation += 1;
                job.fence = None;
                job.worker = None;
                job.lease_until = None;
            } else if job.effects.is_empty() {
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
            let effect = job
                .effects
                .last_mut()
                .ok_or_else(|| anyhow!("Missing effect"))?;
            ensure!(
                effect.intent.content_hash == effect_hash,
                "Wrong reconciliation subject"
            );
            if let Some(receipt) = &receipt {
                receipt.validate()?;
                ensure!(
                    receipt.content_hash == effect.intent.content_hash
                        && receipt.target == effect.intent.target,
                    "Receipt mismatch"
                );
            }
            match decision {
                Decision::ConfirmSucceeded => {
                    let receipt =
                        receipt.ok_or_else(|| anyhow!("Confirmation receipt required"))?;
                    effect.confirmed = true;
                    effect.receipt = Some(receipt.clone());
                    job.result = Some(receipt);
                    ensure!(
                        completion_proven(&job, job.result.as_ref()),
                        "Remaining job effects require an explicit decision"
                    );
                    job.state = PersistentState::Succeeded;
                }
                Decision::ConfirmNoEffect => {
                    ensure!(receipt.is_none(), "No-effect decision cannot carry receipt");
                    job.state = PersistentState::Failed;
                }
                Decision::Abandon => {
                    job.state = PersistentState::ReconciliationRequired;
                }
            }
            let effect = job.effects.last().expect("reconciliation effect");
            tx.execute("INSERT INTO durable_job_reconciliations(job_id,version,subject,generation,effect_hash,basis_hash,target,decision,receipt,at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![job.job_id,job.state_version+1,subject,expected_generation,effect_hash,effect.intent.basis_hash,effect.intent.target,format!("{decision:?}"),serde_json::to_string(&job.result)?,now()])?;
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
fn claim(
    tx: &Transaction<'_>,
    worker: &str,
    admission: &WorkerAdmission,
    job_id: Option<&str>,
) -> Result<Outcome> {
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
        let documents=tx.prepare("SELECT document FROM durable_jobs WHERE state='queued' AND kind=?1 ORDER BY created,id")?.query_map([kind.name()],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for document in documents {
            let mut job: JobRecord = decode(&document)?;
            if job_id.is_none()
                && job.kind == JobKind::SuppliedSourceImport
                && tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM source_import_operations WHERE tenant=?1 AND job_id=?2 AND state='admitted')",
                    params![job.tenant, job.job_id],
                    |row| row.get::<_, bool>(0),
                )?
            {
                continue;
            }
            if let Some(id) = job_id {
                if job.job_id != id {
                    continue;
                }
                ensure!(
                    job.kind == JobKind::SuppliedSourceImport,
                    "Targeted claim requires supplied import"
                );
            }
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
fn completion_proven(job: &JobRecord, result: Option<&ResultArtifact>) -> bool {
    match &job.payload {
        Payload::SuppliedSourceImport { .. } => false,
        Payload::PrinterUpload {
            printer_id, start, ..
        } => {
            let confirmed = |op| {
                job.effects.iter().any(|e| {
                    e.intent.operation == op && e.intent.target == *printer_id && e.confirmed
                })
            };
            confirmed(EffectOperation::PrinterUploadAndStart)
                || (confirmed(EffectOperation::PrinterUpload)
                    && (!*start || confirmed(EffectOperation::PrinterStart)))
        }
        Payload::ExportStlPack { .. }
        | Payload::ExportChecklistHtml { .. }
        | Payload::ExportKitBundle { .. }
        | Payload::ExportAcceptedPlate3mf { .. }
        | Payload::ExportDirect3mf { .. } => result.is_some(),
        _ => true,
    }
}
pub(crate) fn claimed_job(tx: &Transaction<'_>, lease: &AttemptLease) -> Result<JobRecord> {
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
        Payload::ImportScan { project_id }
        | Payload::ExtractSourceDocs { project_id }
        | Payload::SuppliedSourceImport { project_id, .. } => {
            ensure!(
                source_id.is_none(),
                "Individual Source attempt uses its stored Source"
            );
            i64::try_from(project_id)?
        }
        Payload::Sync { .. } | Payload::CheckSourceUpdates {} => {
            source_id.ok_or_else(|| anyhow!("Wildcard Source attempt requires Source"))?
        }
        _ => return Err(anyhow!("Attempt is not Source work")),
    };
    Ok((job.tenant, id))
}
pub(crate) fn source_reserved(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM durable_jobs WHERE tenant=?1 AND resource IN (?2,'source:*') AND state IN ('queued','running','effect_admitted','reconciliation_required'))", params![tenant, format!("source:{id}")], |row| row.get(0))?)
}
fn advance(
    tx: &Transaction<'_>,
    lease: AttemptLease,
    operation: WorkerOperation,
    admission: &WorkerAdmission,
) -> Result<Outcome> {
    let mut job = claimed_job(tx, &lease)?;
    ensure!(
        job.kind != JobKind::SuppliedSourceImport
            || matches!(
                operation,
                WorkerOperation::Heartbeat | WorkerOperation::Progress(_)
            ),
        "Supplied imports advance through owned phases"
    );
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
            effect.confirmed = true;
            effect.receipt = Some(receipt);
            job.state = PersistentState::Running;
            "effect_confirmed"
        }
        WorkerOperation::Finish(result) => {
            ensure!(
                job.state == PersistentState::Running && !job.cancel_requested,
                "Job cannot finish"
            );
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
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(include_str!("jobs/schema.sql"))?;
    ensure!(actual == objects(&expected)?, "Durable job schema mismatch");
    let mut query=connection.prepare("SELECT id,tenant,kind,state,resource,version,generation,lease_until,created,updated,document FROM durable_jobs")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let job = decode(&row.get::<_, String>(10)?)?;
        job.payload.validate()?;
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

pub(crate) fn actor(
    tx: &Transaction<'_>,
    credential: Credential,
    policy: AuthPolicy,
    storage: &Arc<crate::Shared>,
) -> Result<(String, String)> {
    match credential {
        Credential::Session(token) => auth::job_session_actor(tx, token.expose(), policy),
        Credential::RoutedKey { tenant, key } => auth::job_key_actor(tx, &tenant, key),
        Credential::PhysicalOwner(owner) => {
            ensure!(
                Arc::ptr_eq(storage, &owner.storage),
                "Foreign physical owner"
            );
            Ok(("default".into(), "physical-owner".into()))
        }
    }
}

pub(crate) fn actor_ref(
    tx: &Transaction<'_>,
    credential: &Credential,
    policy: AuthPolicy,
    storage: &Arc<crate::Shared>,
) -> Result<(String, String)> {
    match credential {
        Credential::Session(token) => auth::job_session_actor(tx, token.expose(), policy),
        Credential::RoutedKey { tenant, key } => auth::job_key_actor_ref(tx, tenant, key),
        Credential::PhysicalOwner(owner) => {
            ensure!(
                Arc::ptr_eq(storage, &owner.storage),
                "Foreign physical owner"
            );
            Ok(("default".into(), "physical-owner".into()))
        }
    }
}
impl ServerWorkerClient {
    pub fn claim_resolved_import(
        &self,
        claim: crate::uploads::ResolvedCapturedClaim,
    ) -> Result<Option<(JobRecord, AttemptLease)>> {
        match submit(
            &self.storage,
            Command::ClaimResolved {
                claim,
                worker: self.identity.clone(),
                admission: self.admission.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
        {
            Outcome::Claimed(claim) => Ok(claim),
            _ => unreachable!(),
        }
    }

    pub fn claim_import(&self, job_id: &str) -> Result<Option<(JobRecord, AttemptLease)>> {
        match submit(
            &self.storage,
            Command::Claim {
                job_id: Some(job_id.into()),
                worker: self.identity.clone(),
                admission: self.admission.clone(),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
        {
            Outcome::Claimed(claim) => Ok(claim),
            _ => unreachable!(),
        }
    }
    pub fn import_phase(
        &self,
        lease: &AttemptLease,
        phase: crate::uploads::Phase,
    ) -> Result<crate::uploads::Operation> {
        ensure!(lease.worker == self.identity, "Foreign worker");
        crate::uploads::submit(
            &self.storage,
            crate::uploads::Command::Phase {
                lease: lease.clone(),
                phase,
            },
            &AtomicBool::new(false),
        )
    }
}

pub(crate) fn preflight_capture(
    storage: &SettingsClient,
    request: CapturePreflightRequest,
    policy: AuthPolicy,
    shared: Arc<crate::Shared>,
) -> Result<crate::uploads::PreflightedCapture> {
    let CapturePreflightRequest {
        credential,
        operation_key,
        target,
        payload,
        limits,
    } = request;
    match submit(
        storage,
        Command::PreflightCapture {
            credential,
            operation_key,
            target,
            payload,
            limits,
            policy,
            storage: shared,
        },
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )?
    .receive()?
    {
        Outcome::CapturePreflighted(preflight) => Ok(*preflight),
        _ => Err(anyhow!("Unexpected capture authentication reply")),
    }
}

pub(crate) fn correlate_capture(
    storage: &SettingsClient,
    manifest: Vec<u8>,
    inventory: Vec<crate::uploads::File>,
) -> Result<crate::uploads::CaptureJournalCorrelation> {
    match submit(
        storage,
        Command::CorrelateCapture {
            manifest,
            inventory,
        },
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )?
    .receive()?
    {
        Outcome::CaptureCorrelation(correlation) => Ok(correlation),
        _ => Err(anyhow!("Unexpected capture correlation reply")),
    }
}

pub(crate) fn publication_conflicts(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
) -> Result<Vec<pp_contracts::publication::ExecutionConflict>> {
    let records = tx
        .prepare("SELECT id,kind,state,document FROM durable_jobs WHERE tenant=? ORDER BY id")?
        .query_map([tenant], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for (id, kind, state, document) in records {
        let record = decode(&document)?;
        record.payload.validate()?;
        ensure!(
            record.tenant == tenant
                && record.job_id == id
                && record.kind == record.payload.kind()
                && record.kind.name() == kind
                && record.state.name() == state,
            "Job identity mismatch"
        );
        if record.state.terminal() {
            continue;
        }
        let affected = match &record.payload {
            Payload::Sync { .. }
            | Payload::ImportScan { .. }
            | Payload::ExtractSourceDocs { .. }
            | Payload::CheckSourceUpdates {}
            | Payload::SuppliedSourceImport { .. } => false,
            Payload::ExportStlPack { profile_id, .. }
            | Payload::ExportChecklistHtml { profile_id }
            | Payload::ExportKitBundle { profile_id, .. }
            | Payload::ExportAcceptedPlate3mf { profile_id, .. }
            | Payload::ExportDirect3mf { profile_id, .. } => *profile_id == profile as u64,
            Payload::PrinterUpload {
                profile_id,
                checkoff_units,
                ..
            } => {
                let mut owners = std::collections::HashSet::new();
                let mut unresolved = false;
                for u in checkoff_units {
                    let owner: Option<i64> = tx
                        .query_row(
                            "SELECT p.profile_id FROM parts p JOIN build_profiles b ON b.id=p.profile_id AND b.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.id=?",
                            params![tenant, u.part_id as i64],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if let Some(owner) = owner {
                        owners.insert(owner);
                    } else {
                        unresolved = true;
                    }
                }
                ensure!(
                    owners.len() <= 1
                        && profile_id.is_none_or(|p| owners.iter().all(|o| *o as u64 == p)),
                    "Job coordinate ownership mismatch"
                );
                unresolved || *profile_id == Some(profile as u64) || owners.contains(&profile)
            }
        };
        if affected {
            result.push(pp_contracts::publication::ExecutionConflict {
                operation_id: id,
                kind,
                state,
            });
        }
    }
    Ok(result)
}
