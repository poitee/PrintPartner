use anyhow::{Result, anyhow, ensure};
use pp_source::{LocalFiles, SourcePath, local_selection, retained_capture::FrozenCapture};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::{ClaimedAttempt, Credential, JobKind, ServerWorkerClient, WorkerAdmission},
    uploads::{
        Admission, AdmissionLimits, CaptureJournalCorrelation, CapturedPayloadV1, File,
        ImportClient, Input, Operation, PreflightedCapture, PreparedCapturedAdmission, Target,
        inspect_capture_manifest,
    },
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

/// Synchronous admission and lookup for Source imports. Supplied admits hash a
/// directory. Captured admits preflight, prepare, and claim a frozen capture
/// through a policy-aware worker; they never copy retained inputs.
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
