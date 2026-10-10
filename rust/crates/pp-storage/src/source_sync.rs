use crate::{
    catalog::{IssuedTokenState, SourceBinding, SourceWorkLease, SourceWorkProof, State},
    jobs::{
        AttemptLease, CompletedResult, JobKind, JobRecord, LocalCommit, Payload, PersistentState,
        SourceScanResult, SourceSyncFailure, SourceSyncResult,
    },
    source_scan::{LocalScanObservation, LocalScanSettlement},
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncTargetKey {
    pub(crate) job_id: String,
    pub(crate) ordinal: u32,
}

pub struct SyncTargetLease {
    pub(crate) key: SyncTargetKey,
    pub(crate) source_work: SourceWorkLease,
    pub(crate) observation: LocalScanObservation,
    pub(crate) claim_generation: i64,
}

impl SyncTargetLease {
    pub fn key(&self) -> &SyncTargetKey {
        &self.key
    }

    pub fn observation(&self) -> &LocalScanObservation {
        &self.observation
    }

    pub fn settlement(
        &self,
        documents: Vec<crate::source_scan::LocalDocumentRecord>,
    ) -> LocalScanSettlement {
        self.observation.clone().settlement(documents)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SyncTargetInspection {
    Pending,
    Succeeded(SourceScanResult),
    Failed(SourceSyncFailure),
    Halted,
    ReconciliationRequired,
}

pub enum NextSyncTarget {
    Local(SyncTargetLease),
    OrdinaryFailure(SyncTargetInspection),
    Recovered(SyncTargetInspection),
    Halted,
    Complete,
}

pub(crate) struct SyncCommandResult<T> {
    pub(crate) value: T,
    pub(crate) job: JobRecord,
    pub(crate) commit: LocalCommit,
    pub(crate) current_version: i64,
}

impl<T> SyncCommandResult<T> {
    fn committed(value: T, job: JobRecord) -> Self {
        let current_version = job.state_version;
        Self {
            value,
            job,
            commit: LocalCommit::Committed,
            current_version,
        }
    }

    fn read_only(value: T, job: JobRecord) -> Self {
        let current_version = job.state_version;
        Self {
            value,
            job,
            commit: LocalCommit::ReadOnly,
            current_version,
        }
    }
}

pub enum SourceSyncFinishOutcome {
    Completed(Box<CompletedSourceSync>),
    NeedsReconciliation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncAuthorityRefusal {
    MissingOriginal,
    CredentialInvalid,
    PolicyChanged,
    TenantChanged,
    SubjectChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginalAuthorityStatus {
    Valid,
    Refused(SyncAuthorityRefusal),
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncRecoveryDisposition {
    Pending,
    Claimed,
    Succeeded,
    Failed,
    NotRun,
    ReconciliationRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncRecoveryState {
    Completed,
    Failed,
    Cancelled,
    ReconciliationRequired,
}

pub struct SyncRecoveryTarget {
    ordinal: u32,
    requested_source_id: u64,
    disposition: SyncRecoveryDisposition,
    failure: Option<String>,
    result: Option<SourceScanResult>,
    acknowledged: bool,
}

impl SyncRecoveryTarget {
    pub fn ordinal(&self) -> u32 {
        self.ordinal
    }
    pub fn requested_source_id(&self) -> u64 {
        self.requested_source_id
    }
    pub fn disposition(&self) -> SyncRecoveryDisposition {
        self.disposition
    }
    pub fn failure(&self) -> Option<&str> {
        self.failure.as_deref()
    }
    pub fn result(&self) -> Option<&SourceScanResult> {
        self.result.as_ref()
    }
    pub fn acknowledged(&self) -> bool {
        self.acknowledged
    }
}

pub struct SyncRecoveryInspection {
    job_id: String,
    version: i64,
    state: SyncRecoveryState,
    targets: Vec<SyncRecoveryTarget>,
    original_authority: OriginalAuthorityStatus,
}

impl SyncRecoveryInspection {
    pub fn job_id(&self) -> &str {
        &self.job_id
    }
    pub fn version(&self) -> i64 {
        self.version
    }
    pub fn state(&self) -> SyncRecoveryState {
        self.state
    }
    pub fn targets(&self) -> &[SyncRecoveryTarget] {
        &self.targets
    }
    pub fn original_authority(&self) -> OriginalAuthorityStatus {
        self.original_authority
    }
}

pub(crate) struct AuthorizedSyncRead {
    job: JobRecord,
    original_subject: Option<String>,
    original_authority: OriginalAuthorityStatus,
}

impl AuthorizedSyncRead {
    pub(crate) fn new(
        job: JobRecord,
        tenant: String,
        _actor: String,
        expected_version: i64,
        original_subject: Option<String>,
        original_authority: OriginalAuthorityStatus,
    ) -> Result<Self> {
        ensure!(job.tenant == tenant, "Sync recovery tenant mismatch");
        ensure!(job.kind == JobKind::Sync, "Job is not Sync");
        ensure!(
            job.state_version == expected_version,
            "Stale Sync recovery version"
        );
        ensure!(
            job.state == PersistentState::ReconciliationRequired || job.state.terminal(),
            "Sync recovery is not retained"
        );
        Ok(Self {
            job,
            original_subject,
            original_authority,
        })
    }

    pub(crate) fn job(&self) -> &JobRecord {
        &self.job
    }
    pub(crate) fn original_subject(&self) -> Option<&str> {
        self.original_subject.as_deref()
    }
}

#[derive(Clone, Copy, Debug)]
pub enum SourceSyncHalt {
    Fatal,
    UncertainTarget,
}

impl SourceSyncHalt {
    pub(crate) fn stored(self) -> &'static str {
        match self {
            Self::Fatal => "fatal",
            Self::UncertainTarget => "uncertain_target",
        }
    }
}

pub struct CompletedSourceSync {
    pub job: JobRecord,
    pub aggregate: SourceSyncResult,
}

#[derive(Clone, Debug)]
#[doc(hidden)]
pub struct TargetCandidate {
    pub key: SyncTargetKey,
    pub source_id: i64,
}

#[derive(Clone, Debug)]
#[doc(hidden)]
pub struct BoundTarget {
    pub key: SyncTargetKey,
    pub observation: LocalScanObservation,
    pub claim_generation: i64,
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

#[derive(Clone)]
struct ProducerCapture {
    claim_generation: i64,
    parent_generation: i64,
    worker: String,
    fence_digest: String,
    incarnation: String,
    token: String,
    configuration_version: i64,
    authority_actor: String,
    authority_basis_digest: String,
    activation_digest: String,
    path_digest: String,
}

enum ValidatedTargetOutcome {
    Pending,
    Claimed,
    Succeeded {
        result: SourceScanResult,
        _receipt: crate::jobs::ResultArtifact,
    },
    Failed {
        failure: SourceSyncFailure,
        code: String,
    },
    NotRun,
    ReconciliationRequired {
        result: Option<SourceScanResult>,
    },
}

struct ValidatedTarget {
    ordinal: u32,
    source_id: i64,
    acknowledged: bool,
    failure_detail: Option<String>,
    capture: Option<ProducerCapture>,
    outcome: ValidatedTargetOutcome,
}

struct StoredSyncTargetRow {
    requested_source_id: i64,
    source_name: Option<String>,
    state: String,
    claim_generation: i64,
    parent_generation: Option<i64>,
    attempt_worker: Option<String>,
    attempt_fence_digest: Option<String>,
    reservation_incarnation: Option<String>,
    reservation_token: Option<String>,
    configuration_version: Option<i64>,
    authority_actor: Option<String>,
    authority_basis_digest: Option<String>,
    activation_observation_digest: Option<String>,
    path_observation_digest: Option<String>,
    result_json: Option<String>,
    result_digest: Option<String>,
    receipt_id: Option<String>,
    receipt_hash: Option<String>,
    receipt_target: Option<String>,
    failure_code: Option<String>,
    failure_detail: Option<String>,
    reservation_acknowledged: i64,
}

impl StoredSyncTargetRow {
    fn decode(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            requested_source_id: row.get(0)?,
            source_name: row.get(1)?,
            state: row.get(2)?,
            claim_generation: row.get(3)?,
            parent_generation: row.get(4)?,
            attempt_worker: row.get(5)?,
            attempt_fence_digest: row.get(6)?,
            reservation_incarnation: row.get(7)?,
            reservation_token: row.get(8)?,
            configuration_version: row.get(9)?,
            authority_actor: row.get(10)?,
            authority_basis_digest: row.get(11)?,
            activation_observation_digest: row.get(12)?,
            path_observation_digest: row.get(13)?,
            result_json: row.get(14)?,
            result_digest: row.get(15)?,
            receipt_id: row.get(16)?,
            receipt_hash: row.get(17)?,
            receipt_target: row.get(18)?,
            failure_code: row.get(19)?,
            failure_detail: row.get(20)?,
            reservation_acknowledged: row.get(21)?,
        })
    }
}

pub(crate) struct ClaimedSyncTargetCommand<'a> {
    pub(crate) lease: &'a AttemptLease,
    pub(crate) key: &'a SyncTargetKey,
    pub(crate) proof: &'a SourceWorkProof,
    pub(crate) claim_generation: i64,
    pub(crate) policy: crate::auth::AuthPolicy,
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_receipt_id(value: &str) -> bool {
    value.len() == 43
        && value.starts_with("local-scan-")
        && value[11..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_basis(tx: &Transaction<'_>, job: &JobRecord) -> Result<Vec<i64>> {
    let (tenant, selection_kind, basis_digest, target_count): (String, String, String, i64) = tx
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
    let Payload::Sync { project_ids } = &job.payload else {
        return Err(anyhow!("Sync payload required"));
    };
    match project_ids {
        None => ensure!(selection_kind == "all", "Sync selection mismatch"),
        Some(expected) => {
            ensure!(selection_kind == "explicit", "Sync selection mismatch");
            let expected = expected
                .iter()
                .map(|source_id| i64::try_from(*source_id).map_err(Into::into))
                .collect::<Result<Vec<_>>>()?;
            ensure!(source_ids == expected, "Sync selected Sources mismatch");
        }
    }
    let actual_digest = digest(serde_json::to_vec(&(
        1_u8,
        &job.tenant,
        &selection_kind,
        source_ids.iter().enumerate().collect::<Vec<_>>(),
    ))?);
    ensure!(basis_digest == actual_digest, "Sync target basis mismatch");
    Ok(source_ids)
}

fn validate_target(
    tx: &Transaction<'_>,
    job: &JobRecord,
    key: &SyncTargetKey,
) -> Result<ValidatedTarget> {
    let source_ids = validate_basis(tx, job)?;
    validate_target_in_basis(tx, job, key, &source_ids)
}

fn validate_target_in_basis(
    tx: &Transaction<'_>,
    job: &JobRecord,
    key: &SyncTargetKey,
    source_ids: &[i64],
) -> Result<ValidatedTarget> {
    ensure!(job.kind == JobKind::Sync, "Job is not Sync");
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    let source_id = *source_ids
        .get(usize::try_from(key.ordinal)?)
        .ok_or_else(|| anyhow!("Sync target is outside the sealed basis"))?;
    let StoredSyncTargetRow {
        requested_source_id: stored_source_id,
        source_name,
        state,
        claim_generation,
        parent_generation,
        attempt_worker: worker,
        attempt_fence_digest: fence_digest,
        reservation_incarnation: incarnation,
        reservation_token: token,
        configuration_version,
        authority_actor,
        authority_basis_digest,
        activation_observation_digest: activation_digest,
        path_observation_digest: path_digest,
        result_json,
        result_digest,
        receipt_id,
        receipt_hash,
        receipt_target,
        failure_code,
        failure_detail,
        reservation_acknowledged: acknowledged,
    } = tx.query_row(
        "SELECT requested_source_id,source_name,state,claim_generation,parent_generation,attempt_worker,attempt_fence_digest,reservation_incarnation,reservation_token,configuration_version,authority_actor,authority_basis_digest,activation_observation_digest,path_observation_digest,result_json,result_digest,receipt_id,receipt_hash,receipt_target,failure_code,failure_detail,reservation_acknowledged FROM source_sync_targets WHERE job_id=?1 AND ordinal=?2 AND tenant=?3",
        params![key.job_id, key.ordinal, job.tenant],
        StoredSyncTargetRow::decode,
    )?;
    ensure!(stored_source_id == source_id, "Sync target Source mismatch");
    ensure!(
        matches!(acknowledged, 0 | 1),
        "Invalid Sync acknowledgement state"
    );
    ensure!(claim_generation >= 0, "Invalid Sync claim generation");
    let capture_values = [
        parent_generation.is_some(),
        worker.is_some(),
        fence_digest.is_some(),
        incarnation.is_some(),
        token.is_some(),
        configuration_version.is_some(),
        authority_actor.is_some(),
        authority_basis_digest.is_some(),
        activation_digest.is_some(),
        path_digest.is_some(),
    ];
    let capture = if capture_values.iter().any(|present| *present) {
        ensure!(
            capture_values.iter().all(|present| *present),
            "Sync producer capture incomplete"
        );
        let parent_generation = parent_generation.expect("complete capture");
        let worker = worker.expect("complete capture");
        let fence_digest = fence_digest.expect("complete capture");
        let incarnation = incarnation.expect("complete capture");
        let token = token.expect("complete capture");
        let configuration_version = configuration_version.expect("complete capture");
        let authority_actor = authority_actor.expect("complete capture");
        let authority_basis_digest = authority_basis_digest.expect("complete capture");
        let activation_digest = activation_digest.expect("complete capture");
        let path_digest = path_digest.expect("complete capture");
        ensure!(
            claim_generation > 0 && parent_generation > 0,
            "Invalid Sync producer generation"
        );
        ensure!(
            !worker.is_empty() && !authority_actor.is_empty(),
            "Invalid Sync producer identity"
        );
        ensure!(
            valid_digest(&fence_digest),
            "Invalid Sync attempt fence digest"
        );
        ensure!(
            valid_digest(&incarnation),
            "Invalid Sync reservation incarnation"
        );
        ensure!(
            valid_digest(&authority_basis_digest),
            "Invalid Sync authority digest"
        );
        ensure!(
            valid_digest(&activation_digest),
            "Invalid Sync activation digest"
        );
        ensure!(valid_digest(&path_digest), "Invalid Sync path digest");
        ensure!(
            configuration_version > 0,
            "Invalid Sync configuration version"
        );
        let parsed_token = u64::from_str_radix(&token, 16)?;
        ensure!(
            token == token_text(parsed_token)?,
            "Invalid Sync reservation token"
        );
        Some(ProducerCapture {
            claim_generation,
            parent_generation,
            worker,
            fence_digest,
            incarnation,
            token,
            configuration_version,
            authority_actor,
            authority_basis_digest,
            activation_digest,
            path_digest,
        })
    } else {
        None
    };
    let receipt_values = [
        receipt_id.is_some(),
        receipt_hash.is_some(),
        receipt_target.is_some(),
    ];
    ensure!(
        receipt_values.iter().all(|present| *present)
            || receipt_values.iter().all(|present| !*present),
        "Sync receipt capture incomplete"
    );
    let receipt = match (receipt_id, receipt_hash, receipt_target) {
        (Some(receipt_id), Some(content_hash), Some(target)) => {
            let receipt = crate::jobs::ResultArtifact {
                receipt_id,
                content_hash,
                target,
            };
            receipt.validate()?;
            ensure!(
                valid_receipt_id(&receipt.receipt_id),
                "Invalid Local receipt ID"
            );
            ensure!(
                receipt.target == format!("source:{source_id}"),
                "Sync receipt Source mismatch"
            );
            Some(receipt)
        }
        (None, None, None) => None,
        _ => unreachable!(),
    };
    let result = match (result_json, result_digest) {
        (Some(result_json), Some(result_digest)) => {
            ensure!(valid_digest(&result_digest), "Invalid Sync result digest");
            let result: SourceScanResult = serde_json::from_str(&result_json)?;
            let canonical_result = serde_json::to_string(&result)?;
            ensure!(
                result_json == canonical_result,
                "Sync result is not canonical"
            );
            ensure!(
                digest(canonical_result.as_bytes()) == result_digest,
                "Sync result digest mismatch"
            );
            ensure!(
                result.project_id == u64::try_from(source_id).ok(),
                "Sync result Source mismatch"
            );
            Some(result)
        }
        (None, None) => None,
        _ => return Err(anyhow!("Sync result capture incomplete")),
    };
    let failure = || -> Result<SourceSyncFailure> {
        let detail = failure_detail
            .clone()
            .ok_or_else(|| anyhow!("Sync failure detail missing"))?;
        ensure!(
            !detail.is_empty() && detail.len() <= 1024,
            "Invalid Sync failure detail"
        );
        Ok(SourceSyncFailure {
            project_id: u64::try_from(source_id).ok(),
            name: source_name.clone(),
            error: detail,
        })
    };
    let outcome = match state.as_str() {
        "pending" => {
            ensure!(
                capture.is_none()
                    && result.is_none()
                    && receipt.is_none()
                    && failure_code.is_none()
                    && failure_detail.is_none()
                    && acknowledged == 0,
                "Invalid pending Sync target"
            );
            ValidatedTargetOutcome::Pending
        }
        "claimed" => {
            ensure!(
                capture.is_some()
                    && result.is_none()
                    && receipt.is_none()
                    && failure_code.is_none()
                    && failure_detail.is_none()
                    && acknowledged == 0,
                "Invalid claimed Sync target"
            );
            ValidatedTargetOutcome::Claimed
        }
        "succeeded" => {
            ensure!(
                capture.is_some() && failure_code.is_none() && failure_detail.is_none(),
                "Invalid successful Sync target"
            );
            ValidatedTargetOutcome::Succeeded {
                result: result.ok_or_else(|| anyhow!("Sync result missing"))?,
                _receipt: receipt.ok_or_else(|| anyhow!("Sync receipt missing"))?,
            }
        }
        "failed" => {
            ensure!(
                result.is_none() && receipt.is_none(),
                "Failed Sync target retained success evidence"
            );
            let code = failure_code
                .clone()
                .ok_or_else(|| anyhow!("Sync failure code missing"))?;
            match code.as_str() {
                "unavailable" | "unsupported_kind" => {
                    ensure!(
                        capture.is_none() && acknowledged == 1,
                        "Invalid unreserved Sync failure"
                    );
                }
                "local_read"
                | "local_settlement"
                | "configuration_changed"
                | "authority_refused" => {
                    ensure!(
                        capture.is_some(),
                        "Reserved Sync failure lacks producer capture"
                    );
                }
                _ => return Err(anyhow!("Invalid Sync failure code")),
            }
            ValidatedTargetOutcome::Failed {
                failure: failure()?,
                code,
            }
        }
        "not_run" => {
            ensure!(
                capture.is_none()
                    && result.is_none()
                    && receipt.is_none()
                    && failure_code.as_deref() == Some("batch_halt")
                    && acknowledged == 0,
                "Invalid not-run Sync target"
            );
            let _ = failure()?;
            ValidatedTargetOutcome::NotRun
        }
        "reconciliation_required" => {
            ensure!(
                capture.is_some(),
                "Sync reconciliation lacks producer capture"
            );
            ensure!(
                matches!(
                    failure_code.as_deref(),
                    Some(
                        "local_read"
                            | "local_settlement"
                            | "configuration_changed"
                            | "authority_refused"
                    )
                ),
                "Invalid Sync reconciliation reason"
            );
            if result.is_some() || receipt.is_some() {
                ensure!(
                    result.is_some() && receipt.is_some(),
                    "Sync reconciliation receipt/result mismatch"
                );
            }
            let _ = failure()?;
            ValidatedTargetOutcome::ReconciliationRequired { result }
        }
        _ => return Err(anyhow!("Invalid Sync target state")),
    };
    Ok(ValidatedTarget {
        ordinal: key.ordinal,
        source_id,
        acknowledged: acknowledged == 1,
        failure_detail,
        capture,
        outcome,
    })
}

fn require_sync_job(tx: &Transaction<'_>, lease: &AttemptLease) -> Result<JobRecord> {
    let job = crate::jobs::claimed_job(tx, lease)?;
    ensure!(job.kind == JobKind::Sync, "Attempt is not a Sync Job");
    Ok(job)
}

pub(crate) fn candidate_binding(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    key: &SyncTargetKey,
) -> Result<(String, i64)> {
    let job = require_sync_job(tx, lease)?;
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    ensure!(!job.cancel_requested, "Sync was cancelled");
    let (ordinal, source_id, tenant, state): (i64, i64, String, String) = tx.query_row(
        "SELECT ordinal,requested_source_id,tenant,state FROM source_sync_targets WHERE job_id=?1 AND ordinal=(SELECT min(ordinal) FROM source_sync_targets WHERE job_id=?1 AND NOT (state IN ('succeeded','failed') AND reservation_acknowledged=1))",
        [&job.job_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    ensure!(
        ordinal == i64::from(key.ordinal),
        "Sync target ordinal mismatch"
    );
    ensure!(tenant == job.tenant, "Sync target tenant mismatch");
    ensure!(state == "pending", "Sync target is not pending");
    Ok((job.tenant, source_id))
}

fn basis(payload: &Payload, tenant: &str, tx: &Transaction<'_>) -> Result<(String, Vec<i64>)> {
    let Payload::Sync { project_ids } = payload else {
        return Err(anyhow!("Sync payload required"));
    };
    let (kind, ids) = match project_ids {
        Some(ids) => (
            "explicit".to_owned(),
            ids.iter()
                .map(|id| i64::try_from(*id).map_err(Into::into))
                .collect::<Result<Vec<_>>>()?,
        ),
        None => (
            "all".to_owned(),
            tx.prepare(
                "SELECT id FROM projects WHERE tenant_id=?1 ORDER BY last_synced_at ASC,id ASC",
            )?
            .query_map([tenant], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        ),
    };
    ensure!(ids.len() <= 1000, "Too many sources");
    Ok((kind, ids))
}

pub(crate) fn open(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    policy: crate::auth::AuthPolicy,
) -> Result<()> {
    let job = require_sync_job(tx, lease)?;
    ensure!(!job.cancel_requested, "Sync was cancelled");
    crate::jobs::require_original_authority(tx, &job, policy)?;
    let existing: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT selection_kind,target_basis_digest,target_count FROM source_sync_batches WHERE job_id=?1",
            [&job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((stored_kind, stored_digest, stored_count)) = existing {
        let Payload::Sync { project_ids } = &job.payload else {
            return Err(anyhow!("Sync payload required"));
        };
        match project_ids {
            None => ensure!(stored_kind == "all", "Stored Sync selection kind mismatch"),
            Some(ids) => {
                ensure!(
                    stored_kind == "explicit",
                    "Stored Sync selection kind mismatch"
                );
                let stored = tx
                    .prepare("SELECT requested_source_id FROM source_sync_targets WHERE job_id=?1 ORDER BY ordinal")?
                    .query_map([&job.job_id], |row| row.get::<_, i64>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let expected = ids
                    .iter()
                    .map(|id| i64::try_from(*id).map_err(Into::into))
                    .collect::<Result<Vec<_>>>()?;
                ensure!(stored == expected, "Stored Sync target basis mismatch");
                let expected_digest = digest(serde_json::to_vec(&(
                    1_u8,
                    &job.tenant,
                    &stored_kind,
                    expected.iter().enumerate().collect::<Vec<_>>(),
                ))?);
                ensure!(
                    stored_digest == expected_digest,
                    "Stored Sync target digest mismatch"
                );
            }
        }
        let row_count: i64 = tx.query_row(
            "SELECT count(*) FROM source_sync_targets WHERE job_id=?1",
            [&job.job_id],
            |row| row.get(0),
        )?;
        ensure!(
            stored_count == row_count,
            "Stored Sync target count mismatch"
        );
        tx.execute(
            "UPDATE source_sync_targets SET state='pending',parent_generation=NULL,attempt_worker=NULL,attempt_fence_digest=NULL,reservation_incarnation=NULL,reservation_token=NULL,configuration_version=NULL,authority_actor=NULL,authority_basis_digest=NULL,activation_observation_digest=NULL,path_observation_digest=NULL,updated_at=?2 WHERE job_id=?1 AND state='claimed' AND parent_generation<>?3 AND result_json IS NULL AND failure_code IS NULL",
            params![job.job_id, now(), job.generation],
        )?;
        return Ok(());
    }
    let (selection_kind, ids) = basis(&job.payload, &job.tenant, tx)?;
    let basis_digest = digest(serde_json::to_vec(&(
        1_u8,
        &job.tenant,
        &selection_kind,
        ids.iter().enumerate().collect::<Vec<_>>(),
    ))?);
    tx.execute(
        "INSERT INTO source_sync_batches(job_id,tenant,selection_kind,target_basis_digest,target_count,phase,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'open',?6,?6)",
        params![job.job_id, job.tenant, selection_kind, basis_digest, i64::try_from(ids.len())?, now()],
    )?;
    for (ordinal, source_id) in ids.into_iter().enumerate() {
        tx.execute(
            "INSERT INTO source_sync_targets(job_id,ordinal,requested_source_id,tenant,state,updated_at) VALUES(?1,?2,?3,?4,'pending',?5)",
            params![job.job_id, i64::try_from(ordinal)?, source_id, job.tenant, now()],
        )?;
    }
    Ok(())
}

fn update_progress(tx: &Transaction<'_>, mut job: JobRecord) -> Result<JobRecord> {
    let (done, total): (i64, i64) = tx.query_row(
        "SELECT count(*) FILTER (WHERE state IN ('succeeded','failed') AND reservation_acknowledged=1),count(*) FROM source_sync_targets WHERE job_id=?1",
        [&job.job_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    job.progress = Some(if total == 0 {
        100
    } else {
        u8::try_from((done * 100) / total)?
    });
    crate::jobs::save(tx, &mut job, "source_sync_progress")?;
    Ok(job)
}

pub(crate) fn halt_after_error(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    code: &str,
    detail: &str,
) -> Result<Option<JobRecord>> {
    ensure!(
        matches!(
            code,
            "cancelled" | "authority_refused" | "fatal" | "uncertain_target"
        ),
        "Invalid Sync halt code"
    );
    let job =
        crate::jobs::load(tx, lease.job_id())?.ok_or_else(|| anyhow!("Sync Job not found"))?;
    ensure!(job.kind == JobKind::Sync, "Attempt is not a Sync Job");
    ensure!(job.tenant == lease.tenant(), "Sync halt tenant mismatch");
    ensure!(
        job.generation == lease.generation()
            && job.worker.as_deref() == Some(lease.worker())
            && job.fence.as_deref() == Some(lease.fence())
            && job.state == PersistentState::Running,
        "Sync halt attempt mismatch"
    );
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_sync_batches WHERE job_id=?1)",
        [&job.job_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    halt_job(tx, job, code, detail).map(Some)
}

pub(crate) fn halt_job(
    tx: &Transaction<'_>,
    mut job: JobRecord,
    code: &str,
    detail: &str,
) -> Result<JobRecord> {
    ensure!(job.kind == JobKind::Sync, "Job is not Sync");
    let unresolved: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_sync_targets WHERE job_id=?1 AND (state IN ('claimed','reconciliation_required') OR (state IN ('succeeded','failed') AND reservation_acknowledged=0)))",
        [&job.job_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE source_sync_targets SET state='not_run',failure_code='batch_halt',failure_detail=?2,updated_at=?3 WHERE job_id=?1 AND state='pending'",
        params![job.job_id, detail.chars().take(1024).collect::<String>(), now()],
    )?;
    if unresolved || !job.effects.is_empty() {
        tx.execute(
            "UPDATE source_sync_targets SET state='reconciliation_required',failure_code=?2,failure_detail=?3,updated_at=?4 WHERE job_id=?1 AND state='claimed'",
            params![job.job_id, if code == "authority_refused" { "authority_refused" } else { "local_settlement" }, detail.chars().take(1024).collect::<String>(), now()],
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
    let (done, total): (i64, i64) = tx.query_row(
        "SELECT count(*) FILTER (WHERE state IN ('succeeded','failed') AND reservation_acknowledged=1),count(*) FROM source_sync_targets WHERE job_id=?1",
        [&job.job_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    job.progress = Some(if total == 0 {
        100
    } else {
        u8::try_from((done * 100) / total)?
    });
    job.public_result = None;
    job.result = None;
    job.recovery = Some(detail.chars().take(1024).collect());
    job.generation += 1;
    job.fence = None;
    job.worker = None;
    job.lease_until = None;
    crate::jobs::save(tx, &mut job, "source_sync_halted")?;
    Ok(job)
}

pub(crate) fn next(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    policy: crate::auth::AuthPolicy,
) -> Result<(Option<TargetCandidate>, i64)> {
    let mut job =
        crate::jobs::load(tx, lease.job_id())?.ok_or_else(|| anyhow!("Sync Job not found"))?;
    ensure!(job.kind == JobKind::Sync, "Attempt is not a Sync Job");
    ensure!(job.tenant == lease.tenant(), "Sync next tenant mismatch");
    if job.state == PersistentState::ReconciliationRequired || job.state.terminal() {
        return Ok((
            Some(TargetCandidate {
                key: SyncTargetKey {
                    job_id: job.job_id.clone(),
                    ordinal: 0,
                },
                source_id: -1,
            }),
            job.state_version,
        ));
    }
    ensure!(
        job.generation == lease.generation()
            && job.worker.as_deref() == Some(lease.worker())
            && job.fence.as_deref() == Some(lease.fence())
            && job.state == PersistentState::Running,
        "Sync next attempt mismatch"
    );
    if job.cancel_requested {
        let halted = halt_after_error(tx, lease, "cancelled", "Sync was cancelled")?
            .ok_or_else(|| anyhow!("Sync batch is not open"))?;
        return Ok((
            Some(TargetCandidate {
                key: SyncTargetKey {
                    job_id: job.job_id,
                    ordinal: 0,
                },
                source_id: -1,
            }),
            halted.state_version,
        ));
    }
    ensure!(job.state_version == lease.version(), "Stale attempt fence");
    if let Err(error) = crate::jobs::require_original_authority(tx, &job, policy) {
        let detail = format!("{error:#}");
        if !crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error)? {
            return Err(error);
        }
        let job_id = job.job_id.clone();
        let halted = halt_job(tx, job, "authority_refused", &detail)?;
        return Ok((
            Some(TargetCandidate {
                key: SyncTargetKey { job_id, ordinal: 0 },
                source_id: -1,
            }),
            halted.state_version,
        ));
    }
    let row: Option<(i64, i64, String, i64)> = tx
        .query_row(
            "SELECT ordinal,requested_source_id,state,reservation_acknowledged FROM source_sync_targets WHERE job_id=?1 AND NOT (state IN ('succeeded','failed') AND reservation_acknowledged=1) ORDER BY ordinal LIMIT 1",
            [&job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((ordinal, source_id, state, acknowledged)) = row else {
        return Ok((None, job.state_version));
    };
    if matches!(state.as_str(), "succeeded" | "failed") && acknowledged == 0 {
        return Ok((
            Some(TargetCandidate {
                key: SyncTargetKey {
                    job_id: job.job_id,
                    ordinal: u32::try_from(ordinal)?,
                },
                source_id: -2,
            }),
            job.state_version,
        ));
    }
    ensure!(
        state == "pending" && acknowledged == 0,
        "Prior Sync target is not pending"
    );
    let source: Option<(String, String)> = tx
        .query_row(
            "SELECT name,source_type FROM projects WHERE tenant_id=?1 AND id=?2",
            params![job.tenant, source_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match source {
        None => {
            tx.execute(
                "UPDATE source_sync_targets SET state='failed',failure_code='unavailable',failure_detail='Source not found',reservation_acknowledged=1,updated_at=?3 WHERE job_id=?1 AND ordinal=?2 AND state='pending'",
                params![job.job_id, ordinal, now()],
            )?;
            let job = update_progress(tx, job)?;
            Ok((
                Some(TargetCandidate {
                    key: SyncTargetKey {
                        job_id: lease.job_id().to_owned(),
                        ordinal: u32::try_from(ordinal)?,
                    },
                    source_id: 0,
                }),
                job.state_version,
            ))
        }
        Some((name, source_type)) if source_type != "local" => {
            tx.execute(
                "UPDATE source_sync_targets SET source_name=?3,state='failed',failure_code='unsupported_kind',failure_detail='Source kind is not supported by Local Sync',reservation_acknowledged=1,updated_at=?4 WHERE job_id=?1 AND ordinal=?2 AND state='pending'",
                params![job.job_id, ordinal, name, now()],
            )?;
            let job = update_progress(tx, job)?;
            Ok((
                Some(TargetCandidate {
                    key: SyncTargetKey {
                        job_id: lease.job_id().to_owned(),
                        ordinal: u32::try_from(ordinal)?,
                    },
                    source_id: 0,
                }),
                job.state_version,
            ))
        }
        Some(_) => Ok((
            Some(TargetCandidate {
                key: SyncTargetKey {
                    job_id: job.job_id,
                    ordinal: u32::try_from(ordinal)?,
                },
                source_id,
            }),
            job.state_version,
        )),
    }
}

fn require_proof(
    state: &State,
    proof: &SourceWorkProof,
    tenant: &str,
    source_id: i64,
) -> Result<()> {
    match state.classify_issued(&proof.incarnation, proof.token) {
        IssuedTokenState::Active(actual) => ensure!(
            actual
                == &SourceBinding {
                    tenant: tenant.to_owned(),
                    id: source_id
                },
            "Wrong Source reservation"
        ),
        IssuedTokenState::Retired => return Err(anyhow!("Source reservation already retired")),
        IssuedTokenState::NeverIssued => return Err(anyhow!("Never-issued Source reservation")),
        IssuedTokenState::WrongIncarnation => {
            return Err(anyhow!("Wrong Source writer incarnation"));
        }
    }
    Ok(())
}

pub(crate) fn bind(
    tx: &Transaction<'_>,
    state: &State,
    lease: &AttemptLease,
    key: &SyncTargetKey,
    proof: &SourceWorkProof,
    policy: crate::auth::AuthPolicy,
) -> Result<BoundTarget> {
    let job = require_sync_job(tx, lease)?;
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    ensure!(!job.cancel_requested, "Sync was cancelled");
    let authority = crate::jobs::require_original_authority(tx, &job, policy)?;
    let (source_id, source_name, state_name, prior_claim_generation): (i64, String, String, i64) = tx.query_row(
        "SELECT t.requested_source_id,p.name,t.state,t.claim_generation FROM source_sync_targets t JOIN projects p ON p.tenant_id=t.tenant AND p.id=t.requested_source_id WHERE t.job_id=?1 AND t.ordinal=?2",
        params![key.job_id, key.ordinal],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    ensure!(state_name == "pending", "Sync target is not pending");
    require_proof(state, proof, &job.tenant, source_id)?;
    let observation =
        crate::source_scan::project_observation(tx, &job.tenant, source_id, authority.subject())?;
    ensure!(
        tx.execute(
            "UPDATE source_sync_targets SET source_name=?3,state='claimed',claim_generation=claim_generation+1,parent_generation=?4,attempt_worker=?5,attempt_fence_digest=?6,reservation_incarnation=?7,reservation_token=?8,configuration_version=?9,authority_actor=?10,authority_basis_digest=?11,activation_observation_digest=?12,path_observation_digest=?13,updated_at=?14 WHERE job_id=?1 AND ordinal=?2 AND state='pending' AND claim_generation=?15",
            params![key.job_id, key.ordinal, source_name, job.generation, lease.worker(), digest(lease.fence()), proof.incarnation, token_text(proof.token)?, observation.configuration_version(), observation.authority_actor(), observation.authority_basis_digest(), observation.activation_observation_digest(), observation.path_observation_digest(), now(), prior_claim_generation],
        )? == 1,
        "Sync target claim changed"
    );
    Ok(BoundTarget {
        key: key.clone(),
        observation,
        claim_generation: prior_claim_generation + 1,
    })
}

fn claimed_target(
    tx: &Transaction<'_>,
    state: &State,
    lease: &AttemptLease,
    key: &SyncTargetKey,
    proof: &SourceWorkProof,
    claim_generation: i64,
) -> Result<(JobRecord, i64)> {
    let job = require_sync_job(tx, lease)?;
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    let (source_id, target_state, generation, worker, fence, incarnation, token, stored_claim_generation): (i64, String, i64, String, String, String, String, i64) = tx.query_row(
        "SELECT requested_source_id,state,parent_generation,attempt_worker,attempt_fence_digest,reservation_incarnation,reservation_token,claim_generation FROM source_sync_targets WHERE job_id=?1 AND ordinal=?2",
        params![key.job_id, key.ordinal],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
    )?;
    ensure!(target_state == "claimed", "Sync target is not claimed");
    ensure!(
        stored_claim_generation == claim_generation,
        "Sync target claim generation mismatch"
    );
    ensure!(
        generation == job.generation && worker == lease.worker() && fence == digest(lease.fence()),
        "Sync target attempt mismatch"
    );
    ensure!(
        incarnation == proof.incarnation && token == token_text(proof.token)?,
        "Sync target reservation mismatch"
    );
    require_proof(state, proof, &job.tenant, source_id)?;
    Ok((job, source_id))
}

pub(crate) fn settle(
    tx: &Transaction<'_>,
    state: &State,
    command: ClaimedSyncTargetCommand<'_>,
    settlement: LocalScanSettlement,
) -> Result<SyncCommandResult<SyncTargetInspection>> {
    let ClaimedSyncTargetCommand {
        lease,
        key,
        proof,
        claim_generation,
        policy,
    } = command;
    let (mut job, source_id) = claimed_target(tx, state, lease, key, proof, claim_generation)?;
    ensure!(!job.cancel_requested, "Sync was cancelled");
    let authority = match crate::jobs::require_original_authority(tx, &job, policy) {
        Ok(authority) => authority,
        Err(error) => {
            if crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error)? {
                let job = halt_job(
                    tx,
                    job,
                    "authority_refused",
                    "Original authority is no longer valid",
                )?;
                return Ok(SyncCommandResult::committed(
                    SyncTargetInspection::ReconciliationRequired,
                    job,
                ));
            }
            return Err(error);
        }
    };
    let captured: (i64, String, String, String, String) = tx.query_row(
        "SELECT configuration_version,authority_actor,authority_basis_digest,activation_observation_digest,path_observation_digest FROM source_sync_targets WHERE job_id=?1 AND ordinal=?2",
        params![key.job_id, key.ordinal],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    let observation = settlement.observation();
    ensure!(
        settlement.source_id() == source_id
            && observation.authority_actor() == authority.subject()
            && captured.0 == observation.configuration_version()
            && captured.1 == observation.authority_actor()
            && captured.2 == observation.authority_basis_digest()
            && captured.3 == observation.activation_observation_digest()
            && captured.4 == observation.path_observation_digest(),
        "Sync settlement observation mismatch"
    );
    let applied = crate::source_scan::apply_local_documents(tx, &job.tenant, settlement)?;
    let result = applied.local_source_scan_result()?;
    let result_json = serde_json::to_string(&result)?;
    let result_digest = digest(result_json.as_bytes());
    let receipt = applied.receipt();
    ensure!(
        tx.execute(
            "UPDATE source_sync_targets SET state='succeeded',result_json=?3,result_digest=?4,receipt_id=?5,receipt_hash=?6,receipt_target=?7,updated_at=?8 WHERE job_id=?1 AND ordinal=?2 AND state='claimed'",
            params![key.job_id, key.ordinal, result_json, result_digest, receipt.receipt_id, receipt.content_hash, receipt.target, now()],
        )? == 1,
        "Sync target settlement changed"
    );
    Ok(SyncCommandResult::committed(
        SyncTargetInspection::Succeeded(result),
        job,
    ))
}

pub(crate) fn fail(
    tx: &Transaction<'_>,
    state: &State,
    command: ClaimedSyncTargetCommand<'_>,
    detail: &str,
) -> Result<SyncCommandResult<SyncTargetInspection>> {
    let ClaimedSyncTargetCommand {
        lease,
        key,
        proof,
        claim_generation,
        policy,
    } = command;
    ensure!(
        !detail.is_empty() && detail.len() <= 1024,
        "Invalid Local Sync failure"
    );
    let (mut job, source_id) = claimed_target(tx, state, lease, key, proof, claim_generation)?;
    ensure!(!job.cancel_requested, "Sync was cancelled");
    let authority = match crate::jobs::require_original_authority(tx, &job, policy) {
        Ok(authority) => authority,
        Err(error) => {
            if crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error)? {
                let job = halt_job(
                    tx,
                    job,
                    "authority_refused",
                    "Original authority is no longer valid",
                )?;
                return Ok(SyncCommandResult::committed(
                    SyncTargetInspection::ReconciliationRequired,
                    job,
                ));
            }
            return Err(error);
        }
    };
    let captured: (i64, String, String, String, String) = tx.query_row(
        "SELECT configuration_version,authority_actor,authority_basis_digest,activation_observation_digest,path_observation_digest FROM source_sync_targets WHERE job_id=?1 AND ordinal=?2",
        params![key.job_id, key.ordinal],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    let current =
        crate::source_scan::project_observation(tx, &job.tenant, source_id, authority.subject())?;
    ensure!(
        captured.0 == current.configuration_version()
            && captured.1 == authority.subject()
            && captured.1 == current.authority_actor()
            && captured.2 == current.authority_basis_digest()
            && captured.3 == current.activation_observation_digest()
            && captured.4 == current.path_observation_digest(),
        "Local Source observation changed before recording failure"
    );
    crate::source_scan::mark_local_failure(tx, &job.tenant, source_id, detail)?;
    ensure!(
        tx.execute(
            "UPDATE source_sync_targets SET state='failed',failure_code='local_read',failure_detail=?3,updated_at=?4 WHERE job_id=?1 AND ordinal=?2 AND state='claimed'",
            params![key.job_id, key.ordinal, detail, now()],
        )? == 1,
        "Sync target failure changed"
    );
    let failure = failure(tx, key)?;
    Ok(SyncCommandResult::committed(
        SyncTargetInspection::Failed(failure),
        job,
    ))
}

fn failure(tx: &Transaction<'_>, key: &SyncTargetKey) -> Result<SourceSyncFailure> {
    tx.query_row(
        "SELECT requested_source_id,source_name,failure_detail FROM source_sync_targets WHERE job_id=?1 AND ordinal=?2 AND state='failed'",
        params![key.job_id, key.ordinal],
        |row| {
            let id: i64 = row.get(0)?;
            Ok(SourceSyncFailure {
                project_id: u64::try_from(id).ok(),
                name: row.get(1)?,
                error: row.get(2)?,
            })
        },
    ).map_err(Into::into)
}

pub(crate) fn acknowledge(
    tx: &Transaction<'_>,
    state: &mut State,
    command: ClaimedSyncTargetCommand<'_>,
    observation: &LocalScanObservation,
) -> Result<SyncCommandResult<SyncTargetInspection>> {
    let ClaimedSyncTargetCommand {
        lease,
        key,
        proof,
        claim_generation,
        policy,
    } = command;
    let mut job =
        crate::jobs::load(tx, lease.job_id())?.ok_or_else(|| anyhow!("Sync Job not found"))?;
    ensure!(job.kind == JobKind::Sync, "Attempt is not a Sync Job");
    ensure!(
        job.tenant == lease.tenant(),
        "Sync acknowledgement tenant mismatch"
    );
    ensure!(
        job.generation == lease.generation()
            && job.worker.as_deref() == Some(lease.worker())
            && job.fence.as_deref() == Some(lease.fence())
            && job.state == PersistentState::Running
            && job.lease_until.is_some_and(|until| until > now())
            && matches!(job.state_version.checked_sub(lease.version()), Some(0 | 1)),
        "Sync acknowledgement attempt mismatch"
    );
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    let authority = match crate::jobs::require_original_authority(tx, &job, policy) {
        Ok(authority) => authority,
        Err(error) => {
            if crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error)? {
                let job = halt_job(
                    tx,
                    job,
                    "authority_refused",
                    "Original authority is no longer valid",
                )?;
                return Ok(SyncCommandResult::committed(
                    SyncTargetInspection::ReconciliationRequired,
                    job,
                ));
            }
            return Err(error);
        }
    };
    let target = validate_target(tx, &job, key)?;
    if job.state_version == lease.version() + 1 {
        ensure!(
            target.acknowledged,
            "Sync acknowledgement retry did not follow acknowledgement"
        );
    }
    validate_observation(
        target
            .capture
            .as_ref()
            .ok_or_else(|| anyhow!("Settled Sync target lacks producer capture"))?,
        target.source_id,
        observation,
        authority.subject(),
    )?;
    acknowledge_job(tx, state, lease, job, target, proof, Some(claim_generation))
}

fn validate_observation(
    capture: &ProducerCapture,
    source_id: i64,
    observation: &LocalScanObservation,
    authority_subject: &str,
) -> Result<()> {
    ensure!(
        observation.source_id() == source_id
            && capture.configuration_version == observation.configuration_version()
            && capture.authority_actor == authority_subject
            && capture.authority_actor == observation.authority_actor()
            && capture.authority_basis_digest == observation.authority_basis_digest()
            && capture.activation_digest == observation.activation_observation_digest()
            && capture.path_digest == observation.path_observation_digest(),
        "Sync acknowledgement observation mismatch"
    );
    Ok(())
}

fn acknowledge_job(
    tx: &Transaction<'_>,
    state: &mut State,
    lease: &AttemptLease,
    job: JobRecord,
    target: ValidatedTarget,
    proof: &SourceWorkProof,
    expected_claim_generation: Option<i64>,
) -> Result<SyncCommandResult<SyncTargetInspection>> {
    let capture = target
        .capture
        .as_ref()
        .ok_or_else(|| anyhow!("Settled Sync target lacks producer capture"))?;
    let inspection = match target.outcome {
        ValidatedTargetOutcome::Succeeded { result, .. } => SyncTargetInspection::Succeeded(result),
        ValidatedTargetOutcome::Failed { failure, .. } => SyncTargetInspection::Failed(failure),
        _ => return Err(anyhow!("Sync target is not settled")),
    };
    if let Some(expected) = expected_claim_generation {
        ensure!(
            capture.claim_generation == expected,
            "Sync acknowledgement claim generation mismatch"
        );
    }
    ensure!(
        capture.parent_generation == job.generation
            && capture.worker == lease.worker()
            && capture.fence_digest == digest(lease.fence()),
        "Sync target attempt mismatch"
    );
    ensure!(
        capture.incarnation == proof.incarnation && capture.token == token_text(proof.token)?,
        "Sync target acknowledgement mismatch"
    );
    let binding = SourceBinding {
        tenant: job.tenant.clone(),
        id: target.source_id,
    };
    let (retire, conflict) = match state.classify_issued(&proof.incarnation, proof.token) {
        IssuedTokenState::Active(actual) if actual == &binding => (true, false),
        IssuedTokenState::Retired => (false, false),
        IssuedTokenState::Active(_)
        | IssuedTokenState::WrongIncarnation
        | IssuedTokenState::NeverIssued => (false, true),
    };
    if conflict {
        tx.execute(
            "UPDATE source_sync_targets SET state='reconciliation_required',failure_code='local_settlement',failure_detail='Source reservation incarnation cannot be verified',updated_at=?3 WHERE job_id=?1 AND ordinal=?2",
            params![job.job_id, target.ordinal, now()],
        )?;
        let job = halt_job(
            tx,
            job,
            "uncertain_target",
            "Inspect retained Source reservation evidence",
        )?;
        return Ok(SyncCommandResult::committed(
            SyncTargetInspection::ReconciliationRequired,
            job,
        ));
    }
    if retire {
        let _ = state.retire_issued(proof, &binding)?;
    }
    if target.acknowledged {
        return Ok(SyncCommandResult::read_only(inspection, job));
    }
    ensure!(
        tx.execute(
            "UPDATE source_sync_targets SET reservation_acknowledged=1,updated_at=?3 WHERE job_id=?1 AND ordinal=?2 AND reservation_acknowledged=0",
            params![job.job_id, target.ordinal, now()],
        )? == 1,
        "Sync target acknowledgement changed"
    );
    let job = update_progress(tx, job)?;
    Ok(SyncCommandResult::committed(inspection, job))
}

pub(crate) fn adopt(
    tx: &Transaction<'_>,
    state: &mut State,
    lease: &AttemptLease,
    key: &SyncTargetKey,
    policy: crate::auth::AuthPolicy,
) -> Result<SyncCommandResult<SyncTargetInspection>> {
    let mut job =
        crate::jobs::load(tx, lease.job_id())?.ok_or_else(|| anyhow!("Sync Job not found"))?;
    ensure!(job.kind == JobKind::Sync, "Attempt is not a Sync Job");
    ensure!(
        job.tenant == lease.tenant(),
        "Sync adoption tenant mismatch"
    );
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    ensure!(
        job.generation == lease.generation()
            && job.worker.as_deref() == Some(lease.worker())
            && job.fence.as_deref() == Some(lease.fence())
            && job.state == PersistentState::Running
            && job.lease_until.is_some_and(|until| until > now()),
        "Sync adoption attempt mismatch"
    );
    ensure!(
        matches!(job.state_version.checked_sub(lease.version()), Some(0 | 1)),
        "Sync adoption version mismatch"
    );
    let target = validate_target(tx, &job, key)?;
    if job.state_version == lease.version() + 1 {
        ensure!(
            target.acknowledged,
            "Sync adoption retry did not follow acknowledgement"
        );
    }
    let authority = match crate::jobs::require_original_authority(tx, &job, policy) {
        Ok(authority) => authority,
        Err(error) => {
            if crate::jobs::set_sync_source_writer_authority_refusal(&mut job, &error)? {
                let job = halt_job(
                    tx,
                    job,
                    "authority_refused",
                    "Original authority is no longer valid",
                )?;
                return Ok(SyncCommandResult::committed(
                    SyncTargetInspection::ReconciliationRequired,
                    job,
                ));
            }
            return Err(error);
        }
    };
    let capture = target
        .capture
        .as_ref()
        .ok_or_else(|| anyhow!("Sync adoption producer capture missing"))?;
    let current = crate::source_scan::project_observation(
        tx,
        &job.tenant,
        target.source_id,
        authority.subject(),
    )?;
    validate_observation(capture, target.source_id, &current, authority.subject())?;
    let proof = SourceWorkProof {
        incarnation: capture.incarnation.clone(),
        token: u64::from_str_radix(&capture.token, 16)?,
    };
    acknowledge_job(tx, state, lease, job, target, &proof, None)
}

pub(crate) fn inspect(
    tx: &Transaction<'_>,
    _state: &State,
    lease: &AttemptLease,
    key: &SyncTargetKey,
    policy: crate::auth::AuthPolicy,
) -> Result<SyncTargetInspection> {
    let job = require_sync_job(tx, lease)?;
    ensure!(key.job_id == job.job_id, "Sync target Job mismatch");
    crate::jobs::require_original_authority(tx, &job, policy)?;
    let target = validate_target(tx, &job, key)?;
    if matches!(
        &target.outcome,
        ValidatedTargetOutcome::Succeeded { .. } | ValidatedTargetOutcome::Failed { .. }
    ) && !target.acknowledged
    {
        return Ok(SyncTargetInspection::ReconciliationRequired);
    }
    match target.outcome {
        ValidatedTargetOutcome::Pending | ValidatedTargetOutcome::Claimed => {
            Ok(SyncTargetInspection::Pending)
        }
        ValidatedTargetOutcome::Succeeded { result, .. } => {
            Ok(SyncTargetInspection::Succeeded(result))
        }
        ValidatedTargetOutcome::Failed { failure, .. } => Ok(SyncTargetInspection::Failed(failure)),
        ValidatedTargetOutcome::NotRun => Ok(SyncTargetInspection::Halted),
        ValidatedTargetOutcome::ReconciliationRequired { .. } => {
            Ok(SyncTargetInspection::ReconciliationRequired)
        }
    }
}

pub(crate) fn inspect_retained(
    tx: &Transaction<'_>,
    access: &AuthorizedSyncRead,
) -> Result<SyncRecoveryInspection> {
    let job = access.job();
    let source_ids = validate_basis(tx, job)?;
    let batch_phase: String = tx.query_row(
        "SELECT phase FROM source_sync_batches WHERE job_id=?1 AND tenant=?2",
        params![job.job_id, job.tenant],
        |row| row.get(0),
    )?;
    ensure!(
        matches!(
            (job.state, batch_phase.as_str()),
            (PersistentState::Succeeded, "completed")
                | (PersistentState::Failed, "failed" | "halted")
                | (PersistentState::Cancelled, "halted")
                | (
                    PersistentState::ReconciliationRequired,
                    "reconciliation_required"
                )
        ),
        "Sync recovery batch phase mismatch"
    );
    let mut targets = Vec::with_capacity(source_ids.len());
    for ordinal in 0..source_ids.len() {
        let target = validate_target_in_basis(
            tx,
            job,
            &SyncTargetKey {
                job_id: job.job_id.clone(),
                ordinal: u32::try_from(ordinal)?,
            },
            &source_ids,
        )?;
        if let (Some(expected), Some(capture)) =
            (access.original_subject(), target.capture.as_ref())
        {
            ensure!(
                expected == capture.authority_actor,
                "Sync recovery authority capture mismatch"
            );
        }
        let (disposition, result) = match target.outcome {
            ValidatedTargetOutcome::Pending => (SyncRecoveryDisposition::Pending, None),
            ValidatedTargetOutcome::Claimed => (SyncRecoveryDisposition::Claimed, None),
            ValidatedTargetOutcome::Succeeded { result, .. } => {
                (SyncRecoveryDisposition::Succeeded, Some(result))
            }
            ValidatedTargetOutcome::Failed { .. } => (SyncRecoveryDisposition::Failed, None),
            ValidatedTargetOutcome::NotRun => (SyncRecoveryDisposition::NotRun, None),
            ValidatedTargetOutcome::ReconciliationRequired { result } => {
                (SyncRecoveryDisposition::ReconciliationRequired, result)
            }
        };
        targets.push(SyncRecoveryTarget {
            ordinal: target.ordinal,
            requested_source_id: u64::try_from(target.source_id)?,
            disposition,
            failure: target.failure_detail,
            result,
            acknowledged: target.acknowledged,
        });
    }
    let state = match job.state {
        PersistentState::Succeeded => SyncRecoveryState::Completed,
        PersistentState::Failed => SyncRecoveryState::Failed,
        PersistentState::Cancelled => SyncRecoveryState::Cancelled,
        PersistentState::ReconciliationRequired => SyncRecoveryState::ReconciliationRequired,
        _ => return Err(anyhow!("Sync recovery Job is not retained")),
    };
    Ok(SyncRecoveryInspection {
        job_id: job.job_id.clone(),
        version: job.state_version,
        state,
        targets,
        original_authority: access.original_authority,
    })
}

fn validated_terminal_aggregate(tx: &Transaction<'_>, job: &JobRecord) -> Result<SourceSyncResult> {
    let source_ids = validate_basis(tx, job)?;
    let mut results = Vec::new();
    let mut failures = Vec::new();
    for ordinal in 0..source_ids.len() {
        let target = validate_target_in_basis(
            tx,
            job,
            &SyncTargetKey {
                job_id: job.job_id.clone(),
                ordinal: u32::try_from(ordinal)?,
            },
            &source_ids,
        )?;
        ensure!(target.acknowledged, "Sync target is not acknowledged");
        match target.outcome {
            ValidatedTargetOutcome::Succeeded { result, .. } => results.push(result),
            ValidatedTargetOutcome::Failed { failure, code } => {
                ensure!(
                    matches!(
                        code.as_str(),
                        "unavailable" | "unsupported_kind" | "local_read"
                    ),
                    "Sync terminal failure requires reconciliation"
                );
                failures.push(failure);
            }
            _ => return Err(anyhow!("Sync target is not terminal")),
        }
    }
    Ok(SourceSyncResult {
        synced: u64::try_from(results.len())?,
        failed: u64::try_from(failures.len())?,
        results,
        failures,
    })
}

pub(crate) fn finish(
    tx: &Transaction<'_>,
    lease: &AttemptLease,
    policy: crate::auth::AuthPolicy,
) -> Result<SyncCommandResult<SourceSyncResult>> {
    let loaded =
        crate::jobs::load(tx, lease.job_id())?.ok_or_else(|| anyhow!("Sync Job not found"))?;
    ensure!(loaded.kind == JobKind::Sync, "Attempt is not a Sync Job");
    ensure!(
        loaded.tenant == lease.tenant(),
        "Sync finish tenant mismatch"
    );
    if loaded.state == PersistentState::ReconciliationRequired {
        return Err(anyhow!("Inspect retained Sync recovery evidence"));
    }
    if loaded.state.terminal() {
        ensure!(
            loaded.generation == lease.generation(),
            "Sync finish generation mismatch"
        );
        ensure!(
            loaded.state_version == lease.version() + 1,
            "Sync finish retry version mismatch"
        );
        crate::jobs::require_original_authority(tx, &loaded, policy)?;
        let (phase, aggregate_json, aggregate_digest): (String, String, String) = tx.query_row(
            "SELECT phase,aggregate_json,aggregate_digest FROM source_sync_batches WHERE job_id=?1 AND tenant=?2",
            params![loaded.job_id, loaded.tenant],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        ensure!(
            matches!(phase.as_str(), "completed" | "failed"),
            "Sync finish retry batch mismatch"
        );
        let stored_aggregate: SourceSyncResult = serde_json::from_str(&aggregate_json)?;
        let canonical_aggregate = serde_json::to_string(&stored_aggregate)?;
        ensure!(
            aggregate_json == canonical_aggregate,
            "Sync finish retry aggregate is not canonical"
        );
        ensure!(
            digest(canonical_aggregate.as_bytes()) == aggregate_digest,
            "Sync finish retry aggregate mismatch"
        );
        let aggregate = validated_terminal_aggregate(tx, &loaded)?;
        ensure!(
            aggregate == stored_aggregate,
            "Sync finish retry target aggregate mismatch"
        );
        if aggregate.synced == 0 && aggregate.failed > 0 {
            ensure!(
                loaded.state == PersistentState::Failed && loaded.public_result.is_none(),
                "Sync finish retry failed aggregate mismatch"
            );
        } else {
            ensure!(
                matches!(&loaded.public_result, Some(CompletedResult::SourceSync(value)) if value == &aggregate),
                "Sync finish retry public result mismatch"
            );
        }
        return Ok(SyncCommandResult::read_only(aggregate, loaded));
    }
    let mut job = require_sync_job(tx, lease)?;
    ensure!(!job.cancel_requested, "Sync was cancelled");
    ensure!(job.effects.is_empty(), "Sync has generic effect evidence");
    crate::jobs::require_original_authority(tx, &job, policy)?;
    let (batch_tenant, selection_kind, target_basis_digest, target_count, batch_phase): (
        String,
        String,
        String,
        i64,
        String,
    ) = tx.query_row(
        "SELECT tenant,selection_kind,target_basis_digest,target_count,phase FROM source_sync_batches WHERE job_id=?1",
        [&job.job_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    ensure!(batch_tenant == job.tenant, "Sync batch tenant mismatch");
    ensure!(batch_phase == "open", "Sync batch is not open");
    let aggregate = validated_terminal_aggregate(tx, &job)?;
    let aggregate_json = serde_json::to_string(&aggregate)?;
    let aggregate_digest = digest(aggregate_json.as_bytes());
    let all_failed = aggregate.synced == 0 && aggregate.failed > 0;
    job.progress = Some(100);
    job.result = None;
    if all_failed {
        job.state = PersistentState::Failed;
        job.public_result = None;
        let joined = aggregate
            .failures
            .iter()
            .map(|failure| {
                format!(
                    "{}: {}",
                    failure
                        .project_id
                        .map_or_else(|| "unknown".into(), |id| id.to_string()),
                    failure.error
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        job.recovery = Some(joined.chars().take(1024).collect());
    } else {
        job.state = PersistentState::Succeeded;
        job.public_result = Some(CompletedResult::SourceSync(aggregate.clone()));
        job.recovery = None;
    }
    ensure!(
        tx.execute(
            "UPDATE source_sync_batches SET phase=?2,aggregate_json=?3,aggregate_digest=?4,updated_at=?5 WHERE job_id=?1 AND phase='open' AND tenant=?6 AND selection_kind=?7 AND target_basis_digest=?8 AND target_count=?9",
            params![job.job_id, if all_failed { "failed" } else { "completed" }, aggregate_json, aggregate_digest, now(), job.tenant, selection_kind, target_basis_digest, target_count],
        )? == 1,
        "Sync batch terminal update changed"
    );
    crate::jobs::save(
        tx,
        &mut job,
        if all_failed {
            "source_sync_failed"
        } else {
            "source_sync_completed"
        },
    )?;
    Ok(SyncCommandResult::committed(aggregate, job))
}

pub(crate) fn validate_schema(connection: &Connection, version: u64) -> Result<()> {
    let objects = |connection: &Connection| -> Result<Vec<(String, Option<String>)>> {
        Ok(connection
            .prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'source_sync_%' OR name LIKE 'sqlite_autoindex_source_sync_%' ORDER BY name")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    };
    let actual = objects(connection)?;
    if version < 42 {
        ensure!(actual.is_empty(), "Unexpected Source Sync schema");
        return Ok(());
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE durable_jobs(id TEXT PRIMARY KEY); CREATE TABLE projects(id INTEGER PRIMARY KEY);")?;
    expected.execute_batch(include_str!("source_sync/schema.sql"))?;
    ensure!(actual == objects(&expected)?, "Source Sync schema mismatch");
    Ok(())
}
