use crate::{CoreStatus, ShutdownReceipt};
use anyhow::{Context, Result, ensure};
use pp_storage::{lease::StorageLease, restore::PreparedRestore};
use std::path::PathBuf;
use tokio::sync::{mpsc, oneshot};

pub use pp_storage::restore::{RestoreMetadata, RestoreScope};

#[derive(Debug)]
pub enum RestoreOutcome {
    InstalledServiceStopped,
    FailedUnchanged(String),
    FailedRolledBack(String),
    RecoveryRequired(String),
}

pub(super) enum Command {
    Prepare(PathBuf, oneshot::Sender<Result<RestoreMetadata>>),
    Cancel(oneshot::Sender<()>),
    Confirm(oneshot::Sender<RestoreOutcome>),
    Restart(oneshot::Sender<Result<()>>),
}
#[derive(Clone)]
pub(super) struct Client(mpsc::Sender<Command>);
impl Client {
    pub(super) fn channel() -> (Self, mpsc::Receiver<Command>) {
        let (send, receive) = mpsc::channel(4);
        (Self(send), receive)
    }
    async fn send(&self, command: Command) -> Result<()> {
        self.0.send(command).await.context("Core owner stopped")
    }
    pub(super) async fn prepare(&self, archive: PathBuf) -> Result<RestoreMetadata> {
        let (send, receive) = oneshot::channel();
        self.send(Command::Prepare(archive, send)).await?;
        receive
            .await
            .context("Restore preparation cancelled by shutdown")?
    }
    pub(super) async fn cancel(&self) -> Result<()> {
        let (send, receive) = oneshot::channel();
        self.send(Command::Cancel(send)).await?;
        receive.await.context("Core owner stopped")
    }
    pub(super) async fn confirm(&self) -> Result<RestoreOutcome> {
        let (send, receive) = oneshot::channel();
        self.send(Command::Confirm(send)).await?;
        receive.await.context("Restore cancelled by shutdown")
    }
    pub(super) async fn restart(&self) -> Result<()> {
        let (send, receive) = oneshot::channel();
        self.send(Command::Restart(send)).await?;
        receive.await.context("Core owner stopped")?
    }
}

pub(super) enum Admission {
    Idle,
    RestartRequested,
    Prepared(PreparedRestore),
}
impl Admission {
    pub(super) fn prepare(
        &mut self,
        owner: &StorageLease,
        status: &CoreStatus,
        archive: &std::path::Path,
    ) -> Result<RestoreMetadata> {
        ensure!(
            matches!(self, Self::Idle),
            "Another recovery action is pending"
        );
        ensure!(
            available(status),
            "Restore requires a stopped, unavailable service"
        );
        let prepared = PreparedRestore::prepare(owner, archive)?;
        let metadata = prepared.metadata().clone();
        *self = Self::Prepared(prepared);
        Ok(metadata)
    }
    pub(super) fn take(&mut self) -> Result<PreparedRestore> {
        ensure!(matches!(self, Self::Prepared(_)), "No prepared restore");
        let Self::Prepared(prepared) = std::mem::replace(self, Self::Idle) else {
            unreachable!()
        };
        Ok(prepared)
    }
}
pub(super) fn available(status: &CoreStatus) -> bool {
    matches!(status, CoreStatus::Guarded)
}

struct QuiescedStorage<'a>(&'a StorageLease);
impl<'a> QuiescedStorage<'a> {
    fn prove(owner: &'a StorageLease, receipt: &ShutdownReceipt) -> Result<Self> {
        ensure!(
            receipt.tracked_idle
                && receipt.gateway_idle
                && receipt.compat_reaped
                && receipt.gateway_stopped,
            "Restore refused because service drain or process cleanup is unproved; live files unchanged"
        );
        Ok(Self(owner))
    }
    fn install(self, prepared: PreparedRestore) -> RestoreOutcome {
        match prepared.activate(self.0) {
            Ok(()) => RestoreOutcome::InstalledServiceStopped,
            Err(error)
                if !error.is::<pp_storage::restore::RecoveryRequired>()
                    && matches!(pp_storage::restore::pending(self.0), Ok(false)) =>
            {
                RestoreOutcome::FailedRolledBack(format!("{error:#}"))
            }
            Err(error) => RestoreOutcome::RecoveryRequired(format!("{error:#}")),
        }
    }
}
pub(super) fn install(
    owner: &StorageLease,
    receipt: &ShutdownReceipt,
    prepared: PreparedRestore,
) -> RestoreOutcome {
    match QuiescedStorage::prove(owner, receipt) {
        Ok(quiesced) => quiesced.install(prepared),
        Err(error) => RestoreOutcome::FailedUnchanged(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ticket_t_2_offline_restore_refuses_failed_before_filesystem_preparation() {
        let data = std::env::temp_dir().join(format!(
            "pp-restore-failed-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let owner = StorageLease::acquire(&data).unwrap();
        let journal = data.join(".offline-restore-journal.json");
        std::fs::write(&journal, b"pending fixture").unwrap();
        let mut state = Admission::Idle;
        assert_eq!(
            state
                .prepare(&owner, &CoreStatus::Failed, std::path::Path::new("missing"))
                .unwrap_err()
                .to_string(),
            "Restore requires a stopped, unavailable service"
        );
        assert!(matches!(state, Admission::Idle));
        assert_eq!(std::fs::read(&journal).unwrap(), b"pending fixture");
        assert!(StorageLease::acquire(&data).is_err());
        assert_eq!(
            state
                .prepare(
                    &owner,
                    &CoreStatus::Guarded,
                    std::path::Path::new("missing")
                )
                .unwrap_err()
                .to_string(),
            "Pending restore requires recovery before preparing another backup"
        );
        drop(owner);
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn ticket_t_2_offline_restore_requires_all_drain_proofs() {
        let data = std::env::temp_dir().join(format!(
            "pp-restore-proof-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let owner = StorageLease::acquire(&data).unwrap();
        let mut receipt = ShutdownReceipt::failed("fixture");
        receipt.tracked_idle = true;
        receipt.gateway_idle = true;
        receipt.compat_reaped = true;
        receipt.gateway_stopped = true;
        assert!(QuiescedStorage::prove(&owner, &receipt).is_ok());
        for missing in 0..4 {
            let mut proof = ShutdownReceipt::failed("fixture");
            proof.tracked_idle = missing != 0;
            proof.gateway_idle = missing != 1;
            proof.compat_reaped = missing != 2;
            proof.gateway_stopped = missing != 3;
            assert!(QuiescedStorage::prove(&owner, &proof).is_err());
            assert!(StorageLease::acquire(&data).is_err());
        }
        drop(owner);
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn ticket_t_2_offline_restore_refuses_ready_and_restart_admission() {
        let data = std::env::temp_dir().join(format!(
            "pp-restore-admission-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let owner = StorageLease::acquire(&data).unwrap();
        let mut state = Admission::Idle;
        let error = state
            .prepare(
                &owner,
                &CoreStatus::Ready {
                    generation: "fixture".into(),
                    pid: 1,
                },
                std::path::Path::new("missing"),
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Restore requires a stopped, unavailable service"
        );
        state = Admission::RestartRequested;
        assert_eq!(
            state
                .prepare(
                    &owner,
                    &CoreStatus::Guarded,
                    std::path::Path::new("missing")
                )
                .unwrap_err()
                .to_string(),
            "Another recovery action is pending"
        );
        drop(owner);
        std::fs::remove_dir_all(data).unwrap();
    }
}
