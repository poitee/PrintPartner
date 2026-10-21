use crate::{
    SettingsClient,
    catalog::{SourceBinding, SourceBusy, SourceWorkLease, State},
    jobs::{AttemptLease, JobKind, JobRecord, Payload, PersistentState, SourceSyncFailure},
    source_scan::LocalScanObservation,
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

/// One target of a Sync batch, by its ordinal in the sealed basis.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncTargetKey {
    pub(crate) job_id: String,
    pub(crate) ordinal: u32,
}

/// A claimed Local target. It holds the target's Source reservation until it
/// is released or dropped.
pub struct SyncTargetLease {
    pub(crate) key: SyncTargetKey,
    #[cfg_attr(not(test), expect(dead_code, reason = "D18 (b) settles with this"))]
    pub(crate) source_work: SourceWorkLease,
    pub(crate) observation: LocalScanObservation,
    #[cfg_attr(not(test), expect(dead_code, reason = "D18 (b) settles with this"))]
    pub(crate) claim_generation: i64,
}

impl SyncTargetLease {
    pub fn key(&self) -> &SyncTargetKey {
        &self.key
    }

    pub fn observation(&self) -> &LocalScanObservation {
        &self.observation
    }
}

pub enum NextSyncTarget {
    Local(SyncTargetLease),
    /// The target failed before any reservation and needs no settlement.
    OrdinaryFailure(SourceSyncFailure),
    Halted,
    Complete,
}

pub(crate) enum Next {
    Reserve(ReservedTarget),
    Done(NextSyncTarget, i64),
}

/// A target claimed in the transaction. Its token becomes live only after
/// the commit, as a claim-time reservation does.
pub(crate) struct ReservedTarget {
    key: SyncTargetKey,
    observation: LocalScanObservation,
    claim_generation: i64,
    token: u64,
    binding: SourceBinding,
    version: i64,
}

impl ReservedTarget {
    pub(crate) fn activate(
        self,
        state: &mut State,
        client: SettingsClient,
    ) -> Result<(NextSyncTarget, i64)> {
        state.activate(self.token, self.binding.tenant, self.binding.id);
        let proof = state.proof(self.token)?;
        Ok((
            NextSyncTarget::Local(SyncTargetLease {
                key: self.key,
                source_work: crate::catalog::lease(client, proof),
                observation: self.observation,
                claim_generation: self.claim_generation,
            }),
            self.version,
        ))
    }
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn token_text(token: u64) -> Result<String> {
    ensure!(token != 0, "Invalid Source reservation token");
    Ok(format!("{token:016x}"))
}

fn basis_digest(tenant: &str, selection_kind: &str, source_ids: &[i64]) -> Result<String> {
    Ok(digest(serde_json::to_vec(&(
        1_u8,
        tenant,
        selection_kind,
        source_ids.iter().enumerate().collect::<Vec<_>>(),
    ))?))
}

fn selected(payload: &Payload) -> Result<Option<Vec<i64>>> {
    let Payload::Sync { project_ids } = payload else {
        return Err(anyhow!("Sync payload required"));
    };
    project_ids
        .as_ref()
        .map(|ids| {
            ids.iter()
                .map(|id| i64::try_from(*id).map_err(Into::into))
                .collect()
        })
        .transpose()
}

fn require_sync_job(tx: &Transaction<'_>, lease: &AttemptLease) -> Result<JobRecord> {
    let job = crate::jobs::claimed_job(tx, lease)?;
    ensure!(job.kind == JobKind::Sync, "Attempt is not a Sync Job");
    Ok(job)
}

/// Checks the stored batch against the Job's payload and returns its
/// Sources in ordinal order.
fn validate_basis(tx: &Transaction<'_>, job: &JobRecord) -> Result<Vec<i64>> {
    let (tenant, selection_kind, stored_digest, target_count): (String, String, String, i64) = tx
        .query_row(
            "SELECT tenant,selection_kind,target_basis_digest,target_count FROM source_sync_batches WHERE job_id=?1",
            [&job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    ensure!(tenant == job.tenant, "Sync batch tenant mismatch");
    let rows = tx
        .prepare(
            "SELECT ordinal,requested_source_id,tenant FROM source_sync_targets WHERE job_id=?1 ORDER BY ordinal",
        )?
        .query_map([&job.job_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        usize::try_from(target_count)? == rows.len(),
        "Sync target count mismatch"
    );
    let mut source_ids = Vec::with_capacity(rows.len());
    for (expected, (ordinal, source_id, row_tenant)) in rows.into_iter().enumerate() {
        ensure!(
            ordinal == i64::try_from(expected)?,
            "Sync target ordinal mismatch"
        );
        ensure!(row_tenant == job.tenant, "Sync target tenant mismatch");
        source_ids.push(source_id);
    }
    match selected(&job.payload)? {
        None => ensure!(selection_kind == "all", "Sync selection mismatch"),
        Some(expected) => {
            ensure!(selection_kind == "explicit", "Sync selection mismatch");
            ensure!(source_ids == expected, "Sync selected Sources mismatch");
        }
    }
    ensure!(
        stored_digest == basis_digest(&job.tenant, &selection_kind, &source_ids)?,
        "Sync target basis mismatch"
    );
    Ok(source_ids)
}

/// Seals the batch's targets on first open. A later attempt revalidates the
/// sealed basis and returns earlier attempts' unsettled claims to pending.
/// A recognized authority refusal is returned for reporting after commit.
pub(crate) fn open(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    policy: crate::auth::AuthPolicy,
) -> Result<Option<crate::jobs::CommittedRefusal>> {
    let mut job = require_sync_job(tx, lease)?;
    ensure!(!job.cancel_requested, "Sync was cancelled");
    if let Err(error) = crate::jobs::require_original_authority(tx, &job, policy) {
        if !crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error) {
            return Err(error);
        }
        let job = halt_job(tx, job, "authority_refused", &format!("{error:#}"))?;
        return Ok(Some(crate::jobs::CommittedRefusal {
            job,
            failure: error.downcast()?,
        }));
    }
    let opened: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_sync_batches WHERE job_id=?1)",
        [&job.job_id],
        |row| row.get(0),
    )?;
    if opened {
        validate_basis(tx, &job)?;
        tx.execute(
            "UPDATE source_sync_targets SET state='pending',parent_generation=NULL,attempt_worker=NULL,attempt_fence_digest=NULL,reservation_incarnation=NULL,reservation_token=NULL,configuration_version=NULL,authority_actor=NULL,authority_basis_digest=NULL,activation_observation_digest=NULL,path_observation_digest=NULL,updated_at=?2 WHERE job_id=?1 AND state='claimed' AND parent_generation<>?3 AND result_json IS NULL AND failure_code IS NULL",
            params![job.job_id, now(), job.generation],
        )?;
        return Ok(None);
    }
    let (selection_kind, source_ids) = match selected(&job.payload)? {
        Some(ids) => ("explicit", ids),
        None => (
            "all",
            tx.prepare(
                "SELECT id FROM projects WHERE tenant_id=?1 ORDER BY last_synced_at ASC,id ASC",
            )?
            .query_map([&job.tenant], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        ),
    };
    ensure!(source_ids.len() <= 1000, "Too many sources");
    tx.execute(
        "INSERT INTO source_sync_batches(job_id,tenant,selection_kind,target_basis_digest,target_count,phase,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'open',?6,?6)",
        params![
            job.job_id,
            job.tenant,
            selection_kind,
            basis_digest(&job.tenant, selection_kind, &source_ids)?,
            i64::try_from(source_ids.len())?,
            now()
        ],
    )?;
    for (ordinal, source_id) in source_ids.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO source_sync_targets(job_id,ordinal,requested_source_id,tenant,state,updated_at) VALUES(?1,?2,?3,?4,'pending',?5)",
            params![job.job_id, i64::try_from(ordinal)?, source_id, job.tenant, now()],
        )?;
    }
    Ok(None)
}

fn progress(tx: &Transaction<'_>, job_id: &str) -> Result<u8> {
    let (done, total): (i64, i64) = tx.query_row(
        "SELECT count(*) FILTER (WHERE state IN ('succeeded','failed') AND reservation_acknowledged=1),count(*) FROM source_sync_targets WHERE job_id=?1",
        [job_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(if total == 0 {
        100
    } else {
        u8::try_from((done * 100) / total)?
    })
}

/// Ends the Job and closes its batch. Pending targets become not-run. A
/// claimed or unacknowledged target, or a generic effect, leaves the Job for
/// reconciliation instead of a terminal state.
pub(crate) fn halt_job(
    tx: &Transaction<'_>,
    mut job: JobRecord,
    code: &str,
    detail: &str,
) -> Result<JobRecord> {
    ensure!(job.kind == JobKind::Sync, "Job is not Sync");
    ensure!(
        matches!(
            code,
            "cancelled" | "authority_refused" | "fatal" | "uncertain_target"
        ),
        "Invalid Sync halt code"
    );
    let detail: String = detail.chars().take(1024).collect();
    if code == "authority_refused"
        && matches!(
            job.state,
            PersistentState::Failed | PersistentState::ReconciliationRequired
        )
        && job.authority_refusal.as_ref().is_some_and(|refusal| {
            refusal.phase == crate::jobs::AuthorityRefusalPhase::SourceWriter
                && refusal.generation == job.generation - 1
        })
        && job.recovery.as_deref() == Some(detail.as_str())
    {
        return Ok(job);
    }
    let unresolved: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_sync_targets WHERE job_id=?1 AND (state IN ('claimed','reconciliation_required') OR (state IN ('succeeded','failed') AND reservation_acknowledged=0)))",
        [&job.job_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE source_sync_targets SET state='not_run',failure_code='batch_halt',failure_detail=?2,updated_at=?3 WHERE job_id=?1 AND state='pending'",
        params![job.job_id, detail, now()],
    )?;
    if unresolved || !job.effects.is_empty() {
        let reason = if code == "authority_refused" {
            "authority_refused"
        } else {
            "local_settlement"
        };
        tx.execute(
            "UPDATE source_sync_targets SET state='reconciliation_required',failure_code=?2,failure_detail=?3,updated_at=?4 WHERE job_id=?1 AND state='claimed'",
            params![job.job_id, reason, detail, now()],
        )?;
        tx.execute(
            "UPDATE source_sync_batches SET phase='reconciliation_required',halt_code=NULL,updated_at=?2 WHERE job_id=?1 AND phase='open'",
            params![job.job_id, now()],
        )?;
        job.state = PersistentState::ReconciliationRequired;
    } else {
        tx.execute(
            "UPDATE source_sync_batches SET phase='halted',halt_code=?2,updated_at=?3 WHERE job_id=?1 AND phase='open'",
            params![job.job_id, code, now()],
        )?;
        job.state = if code == "cancelled" {
            PersistentState::Cancelled
        } else {
            PersistentState::Failed
        };
    }
    job.progress = Some(progress(tx, &job.job_id)?);
    job.public_result = None;
    job.result = None;
    job.recovery = Some(detail);
    job.generation += 1;
    job.fence = None;
    job.worker = None;
    job.lease_until = None;
    crate::jobs::save(tx, &mut job, "source_sync_halted")?;
    Ok(job)
}

fn failure(tx: &Transaction<'_>, key: &SyncTargetKey) -> Result<SourceSyncFailure> {
    Ok(tx.query_row(
        "SELECT requested_source_id,source_name,failure_detail FROM source_sync_targets WHERE job_id=?1 AND ordinal=?2 AND state='failed'",
        params![key.job_id, key.ordinal],
        |row| {
            Ok(SourceSyncFailure {
                project_id: u64::try_from(row.get::<_, i64>(0)?).ok(),
                name: row.get(1)?,
                error: row.get(2)?,
            })
        },
    )?)
}

/// Claims the batch's next pending target. A missing or non-Local Source
/// fails the target at once. A Local target records the attempt, the Source
/// observation and a new reservation token, which is activated only after
/// the commit.
pub(crate) fn next(
    tx: &Transaction<'_>,
    state: &State,
    lease: &AttemptLease,
    policy: crate::auth::AuthPolicy,
) -> Result<Next> {
    let loaded =
        crate::jobs::load(tx, lease.job_id())?.ok_or_else(|| anyhow!("Sync Job not found"))?;
    ensure!(loaded.kind == JobKind::Sync, "Attempt is not a Sync Job");
    ensure!(loaded.tenant == lease.tenant(), "Sync next tenant mismatch");
    if loaded.state == PersistentState::ReconciliationRequired || loaded.state.terminal() {
        return Ok(Next::Done(NextSyncTarget::Halted, loaded.state_version));
    }
    let mut job = require_sync_job(tx, lease)?;
    if job.cancel_requested {
        let halted = halt_job(tx, job, "cancelled", "Sync was cancelled")?;
        return Ok(Next::Done(NextSyncTarget::Halted, halted.state_version));
    }
    let authority = match crate::jobs::require_original_authority(tx, &job, policy) {
        Ok(authority) => authority,
        Err(error) => {
            if !crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error) {
                return Err(error);
            }
            let halted = halt_job(tx, job, "authority_refused", &format!("{error:#}"))?;
            return Ok(Next::Done(NextSyncTarget::Halted, halted.state_version));
        }
    };
    let phase: Option<String> = tx
        .query_row(
            "SELECT phase FROM source_sync_batches WHERE job_id=?1",
            [&job.job_id],
            |row| row.get(0),
        )
        .optional()?;
    ensure!(phase.as_deref() == Some("open"), "Sync batch is not open");
    let row: Option<(i64, i64, String, i64)> = tx
        .query_row(
            "SELECT ordinal,requested_source_id,state,claim_generation FROM source_sync_targets WHERE job_id=?1 AND NOT (state IN ('succeeded','failed') AND reservation_acknowledged=1) ORDER BY ordinal LIMIT 1",
            [&job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((ordinal, source_id, target_state, claim_generation)) = row else {
        return Ok(Next::Done(NextSyncTarget::Complete, job.state_version));
    };
    ensure!(
        target_state == "pending",
        "Prior Sync target is not pending"
    );
    let key = SyncTargetKey {
        job_id: job.job_id.clone(),
        ordinal: u32::try_from(ordinal)?,
    };
    let source: Option<(String, String)> = tx
        .query_row(
            "SELECT name,source_type FROM projects WHERE tenant_id=?1 AND id=?2",
            params![job.tenant, source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let source_name = match source {
        None => {
            tx.execute(
                "UPDATE source_sync_targets SET state='failed',failure_code='unavailable',failure_detail='Source not found',reservation_acknowledged=1,updated_at=?3 WHERE job_id=?1 AND ordinal=?2 AND state='pending'",
                params![key.job_id, key.ordinal, now()],
            )?;
            return ordinary_failure(tx, job, &key);
        }
        Some((name, source_type)) if source_type != "local" => {
            tx.execute(
                "UPDATE source_sync_targets SET source_name=?3,state='failed',failure_code='unsupported_kind',failure_detail='Source kind is not supported by Local Sync',reservation_acknowledged=1,updated_at=?4 WHERE job_id=?1 AND ordinal=?2 AND state='pending'",
                params![key.job_id, key.ordinal, name, now()],
            )?;
            return ordinary_failure(tx, job, &key);
        }
        Some((name, _)) => name,
    };
    let durably_claimed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_sync_targets WHERE tenant=?1 AND requested_source_id=?2 AND state='claimed')",
        params![job.tenant, source_id],
        |row| row.get(0),
    )?;
    ensure!(
        !durably_claimed && !state.source_busy(&job.tenant, source_id),
        SourceBusy
    );
    let token = state.next_token()?;
    let observation =
        crate::source_scan::project_observation(tx, &job.tenant, source_id, authority.subject())?;
    ensure!(
        tx.execute(
            "UPDATE source_sync_targets SET source_name=?3,state='claimed',claim_generation=claim_generation+1,parent_generation=?4,attempt_worker=?5,attempt_fence_digest=?6,reservation_incarnation=?7,reservation_token=?8,configuration_version=?9,authority_actor=?10,authority_basis_digest=?11,activation_observation_digest=?12,path_observation_digest=?13,updated_at=?14 WHERE job_id=?1 AND ordinal=?2 AND state='pending' AND claim_generation=?15",
            params![
                key.job_id,
                key.ordinal,
                source_name,
                job.generation,
                lease.worker(),
                digest(lease.fence()),
                state.incarnation(),
                token_text(token)?,
                observation.configuration_version,
                observation.authority_actor,
                observation.authority_basis_digest,
                observation.activation_observation_digest,
                observation.path_observation_digest,
                now(),
                claim_generation
            ],
        )? == 1,
        "Sync target claim changed"
    );
    Ok(Next::Reserve(ReservedTarget {
        key,
        observation,
        claim_generation: claim_generation + 1,
        token,
        binding: SourceBinding {
            tenant: job.tenant,
            id: source_id,
        },
        version: job.state_version,
    }))
}

fn ordinary_failure(tx: &Transaction<'_>, mut job: JobRecord, key: &SyncTargetKey) -> Result<Next> {
    let failure = failure(tx, key)?;
    job.progress = Some(progress(tx, &job.job_id)?);
    crate::jobs::save(tx, &mut job, "source_sync_progress")?;
    Ok(Next::Done(
        NextSyncTarget::OrdinaryFailure(failure),
        job.state_version,
    ))
}

pub(crate) fn validate_schema(connection: &Connection, version: u64) -> Result<()> {
    let objects = |connection: &Connection| -> Result<Vec<(String, Option<String>)>> {
        Ok(connection
            .prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'source_sync_%' OR name LIKE 'sqlite_autoindex_source_sync_%' ORDER BY name")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    };
    let actual = objects(connection)?;
    if version < 41 {
        ensure!(actual.is_empty(), "Unexpected Source Sync schema");
        return Ok(());
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE durable_jobs(id TEXT PRIMARY KEY); CREATE TABLE projects(id INTEGER PRIMARY KEY);")?;
    expected.execute_batch(include_str!("source_sync/schema.sql"))?;
    ensure!(actual == objects(&expected)?, "Source Sync schema mismatch");
    Ok(())
}

#[cfg(test)]
mod tests;
