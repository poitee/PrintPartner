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
    pub(crate) storage: Arc<crate::Shared>,
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
    policy: Option<AuthPolicy>,
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
    pub(crate) fn generation(&self) -> i64 {
        self.generation
    }
    pub(crate) fn fence(&self) -> &str {
        &self.fence
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

enum TransactionDecision {
    Outcome(Outcome),
    Authority {
        authority: ValidatedAuthority,
        reply: mpsc::Sender<ValidatedAuthority>,
    },
    Refused(CommittedRefusal),
    ErrorAfterCommit(anyhow::Error),
}

struct CommittedRefusal {
    job: JobRecord,
    failure: auth::AuthorityFailure,
}

enum AuthorityDecision {
    Authorized(ValidatedAuthority),
    Refused(AuthorityRefusalReason),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedAuthority {
    tenant: String,
    subject: String,
}
impl ValidatedAuthority {
    pub fn tenant(&self) -> &str {
        &self.tenant
    }
    pub fn subject(&self) -> &str {
        &self.subject
    }
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
        policy: Option<AuthPolicy>,
    },
    ClaimResolved {
        claim: crate::uploads::ResolvedCapturedClaim,
        worker: String,
        admission: Arc<WorkerAdmission>,
        policy: Option<AuthPolicy>,
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
        policy: Option<AuthPolicy>,
    },
    Authorize {
        lease: AttemptLease,
        policy: AuthPolicy,
        reply: mpsc::Sender<ValidatedAuthority>,
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
        self.job_worker_inner(admission, None)
    }
    pub fn job_worker_with_policy(
        &self,
        policy: AuthPolicy,
        admission: WorkerAdmission,
    ) -> Result<ServerWorkerClient> {
        self.auth_with_policy(policy)?;
        self.job_worker_inner(admission, Some(policy))
    }
    fn job_worker_inner(
        &self,
        admission: WorkerAdmission,
        policy: Option<AuthPolicy>,
    ) -> Result<ServerWorkerClient> {
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
            policy,
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
                policy: self.policy,
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
                policy: self.policy,
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
    pub fn authorize(&self, lease: &AttemptLease) -> Result<ValidatedAuthority> {
        ensure!(lease.worker == self.identity, "Foreign worker lease");
        let policy = self.policy.ok_or(auth::AuthorityFailure::PolicyRequired)?;
        let (reply, receiver) = mpsc::channel();
        submit(
            &self.storage,
            Command::Authorize {
                lease: lease.clone(),
                policy,
                reply,
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?;
        receiver
            .recv()
            .map_err(|_| anyhow!(JobFailure::CommitUnknown))
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
    match job.authority_disposition {
        AuthorityDisposition::Original => {
            document["_authority"] = auth::authority::encode(
                job.authority
                    .as_ref()
                    .ok_or_else(|| anyhow!("Missing durable authority"))?,
            )?;
        }
        AuthorityDisposition::PhysicalOwner => {
            document["_authority"] = serde_json::Value::Null;
        }
        AuthorityDisposition::LegacyMissing => {
            document
                .as_object_mut()
                .expect("job document")
                .remove("_authority");
        }
    }
    if let Some(observation) = &job.authority_refusal {
        document["_authority_refusal"] = serde_json::to_value(observation)?;
    }
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
    match value.get("_authority") {
        Some(authority) if authority.is_null() => {
            job.authority = None;
            job.authority_disposition = AuthorityDisposition::PhysicalOwner;
        }
        Some(authority) => {
            job.authority = Some(auth::authority::decode(authority.clone())?);
            job.authority_disposition = AuthorityDisposition::Original;
        }
        None => {
            job.authority = None;
            job.authority_disposition = AuthorityDisposition::LegacyMissing;
        }
    }
    job.authority_refusal = value
        .get("_authority_refusal")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?;
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
    let decision = match command {
        Command::User {
            credential,
            policy,
            operation,
            storage,
        } => {
            let auth_committed = matches!(&credential, Credential::RoutedKey { .. });
            let mut outcome = match operation {
                UserOperation::Enqueue { .. } => {
                    let (tenant, subject, authority) =
                        auth::authority::admit(&tx, credential, policy, &storage)?;
                    user_with_authority(&tx, &tenant, &subject, authority, operation)?
                }
                operation => {
                    let (tenant, subject) = actor(&tx, credential, policy, &storage)?;
                    user(&tx, &tenant, &subject, operation)?
                }
            };
            if auth_committed && let Outcome::Job(_, commit) = &mut outcome {
                *commit = LocalCommit::Committed;
            }
            TransactionDecision::Outcome(outcome)
        }
        Command::Claim {
            worker,
            admission,
            job_id,
            policy,
        } => claim(&tx, &worker, &admission, policy, job_id.as_deref())?,
        Command::ClaimResolved {
            claim: resolved,
            worker,
            admission,
            policy,
        } => {
            let job_id = crate::uploads::validate_resolved_claim(&tx, &resolved)?.to_owned();
            claim(&tx, &worker, &admission, policy, Some(&job_id))?
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
            TransactionDecision::Outcome(Outcome::CapturePreflighted(Box::new(
                crate::uploads::PreflightedCapture {
                    credential,
                    tenant,
                    actor,
                    target,
                    replay,
                },
            )))
        }
        Command::CorrelateCapture {
            manifest,
            inventory,
        } => TransactionDecision::Outcome(Outcome::CaptureCorrelation(
            crate::uploads::correlate_capture(&tx, manifest, inventory)?,
        )),
        Command::Worker {
            lease,
            operation,
            admission,
            policy,
        } => advance(&tx, lease, operation, &admission, policy)?,
        Command::Authorize {
            lease,
            policy,
            reply,
        } => {
            let job = claimed_job(&tx, &lease)?;
            TransactionDecision::Authority {
                authority: require_original_authority(&tx, &job, policy)?,
                reply,
            }
        }
        Command::Retain { per_tenant, global } => {
            TransactionDecision::Outcome(Outcome::Retained(prune(&tx, per_tenant, global)?))
        }
    };
    if matches!(&decision,TransactionDecision::Outcome(Outcome::Job(job,LocalCommit::Committed)) if job.state.terminal())
        || matches!(&decision, TransactionDecision::Refused(CommittedRefusal { job, .. }) if job.state.terminal())
    {
        prune(&tx, 1000, 10000)?;
    }
    tx.commit()
        .map_err(|_| anyhow!(JobFailure::CommitUnknown))?;
    match decision {
        TransactionDecision::Outcome(outcome) => Ok(outcome),
        TransactionDecision::Authority { authority, reply } => {
            reply
                .send(authority)
                .map_err(|_| anyhow!(JobFailure::CommitUnknown))?;
            Ok(Outcome::Claimed(None))
        }
        TransactionDecision::Refused(CommittedRefusal { job, failure }) => {
            let _committed_transition = job;
            Err(failure.into())
        }
        TransactionDecision::ErrorAfterCommit(error) => Err(error),
    }
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
    user_with_authority(tx, tenant, subject, None, operation)
}
pub(crate) fn user_with_authority(
    tx: &Transaction<'_>,
    tenant: &str,
    subject: &str,
    authority: Option<auth::authority::AuthorityBasis>,
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
                authority_disposition: if authority.is_some() {
                    AuthorityDisposition::Original
                } else {
                    AuthorityDisposition::PhysicalOwner
                },
                authority,
                authority_refusal: None,
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
    policy: Option<AuthPolicy>,
    job_id: Option<&str>,
) -> Result<TransactionDecision> {
    recover_in(tx, false)?;
    let mut terminalized_refusal = false;
    let active: i64 = tx.query_row(
        "SELECT COUNT(*) FROM durable_jobs WHERE state IN ('running','effect_admitted')",
        [],
        |r| r.get(0),
    )?;
    if active >= admission.total as i64 {
        return Ok(TransactionDecision::Outcome(Outcome::Claimed(None)));
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
            let authority = match job.authority_disposition {
                AuthorityDisposition::PhysicalOwner => None,
                AuthorityDisposition::LegacyMissing => Some(AuthorityDecision::Refused(
                    AuthorityRefusalReason::MissingOriginal,
                )),
                AuthorityDisposition::Original => {
                    let Some(policy) = policy else {
                        if terminalized_refusal {
                            prune(tx, 1000, 10000)?;
                        }
                        return Ok(TransactionDecision::ErrorAfterCommit(
                            auth::AuthorityFailure::PolicyRequired.into(),
                        ));
                    };
                    Some(decide_original_authority(tx, &job, policy)?)
                }
            };
            if let Some(AuthorityDecision::Authorized(authority)) = &authority {
                debug_assert_eq!(authority.tenant(), job.tenant);
            }
            if let Some(AuthorityDecision::Refused(reason)) = authority {
                let failure = reason.failure();
                if job_id.is_some() {
                    crate::uploads::record_targeted_authority_refusal(tx, &job)?;
                }
                record_refusal(
                    tx,
                    &mut job,
                    reason,
                    if job_id.is_some() {
                        AuthorityRefusalPhase::TargetedClaim
                    } else {
                        AuthorityRefusalPhase::Claim
                    },
                    None,
                )?;
                terminalized_refusal |= job.state.terminal();
                if job_id.is_some() {
                    if terminalized_refusal {
                        prune(tx, 1000, 10000)?;
                    }
                    return Ok(TransactionDecision::Refused(CommittedRefusal {
                        job,
                        failure,
                    }));
                }
                continue;
            }
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
            if terminalized_refusal {
                prune(tx, 1000, 10000)?;
            }
            return Ok(TransactionDecision::Outcome(Outcome::Claimed(Some((
                job, lease,
            )))));
        }
    }
    if terminalized_refusal {
        prune(tx, 1000, 10000)?;
    }
    Ok(TransactionDecision::Outcome(Outcome::Claimed(None)))
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

impl AuthorityRefusalReason {
    fn failure(self) -> auth::AuthorityFailure {
        match self {
            Self::MissingOriginal => auth::AuthorityFailure::Missing,
            Self::CredentialInvalid => auth::AuthorityFailure::CredentialInvalid,
            Self::PolicyChanged => auth::AuthorityFailure::PolicyChanged,
            Self::TenantChanged => auth::AuthorityFailure::TenantChanged,
            Self::SubjectChanged => auth::AuthorityFailure::SubjectChanged,
        }
    }
}

fn decide_original_authority(
    tx: &Transaction<'_>,
    job: &JobRecord,
    policy: AuthPolicy,
) -> Result<AuthorityDecision> {
    match require_original_authority(tx, job, policy) {
        Ok(authority) => Ok(AuthorityDecision::Authorized(authority)),
        Err(error) => {
            let reason = match error.downcast_ref::<auth::AuthorityFailure>() {
                Some(auth::AuthorityFailure::CredentialInvalid) => {
                    AuthorityRefusalReason::CredentialInvalid
                }
                Some(auth::AuthorityFailure::PolicyChanged) => {
                    AuthorityRefusalReason::PolicyChanged
                }
                Some(auth::AuthorityFailure::TenantChanged) => {
                    AuthorityRefusalReason::TenantChanged
                }
                Some(auth::AuthorityFailure::SubjectChanged) => {
                    AuthorityRefusalReason::SubjectChanged
                }
                _ => return Err(error),
            };
            Ok(AuthorityDecision::Refused(reason))
        }
    }
}

fn record_refusal(
    tx: &Transaction<'_>,
    job: &mut JobRecord,
    reason: AuthorityRefusalReason,
    phase: AuthorityRefusalPhase,
    matching_receipt: Option<ResultArtifact>,
) -> Result<()> {
    if let Some(receipt) = matching_receipt {
        let effect = job
            .effects
            .last_mut()
            .ok_or_else(|| anyhow!("No effect intent"))?;
        effect.receipt = Some(receipt);
    }
    job.authority_refusal = Some(AuthorityRefusalObservation {
        version: 1,
        reason,
        phase,
        observed_at: now(),
        generation: job.generation,
    });
    job.generation += 1;
    job.fence = None;
    job.worker = None;
    job.lease_until = None;
    if job.effects.is_empty() {
        job.state = PersistentState::Failed;
        job.recovery = Some("Original authority is no longer valid".into());
    } else {
        job.state = PersistentState::ReconciliationRequired;
        job.recovery = Some("Inspect retained effect evidence and reconcile explicitly".into());
    }
    save(tx, job, "authority_refused")
}

fn advance(
    tx: &Transaction<'_>,
    lease: AttemptLease,
    operation: WorkerOperation,
    admission: &WorkerAdmission,
    policy: Option<AuthPolicy>,
) -> Result<TransactionDecision> {
    let mut job = claimed_job(tx, &lease)?;
    let authority = match job.authority_disposition {
        AuthorityDisposition::PhysicalOwner => None,
        AuthorityDisposition::LegacyMissing => Some(AuthorityDecision::Refused(
            AuthorityRefusalReason::MissingOriginal,
        )),
        AuthorityDisposition::Original => {
            let Some(policy) = policy else {
                return Ok(TransactionDecision::ErrorAfterCommit(
                    auth::AuthorityFailure::PolicyRequired.into(),
                ));
            };
            Some(decide_original_authority(tx, &job, policy)?)
        }
    };
    if let Some(AuthorityDecision::Authorized(authority)) = &authority {
        debug_assert_eq!(authority.tenant(), job.tenant);
    }
    if let Some(AuthorityDecision::Refused(reason)) = authority {
        let matching_receipt = if let WorkerOperation::ConfirmEffect(receipt) = &operation {
            ensure!(
                job.state == PersistentState::EffectAdmitted,
                "No admitted effect"
            );
            receipt.validate()?;
            let effect = job
                .effects
                .last()
                .ok_or_else(|| anyhow!("No effect intent"))?;
            ensure!(
                !effect.confirmed
                    && receipt.content_hash == effect.intent.content_hash
                    && receipt.target == effect.intent.target,
                "Receipt mismatch"
            );
            Some(receipt.clone())
        } else {
            None
        };
        let failure = reason.failure();
        record_refusal(
            tx,
            &mut job,
            reason,
            AuthorityRefusalPhase::WorkerAdvance,
            matching_receipt,
        )?;
        return Ok(TransactionDecision::Refused(CommittedRefusal {
            job,
            failure,
        }));
    }
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
    Ok(TransactionDecision::Outcome(Outcome::Job(
        job,
        LocalCommit::Committed,
    )))
}

pub(crate) fn require_original_authority(
    tx: &Transaction<'_>,
    job: &JobRecord,
    policy: AuthPolicy,
) -> Result<ValidatedAuthority> {
    ensure!(
        job.authority_disposition == AuthorityDisposition::Original,
        auth::AuthorityFailure::Missing
    );
    let basis = job
        .authority
        .as_ref()
        .ok_or(auth::AuthorityFailure::Missing)?;
    let (tenant, subject) = auth::authority::resolve(tx, basis, policy)?;
    ensure!(tenant == job.tenant, auth::AuthorityFailure::TenantChanged);
    Ok(ValidatedAuthority { tenant, subject })
}

pub(crate) fn revalidate_source_authority(
    tx: &Transaction<'_>,
    job: &JobRecord,
    policy: AuthPolicy,
) -> Result<()> {
    if job.authority_disposition == AuthorityDisposition::PhysicalOwner {
        return Ok(());
    }
    require_original_authority(tx, job, policy).map(drop)
}

pub(crate) fn commit_source_authority_refusal(
    tx: &Transaction<'_>,
    job: &mut JobRecord,
    error: &anyhow::Error,
) -> Result<bool> {
    let reason = if job.authority_disposition == AuthorityDisposition::LegacyMissing {
        Some(AuthorityRefusalReason::MissingOriginal)
    } else {
        match error.downcast_ref::<auth::AuthorityFailure>() {
            Some(auth::AuthorityFailure::CredentialInvalid) => {
                Some(AuthorityRefusalReason::CredentialInvalid)
            }
            Some(auth::AuthorityFailure::PolicyChanged) => {
                Some(AuthorityRefusalReason::PolicyChanged)
            }
            Some(auth::AuthorityFailure::TenantChanged) => {
                Some(AuthorityRefusalReason::TenantChanged)
            }
            Some(auth::AuthorityFailure::SubjectChanged) => {
                Some(AuthorityRefusalReason::SubjectChanged)
            }
            _ => None,
        }
    };
    let Some(reason) = reason else {
        return Ok(false);
    };
    record_refusal(tx, job, reason, AuthorityRefusalPhase::SourceWriter, None)?;
    save(tx, job, "source_authority_refused")?;
    Ok(true)
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
                policy: self.policy,
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
                policy: self.policy,
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
        let policy = self.policy.ok_or(auth::AuthorityFailure::PolicyRequired)?;
        crate::uploads::submit(
            &self.storage,
            crate::uploads::Command::Phase {
                lease: lease.clone(),
                phase,
                policy,
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

#[cfg(test)]
mod authority_lease_tests {
    use super::*;
    use crate::{
        Limits,
        auth::{FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    };

    fn policy() -> AuthPolicy {
        AuthPolicy {
            registration: RegistrationPolicy::Open,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        }
    }

    fn admission() -> WorkerAdmission {
        WorkerAdmission {
            kinds: vec![(JobKind::ExportChecklistHtml, 2)],
            total: 2,
            per_resource: 2,
            lease_seconds: 60,
        }
    }

    #[test]
    fn authority_bearing_live_lease_rejects_stale_foreign_cross_job_and_tenant_mismatch() {
        let path = std::env::temp_dir().join(format!(
            "pp-authority-lease-unit-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
        let auth::Outcome::Session { user, token } = owner
            .auth_with_policy(policy())
            .unwrap()
            .submit(
                auth::Request::Register {
                    email: "authority-lease-unit@example.com".into(),
                    display_name: "Authority lease unit".into(),
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
        let token = token.expose().to_owned();
        let client = owner.jobs(policy()).unwrap();
        for (key, profile_id) in [("lease-a", 1), ("lease-b", 2)] {
            client
                .submit(
                    Credential::Session(Secret::new(token.clone())),
                    UserOperation::Enqueue {
                        key: key.into(),
                        payload_version: 1,
                        payload: Payload::ExportChecklistHtml { profile_id },
                    },
                    &AtomicBool::new(false),
                    Duration::from_secs(5),
                )
                .unwrap()
                .receive()
                .unwrap();
        }
        let worker = owner.job_worker_with_policy(policy(), admission()).unwrap();
        let (_, mut first) = worker.claim().unwrap().unwrap();
        let (_, second) = worker.claim().unwrap().unwrap();
        let authority = worker.authorize(&first).unwrap();
        assert_eq!(authority.tenant(), user.tenant_id);
        assert_eq!(authority.subject(), format!("user:{}", user.user_id));

        let stale = first.clone();
        worker
            .update(&mut first, WorkerOperation::Progress(7))
            .unwrap();
        assert!(
            worker
                .authorize(&stale)
                .unwrap_err()
                .to_string()
                .contains("Stale")
        );

        let foreign = owner.job_worker_with_policy(policy(), admission()).unwrap();
        assert!(
            foreign
                .authorize(&first)
                .unwrap_err()
                .to_string()
                .contains("Foreign worker")
        );

        let mut cross_job = first.clone();
        cross_job.job_id = second.job_id.clone();
        assert!(
            worker
                .authorize(&cross_job)
                .unwrap_err()
                .to_string()
                .contains("Stale attempt fence")
        );

        let mut wrong_tenant = first.clone();
        wrong_tenant.tenant = "wrong-tenant".into();
        assert!(
            worker
                .authorize(&wrong_tenant)
                .unwrap_err()
                .to_string()
                .contains("Job not found")
        );
        assert_eq!(worker.authorize(&first).unwrap(), authority);
        owner.shutdown().unwrap();
    }
}
