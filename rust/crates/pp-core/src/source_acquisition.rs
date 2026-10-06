use crate::uploads::{SourceImports, Through};
use anyhow::{Context, Result, anyhow, ensure};
use pp_source::{
    SourcePath,
    retained_capture::{
        CaptureCandidate, FreezeResult, FrozenCapture, RetainedCapturePhase,
        RetainedCaptureReceipt, RetainedCaptureVault,
    },
};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::Credential,
    uploads::{
        AdmissionLimits, CaptureId, CapturedPayloadV1, File, Operation, PreflightedCapture, Target,
    },
};
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub struct CapturedFile {
    pub path: SourcePath,
    pub input: Box<dyn Read + Send>,
}

pub struct CaptureRequest {
    pub credential: Credential,
    pub operation_key: String,
    pub target: Target,
    pub payload: CapturedPayloadV1,
    pub limits: AdmissionLimits,
    pub files: Vec<CapturedFile>,
}

pub struct AcquisitionReply {
    result: mpsc::Receiver<Result<Operation>>,
}

impl AcquisitionReply {
    pub fn wait(self) -> Result<Operation> {
        self.result
            .recv()
            .map_err(|_| anyhow!("Source acquisition worker stopped"))?
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ShutdownReceipt {
    pub drained: usize,
    pub retained: usize,
}

struct Gate {
    open: bool,
    active: usize,
    capacity: usize,
}

struct IngressPermit {
    gate: Arc<Mutex<Gate>>,
}

impl Drop for IngressPermit {
    fn drop(&mut self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.active = gate.active.saturating_sub(1);
        }
    }
}

struct ServiceTask {
    finished: mpsc::Receiver<()>,
    worker: JoinHandle<()>,
}

pub struct SourceAcquisitions {
    imports: Arc<SourceImports>,
    data_dir: PathBuf,
    gate: Arc<Mutex<Gate>>,
    tasks: Mutex<Vec<ServiceTask>>,
    service_owned: Arc<Mutex<Vec<RetainedCaptureReceipt>>>,
}

struct CaptureOperation<'a> {
    owner: &'a SourceAcquisitions,
    authority: Option<PreflightedCapture>,
    permit: Option<IngressPermit>,
    candidate: Option<CaptureCandidate>,
    cancelled: &'a AtomicBool,
}

struct ServiceOwnedCapture {
    prepared: pp_storage::uploads::PreparedCapturedAdmission,
    frozen: FrozenCapture,
    freeze_error: Option<pp_source::Error>,
    permit: IngressPermit,
}

enum ClassifiedFreeze {
    ServiceOwned(Box<ServiceOwnedCapture>),
    CandidateError {
        candidate: Box<CaptureCandidate>,
        error: pp_source::Error,
        permit: IngressPermit,
    },
}

impl ServiceOwnedCapture {
    fn from_freeze_result(
        prepared: pp_storage::uploads::PreparedCapturedAdmission,
        permit: IngressPermit,
        result: FreezeResult,
    ) -> ClassifiedFreeze {
        let (frozen, freeze_error) = match result {
            FreezeResult::Frozen(frozen) => (frozen, None),
            FreezeResult::FrozenWithError { capture, error } => (capture, Some(error)),
            FreezeResult::CandidateError { candidate, error } => {
                return ClassifiedFreeze::CandidateError {
                    candidate: Box::new(candidate),
                    error,
                    permit,
                };
            }
        };
        ClassifiedFreeze::ServiceOwned(Box::new(Self {
            prepared,
            frozen,
            freeze_error,
            permit,
        }))
    }
}

impl SourceAcquisitions {
    pub fn new(
        owner: &WriterOwner,
        policy: AuthPolicy,
        quota: u64,
        capacity: usize,
    ) -> Result<Self> {
        ensure!(capacity > 0, "Source acquisition capacity must be positive");
        let data_dir = owner
            .import_repos_root()?
            .parent()
            .ok_or_else(|| anyhow!("Storage data directory unavailable"))?
            .to_owned();
        Ok(Self {
            imports: Arc::new(SourceImports::new(owner, policy, quota)?),
            data_dir,
            gate: Arc::new(Mutex::new(Gate {
                open: false,
                active: 0,
                capacity,
            })),
            tasks: Mutex::new(Vec::new()),
            service_owned: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn recover_before_accepting(&self) -> Result<usize> {
        self.set_ingress(false)?;
        let result = self.reconcile_retained();
        if result.is_ok() {
            self.set_ingress(true)?;
        }
        result
    }

    pub fn reconcile(&self) -> Result<usize> {
        let was_open = {
            let mut gate = self
                .gate
                .lock()
                .map_err(|_| anyhow!("Source acquisition gate poisoned"))?;
            let was_open = gate.open;
            gate.open = false;
            was_open
        };
        let result = self.reconcile_retained();
        if result.is_ok() && was_open {
            self.set_ingress(true)?;
        }
        result
    }

    fn reconcile_retained(&self) -> Result<usize> {
        ensure!(
            self.gate
                .lock()
                .map_err(|_| anyhow!("Source acquisition gate poisoned"))?
                .active
                == 0,
            "Source acquisitions are active"
        );
        let vault = RetainedCaptureVault::open(&self.data_dir)?;
        vault.finish_deleting()?;
        let entries = vault.scan()?;
        let capacity = self
            .gate
            .lock()
            .map_err(|_| anyhow!("Source acquisition gate poisoned"))?
            .capacity;
        ensure!(
            entries.len() <= capacity,
            "Retained source acquisition capacity exceeded"
        );
        let mut reconciled = 0;
        for entry in entries {
            match entry.phase() {
                RetainedCapturePhase::Frozen => {
                    let frozen = vault.open_frozen(entry.capture_id())?;
                    self.imports
                        .work_frozen(frozen, Through::Settled, &AtomicBool::new(false))?;
                    reconciled += 1;
                }
                RetainedCapturePhase::Deleting => {
                    return Err(anyhow!("Retained deleting capture did not converge"));
                }
                RetainedCapturePhase::Candidate | RetainedCapturePhase::Malformed => {
                    return Err(anyhow!("Retained capture requires repair"));
                }
            }
        }
        Ok(reconciled)
    }

    pub fn acquire(
        &self,
        request: CaptureRequest,
        request_cancelled: &AtomicBool,
    ) -> Result<AcquisitionReply> {
        let authority = self
            .imports
            .preflight_capture(
                request.credential,
                request.operation_key.clone(),
                request.target,
                request.payload.clone(),
                request.limits,
            )
            .context("Source acquisition preflight failed")?;
        if let Some(operation) = authority.replay().cloned() {
            let (sender, result) = mpsc::channel();
            sender
                .send(Ok(operation))
                .map_err(|_| anyhow!("Source acquisition reply unavailable"))?;
            return Ok(AcquisitionReply { result });
        }
        let permit = self.reserve()?;
        let operation = CaptureOperation {
            owner: self,
            authority: Some(authority),
            permit: Some(permit),
            candidate: None,
            cancelled: request_cancelled,
        };
        let owned = operation.run_to_freeze(
            request.operation_key,
            request.payload,
            request.limits,
            request.files,
        )?;
        self.adopt(owned)
    }

    fn adopt(&self, owned: ServiceOwnedCapture) -> Result<AcquisitionReply> {
        let receipt = owned.frozen.receipt();
        self.service_owned
            .lock()
            .map_err(|_| anyhow!("Source acquisition registry poisoned"))?
            .push(receipt.clone());
        let imports = self.imports.clone();
        let service_owned = self.service_owned.clone();
        let worker_receipt = receipt.clone();
        let (result_tx, result) = mpsc::channel();
        let (finished_tx, finished) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("pp-source-acquisition".into())
            .spawn(move || {
                let ServiceOwnedCapture {
                    prepared,
                    frozen,
                    freeze_error,
                    permit,
                } = owned;
                let stabilized: Result<()> = freeze_error.map_or_else(
                    || Ok(()),
                    |_| frozen.stabilize().map_err(anyhow::Error::from),
                );
                let admitted = stabilized.and_then(|()| imports.admit_captured(prepared));
                let recovered =
                    imports.work_frozen(frozen, Through::Settled, &AtomicBool::new(false));
                let outcome = match recovered {
                    Ok(Some(operation)) => Ok(operation),
                    Ok(None) => admitted.and_then(|operation| {
                        ensure!(
                            operation.cleanup_settled,
                            "Source acquisition did not settle"
                        );
                        Ok(operation)
                    }),
                    Err(error) => Err(error),
                };
                let _ = result_tx.send(outcome);
                drop(permit);
                if let Ok(mut receipts) = service_owned.lock() {
                    receipts.retain(|registered| registered != &worker_receipt);
                }
                let _ = finished_tx.send(());
            });
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                self.set_ingress(false)?;
                return Err(anyhow!(
                    "Source acquisition worker unavailable; retained repair receipt {receipt:?}: {error}"
                ));
            }
        };
        self.tasks
            .lock()
            .map_err(|_| anyhow!("Source acquisition tasks poisoned"))?
            .push(ServiceTask { finished, worker });
        Ok(AcquisitionReply { result })
    }

    pub fn shutdown(&self, budget: Duration) -> Result<ShutdownReceipt> {
        self.set_ingress(false)?;
        let deadline = Instant::now() + budget;
        let mut drained = 0;
        loop {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| anyhow!("Source acquisition tasks poisoned"))?;
            let mut index = 0;
            while index < tasks.len() {
                if tasks[index].finished.try_recv().is_ok() {
                    let task = tasks.swap_remove(index);
                    task.worker
                        .join()
                        .map_err(|_| anyhow!("Source acquisition worker panicked"))?;
                    drained += 1;
                } else {
                    index += 1;
                }
            }
            if tasks.is_empty() || Instant::now() >= deadline {
                return Ok(ShutdownReceipt {
                    drained,
                    retained: tasks.len(),
                });
            }
            drop(tasks);
            std::thread::yield_now();
        }
    }

    fn reserve(&self) -> Result<IngressPermit> {
        let mut gate = self
            .gate
            .lock()
            .map_err(|_| anyhow!("Source acquisition gate poisoned"))?;
        ensure!(gate.open, "Source acquisition ingress is closed");
        ensure!(
            gate.active < gate.capacity,
            "Source acquisition capacity exhausted"
        );
        gate.active += 1;
        Ok(IngressPermit {
            gate: self.gate.clone(),
        })
    }

    fn set_ingress(&self, open: bool) -> Result<()> {
        self.gate
            .lock()
            .map_err(|_| anyhow!("Source acquisition gate poisoned"))?
            .open = open;
        Ok(())
    }
}

impl CaptureOperation<'_> {
    fn run_to_freeze(
        mut self,
        operation_key: String,
        payload: CapturedPayloadV1,
        limits: AdmissionLimits,
        files: Vec<CapturedFile>,
    ) -> Result<ServiceOwnedCapture> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(self.fail_before_freeze(anyhow!("Source acquisition cancelled")));
        }
        if files.is_empty() {
            return Err(self.fail_before_freeze(anyhow!("Source acquisition has no files")));
        }
        let vault = match RetainedCaptureVault::open(&self.owner.data_dir) {
            Ok(vault) => vault,
            Err(error) => return Err(self.fail_before_freeze(error.into())),
        };
        let candidate = match vault.allocate_owned() {
            Ok(candidate) => candidate,
            Err(error) => {
                if error.retained().is_some() {
                    let _ = self.owner.set_ingress(false);
                }
                return Err(self.fail_before_freeze(error.into()));
            }
        };
        self.candidate = Some(candidate);
        for file in files {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(self.fail_before_freeze(anyhow!("Source acquisition cancelled")));
            }
            let result = self
                .candidate
                .as_mut()
                .expect("candidate owner")
                .write_file_from_cancelled(
                    file.path,
                    file.input,
                    limits.max_input_bytes,
                    self.cancelled,
                );
            if let Err(error) = result {
                return Err(self.fail_before_freeze(error.into()));
            }
        }
        if self.cancelled.load(Ordering::Acquire) {
            return Err(self.fail_before_freeze(anyhow!("Source acquisition cancelled")));
        }
        let inventory = match self
            .candidate
            .as_ref()
            .expect("candidate owner")
            .inventory(limits.max_input_bytes)
        {
            Ok(files) => files
                .into_iter()
                .map(|file| File {
                    path: file.path.as_str().to_owned(),
                    size: file.size,
                    sha256: file.sha256,
                    kind: "input".into(),
                })
                .collect::<Vec<_>>(),
            Err(error) => {
                return Err(self.fail_before_freeze(
                    anyhow::Error::from(error).context("Source acquisition inventory failed"),
                ));
            }
        };
        if self.cancelled.load(Ordering::Acquire) {
            return Err(self.fail_before_freeze(anyhow!("Source acquisition cancelled")));
        }
        let capture_id = match CaptureId::new(
            self.candidate
                .as_ref()
                .expect("candidate owner")
                .capture_id()
                .as_str()
                .to_owned(),
        ) {
            Ok(capture_id) => capture_id,
            Err(error) => {
                return Err(
                    self.fail_before_freeze(error.context("Source acquisition binding failed"))
                );
            }
        };
        let prepared = match self.authority.take().expect("capture authority").prepare(
            capture_id,
            operation_key,
            payload,
            limits,
            inventory,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                return Err(
                    self.fail_before_freeze(error.context("Source acquisition binding failed"))
                );
            }
        };
        if self.cancelled.load(Ordering::Acquire) {
            return Err(self.fail_before_freeze(anyhow!("Source acquisition cancelled")));
        }
        let candidate = self.candidate.take().expect("candidate owner");
        let freeze = candidate.freeze_owned(prepared.manifest());
        match ServiceOwnedCapture::from_freeze_result(
            prepared,
            self.permit.take().expect("ingress permit"),
            freeze,
        ) {
            ClassifiedFreeze::ServiceOwned(owned) => Ok(*owned),
            ClassifiedFreeze::CandidateError {
                candidate,
                error,
                permit,
            } => {
                self.candidate = Some(*candidate);
                self.permit = Some(permit);
                Err(self.fail_before_freeze(
                    anyhow::Error::from(error).context("Source acquisition freeze failed"),
                ))
            }
        }
    }

    fn fail_before_freeze(mut self, source: anyhow::Error) -> anyhow::Error {
        let Some(candidate) = self.candidate.take() else {
            return source;
        };
        match candidate.abort() {
            Ok(()) => source.context("Owned capture candidate removed"),
            Err(cleanup) => {
                let _ = self.owner.set_ingress(false);
                source.context(format!(
                    "Owned capture cleanup retained repair receipt {:?}: {cleanup}",
                    cleanup.receipt()
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pp_storage::{
        Limits,
        auth::{FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
        catalog::CreateSource,
    };
    use std::io::Cursor;

    fn policy() -> AuthPolicy {
        AuthPolicy {
            registration: RegistrationPolicy::Open,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        }
    }

    #[test]
    fn core_adopts_real_frozen_capture_from_synthetic_frozen_with_error_branch() {
        let root = std::env::temp_dir().join(format!(
            "pp-core-frozen-with-error-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir_all(&root).unwrap();
        let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
        let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
        acquisitions.recover_before_accepting().unwrap();
        let target = Target::Create {
            metadata: Box::new(CreateSource {
                name: "Frozen with error".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            }),
        };
        let payload = CapturedPayloadV1::files(vec!["triangle.stl".into()]);
        let limits = AdmissionLimits {
            reserved_bytes: 20 * 1024 * 1024,
            max_input_bytes: 64 * 1024,
            max_prepared_bytes: 64 * 1024,
        };
        let authority = acquisitions
            .imports
            .preflight_capture(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "frozen-with-error".into(),
                target,
                payload.clone(),
                limits,
            )
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let operation = CaptureOperation {
            owner: &acquisitions,
            authority: Some(authority),
            permit: Some(acquisitions.reserve().unwrap()),
            candidate: None,
            cancelled: &cancelled,
        };
        let owned = operation
            .run_to_freeze(
                "frozen-with-error".into(),
                payload,
                limits,
                vec![CapturedFile {
                    path: SourcePath::try_from("triangle.stl".to_owned()).unwrap(),
                    input: Box::new(Cursor::new(b"solid triangle\nendsolid triangle\n".to_vec())),
                }],
            )
            .unwrap();
        assert!(owned.freeze_error.is_none());
        let ServiceOwnedCapture {
            prepared,
            frozen,
            permit,
            ..
        } = owned;
        let owned = match ServiceOwnedCapture::from_freeze_result(
            prepared,
            permit,
            FreezeResult::FrozenWithError {
                capture: frozen,
                error: pp_source::Error::CorruptSnapshot,
            },
        ) {
            ClassifiedFreeze::ServiceOwned(owned) => *owned,
            ClassifiedFreeze::CandidateError { .. } => {
                panic!("frozen ownership returned to the candidate branch")
            }
        };
        let settled = acquisitions.adopt(owned).unwrap().wait().unwrap();
        assert!(settled.cleanup_settled);
        assert_eq!(
            std::fs::read_dir(root.join("source-captures"))
                .unwrap()
                .count(),
            0
        );
        acquisitions.shutdown(Duration::from_secs(5)).unwrap();
        drop(acquisitions);
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn core_cleans_candidate_after_private_binding_failure() {
        let root = std::env::temp_dir().join(format!(
            "pp-core-binding-failure-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir_all(&root).unwrap();
        let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
        let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
        acquisitions.recover_before_accepting().unwrap();
        let target = Target::Create {
            metadata: Box::new(CreateSource {
                name: "Binding failure".into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            }),
        };
        let valid_payload = CapturedPayloadV1::files(vec!["triangle.stl".into()]);
        let authority = acquisitions
            .imports
            .preflight_capture(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                "binding-failure".into(),
                target,
                valid_payload,
                AdmissionLimits {
                    reserved_bytes: 20 * 1024 * 1024,
                    max_input_bytes: 64 * 1024,
                    max_prepared_bytes: 64 * 1024,
                },
            )
            .unwrap();
        let mut unsupported =
            serde_json::to_value(CapturedPayloadV1::files(vec!["triangle.stl".into()])).unwrap();
        unsupported["policy"]["max_files"] = serde_json::json!(9_999);
        let unsupported = serde_json::from_value(unsupported).unwrap();
        let cancelled = AtomicBool::new(false);
        let operation = CaptureOperation {
            owner: &acquisitions,
            authority: Some(authority),
            permit: Some(acquisitions.reserve().unwrap()),
            candidate: None,
            cancelled: &cancelled,
        };
        let result = operation.run_to_freeze(
            "binding-failure".into(),
            unsupported,
            AdmissionLimits {
                reserved_bytes: 20 * 1024 * 1024,
                max_input_bytes: 64 * 1024,
                max_prepared_bytes: 64 * 1024,
            },
            vec![CapturedFile {
                path: SourcePath::try_from("triangle.stl".to_owned()).unwrap(),
                input: Box::new(Cursor::new(b"solid triangle\nendsolid triangle\n".to_vec())),
            }],
        );
        let error = match result {
            Ok(_) => panic!("unsupported captured policy reached freeze"),
            Err(error) => format!("{error:#}"),
        };
        assert!(error.contains("Source acquisition binding failed"));
        assert!(error.contains("Unsupported capture policy"));
        assert!(error.contains("Owned capture candidate removed"));
        assert!(!error.contains("Source acquisition inventory failed"));
        assert!(!error.contains("Source acquisition freeze failed"));
        assert_eq!(
            std::fs::read_dir(root.join("source-captures"))
                .unwrap()
                .count(),
            0
        );
        assert!(
            acquisitions
                .imports
                .get(
                    Credential::PhysicalOwner(owner.job_physical_owner()),
                    "binding-failure".into(),
                )
                .is_err()
        );
        drop(acquisitions.reserve().unwrap());
        acquisitions.shutdown(Duration::from_secs(5)).unwrap();
        drop(acquisitions);
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
