use anyhow::{Result, anyhow, ensure};
use pp_source::{
    LocalFiles, SourcePath, local_selection,
    retained_capture::{FrozenCapture, RetainedInputTransfer},
};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::{ClaimedAttempt, Credential, JobKind, ServerWorkerClient, WorkerAdmission},
    uploads::{
        Admission, AdmissionLimits, CaptureJournalCorrelation, CapturedPayloadV1, File,
        ImportClient, Input, Operation, OwnedInput, Phase, PreflightedCapture,
        PreparedCapturedAdmission, State, Target, inspect_capture_manifest,
    },
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

/// Synchronous admission and lookup for Source imports. Supplied admits hash a
/// directory. Captured admits preflight, prepare, claim, and copy retained
/// inputs into owned import directories. They do not publish or activate.
pub struct SourceImports {
    client: ImportClient,
    worker: ServerWorkerClient,
    repos: PathBuf,
}

impl SourceImports {
    pub fn new(owner: &WriterOwner, policy: AuthPolicy, quota: u64) -> Result<Self> {
        Ok(Self {
            client: owner.imports(policy, quota)?,
            worker: owner.job_worker_with_policy(policy, source_worker_admission())?,
            repos: owner.import_repos_root()?,
        })
    }

    /// Admits `request` once per key, hashing its named files from `supplied`.
    pub fn admit(
        &self,
        credential: Credential,
        request: Admission,
        supplied: &Path,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        ensure!(
            request.max_input_bytes > 0 && request.max_input_bytes <= 256 * 1024 * 1024,
            "Invalid import input limit"
        );
        let requested = match &request.input {
            Input::Files { paths } => paths.clone(),
            Input::Zip { path } => vec![path.clone()],
            Input::Captured(_) => {
                anyhow::bail!("Captured imports require prepared admission")
            }
        };
        let paths = requested
            .into_iter()
            .map(SourcePath::try_from)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        scanned(cancelled, Ok(()))?;
        let local = scanned(cancelled, LocalFiles::open(supplied))?;
        let inventory = local.inventory_until(&paths, request.max_input_bytes, cancelled);
        let expected_files = scanned(cancelled, inventory)?
            .into_iter()
            .map(input_file)
            .collect();
        let accounting_epoch = self.client.accounting_epoch();
        let disk = scanned(
            cancelled,
            local_selection::stored_bytes(&self.repos, cancelled),
        )?;
        self.client.admit(
            credential,
            request,
            expected_files,
            disk,
            accounting_epoch,
            cancelled,
        )
    }

    /// Preflights a captured import without writing journal rows or files.
    pub fn preflight_capture(
        &self,
        credential: Credential,
        operation_key: String,
        target: Target,
        payload: CapturedPayloadV1,
        limits: AdmissionLimits,
    ) -> Result<PreflightedCapture> {
        let disk = local_selection::stored_bytes(&self.repos, &AtomicBool::new(false))?;
        self.client
            .preflight_capture(credential, operation_key, target, payload, limits, disk)
    }

    /// Admits a prepared captured import once per key.
    pub fn admit_captured(&self, prepared: PreparedCapturedAdmission) -> Result<Operation> {
        let accounting_epoch = self.client.accounting_epoch();
        let disk = local_selection::stored_bytes(&self.repos, &AtomicBool::new(false))?;
        self.client.admit_prepared(prepared, disk, accounting_epoch)
    }

    /// Correlates a frozen capture with the journal and claims it only when the
    /// retained claim still matches and a current Source proof is available.
    /// Refuses before any retained-input file copy.
    pub fn prepare_frozen_claim(&self, frozen: &FrozenCapture) -> Result<ClaimedAttempt> {
        let manifest = frozen.manifest()?;
        let inspected = inspect_capture_manifest(&manifest)?;
        let paths = inspected
            .paths()
            .iter()
            .cloned()
            .map(SourcePath::try_from)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let inventory = frozen
            .inventory(&paths, inspected.max_input_bytes())?
            .into_iter()
            .map(input_file)
            .collect();
        match self
            .client
            .correlate_capture_manifest(manifest, inventory)?
        {
            CaptureJournalCorrelation::ExactAdmitted(claim) => {
                let claimed = self
                    .worker
                    .claim_resolved_import(claim)?
                    .ok_or_else(|| anyhow!("Captured import claim unavailable"))?;
                ensure!(
                    claimed.source_work.is_some(),
                    "Supplied import claim missing Source authority"
                );
                Ok(claimed)
            }
            CaptureJournalCorrelation::MismatchRepairRequired
            | CaptureJournalCorrelation::Absent
            | CaptureJournalCorrelation::ExactOwnedOrLater => {
                Err(anyhow!("Retained capture requires repair"))
            }
        }
    }

    /// Copies retained inputs for a claimed frozen capture into
    /// `repos/.pp-imports/{job_id}` through directory capabilities (`O_NOFOLLOW`
    /// and `O_EXCL`). Case-folded path collisions are rejected before any
    /// destination file is opened. Advances the journal to `OwnedInputReady`
    /// and removes the frozen capture. Does not publish or activate.
    pub fn write_retained_inputs(
        &self,
        claim: ClaimedAttempt,
        frozen: FrozenCapture,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        let ClaimedAttempt {
            job: _,
            lease,
            source_work,
        } = claim;
        let live =
            source_work.ok_or_else(|| anyhow!("Supplied import claim missing Source authority"))?;
        let mut op = self.worker.import_phase(&lease, &live, Phase::Read)?;
        if op.state == State::Admitted {
            let paths = op
                .requested_files
                .iter()
                .map(|file| SourcePath::try_from(file.path.clone()))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let inventory = frozen
                .transfer_owned_input(RetainedInputTransfer {
                    paths: &paths,
                    owned_root: &self.repos,
                    operation: &op.job_id,
                    max_bytes: op.max_input_bytes,
                    cancelled,
                })?
                .into_inventory();
            let files = inventory.into_iter().map(input_file).collect::<Vec<_>>();
            ensure!(
                files == op.requested_files
                    && hex::encode(Sha256::digest(serde_json::to_vec(&files)?))
                        == op.requested_digest,
                "Owned input requires repair"
            );
            op = self.worker.import_phase(
                &lease,
                &live,
                Phase::Owned(OwnedInput {
                    locator: format!(".pp-imports/{}", op.job_id),
                    digest: op.requested_digest.clone(),
                    files: op.requested_files.clone(),
                }),
            )?;
            frozen.remove(&paths)?;
        }
        Ok(op)
    }

    pub fn get(&self, credential: Credential, key: String) -> Result<Operation> {
        self.client.get(credential, key)
    }

    /// Names every regular file below `supplied`.
    pub fn directory_input(supplied: &Path) -> Result<Input> {
        Ok(Input::Files {
            paths: LocalFiles::open(supplied)?
                .paths()?
                .into_iter()
                .map(String::from)
                .collect(),
        })
    }
}

fn source_worker_admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: vec![(JobKind::SuppliedSourceImport, 1)],
        total: 1,
        per_resource: 1,
        lease_seconds: 60,
    }
}

fn input_file(file: pp_source::local_selection::InputFile) -> File {
    File {
        path: file.path.as_str().into(),
        size: file.size,
        sha256: file.sha256,
        kind: "input".into(),
    }
}

/// Reports a scan stopped by `cancelled` as a cancellation, not as its I/O
/// result.
fn scanned<T>(cancelled: &AtomicBool, result: Result<T, pp_source::Error>) -> Result<T> {
    ensure!(
        !cancelled.load(Ordering::Acquire),
        "Cancelled before admission"
    );
    Ok(result?)
}
