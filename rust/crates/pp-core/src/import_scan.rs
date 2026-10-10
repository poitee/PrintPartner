use crate::uploads::source_worker_admission;
use anyhow::{Context, Result, anyhow, ensure};
use pp_source::{LocalFiles, SourcePath};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::{ClaimedAttempt, JobKind, Payload, ServerWorkerClient, WorkerOperation},
    source_scan::{
        CompletedLocalScan, LocalCompletionInspection, LocalDocumentKind, LocalDocumentRecord,
    },
};
use std::path::Path;

pub struct ImportScanWorker {
    storage: ServerWorkerClient,
}

struct ImportScanRun {
    source_id: i64,
    attempt: pp_storage::jobs::AttemptLease,
    source_work: pp_storage::catalog::SourceWorkLease,
}

impl ImportScanRun {
    fn bind(claim: ClaimedAttempt) -> Result<Self> {
        let ClaimedAttempt {
            job,
            lease,
            source_work,
        } = claim;
        ensure!(
            job.kind == JobKind::ImportScan,
            "Wrong ImportScan claim kind"
        );
        let Payload::ImportScan { project_id } = job.payload else {
            return Err(anyhow!("Wrong ImportScan payload"));
        };
        Ok(Self {
            source_id: i64::try_from(project_id)?,
            attempt: lease,
            source_work: source_work
                .ok_or_else(|| anyhow!("ImportScan claim missing Source reservation"))?,
        })
    }
}

impl ImportScanWorker {
    pub fn new(owner: &WriterOwner, policy: AuthPolicy) -> Result<Self> {
        Ok(Self {
            storage: owner.job_worker_with_policy(policy, source_worker_admission())?,
        })
    }

    pub fn run_one(&self) -> Result<Option<CompletedLocalScan>> {
        let Some(claim) = self.storage.claim_kind(JobKind::ImportScan)? else {
            return Ok(None);
        };
        let mut run = ImportScanRun::bind(claim)?;
        let observation = match self
            .storage
            .observe_local_scan(&run.attempt, &run.source_work)
        {
            Ok(observation) => observation,
            Err(primary) => {
                return Err(fail_before_settlement(&self.storage, &mut run, primary));
            }
        };
        ensure!(
            observation.source_id() == run.source_id,
            "ImportScan observation Source mismatch"
        );
        let documents = match read_documents(observation.local_path()) {
            Ok(documents) => documents,
            Err(primary) => {
                return Err(fail_before_settlement(&self.storage, &mut run, primary));
            }
        };
        let settlement = observation.settlement(documents);
        let applied =
            match self
                .storage
                .settle_local_scan(&mut run.attempt, &run.source_work, settlement)
            {
                Ok(applied) => applied,
                Err(primary) => match self
                    .storage
                    .inspect_local_scan_while_held(&mut run.attempt, &run.source_work)
                {
                    Ok(pp_storage::source_scan::HeldLocalScanInspection::Applied(_, applied)) => {
                        applied
                    }
                    Ok(pp_storage::source_scan::HeldLocalScanInspection::NotApplied(_)) => {
                        return Err(fail_before_settlement(&self.storage, &mut run, primary));
                    }
                    Err(inspection) => {
                        std::mem::forget(run.source_work);
                        return Err(primary.context(format!(
                            "held Local scan inspection also failed: {inspection:#}"
                        )));
                    }
                },
            };
        let result = applied.local_source_scan_result()?;
        match self.storage.complete_local_scan(
            &mut run.attempt,
            &mut run.source_work,
            applied.clone(),
            result,
        ) {
            Ok(LocalCompletionInspection::Completed(completed)) => Ok(Some(completed)),
            Ok(LocalCompletionInspection::CommittedReservationConflict(_)) => Err(anyhow!(
                "Local scan committed with a Source reservation conflict"
            )),
            Ok(LocalCompletionInspection::CommittedReservationCorrupt(_)) => Err(anyhow!(
                "Local scan committed with a corrupt Source reservation"
            )),
            Ok(LocalCompletionInspection::NotCommitted) => {
                self.storage.record_local_scan_reconciliation(
                    &run.attempt,
                    &mut run.source_work,
                    applied,
                    "Local scan completion refused after confirmed settlement".into(),
                )?;
                Err(anyhow!("Local scan completion was not committed"))
            }
            Err(primary) => match self.storage.inspect_local_scan_completion(&run.attempt) {
                Ok(LocalCompletionInspection::Completed(completed)) => {
                    run.source_work
                        .release()
                        .context("Local scan completed but reservation retirement failed")?;
                    Ok(Some(completed))
                }
                Ok(LocalCompletionInspection::CommittedReservationConflict(_)) => Err(anyhow!(
                    "Local scan committed with a Source reservation conflict"
                )),
                Ok(LocalCompletionInspection::CommittedReservationCorrupt(_)) => Err(anyhow!(
                    "Local scan committed with a corrupt Source reservation"
                )),
                Ok(LocalCompletionInspection::NotCommitted) => {
                    let reconciliation = self.storage.record_local_scan_reconciliation(
                        &run.attempt,
                        &mut run.source_work,
                        applied,
                        "Local scan completion refused after confirmed settlement".into(),
                    );
                    match reconciliation {
                        Ok(_) => Err(primary),
                        Err(secondary) => Err(primary.context(format!(
                            "recording Local scan reconciliation also failed: {secondary:#}"
                        ))),
                    }
                }
                Err(inspection) => {
                    std::mem::forget(run.source_work);
                    Err(primary.context(format!(
                        "Local scan completion inspection also failed: {inspection:#}"
                    )))
                }
            },
        }
    }
}

fn fail_before_settlement(
    storage: &ServerWorkerClient,
    run: &mut ImportScanRun,
    primary: anyhow::Error,
) -> anyhow::Error {
    let mut secondary = Vec::new();
    if let Err(error) = storage.update(&mut run.attempt, WorkerOperation::Fail) {
        secondary.push(format!("recording failure failed: {error:#}"));
    }
    if let Err(error) = run.source_work.release() {
        secondary.push(format!("releasing Source reservation failed: {error:#}"));
    }
    if secondary.is_empty() {
        primary
    } else {
        primary.context(secondary.join("; "))
    }
}

pub(crate) fn read_documents(path: Option<&str>) -> Result<Vec<LocalDocumentRecord>> {
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    let path = Path::new(path);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let local = LocalFiles::open(path)?;
    let paths = local
        .paths()?
        .into_iter()
        .filter(|path| document_kind(path).is_some())
        .collect::<Vec<_>>();
    let inventory = local.validated_inventory(&paths, pp_source::MAX_CONTENT_BYTES)?;
    inventory
        .into_iter()
        .map(|file| {
            let kind = document_kind(&file.path)
                .ok_or_else(|| anyhow!("Invalid selected Local document"))?;
            Ok(LocalDocumentRecord {
                relative_path: file.path.as_str().to_owned(),
                kind,
                size_bytes: file.size,
                content_sha256: file.sha256,
            })
        })
        .collect()
}

fn document_kind(path: &SourcePath) -> Option<LocalDocumentKind> {
    let lower = path.as_str().to_lowercase();
    if lower.ends_with(".pdf") {
        Some(LocalDocumentKind::Pdf)
    } else if lower.ends_with(".md") {
        Some(
            if lower
                .rsplit('/')
                .next()
                .is_some_and(|name| name == "readme.md" || name.starts_with("readme."))
            {
                LocalDocumentKind::Readme
            } else {
                LocalDocumentKind::Markdown
            },
        )
    } else {
        None
    }
}
