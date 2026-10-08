use crate::{import_scan::read_documents, uploads::source_worker_admission};
use anyhow::{Result, ensure};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::{ClaimedAttempt, JobKind, Payload, ServerWorkerClient},
    source_sync::{CompletedSourceSync, NextSyncTarget, SourceSyncHalt},
};

pub struct LocalSourceSyncWorker {
    storage: ServerWorkerClient,
}

struct SourceSyncRun {
    attempt: pp_storage::jobs::AttemptLease,
}

impl SourceSyncRun {
    fn bind(claim: ClaimedAttempt) -> Result<Self> {
        ensure!(
            claim.job.kind == JobKind::Sync,
            "Wrong Source Sync claim kind"
        );
        ensure!(
            matches!(claim.job.payload, Payload::Sync { .. }),
            "Wrong Source Sync payload"
        );
        ensure!(
            claim.source_work.is_none(),
            "Source Sync parent holds a Source reservation"
        );
        Ok(Self {
            attempt: claim.lease,
        })
    }
}

impl LocalSourceSyncWorker {
    pub fn new(owner: &WriterOwner, policy: AuthPolicy) -> Result<Self> {
        Ok(Self {
            storage: owner.job_worker_with_policy(policy, source_worker_admission())?,
        })
    }

    pub fn run_one(&self) -> Result<Option<CompletedSourceSync>> {
        let Some(claim) = self.storage.claim_kind(JobKind::Sync)? else {
            return Ok(None);
        };
        let mut run = SourceSyncRun::bind(claim)?;
        self.storage.open_source_sync(&run.attempt)?;
        loop {
            let next = match self.storage.claim_next_source_sync_target(&mut run.attempt) {
                Ok(next) => next,
                Err(error) => {
                    let _ = self.storage.halt_source_sync(
                        &run.attempt,
                        SourceSyncHalt::Fatal,
                        format!("{error:#}"),
                    );
                    return Err(error);
                }
            };
            match next {
                NextSyncTarget::Complete => match self.storage.finish_source_sync(&run.attempt)? {
                    pp_storage::source_sync::SourceSyncFinishOutcome::Completed(completed) => {
                        return Ok(Some(*completed));
                    }
                    pp_storage::source_sync::SourceSyncFinishOutcome::NeedsReconciliation => {
                        return Err(anyhow::anyhow!("Source Sync requires retained inspection"));
                    }
                },
                NextSyncTarget::OrdinaryFailure(_) => continue,
                NextSyncTarget::Recovered(_) => continue,
                NextSyncTarget::Halted => return Err(anyhow::anyhow!("Source Sync halted")),
                NextSyncTarget::Local(mut target) => {
                    let key = target.key().clone();
                    let documents = match read_documents(target.observation().local_path()) {
                        Ok(documents) => documents,
                        Err(error) => {
                            let inspection = match self.storage.fail_source_sync_target(
                                &mut run.attempt,
                                &mut target,
                                format!("{error:#}"),
                            ) {
                                Ok(inspection) => inspection,
                                Err(failure_error) => {
                                    let _ = self.storage.halt_source_sync(
                                        &run.attempt,
                                        SourceSyncHalt::Fatal,
                                        format!("{failure_error:#}"),
                                    );
                                    return Err(failure_error);
                                }
                            };
                            if inspection
                                == pp_storage::source_sync::SyncTargetInspection::ReconciliationRequired
                            {
                                return Err(anyhow::anyhow!(
                                    "Source Sync requires retained inspection"
                                ));
                            }
                            continue;
                        }
                    };
                    let settlement = target.settlement(documents);
                    let inspection = match self.storage.settle_source_sync_target(
                        &mut run.attempt,
                        &mut target,
                        settlement,
                    ) {
                        Ok(inspection) => inspection,
                        Err(settlement_error) => {
                            match self.storage.adopt_source_sync_target(&mut run.attempt, key) {
                                Ok(inspection) => inspection,
                                Err(adoption_error) => {
                                    let detail = format!(
                                        "Sync settlement reply unresolved: {settlement_error:#}; adoption failed: {adoption_error:#}"
                                    );
                                    let _ = self.storage.halt_source_sync(
                                        &run.attempt,
                                        SourceSyncHalt::UncertainTarget,
                                        detail.clone(),
                                    );
                                    return Err(anyhow::anyhow!(detail));
                                }
                            }
                        }
                    };
                    ensure!(
                        matches!(
                            inspection,
                            pp_storage::source_sync::SyncTargetInspection::Succeeded(_)
                        ),
                        "Local Source Sync target did not succeed"
                    );
                }
            }
        }
    }
}
