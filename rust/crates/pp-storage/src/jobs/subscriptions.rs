use super::{Credential, JobAccessFailure, JobRecord, JobSnapshot};
use crate::auth::{self, AuthPolicy, StreamAuthority};
use anyhow::{Result, ensure};
use rusqlite::{Connection, TransactionBehavior};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    sync::{Arc, Condvar, Mutex, Weak},
    time::{Duration, Instant},
};

const MAX_SUBSCRIPTIONS: usize = 128;
const MAILBOX_CAPACITY: usize = 16;

thread_local! {
    static COLLECTOR: RefCell<Option<Collector>> = const { RefCell::new(None) };
}

struct Collector {
    changes: Vec<CommittedJobView>,
    committed: bool,
}

pub(crate) fn begin_collection() {
    COLLECTOR.with(|collector| {
        *collector.borrow_mut() = Some(Collector {
            changes: Vec::new(),
            committed: false,
        });
    });
}

pub(crate) fn mark_committed() {
    COLLECTOR.with(|collector| {
        if let Some(collector) = collector.borrow_mut().as_mut() {
            collector.committed = true;
        }
    });
}

pub(crate) fn record(job: &JobRecord) {
    COLLECTOR.with(|collector| {
        if let Some(collector) = collector.borrow_mut().as_mut()
            && !job.internal_only()
        {
            collector.changes.push(CommittedJobView {
                tenant: job.tenant.clone(),
                snapshot: Arc::new(job.snapshot()),
            });
        }
    });
}

pub(crate) fn finish_collection() -> Vec<CommittedJobView> {
    COLLECTOR.with(|collector| {
        let Some(collector) = collector.borrow_mut().take() else {
            return Vec::new();
        };
        if !collector.committed {
            return Vec::new();
        }
        let changes = collector.changes;
        let mut final_by_job = HashMap::new();
        let mut order = Vec::new();
        for change in changes {
            if !final_by_job.contains_key(&change.snapshot.job_id) {
                order.push(change.snapshot.job_id.clone());
            }
            final_by_job.insert(change.snapshot.job_id.clone(), change);
        }
        order
            .into_iter()
            .filter_map(|id| final_by_job.remove(&id))
            .collect()
    })
}

pub(crate) struct CommittedJobView {
    tenant: String,
    snapshot: Arc<JobSnapshot>,
}

#[derive(Clone)]
pub struct JobSubscription {
    cell: Arc<SubscriptionCell>,
}

pub struct PreparedFrame<T> {
    cell: Arc<SubscriptionCell>,
    snapshot: Arc<JobSnapshot>,
    payload: T,
}

pub enum PreparedEvent<T> {
    Frame(PreparedFrame<T>),
    Closed(StreamClose),
    Pending,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NonblockingSend {
    Accepted,
    Disconnected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameAdmission {
    Admitted,
    Closed(StreamClose),
    Disconnected,
    Superseded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamClose {
    Finished,
    Revoked,
    Expired,
    Lagged,
    OwnerStopped,
}

struct SubscriptionCell {
    authority_gate: Arc<Mutex<()>>,
    slot: Mutex<StreamSlot>,
    changed: Condvar,
}

struct StreamSlot {
    credential: Credential,
    policy: AuthPolicy,
    identity: auth::StreamAuthorityIdentity,
    tenant: String,
    subject: String,
    expires_at: Option<i64>,
    job_id: String,
    queue: VecDeque<Arc<JobSnapshot>>,
    last_version: i64,
    close: Option<StreamClose>,
}

pub(crate) struct JobSubscriptions {
    authority_gate: Arc<Mutex<()>>,
    registry: Mutex<SubscriptionRegistry>,
}

enum SubscriptionRegistry {
    Running(Vec<Weak<SubscriptionCell>>),
    Stopped,
}

impl SubscriptionRegistry {
    fn accepting_cells(
        &mut self,
    ) -> std::result::Result<&mut Vec<Weak<SubscriptionCell>>, JobAccessFailure> {
        match self {
            Self::Running(cells) => Ok(cells),
            Self::Stopped => Err(JobAccessFailure::Stopped),
        }
    }

    fn take_on_stop(&mut self) -> Vec<Weak<SubscriptionCell>> {
        match std::mem::replace(self, Self::Stopped) {
            Self::Running(cells) => cells,
            Self::Stopped => Vec::new(),
        }
    }
}

impl JobSubscriptions {
    pub(crate) fn new() -> Self {
        Self {
            authority_gate: Arc::new(Mutex::new(())),
            registry: Mutex::new(SubscriptionRegistry::Running(Vec::new())),
        }
    }

    pub(crate) fn authority_change<T>(&self, change: impl FnOnce() -> T) -> T {
        let _gate = self
            .authority_gate
            .lock()
            .expect("Job authority gate poisoned");
        change()
    }

    pub(crate) fn register(
        &self,
        credential: Credential,
        authority: StreamAuthority,
        policy: AuthPolicy,
        snapshot: JobSnapshot,
    ) -> Result<JobSubscription> {
        let mut registry = self.registry.lock().expect("Job subscriptions poisoned");
        let cells = registry.accepting_cells()?;
        cells.retain(|cell| cell.strong_count() > 0);
        ensure!(cells.len() < MAX_SUBSCRIPTIONS, JobAccessFailure::Capacity);
        let terminal = matches!(snapshot.status, "done" | "error" | "cancelled");
        let version = snapshot.version;
        let cell = Arc::new(SubscriptionCell {
            authority_gate: self.authority_gate.clone(),
            slot: Mutex::new(StreamSlot {
                credential,
                policy,
                identity: authority.identity,
                tenant: authority.tenant,
                subject: authority.subject,
                expires_at: authority.expires_at,
                job_id: snapshot.job_id.clone(),
                queue: VecDeque::from([Arc::new(snapshot)]),
                last_version: version,
                close: terminal.then_some(StreamClose::Finished),
            }),
            changed: Condvar::new(),
        });
        cells.push(Arc::downgrade(&cell));
        Ok(JobSubscription { cell })
    }

    pub(crate) fn publish(&self, changes: Vec<CommittedJobView>) {
        if changes.is_empty() {
            return;
        }
        let mut registry = self.registry.lock().expect("Job subscriptions poisoned");
        let SubscriptionRegistry::Running(cells) = &mut *registry else {
            return;
        };
        cells.retain(|cell| cell.strong_count() > 0);
        for weak in cells.iter() {
            let Some(cell) = weak.upgrade() else {
                continue;
            };
            let mut slot = cell.slot.lock().expect("Job subscription poisoned");
            if slot.close.is_some() && slot.close != Some(StreamClose::Finished) {
                continue;
            }
            for change in &changes {
                if change.tenant != slot.tenant || change.snapshot.job_id != slot.job_id {
                    continue;
                }
                if change.snapshot.version <= slot.last_version {
                    continue;
                }
                if slot.queue.len() >= MAILBOX_CAPACITY {
                    slot.queue.clear();
                    slot.close = Some(StreamClose::Lagged);
                    break;
                }
                slot.last_version = change.snapshot.version;
                slot.queue.push_back(change.snapshot.clone());
                if matches!(change.snapshot.status, "done" | "error" | "cancelled") {
                    slot.close = Some(StreamClose::Finished);
                }
            }
            drop(slot);
            cell.changed.notify_all();
        }
    }

    pub(crate) fn revalidate(&self, connection: &mut Connection) -> Result<()> {
        let mut registry = self.registry.lock().expect("Job subscriptions poisoned");
        let SubscriptionRegistry::Running(cells) = &mut *registry else {
            return Ok(());
        };
        cells.retain(|cell| cell.strong_count() > 0);
        if cells.is_empty() {
            return Ok(());
        }
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        for weak in cells.iter() {
            let Some(cell) = weak.upgrade() else {
                continue;
            };
            let mut slot = cell.slot.lock().expect("Job subscription poisoned");
            if slot.close.is_some() && slot.close != Some(StreamClose::Finished) {
                continue;
            }
            let current = auth::resolve_stream_authority(&tx, &slot.credential, slot.policy, false);
            let valid = current.is_ok_and(|current| {
                current.identity == slot.identity
                    && current.tenant == slot.tenant
                    && current.subject == slot.subject
            });
            if !valid {
                slot.queue.clear();
                slot.close = Some(StreamClose::Revoked);
                drop(slot);
                cell.changed.notify_all();
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn stop(&self) {
        let _gate = self
            .authority_gate
            .lock()
            .expect("Job authority gate poisoned");
        self.stop_under_authority_gate();
    }

    pub(crate) fn stop_under_authority_gate(&self) {
        let cells = {
            let mut registry = self.registry.lock().expect("Job subscriptions poisoned");
            let SubscriptionRegistry::Running(cells) = &mut *registry else {
                return;
            };
            cells.retain(|cell| cell.strong_count() > 0);
            cells.iter().filter_map(Weak::upgrade).collect()
        };
        Self::close_cells(cells);
    }

    pub(crate) fn stop_owner(&self) {
        let _gate = self
            .authority_gate
            .lock()
            .expect("Job authority gate poisoned");
        let cells = {
            let mut registry = self.registry.lock().expect("Job subscriptions poisoned");
            registry
                .take_on_stop()
                .into_iter()
                .filter_map(|cell| cell.upgrade())
                .collect()
        };
        Self::close_cells(cells);
    }

    fn close_cells(cells: Vec<Arc<SubscriptionCell>>) {
        for cell in cells {
            let mut slot = cell.slot.lock().expect("Job subscription poisoned");
            slot.queue.clear();
            slot.close = Some(StreamClose::OwnerStopped);
            drop(slot);
            cell.changed.notify_all();
        }
    }
}

impl JobSubscription {
    pub fn prepare<T, E>(
        &self,
        wait: Duration,
        encode: impl FnOnce(&JobSnapshot) -> std::result::Result<T, E>,
    ) -> std::result::Result<PreparedEvent<T>, E> {
        let deadline = Instant::now() + wait;
        let mut slot = self.cell.slot.lock().expect("Job subscription poisoned");
        loop {
            let now = time::OffsetDateTime::now_utc().unix_timestamp();
            if slot.expires_at.is_some_and(|expiry| expiry <= now) {
                slot.queue.clear();
                slot.close = Some(StreamClose::Expired);
            }
            if slot
                .close
                .is_some_and(|close| close != StreamClose::Finished)
            {
                return Ok(PreparedEvent::Closed(slot.close.expect("close checked")));
            }
            if let Some(snapshot) = slot.queue.front().cloned() {
                drop(slot);
                let payload = encode(&snapshot)?;
                return Ok(PreparedEvent::Frame(PreparedFrame {
                    cell: self.cell.clone(),
                    snapshot,
                    payload,
                }));
            }
            if let Some(close) = slot.close {
                return Ok(PreparedEvent::Closed(close));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(PreparedEvent::Pending);
            }
            let authority_remaining = slot
                .expires_at
                .map(|expiry| Duration::from_secs((expiry - now).max(0) as u64))
                .unwrap_or(remaining);
            slot = self
                .cell
                .changed
                .wait_timeout(slot, remaining.min(authority_remaining))
                .expect("Job subscription poisoned")
                .0;
        }
    }

    pub fn admit<T>(
        &self,
        frame: PreparedFrame<T>,
        send: impl FnOnce(T) -> NonblockingSend,
    ) -> FrameAdmission {
        if !Arc::ptr_eq(&self.cell, &frame.cell) {
            return FrameAdmission::Superseded;
        }
        let _gate = self
            .cell
            .authority_gate
            .lock()
            .expect("Job authority gate poisoned");
        let mut slot = self.cell.slot.lock().expect("Job subscription poisoned");
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        if slot.expires_at.is_some_and(|expiry| expiry <= now) {
            slot.queue.clear();
            slot.close = Some(StreamClose::Expired);
        }
        if let Some(close) = slot.close.filter(|close| *close != StreamClose::Finished) {
            return FrameAdmission::Closed(close);
        }
        let Some(current) = slot.queue.front() else {
            return slot
                .close
                .map(FrameAdmission::Closed)
                .unwrap_or(FrameAdmission::Superseded);
        };
        if !Arc::ptr_eq(current, &frame.snapshot) {
            return FrameAdmission::Superseded;
        }
        match send(frame.payload) {
            NonblockingSend::Accepted => {
                slot.queue.pop_front();
                FrameAdmission::Admitted
            }
            NonblockingSend::Disconnected => FrameAdmission::Disconnected,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_stop_is_terminal_idempotent_and_refuses_registration() {
        let subscriptions = JobSubscriptions::new();
        {
            let mut registry = subscriptions
                .registry
                .lock()
                .expect("Job subscriptions poisoned");
            assert!(registry.accepting_cells().is_ok());
        }
        subscriptions.stop_owner();
        subscriptions.stop_owner();
        let mut registry = subscriptions
            .registry
            .lock()
            .expect("Job subscriptions poisoned");
        assert_eq!(
            registry.accepting_cells().unwrap_err(),
            JobAccessFailure::Stopped
        );
    }

    #[test]
    fn fault_stop_keeps_registry_accepting() {
        let subscriptions = JobSubscriptions::new();
        subscriptions.stop();
        let mut registry = subscriptions
            .registry
            .lock()
            .expect("Job subscriptions poisoned");
        assert!(registry.accepting_cells().is_ok());
    }
}
