use super::{
    ChecklistHtmlResult, CompletedResult, ExportBasis,
    model::{
        EffectOperation, EffectOutcome, EffectReceipt, JobKind, JobRecord, Payload,
        PersistentState, digest, id, text,
    },
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChecklistCompletionClaim {
    version: u8,
    attempt: i64,
    generation: i64,
    tenant_binding: String,
    capture: ChecklistCaptureSeal,
    content_sha256: String,
    tenant_relative_target: String,
    result: ChecklistHtmlResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChecklistCaptureSeal {
    capture_id: String,
    accepted_basis: Option<ExportBasis>,
}

pub(super) fn validate_claims(job: &JobRecord) -> Result<()> {
    let claimed = job
        .effects
        .iter()
        .filter(|effect| effect.checklist_completion.is_some())
        .count();
    ensure!(claimed <= 1, "Multiple checklist completion claims");
    for effect in &job.effects {
        if let Some(claim) = &effect.checklist_completion {
            validate_claim(job, effect, claim)?;
        }
    }
    Ok(())
}

fn validate_claim(
    job: &JobRecord,
    effect: &EffectReceipt,
    claim: &ChecklistCompletionClaim,
) -> Result<()> {
    let Payload::ExportChecklistHtml { profile_id } = &job.payload else {
        return Err(anyhow::anyhow!(
            "Checklist claim requires checklist payload"
        ));
    };
    ensure!(
        job.kind == JobKind::ExportChecklistHtml && claim.version == 1,
        "Invalid checklist claim version or kind"
    );
    ensure!(
        effect.intent.operation == EffectOperation::LocalArtifact
            && effect.attempt > 0
            && effect.generation > 0
            && claim.attempt == effect.attempt
            && claim.generation == effect.generation,
        "Checklist claim effect coordinates mismatch"
    );
    ensure!(
        claim.tenant_binding == tenant_binding(&job.tenant),
        "Checklist claim tenant mismatch"
    );
    text(&claim.capture.capture_id, 128)?;
    digest(&claim.content_sha256)?;
    validate_target(&claim.tenant_relative_target)?;
    ensure!(
        claim.capture.capture_id == effect.intent.basis_hash
            && claim.content_sha256 == effect.intent.content_hash
            && claim.tenant_relative_target == effect.intent.target
            && claim.result.path == claim.tenant_relative_target
            && claim.result.download_url.is_none(),
        "Checklist claim intent or result mismatch"
    );
    match &claim.capture.accepted_basis {
        Some(basis) => {
            ensure!(
                basis.profile_id == *profile_id
                    && claim.result.plan_version == Some(basis.plan_version)
                    && claim.result.revision_id == Some(basis.plan_revision_id),
                "Checklist Ready basis mismatch"
            );
            id(basis.plan_version)?;
            id(basis.plan_revision_id)?;
            digest(&basis.plan_revision_digest)?;
            digest(&basis.required_unit_mapping_digest)?;
        }
        None => ensure!(
            claim.result.plan_version.is_none()
                && claim.result.revision_id.is_none()
                && claim.result.part_count == 0
                && claim.result.thumb_count == 0,
            "Checklist Empty basis mismatch"
        ),
    }
    if let Some(receipt) = &effect.receipt {
        ensure!(
            receipt.content_hash == claim.content_sha256
                && receipt.target == claim.tenant_relative_target,
            "Checklist claim receipt mismatch"
        );
    }
    if job.state == PersistentState::Succeeded {
        let EffectOutcome::Confirmed(receipt) = effect.outcome()? else {
            return Err(anyhow::anyhow!(
                "Succeeded checklist claim requires confirmed receipt"
            ));
        };
        ensure!(
            job.result.as_ref() == Some(receipt)
                && job.public_result.as_ref()
                    == Some(&CompletedResult::ChecklistHtml(claim.result.clone())),
            "Succeeded checklist result mismatch"
        );
    }
    Ok(())
}

fn tenant_binding(tenant: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"printpartner:checklist-completion-tenant:v1\0");
    hash.update(tenant.as_bytes());
    hex::encode(hash.finalize())
}

fn validate_target(target: &str) -> Result<()> {
    text(target, 1024)?;
    ensure!(
        !target.starts_with('/')
            && !target.contains('\\')
            && target
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "Invalid checklist tenant-relative target"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::model::{AuthorityDisposition, ResultArtifact};

    const LEGACY_CHECKLIST_DOCUMENT: &str = r#"{"job_id":"legacy-checklist","tenant":"default","kind":"export-checklist-html","payload_version":1,"payload":{"kind":"export-checklist-html","payload":{"profile_id":7}},"state":"succeeded","state_version":3,"attempt":1,"generation":1,"lease_until":null,"created_at":1,"updated_at":3,"finished_at":3,"cancel_requested":false,"progress":100,"effects":[{"intent":{"operation":"local_artifact","basis_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target":"checklists/7/legacy.html"},"attempt":1,"generation":1,"confirmed":true,"receipt":{"receipt_id":"legacy-receipt","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target":"checklists/7/legacy.html"}}],"result":{"receipt_id":"legacy-receipt","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target":"checklists/7/legacy.html"},"public_result":{"path":"checklists/7/legacy.html","download_url":null,"part_count":4,"thumb_count":2},"recovery":null,"_attempt_worker":null,"_attempt_fence":null}"#;
    const LEGACY_UNRELATED_EFFECT_DOCUMENT: &str = r#"{"job_id":"legacy-kit","tenant":"default","kind":"export-kit-bundle","payload_version":1,"payload":{"kind":"export-kit-bundle","payload":{"profile_id":7,"include_print_progress":false}},"state":"effect_admitted","state_version":2,"attempt":1,"generation":1,"lease_until":100,"created_at":1,"updated_at":2,"finished_at":null,"cancel_requested":false,"progress":null,"effects":[{"intent":{"operation":"local_artifact","basis_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","content_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","target":"exports/legacy-kit.zip"},"attempt":1,"generation":1,"confirmed":false,"receipt":null}],"result":null,"recovery":null,"_attempt_worker":"legacy-worker","_attempt_fence":"legacy-fence"}"#;

    fn basis() -> ExportBasis {
        ExportBasis {
            profile_id: 7,
            plan_version: 11,
            plan_revision_id: 13,
            plan_revision_digest: "d".repeat(64),
            required_unit_mapping_digest: "e".repeat(64),
        }
    }

    fn claimed_job(accepted_basis: Option<ExportBasis>) -> JobRecord {
        let content = "b".repeat(64);
        let capture_id = "a".repeat(64);
        let target = format!("checklists/7/{content}.html");
        let result = ChecklistHtmlResult {
            path: target.clone(),
            download_url: None,
            part_count: if accepted_basis.is_some() { 4 } else { 0 },
            thumb_count: if accepted_basis.is_some() { 2 } else { 0 },
            plan_version: accepted_basis.as_ref().map(|value| value.plan_version),
            revision_id: accepted_basis.as_ref().map(|value| value.plan_revision_id),
        };
        JobRecord {
            job_id: "checklist-claim".into(),
            tenant: "tenant-a".into(),
            kind: JobKind::ExportChecklistHtml,
            payload_version: 1,
            payload: Payload::ExportChecklistHtml { profile_id: 7 },
            state: PersistentState::EffectAdmitted,
            state_version: 2,
            attempt: 1,
            generation: 1,
            lease_until: Some(100),
            created_at: 1,
            updated_at: 2,
            finished_at: None,
            cancel_requested: false,
            progress: None,
            effects: vec![EffectReceipt {
                intent: super::super::EffectIntent {
                    operation: EffectOperation::LocalArtifact,
                    basis_hash: capture_id.clone(),
                    content_hash: content.clone(),
                    target: target.clone(),
                },
                attempt: 1,
                generation: 1,
                confirmed: false,
                no_effect: false,
                receipt: None,
                checklist_completion: Some(Box::new(ChecklistCompletionClaim {
                    version: 1,
                    attempt: 1,
                    generation: 1,
                    tenant_binding:
                        "e6af687dc0430653124c67740afc9f0f6ea2a32dd24fe328f2680145a08ee5d4".into(),
                    capture: ChecklistCaptureSeal {
                        capture_id,
                        accepted_basis,
                    },
                    content_sha256: content,
                    tenant_relative_target: target,
                    result,
                })),
            }],
            result: None,
            public_result: None,
            recovery: None,
            authority: None,
            authority_disposition: AuthorityDisposition::PhysicalOwner,
            authority_refusal: None,
            fence: Some("fence".into()),
            worker: Some("worker".into()),
        }
    }

    fn decode_result(job: &JobRecord) -> Result<JobRecord> {
        super::super::decode(&super::super::encode(job)?)
    }

    #[test]
    fn historical_documents_omit_the_claim_field_and_round_trip() {
        for document in [LEGACY_CHECKLIST_DOCUMENT, LEGACY_UNRELATED_EFFECT_DOCUMENT] {
            assert!(!document.contains("checklist_completion"));
            let decoded = super::super::decode(document).unwrap();
            assert!(decoded.effects[0].checklist_completion.is_none());
            assert_eq!(super::super::encode(&decoded).unwrap(), document);
        }
    }

    #[test]
    fn tenant_binding_uses_the_versioned_checklist_domain() {
        assert_eq!(
            tenant_binding("tenant-a"),
            "e6af687dc0430653124c67740afc9f0f6ea2a32dd24fe328f2680145a08ee5d4"
        );
    }

    #[test]
    fn ready_and_empty_claims_decode_through_state_validation() {
        for accepted_basis in [Some(basis()), None] {
            let mut job = claimed_job(accepted_basis);
            assert_eq!(decode_result(&job).unwrap().effects, job.effects);
            job.generation = 2;
            job.state = PersistentState::ReconciliationRequired;
            job.effects[0].confirmed = true;
            job.effects[0].receipt = Some(ResultArtifact {
                receipt_id: "retained-receipt".into(),
                content_hash: job.effects[0].intent.content_hash.clone(),
                target: job.effects[0].intent.target.clone(),
            });
            assert!(decode_result(&job).is_ok());
        }
    }

    #[test]
    fn ready_claim_accepts_the_basis_seals_node_accepts() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/parity/jobs-model/jobs-model.json"
        ))
        .unwrap();
        let cases = golden["accepted_basis"].as_array().unwrap();
        assert_eq!(cases.len(), 9);
        for case in cases {
            let basis: ExportBasis = serde_json::from_value(case["input"].clone()).unwrap();
            let mut job = claimed_job(Some(basis.clone()));
            let result = &mut job.effects[0].checklist_completion.as_mut().unwrap().result;
            result.plan_version = Some(basis.plan_version);
            result.revision_id = Some(basis.plan_revision_id);
            assert_eq!(
                decode_result(&job).is_ok(),
                case["accepted"].as_bool().unwrap(),
                "{}",
                case["id"]
            );
        }
    }

    #[test]
    fn empty_claim_rejects_nonzero_part_or_thumb_counts() {
        for (part_count, thumb_count) in [(1, 0), (0, 1), (1, 1)] {
            let mut job = claimed_job(None);
            let result = &mut job.effects[0].checklist_completion.as_mut().unwrap().result;
            result.part_count = part_count;
            result.thumb_count = thumb_count;
            assert!(decode_result(&job).is_err());
        }
        assert!(decode_result(&claimed_job(None)).is_ok());
    }

    #[test]
    fn claim_tuple_mismatches_fail_decode_state_validation() {
        fn claim(job: &mut JobRecord) -> &mut ChecklistCompletionClaim {
            job.effects[0].checklist_completion.as_mut().unwrap()
        }
        let mutations: [fn(&mut JobRecord); 13] = [
            |job| claim(job).version = 2,
            |job| job.tenant = "tenant-b".into(),
            |job| job.kind = JobKind::ExportKitBundle,
            |job| job.payload = Payload::ExportChecklistHtml { profile_id: 8 },
            |job| job.effects[0].attempt = 2,
            |job| job.effects[0].generation = 2,
            |job| job.effects[0].intent.operation = EffectOperation::SourceRefresh,
            |job| job.effects[0].intent.basis_hash = "c".repeat(64),
            |job| job.effects[0].intent.content_hash = "c".repeat(64),
            |job| job.effects[0].intent.target = "checklists/other.html".into(),
            |job| claim(job).result.path = "checklists/other.html".into(),
            |job| claim(job).result.plan_version = Some(12),
            |job| {
                job.effects[0].confirmed = true;
                job.effects[0].receipt = Some(ResultArtifact {
                    receipt_id: "receipt".into(),
                    content_hash: "f".repeat(64),
                    target: job.effects[0].intent.target.clone(),
                });
            },
        ];
        for mutate in mutations {
            let mut job = claimed_job(Some(basis()));
            mutate(&mut job);
            assert!(decode_result(&job).is_err());
        }
    }

    #[test]
    fn successful_claim_requires_its_confirmed_artifact_and_public_result() {
        let mut job = claimed_job(None);
        let (content_sha256, tenant_relative_target, public_result) = {
            let claim = job.effects[0].checklist_completion.as_ref().unwrap();
            (
                claim.content_sha256.clone(),
                claim.tenant_relative_target.clone(),
                claim.result.clone(),
            )
        };
        let receipt = ResultArtifact {
            receipt_id: "receipt".into(),
            content_hash: content_sha256,
            target: tenant_relative_target,
        };
        job.effects[0].confirmed = true;
        job.effects[0].receipt = Some(receipt.clone());
        job.state = PersistentState::Succeeded;
        job.result = Some(receipt);
        job.public_result = Some(CompletedResult::ChecklistHtml(public_result));
        assert!(decode_result(&job).is_ok());

        job.public_result = None;
        assert!(decode_result(&job).is_err());
    }
}
