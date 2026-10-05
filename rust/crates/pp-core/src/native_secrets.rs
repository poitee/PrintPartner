use pp_storage::{
    WriterOwner,
    native_secrets::{
        MigrationPreparation, NativeSecretMigrationClient, SecretLocator, SecretMaterial,
        StorageFailure,
    },
};
use std::{
    error::Error,
    fmt,
    sync::{Mutex, TryLockError, atomic::AtomicBool},
    time::Duration,
};

const WRITER_WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Created,
    AlreadyPresent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeStoreFailure {
    Unavailable,
    Conflict,
    ReplyLost,
}

#[derive(Debug)]
pub struct StoreError(NativeStoreFailure);

impl StoreError {
    pub fn new(failure: NativeStoreFailure) -> Self {
        Self(failure)
    }

    pub fn failure(&self) -> NativeStoreFailure {
        self.0
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.0 {
            NativeStoreFailure::Unavailable => "native secret store unavailable",
            NativeStoreFailure::Conflict => "native secret locator conflict",
            NativeStoreFailure::ReplyLost => "native secret store reply lost",
        })
    }
}

impl Error for StoreError {}

pub trait NativeSecretStore: Send {
    fn put_new_or_verify(
        &mut self,
        locator: &SecretLocator,
        secret: &SecretMaterial,
    ) -> Result<PutOutcome, StoreError>;

    fn read(&mut self, locator: &SecretLocator) -> Result<Option<SecretMaterial>, StoreError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationFailure {
    Cancelled,
    Busy,
    Storage(StorageFailure),
    Store(NativeStoreFailure),
    MissingNativeSecret,
    NativeSecretMismatch,
    BlockingWorkerFailed,
}

#[derive(Debug)]
pub struct MigrationError(MigrationFailure);

impl MigrationError {
    pub fn failure(&self) -> MigrationFailure {
        self.0
    }
}

impl fmt::Display for MigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.0 {
            MigrationFailure::Cancelled => "native secret migration cancelled",
            MigrationFailure::Busy => "native secret migration already running",
            MigrationFailure::Storage(_) => "native secret migration storage failure",
            MigrationFailure::Store(_) => "native secret store failure",
            MigrationFailure::MissingNativeSecret => "native secret is missing",
            MigrationFailure::NativeSecretMismatch => "native secret readback mismatch",
            MigrationFailure::BlockingWorkerFailed => "native secret blocking worker failed",
        })
    }
}

impl Error for MigrationError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    Absent,
    LegacyRowRemoved,
}

pub struct NativeSecretMigrator<S> {
    storage: NativeSecretMigrationClient,
    store: Mutex<S>,
    active: Mutex<()>,
}

impl<S: NativeSecretStore> NativeSecretMigrator<S> {
    pub fn new(owner: &WriterOwner, store: S) -> Self {
        Self {
            storage: owner.native_secret_migration(),
            store: Mutex::new(store),
            active: Mutex::new(()),
        }
    }

    pub fn migrate_github_pat(
        &self,
        cancelled: &AtomicBool,
    ) -> Result<MigrationOutcome, MigrationError> {
        let _active = match self.active.try_lock() {
            Ok(active) => active,
            Err(TryLockError::WouldBlock) => {
                return Err(MigrationError(MigrationFailure::Busy));
            }
            Err(TryLockError::Poisoned(_)) => {
                return Err(MigrationError(MigrationFailure::BlockingWorkerFailed));
            }
        };
        let preparation = self
            .storage
            .prepare(cancelled, WRITER_WAIT)
            .map_err(|error| MigrationError(MigrationFailure::Storage(error.failure())))?;
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(MigrationError(MigrationFailure::Cancelled));
        }
        match preparation {
            MigrationPreparation::Absent => Ok(MigrationOutcome::Absent),
            MigrationPreparation::Prepared(prepared) => {
                let native_result = std::thread::scope(|scope| {
                    scope
                        .spawn(|| {
                            let mut store = self.store.lock().map_err(|_| {
                                MigrationError(MigrationFailure::BlockingWorkerFailed)
                            })?;
                            store
                                .put_new_or_verify(prepared.locator(), prepared.material())
                                .map_err(|error| {
                                    MigrationError(MigrationFailure::Store(error.failure()))
                                })?;
                            let readback = store.read(prepared.locator()).map_err(|error| {
                                MigrationError(MigrationFailure::Store(error.failure()))
                            })?;
                            let Some(readback) = readback else {
                                return Err(MigrationError(MigrationFailure::MissingNativeSecret));
                            };
                            if !prepared.material().matches(&readback) {
                                return Err(MigrationError(MigrationFailure::NativeSecretMismatch));
                            }
                            Ok(())
                        })
                        .join()
                });
                match native_result {
                    Ok(result) => result?,
                    Err(_) => {
                        return Err(MigrationError(MigrationFailure::BlockingWorkerFailed));
                    }
                }
                if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(MigrationError(MigrationFailure::Cancelled));
                }
                self.storage
                    .confirm(prepared, cancelled, WRITER_WAIT)
                    .map_err(|error| MigrationError(MigrationFailure::Storage(error.failure())))?;
                Ok(MigrationOutcome::LegacyRowRemoved)
            }
            MigrationPreparation::LegacyRowRemoved(locator) => {
                let native_result = std::thread::scope(|scope| {
                    scope
                        .spawn(|| {
                            let mut store = self.store.lock().map_err(|_| {
                                MigrationError(MigrationFailure::BlockingWorkerFailed)
                            })?;
                            store
                                .read(&locator)
                                .map_err(|error| {
                                    MigrationError(MigrationFailure::Store(error.failure()))
                                })?
                                .ok_or(MigrationError(MigrationFailure::MissingNativeSecret))
                        })
                        .join()
                });
                match native_result {
                    Ok(result) => {
                        let _material = result?;
                    }
                    Err(_) => {
                        return Err(MigrationError(MigrationFailure::BlockingWorkerFailed));
                    }
                }
                if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(MigrationError(MigrationFailure::Cancelled));
                }
                Ok(MigrationOutcome::LegacyRowRemoved)
            }
        }
    }
}
