use crate::{
    catalog::{IssuedTokenState, SourceBinding, SourceWorkProof, State},
    jobs::{
        AttemptLease, EffectIntent, EffectOperation, EffectReceipt, JobRecord, Payload,
        ResultArtifact, SourceScanResult,
    },
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

const PRODUCER_VERSION: &str = "local-import-scan-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalDocumentKind {
    Readme,
    Markdown,
    Pdf,
}

impl LocalDocumentKind {
    fn stored(&self) -> &'static str {
        match self {
            Self::Readme => "readme",
            Self::Markdown => "md",
            Self::Pdf => "pdf",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalDocumentRecord {
    pub relative_path: String,
    pub kind: LocalDocumentKind,
    pub size_bytes: u64,
    pub content_sha256: String,
}

#[derive(Clone, Debug)]
pub struct LocalScanObservation {
    source_id: i64,
    local_path: Option<String>,
    configuration_version: i64,
    authority_actor: String,
    authority_basis_digest: String,
    activation_observation_digest: String,
    path_observation_digest: String,
}

impl LocalScanObservation {
    pub fn source_id(&self) -> i64 {
        self.source_id
    }

    pub fn local_path(&self) -> Option<&str> {
        self.local_path.as_deref()
    }

    pub fn settlement(self, documents: Vec<LocalDocumentRecord>) -> LocalScanSettlement {
        LocalScanSettlement {
            observation: self,
            documents,
        }
    }
}

pub struct LocalScanSettlement {
    observation: LocalScanObservation,
    documents: Vec<LocalDocumentRecord>,
}

#[derive(Clone, Debug)]
pub struct LocalScanApplied {
    source_id: i64,
    receipt: ResultArtifact,
    inventory_digest: String,
    index_digest: String,
    doc_count: u64,
}

impl LocalScanApplied {
    pub fn local_source_scan_result(&self) -> Result<SourceScanResult> {
        Ok(SourceScanResult {
            project_id: Some(u64::try_from(self.source_id)?),
            stl_count: 0,
            downloaded: 0,
            doc_count: self.doc_count,
            docs_downloaded: 0,
            pdf_extract_job_id: None,
            postprocess_warning: None,
        })
    }
}

fn digest_bytes(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains(['\\', '\0', ':'])
        && !value.starts_with('/')
        && value.split('/').count() <= 64
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn token_text(token: u64) -> Result<String> {
    ensure!(token != 0, "Invalid Source reservation token");
    Ok(format!("{token:016x}"))
}

fn scan_source(job: &JobRecord) -> Result<i64> {
    let Payload::ImportScan { project_id } = job.payload else {
        return Err(anyhow!("Attempt is not an ImportScan"));
    };
    i64::try_from(project_id).map_err(Into::into)
}

fn expected_binding(job: &JobRecord) -> Result<SourceBinding> {
    Ok(SourceBinding {
        tenant: job.tenant.clone(),
        id: scan_source(job)?,
    })
}

fn require_live_reservation(
    state: &State,
    proof: &SourceWorkProof,
    expected: &SourceBinding,
) -> Result<()> {
    match state.classify_issued(&proof.incarnation, proof.token) {
        IssuedTokenState::Active(actual) => ensure!(actual == expected, "Wrong Source reservation"),
        IssuedTokenState::Retired => return Err(anyhow!("Source reservation already retired")),
        IssuedTokenState::NeverIssued => return Err(anyhow!("Never-issued Source reservation")),
        IssuedTokenState::WrongIncarnation => {
            return Err(anyhow!("Wrong Source writer incarnation"));
        }
    }
    Ok(())
}

pub(crate) fn project_observation(
    tx: &Transaction<'_>,
    tenant: &str,
    source_id: i64,
    actor: &str,
) -> Result<LocalScanObservation> {
    let (source_type, local_path, configuration_version, source_kind, current_revision): (
        String,
        Option<String>,
        i64,
        String,
        Option<i64>,
    ) = tx.query_row(
        "SELECT source_type,local_path,source_configuration_version,source_kind,current_source_revision_id FROM projects WHERE tenant_id=?1 AND id=?2",
        params![tenant, source_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )?;
    ensure!(source_type == "local", "ImportScan requires a Local Source");
    ensure!(
        configuration_version > 0,
        "Invalid Source configuration version"
    );
    let authority_basis_digest = digest_bytes(serde_json::to_vec(&(tenant, actor))?);
    let activation_observation_digest = digest_bytes(serde_json::to_vec(&(
        source_id,
        configuration_version,
        source_type,
        source_kind,
        current_revision,
    ))?);
    let path_observation_digest = digest_bytes(serde_json::to_vec(&local_path)?);
    Ok(LocalScanObservation {
        source_id,
        local_path,
        configuration_version,
        authority_actor: actor.to_owned(),
        authority_basis_digest,
        activation_observation_digest,
        path_observation_digest,
    })
}

fn mark_source_synced(
    tx: &Transaction<'_>,
    tenant: &str,
    source_id: i64,
    configuration_version: i64,
    local_path: Option<&str>,
    synced_at: &str,
) -> Result<()> {
    let raw: Option<String> = tx.query_row(
        "SELECT metadata_json FROM projects WHERE tenant_id=?1 AND id=?2",
        params![tenant, source_id],
        |row| row.get(0),
    )?;
    let metadata = raw
        .map(|raw| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw))
        .transpose()?
        .map(|mut metadata| {
            metadata.remove("sync_error");
            metadata.remove("sync_required");
            serde_json::to_string(&metadata)
        })
        .transpose()?;
    ensure!(
        tx.execute(
            "UPDATE projects SET last_synced_at=?3,metadata_json=?4 WHERE tenant_id=?1 AND id=?2 AND source_configuration_version=?5 AND local_path IS ?6",
            params![tenant, source_id, synced_at, metadata, configuration_version, local_path],
        )? == 1,
        "Local Source changed while marking it synced"
    );
    Ok(())
}

pub(crate) fn observe(
    tx: &Transaction<'_>,
    state: &State,
    lease: &AttemptLease,
    proof: &SourceWorkProof,
    policy: crate::auth::AuthPolicy,
) -> Result<LocalScanObservation> {
    let job = crate::jobs::claimed_job(tx, lease)?;
    ensure!(!job.cancel_requested, "ImportScan was cancelled");
    let authority = crate::jobs::require_original_authority(tx, &job, policy)?;
    let binding = expected_binding(&job)?;
    require_live_reservation(state, proof, &binding)?;
    let observation = project_observation(tx, &job.tenant, binding.id, authority.subject())?;
    let fence_digest = digest_bytes(lease.fence());
    tx.execute(
        "INSERT INTO source_scan_executions(job_id,generation,tenant,attempt_worker,attempt_fence_digest,source_id,reservation_incarnation,reservation_token,configuration_version,authority_actor,authority_basis_digest,activation_observation_digest,path_observation_digest,producer_version,phase,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'observed',?15)",
        params![
            job.job_id,
            job.generation,
            job.tenant,
            lease.worker(),
            fence_digest,
            binding.id,
            proof.incarnation,
            token_text(proof.token)?,
            observation.configuration_version,
            observation.authority_actor,
            observation.authority_basis_digest,
            observation.activation_observation_digest,
            observation.path_observation_digest,
            PRODUCER_VERSION,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        ],
    )?;
    Ok(observation)
}

fn validate_documents(documents: &[LocalDocumentRecord]) -> Result<()> {
    ensure!(documents.len() <= 10_000, "Too many Local documents");
    let mut previous: Option<&str> = None;
    for document in documents {
        ensure!(
            valid_path(&document.relative_path),
            "Invalid Local document path"
        );
        ensure!(
            valid_digest(&document.content_sha256),
            "Invalid Local document digest"
        );
        ensure!(
            previous.is_none_or(|path| {
                path.encode_utf16()
                    .cmp(document.relative_path.encode_utf16())
                    == Ordering::Less
            }),
            "Local documents are not canonically ordered"
        );
        previous = Some(&document.relative_path);
    }
    Ok(())
}

fn inventory_digest(documents: &[LocalDocumentRecord]) -> Result<String> {
    let mut hash = Sha256::new();
    for document in documents {
        hash.update(serde_json::to_vec(document)?);
        hash.update(b"\n");
    }
    Ok(hex::encode(hash.finalize()))
}

fn index_digest(documents: &[LocalDocumentRecord]) -> Result<String> {
    let mut hash = Sha256::new();
    for document in documents {
        hash.update(serde_json::to_vec(&(
            &document.relative_path,
            document.kind.stored(),
            document.size_bytes,
            &document.content_sha256,
            if document.kind == LocalDocumentKind::Pdf {
                "pending"
            } else {
                "na"
            },
            Option::<i64>::None,
            Option::<String>::None,
            Option::<String>::None,
        ))?);
        hash.update(b"\n");
    }
    Ok(hex::encode(hash.finalize()))
}

pub(crate) fn apply_local_documents(
    tx: &Transaction<'_>,
    tenant: &str,
    settlement: LocalScanSettlement,
) -> Result<LocalScanApplied> {
    validate_documents(&settlement.documents)?;
    let current = project_observation(
        tx,
        tenant,
        settlement.observation.source_id,
        &settlement.observation.authority_actor,
    )?;
    ensure!(
        current.source_id == settlement.observation.source_id
            && current.local_path == settlement.observation.local_path
            && current.configuration_version == settlement.observation.configuration_version
            && current.authority_actor == settlement.observation.authority_actor
            && current.authority_basis_digest == settlement.observation.authority_basis_digest
            && current.activation_observation_digest
                == settlement.observation.activation_observation_digest
            && current.path_observation_digest == settlement.observation.path_observation_digest,
        "Local Source observation changed"
    );
    let inventory_digest = inventory_digest(&settlement.documents)?;
    let index_digest = index_digest(&settlement.documents)?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    tx.execute(
        "DELETE FROM source_docs WHERE tenant_id=?1 AND project_id=?2",
        params![tenant, current.source_id],
    )?;
    for document in &settlement.documents {
        tx.execute(
            "INSERT INTO source_docs(tenant_id,project_id,path,kind,size_bytes,content_hash,extract_status,extract_error,page_count,updated_at,source_revision_id,input_digest,producer_version)
             VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,NULL,?8,NULL,NULL,NULL)",
            params![
                tenant,
                current.source_id,
                document.relative_path,
                document.kind.stored(),
                i64::try_from(document.size_bytes)?,
                document.content_sha256,
                if document.kind == LocalDocumentKind::Pdf { "pending" } else { "na" },
                now.to_string(),
            ],
        )?;
    }
    mark_source_synced(
        tx,
        tenant,
        current.source_id,
        current.configuration_version,
        current.local_path.as_deref(),
        &now.to_string(),
    )?;
    let target = format!("source:{}", current.source_id);
    let receipt = ResultArtifact {
        receipt_id: format!("local-scan-{}", hex::encode(rand::random::<[u8; 16]>())),
        content_hash: index_digest.clone(),
        target,
    };
    Ok(LocalScanApplied {
        source_id: current.source_id,
        receipt,
        inventory_digest,
        index_digest,
        doc_count: settlement.documents.len() as u64,
    })
}

pub(crate) fn settle(
    tx: &Transaction<'_>,
    state: &State,
    lease: &AttemptLease,
    proof: &SourceWorkProof,
    policy: crate::auth::AuthPolicy,
    settlement: LocalScanSettlement,
) -> Result<(JobRecord, LocalScanApplied)> {
    let mut job = crate::jobs::claimed_job(tx, lease)?;
    ensure!(!job.cancel_requested, "ImportScan was cancelled");
    let authority = crate::jobs::require_original_authority(tx, &job, policy)?;
    let binding = expected_binding(&job)?;
    require_live_reservation(state, proof, &binding)?;
    ensure!(
        settlement.observation.source_id == binding.id,
        "Local scan settlement Source mismatch"
    );
    ensure!(
        settlement.observation.authority_actor == authority.subject(),
        "Local Source authority changed"
    );
    let basis_hash = settlement.observation.activation_observation_digest.clone();
    let phase: String = tx.query_row(
        "SELECT phase FROM source_scan_executions WHERE job_id=?1 AND generation=?2 AND attempt_worker=?3 AND attempt_fence_digest=?4",
        params![job.job_id, job.generation, lease.worker(), digest_bytes(lease.fence())],
        |row| row.get(0),
    )?;
    ensure!(phase == "observed", "Local scan is not observed");
    let applied = apply_local_documents(tx, &job.tenant, settlement)?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    job.effects.push(EffectReceipt {
        intent: EffectIntent {
            operation: EffectOperation::SourceRefresh,
            basis_hash,
            content_hash: applied.index_digest.clone(),
            target: applied.receipt.target.clone(),
        },
        attempt: job.attempt,
        generation: job.generation,
        confirmed: true,
        no_effect: false,
        receipt: Some(applied.receipt.clone()),
        checklist_completion: None,
    });
    crate::jobs::save(tx, &mut job, "local_scan_settled")?;
    tx.execute(
        "UPDATE source_scan_executions SET phase='local_settled',effect_applied=1,inventory_digest=?3,index_digest=?4,receipt_id=?5,receipt_hash=?6,receipt_target=?7,updated_at=?8 WHERE job_id=?1 AND generation=?2 AND phase='observed'",
        params![job.job_id, job.generation, applied.inventory_digest, applied.index_digest, applied.receipt.receipt_id, applied.receipt.content_hash, applied.receipt.target, now],
    )?;
    Ok((job, applied))
}

#[cfg(test)]
mod tests;
