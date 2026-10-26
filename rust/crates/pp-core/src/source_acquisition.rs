use crate::uploads::{SourceImports, Through};
use anyhow::{Result, anyhow, ensure};
use pp_source::retained_capture::{RetainedCapturePhase, RetainedCaptureVault};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    uploads::{Operation, PreparedCapturedAdmission},
};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

/// Captured Source acquisitions over the retained capture vault. Ingress stays
/// closed until [`SourceAcquisitions::recover_before_accepting`] has settled
/// every retained capture left by an earlier process.
pub struct SourceAcquisitions {
    imports: SourceImports,
    data_dir: PathBuf,
    accepting: AtomicBool,
}

impl SourceAcquisitions {
    pub fn new(owner: &WriterOwner, policy: AuthPolicy, quota: u64) -> Result<Self> {
        let data_dir = owner
            .import_repos_root()?
            .parent()
            .ok_or_else(|| anyhow!("Storage data directory unavailable"))?
            .to_owned();
        Ok(Self {
            imports: SourceImports::new(owner, policy, quota)?,
            data_dir,
            accepting: AtomicBool::new(false),
        })
    }

    /// Closes ingress, finishes interrupted vault deletions, and drives every
    /// frozen capture that exactly matches an admitted journal row through
    /// settlement. Captures whose journal row is already owned or later, or
    /// absent, are removed. Conflicting, candidate, and malformed captures are
    /// left byte-for-byte unchanged; while any remain, ingress stays closed and
    /// this returns an error. Returns the number of captures reconciled.
    pub fn recover_before_accepting(&self) -> Result<usize> {
        self.accepting.store(false, Ordering::SeqCst);
        let vault = RetainedCaptureVault::open(&self.data_dir)?;
        vault.finish_deleting()?;
        let entries = vault.scan()?;
        let mut first_error = None;
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
                first_error.get_or_insert(error);
            }
        }
        let remaining = vault.scan()?.len();
        if remaining > 0 {
            let cause = first_error.map_or_else(String::new, |error| format!(": {error}"));
            return Err(anyhow!(
                "Retained captures require repair ({remaining} remaining){cause}"
            ));
        }
        self.accepting.store(true, Ordering::SeqCst);
        Ok(entries.len())
    }

    /// Admits a prepared captured import once recovery has opened ingress.
    /// Refused admissions write no journal rows.
    pub fn admit_captured(&self, prepared: PreparedCapturedAdmission) -> Result<Operation> {
        ensure!(
            self.accepting.load(Ordering::SeqCst),
            "Source acquisition ingress is closed"
        );
        self.imports.admit_captured(prepared)
    }
}
