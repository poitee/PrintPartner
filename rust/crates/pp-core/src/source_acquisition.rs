use crate::uploads::{SourceImports, Through};
use anyhow::{Context, Result, anyhow, ensure};
use pp_source::{
    SourcePath,
    retained_capture::{
        CaptureCandidate, FreezeResult, FrozenCapture, RetainedCapturePhase, RetainedCaptureVault,
    },
};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::Credential,
    uploads::{
        AdmissionLimits, CaptureId, CapturedPayloadV1, File, Operation, PreflightedCapture,
        PreparedCapturedAdmission, Target,
    },
};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::Read,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

/// One file of a capture request, read into the retained capture.
pub struct CapturedFile {
    pub path: SourcePath,
    pub input: Box<dyn Read + Send>,
}

/// A captured Source import request: the admission it asks for and the files
/// that make up its input.
pub struct CaptureRequest {
    pub credential: Credential,
    pub operation_key: String,
    pub target: Target,
    pub payload: CapturedPayloadV1,
    pub limits: AdmissionLimits,
    pub files: Vec<CapturedFile>,
}

/// The result of an accepted acquisition, delivered once its operation is
/// recorded.
pub struct AcquisitionReply {
    result: mpsc::Receiver<Result<Operation>>,
}

impl AcquisitionReply {
    fn ready(result: Result<Operation>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let _ = sender.send(result);
        Self { result: receiver }
    }

    /// Blocks until the acquisition's operation is recorded.
    pub fn wait(self) -> Result<Operation> {
        self.result
            .recv()
            .map_err(|_| anyhow!("Source acquisition worker stopped"))?
    }
}

/// What [`SourceAcquisitions::shutdown`] observed when it returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquisitionDrain {
    /// Whether every acquisition finished within the budget.
    pub idle: bool,
    /// Operation keys whose workers stopped for shutdown after admission,
    /// sorted. Each keeps its journal row and reserved bytes; nothing resumes
    /// it in this instance. A key stopped while still admitted keeps its
    /// retained capture, which a later instance's
    /// [`SourceAcquisitions::recover_before_accepting`] settles; a key stopped
    /// after its capture became owned input is resumed by import job restart
    /// recovery when storage is next opened.
    pub interrupted: Vec<String>,
    /// Operation keys still in flight when the budget ran out, sorted.
    pub pending: Vec<String>,
}

const INTERRUPTED: &str = "Source acquisition interrupted by shutdown; retained for recovery";

struct Gate {
    open: bool,
    /// Set once by shutdown; refuses every later acquisition and recovery.
    shut_down: bool,
    active: usize,
    capacity: usize,
    /// Operation keys of every acquisition between preflight and its recorded
    /// result. Keys are held across tenants, so two tenants acquiring one key
    /// at the same moment see the later one refused.
    in_flight: HashSet<String>,
    interrupted: BTreeSet<String>,
}

/// The gate, signalled whenever an operation key is released, and the stop
/// flag every worker observes.
struct Shared {
    gate: Mutex<Gate>,
    released: Condvar,
    stop: AtomicBool,
}

impl Shared {
    fn gate(&self) -> Result<MutexGuard<'_, Gate>> {
        self.gate
            .lock()
            .map_err(|_| anyhow!("Source acquisition gate poisoned"))
    }
}

/// One reserved operation key and, once taken, one capacity slot; dropping it
/// returns both.
struct Permit {
    shared: Arc<Shared>,
    key: String,
    slot: bool,
}

impl Permit {
    fn take_slot(&mut self) -> Result<()> {
        let mut gate = self.shared.gate()?;
        ensure!(!gate.shut_down, "Source acquisition is shutting down");
        ensure!(gate.open, "Source acquisition ingress is closed");
        ensure!(
            gate.active < gate.capacity,
            "Source acquisition capacity exhausted"
        );
        gate.active += 1;
        self.slot = true;
        Ok(())
    }

    /// Records this key as stopped by shutdown, before the key is released.
    fn interrupt(&self) {
        if let Ok(mut gate) = self.shared.gate() {
            gate.interrupted.insert(self.key.clone());
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut gate) = self.shared.gate() {
            gate.in_flight.remove(&self.key);
            if self.slot {
                gate.active -= 1;
            }
        }
        self.shared.released.notify_all();
    }
}

/// The admission a capture's manifest is bound to.
struct Bound {
    operation_key: String,
    payload: CapturedPayloadV1,
    limits: AdmissionLimits,
}

/// A frozen capture with its prepared admission, owned by the service until
/// its operation is recorded.
struct Accepted {
    prepared: PreparedCapturedAdmission,
    frozen: FrozenCapture,
    unstable: bool,
    permit: Permit,
}

/// Captured Source acquisitions over the retained capture vault. Ingress stays
/// closed until [`SourceAcquisitions::recover_before_accepting`] has settled
/// every retained capture left by an earlier process. At most `capacity`
/// acquisitions hold a slot at once; a request beyond that is refused before
/// it reads input or writes a capture or journal row. After
/// [`SourceAcquisitions::shutdown`] the instance refuses all work; a new
/// instance recovers what it left.
pub struct SourceAcquisitions {
    imports: Arc<SourceImports>,
    data_dir: PathBuf,
    shared: Arc<Shared>,
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
            shared: Arc::new(Shared {
                gate: Mutex::new(Gate {
                    open: false,
                    shut_down: false,
                    active: 0,
                    capacity,
                    in_flight: HashSet::new(),
                    interrupted: BTreeSet::new(),
                }),
                released: Condvar::new(),
                stop: AtomicBool::new(false),
            }),
        })
    }

    /// Begins shutdown and drains acquisition workers within one `budget`
    /// shared by every acquisition. Ingress closes for good: later
    /// acquisitions, including replies for recorded keys, and recovery are
    /// refused without reading input or writing anything. An acquisition
    /// still capturing its input finishes its capture unless its own
    /// cancellation stops it. Every worker is told to stop: one that has
    /// admitted its capture but not settled it stops, leaves its journal row
    /// and retained capture as they are, and replies that it was interrupted.
    /// Nothing replays interrupted work here; a new instance's
    /// [`SourceAcquisitions::recover_before_accepting`] settles a retained
    /// capture, after a restart when its import job was already claimed.
    /// Returns once no
    /// acquisition is in flight or the budget runs out; repeating it waits
    /// again and reports every interruption so far.
    pub fn shutdown(&self, budget: Duration) -> Result<AcquisitionDrain> {
        let deadline = Instant::now() + budget;
        let mut gate = self.gate()?;
        gate.shut_down = true;
        gate.open = false;
        self.shared.stop.store(true, Ordering::Release);
        while !gate.in_flight.is_empty() {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            gate = self
                .shared
                .released
                .wait_timeout(gate, left)
                .map_err(|_| anyhow!("Source acquisition gate poisoned"))?
                .0;
        }
        let mut pending = gate.in_flight.iter().cloned().collect::<Vec<_>>();
        pending.sort();
        Ok(AcquisitionDrain {
            idle: pending.is_empty(),
            interrupted: gate.interrupted.iter().cloned().collect(),
            pending,
        })
    }

    /// Closes ingress, finishes interrupted vault deletions, and drives every
    /// frozen capture that exactly matches an admitted journal row through
    /// settlement. Captures whose journal row is already owned or later, or
    /// absent, are removed. Conflicting, candidate, and malformed captures are
    /// left byte-for-byte unchanged; while any remain, ingress stays closed and
    /// this returns an error naming each remaining capture and its cause.
    /// Refuses while an acquisition still holds a slot, leaving ingress as it
    /// was, and refuses once shutdown has begun. Returns the number of
    /// captures reconciled.
    pub fn recover_before_accepting(&self) -> Result<usize> {
        {
            let mut gate = self.gate()?;
            ensure!(!gate.shut_down, "Source acquisitions are shut down");
            ensure!(gate.in_flight.is_empty(), "Source acquisitions are active");
            gate.open = false;
        }
        let vault = RetainedCaptureVault::open(&self.data_dir)?;
        // A malformed slot stops vault deletion cleanup; it is reported below
        // with every other capture that remains.
        let deleting = vault.finish_deleting().err();
        let entries = vault.scan()?;
        let mut causes = HashMap::new();
        for entry in &entries {
            if entry.phase() != RetainedCapturePhase::Frozen {
                continue;
            }
            let worked = vault
                .open_frozen(entry.capture_id())
                .map_err(anyhow::Error::from)
                .and_then(|frozen| {
                    self.imports
                        .work_frozen(frozen, Through::Settled, &AtomicBool::new(false))
                });
            if let Err(error) = worked {
                causes.insert(entry.capture_id().as_str().to_owned(), error.to_string());
            }
        }
        let remaining = vault.scan()?;
        if !remaining.is_empty() {
            let causes = remaining
                .iter()
                .map(|entry| {
                    let cause = causes
                        .remove(entry.capture_id().as_str())
                        .unwrap_or_else(|| {
                            match entry.phase() {
                                // Settlement returned without error but left the
                                // capture: its job is claimed until restart recovery
                                // requeues it.
                                RetainedCapturePhase::Frozen => {
                                    "Import job is held by another attempt".to_owned()
                                }
                                RetainedCapturePhase::Candidate => {
                                    "Capture candidate was never frozen".to_owned()
                                }
                                RetainedCapturePhase::Deleting => match &deleting {
                                    Some(error) => format!("Capture deletion stopped: {error}"),
                                    None => "Capture deletion stopped".to_owned(),
                                },
                                RetainedCapturePhase::Malformed => {
                                    "Malformed retained capture".to_owned()
                                }
                            }
                        });
                    format!("{}: {cause}", entry.capture_id().as_str())
                })
                .collect::<Vec<_>>()
                .join("; ");
            return Err(anyhow!(
                "Retained captures require repair ({} remaining): {causes}",
                remaining.len()
            ));
        }
        self.set_ingress(true)?;
        Ok(entries.len())
    }

    /// Admits a prepared captured import once recovery has opened ingress.
    /// Refused admissions write no journal rows.
    pub fn admit_captured(&self, prepared: PreparedCapturedAdmission) -> Result<Operation> {
        ensure!(self.gate()?.open, "Source acquisition ingress is closed");
        self.imports.admit_captured(prepared)
    }

    /// Acquires a captured import. A key whose operation is already recorded
    /// replies with that operation as recorded, which may not be settled yet,
    /// and writes nothing. The key is reserved before preflight, so a retry of
    /// a key still in flight is refused rather than freezing a second capture.
    /// Otherwise the request takes a capacity slot and
    /// keeps its key reserved, its files are written and frozen as a retained
    /// capture, and a worker admits and settles it; slot and key are held until
    /// the operation is recorded. A request refused for closed ingress,
    /// exhausted capacity, a key already in flight, or preflight reads no input
    /// and writes no capture and no journal row; one that fails before freezing
    /// removes its candidate.
    pub fn acquire(
        &self,
        request: CaptureRequest,
        cancelled: &AtomicBool,
    ) -> Result<AcquisitionReply> {
        let CaptureRequest {
            credential,
            operation_key,
            target,
            payload,
            limits,
            files,
        } = request;
        let mut permit = self.reserve(operation_key.clone())?;
        let authority = self
            .imports
            .preflight_capture(
                credential,
                operation_key.clone(),
                target,
                payload.clone(),
                limits,
            )
            .context("Source acquisition preflight failed")?;
        if let Some(operation) = authority.replay() {
            return Ok(AcquisitionReply::ready(Ok(operation.clone())));
        }
        permit.take_slot()?;
        let accepted = self.freeze(
            authority,
            permit,
            Bound {
                operation_key,
                payload,
                limits,
            },
            files,
            cancelled,
        )?;
        self.spawn(accepted)
    }

    /// Writes the request's files into a new candidate, binds its manifest to
    /// the preflighted admission, and freezes it. Before the freeze, any
    /// failure removes the candidate; a candidate that cannot be removed
    /// closes ingress until recovery repairs it.
    fn freeze(
        &self,
        authority: PreflightedCapture,
        permit: Permit,
        bound: Bound,
        files: Vec<CapturedFile>,
        cancelled: &AtomicBool,
    ) -> Result<Accepted> {
        ensure!(!files.is_empty(), "Source acquisition has no files");
        let vault = RetainedCaptureVault::open(&self.data_dir)?;
        let mut candidate = vault.allocate_owned().map_err(|error| {
            if error.retained().is_some() {
                let _ = self.set_ingress(false);
            }
            anyhow::Error::from(error)
        })?;
        let limits = bound.limits;
        let prepared = (|| -> Result<PreparedCapturedAdmission> {
            for file in files {
                ensure!(
                    !cancelled.load(Ordering::Acquire),
                    "Source acquisition cancelled"
                );
                candidate.write_file_from_cancelled(
                    file.path,
                    file.input,
                    limits.max_input_bytes,
                    cancelled,
                )?;
            }
            let inventory = candidate
                .inventory(limits.max_input_bytes)
                .context("Source acquisition inventory failed")?
                .into_iter()
                .map(|file| File {
                    path: file.path.as_str().to_owned(),
                    size: file.size,
                    sha256: file.sha256,
                    kind: "input".into(),
                })
                .collect();
            let capture_id = CaptureId::new(candidate.capture_id().as_str().to_owned())?;
            let prepared = authority
                .prepare(
                    capture_id,
                    bound.operation_key,
                    bound.payload,
                    limits,
                    inventory,
                )
                .context("Source acquisition binding failed")?;
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "Source acquisition cancelled"
            );
            Ok(prepared)
        })();
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => return Err(self.abort(candidate, error)),
        };
        match candidate.freeze_owned(prepared.manifest()) {
            FreezeResult::Frozen(frozen) => Ok(Accepted {
                prepared,
                frozen,
                unstable: false,
                permit,
            }),
            FreezeResult::FrozenWithError { capture, .. } => Ok(Accepted {
                prepared,
                frozen: capture,
                unstable: true,
                permit,
            }),
            FreezeResult::CandidateError { candidate, error } => Err(self.abort(
                candidate,
                anyhow::Error::from(error).context("Source acquisition freeze failed"),
            )),
        }
    }

    fn abort(&self, candidate: CaptureCandidate, error: anyhow::Error) -> anyhow::Error {
        match candidate.abort() {
            Ok(()) => error.context("Owned capture candidate removed"),
            Err(cleanup) => {
                let _ = self.set_ingress(false);
                error.context(format!(
                    "Owned capture cleanup retained repair receipt {:?}: {cleanup}",
                    cleanup.receipt()
                ))
            }
        }
    }

    /// Admits and settles an accepted capture on its own worker. The slot is
    /// returned once the operation is recorded, before the reply is sent. A
    /// worker that sees shutdown after admission stops before settling.
    fn spawn(&self, accepted: Accepted) -> Result<AcquisitionReply> {
        let receipt = accepted.frozen.receipt();
        let imports = self.imports.clone();
        let shared = self.shared.clone();
        let (sender, result) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("pp-source-acquisition".into())
            .spawn(move || {
                let Accepted {
                    prepared,
                    frozen,
                    unstable,
                    permit,
                } = accepted;
                let stabilized = if unstable {
                    frozen.stabilize().map_err(anyhow::Error::from)
                } else {
                    Ok(())
                };
                let admitted = stabilized.and_then(|()| imports.admit_captured(prepared));
                let retained = admitted.is_ok();
                let stopped = || retained && shared.stop.load(Ordering::Acquire);
                let outcome = if stopped() {
                    Err(anyhow!(INTERRUPTED))
                } else {
                    match imports.work_frozen(frozen, Through::Settled, &shared.stop) {
                        Ok(Some(operation)) => Ok(operation),
                        Ok(None) => admitted.and_then(|operation| {
                            ensure!(
                                operation.cleanup_settled,
                                "Source acquisition did not settle"
                            );
                            Ok(operation)
                        }),
                        Err(error) => Err(error),
                    }
                };
                // A failure seen after shutdown stopped an admitted worker
                // leaves the import for recovery rather than failing it.
                let outcome = match outcome {
                    Err(_) if stopped() => {
                        permit.interrupt();
                        Err(anyhow!(INTERRUPTED))
                    }
                    outcome => outcome,
                };
                drop(permit);
                let _ = sender.send(outcome);
            });
        if let Err(error) = spawned {
            self.set_ingress(false)?;
            return Err(anyhow!(
                "Source acquisition worker unavailable; retained repair receipt {receipt:?}: {error}"
            ));
        }
        Ok(AcquisitionReply { result })
    }

    fn reserve(&self, key: String) -> Result<Permit> {
        let mut gate = self.gate()?;
        ensure!(!gate.shut_down, "Source acquisition is shutting down");
        ensure!(
            gate.in_flight.insert(key.clone()),
            "Source acquisition already in progress for this key"
        );
        Ok(Permit {
            shared: self.shared.clone(),
            key,
            slot: false,
        })
    }

    fn set_ingress(&self, open: bool) -> Result<()> {
        self.gate()?.open = open;
        Ok(())
    }

    fn gate(&self) -> Result<MutexGuard<'_, Gate>> {
        self.shared.gate()
    }
}
