pub mod auth;
pub mod build_graph;
pub mod catalog;
pub mod checkoff_progress;
pub mod jobs;
pub mod lease;
pub mod native_secrets;
pub mod plan_publication;
pub mod profiles;
pub use working_drafts::save as plan_save;
pub mod read_model;
pub mod required_units;
mod schema;
pub mod source_scan;
pub mod uploads;
pub mod working_drafts;

use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
pub use schema::SchemaReady;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SettingSnapshot {
    Missing,
    Stored { value: String },
}
#[derive(Clone, Debug)]
pub struct Setting {
    pub tenant: String,
    pub key: String,
    pub value: String,
}
#[derive(Clone, Debug)]
pub enum SettingCommand {
    Set(Setting),
    CompareAndSet {
        setting: Setting,
        expected: SettingSnapshot,
    },
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub queued_writes: usize,
    pub readers: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            queued_writes: 32,
            readers: 4,
        }
    }
}
pub type WriteReply = mpsc::Receiver<Result<bool>>;
enum Work {
    Setting(SettingCommand),
    Backup(PathBuf),
}
enum Envelope {
    BuildGraph {
        command: build_graph::Command,
        reply: build_graph::Reply,
    },
    PlanSave {
        command: plan_save::Command,
        reply: mpsc::Sender<Result<plan_save::Outcome>>,
    },
    WorkingDraft {
        command: working_drafts::Command,
        reply: mpsc::Sender<Result<pp_contracts::working_drafts::Outcome>>,
    },
    Publication {
        command: plan_publication::Command,
        reply: mpsc::Sender<Result<pp_contracts::publication::Outcome>>,
    },
    RequiredUnits {
        command: required_units::Command,
        reply: mpsc::Sender<Result<pp_contracts::reconciliation::Outcome>>,
    },
    Checkoff {
        command: checkoff_progress::Command,
        reply: mpsc::Sender<Result<checkoff_progress::Response>>,
    },
    Uploads {
        command: uploads::Command,
        reply: mpsc::Sender<Result<uploads::Operation>>,
    },
    Read {
        command: read_model::Command,
        reply: mpsc::Sender<Result<read_model::Batch>>,
    },
    Catalog {
        command: catalog::Command,
        reply: mpsc::Sender<Result<catalog::Reply>>,
    },
    CatalogRequest {
        command: catalog::Command,
        reply: mpsc::Sender<Result<catalog::Outcome>>,
    },
    Jobs {
        command: jobs::Command,
        reply: mpsc::Sender<Result<jobs::Outcome>>,
    },
    NativeSecrets {
        command: native_secrets::Command,
        reply: native_secrets::Reply,
    },
    Setting {
        work: Work,
        reply: mpsc::Sender<Result<bool>>,
    },
    AuthReady {
        ready: VecDeque<auth::WriterWork>,
        next: QueueClass,
    },
}
struct Queue {
    closed: bool,
    pending: VecDeque<Envelope>,
}
#[derive(Clone, Copy)]
enum QueueClass {
    Normal,
    Auth,
}
enum Scheduled {
    Normal(Envelope),
    Auth(auth::WriterWork),
}
struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
    capacity: usize,
    orphaned_source_leases: Mutex<Vec<u64>>,
    job_admission: Mutex<Option<Arc<jobs::WorkerAdmission>>>,
    import_epoch: AtomicU64,
    import_quota: Mutex<Option<u64>>,
    job_subscriptions: jobs::JobSubscriptions,
}
fn push_auth_ready(pending: &mut VecDeque<Envelope>, work: auth::WriterWork) {
    if let Some(Envelope::AuthReady { ready, .. }) = pending
        .iter_mut()
        .find(|envelope| matches!(envelope, Envelope::AuthReady { .. }))
    {
        ready.push_back(work);
    } else {
        pending.push_back(Envelope::AuthReady {
            ready: VecDeque::from([work]),
            next: QueueClass::Normal,
        });
    }
}
fn schedule(pending: &mut VecDeque<Envelope>, now: Instant) -> Option<Scheduled> {
    let auth_envelope = pending.iter().position(|envelope| {
        matches!(
            envelope,
            Envelope::AuthReady { ready, .. } if ready.iter().any(|work| work.eligible(now))
        )
    });
    let normal = pending
        .iter()
        .position(|envelope| !matches!(envelope, Envelope::AuthReady { .. }));
    let take_auth = match (normal, auth_envelope) {
        (None, None) => return None,
        (Some(_), None) => false,
        (None, Some(_)) => true,
        (Some(_), Some(index)) => matches!(
            pending.get(index),
            Some(Envelope::AuthReady {
                next: QueueClass::Auth,
                ..
            })
        ),
    };
    if take_auth {
        let index = auth_envelope.expect("Auth work located");
        let Envelope::AuthReady { ready, next } =
            pending.get_mut(index).expect("Auth work located")
        else {
            unreachable!()
        };
        let work_index = ready
            .iter()
            .position(|work| work.eligible(now))
            .expect("Eligible auth work located");
        let work = ready
            .remove(work_index)
            .expect("Eligible auth work located");
        *next = QueueClass::Normal;
        if ready.is_empty() {
            pending.remove(index);
        }
        Some(Scheduled::Auth(work))
    } else {
        if let Some(index) = auth_envelope
            && let Some(Envelope::AuthReady { next, .. }) = pending.get_mut(index)
        {
            *next = QueueClass::Auth;
        }
        normal
            .and_then(|index| pending.remove(index))
            .map(Scheduled::Normal)
    }
}
fn earliest_auth_retry(pending: &VecDeque<Envelope>) -> Option<Instant> {
    pending
        .iter()
        .filter_map(|envelope| match envelope {
            Envelope::AuthReady { ready, .. } => {
                ready.iter().filter_map(|work| work.retry_at()).min()
            }
            _ => None,
        })
        .min()
}
#[derive(Clone)]
pub struct SettingsClient {
    shared: Arc<Shared>,
    readers: Arc<ReaderPool>,
}
struct ReaderState {
    closed: bool,
    idle: Vec<Connection>,
    active: usize,
}
struct ReaderPool {
    state: Mutex<ReaderState>,
    changed: Condvar,
}
pub struct ReaderCheckout {
    connection: Option<Connection>,
    pool: Arc<ReaderPool>,
}
pub struct WriterOwner {
    client: SettingsClient,
    join: Option<JoinHandle<()>>,
    lease: Option<lease::StorageLease>,
}

fn snapshot(connection: &Connection, tenant: &str, key: &str) -> Result<SettingSnapshot> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id=?1 AND key=?2",
            params![tenant, key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match value {
        None => SettingSnapshot::Missing,
        Some(value) => SettingSnapshot::Stored { value },
    })
}
fn execute(connection: &mut Connection, work: Work) -> Result<bool> {
    let command = match work {
        Work::Setting(command) => command,
        Work::Backup(path) => {
            schema::backup(connection, &path, false)?;
            return Ok(true);
        }
    };
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let setting = match command {
        SettingCommand::Set(setting) => setting,
        SettingCommand::CompareAndSet { setting, expected } => {
            if snapshot(&tx, &setting.tenant, &setting.key)? != expected {
                tx.commit()?;
                return Ok(false);
            }
            setting
        }
    };
    tx.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value",params![setting.tenant,setting.key,setting.value])?;
    tx.commit()?;
    Ok(true)
}
impl SettingsClient {
    pub(crate) fn enqueue_auth(&self, work: auth::WriterWork) {
        let mut queue = self.shared.queue.lock().expect("Writer admission poisoned");
        if queue.closed {
            drop(queue);
            auth::finish_stopped(work);
            return;
        }
        push_auth_ready(&mut queue.pending, work);
        self.shared.changed.notify_all();
    }

    fn enqueue(&self, work: Work, cancelled: &AtomicBool, wait: Duration) -> Result<WriteReply> {
        let deadline = Instant::now() + wait;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!("Writer admission poisoned"))?;
        loop {
            ensure!(!queue.closed, "Storage stopped");
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "Cancelled before admission"
            );
            if queue.pending.len() < self.shared.capacity {
                let (reply, receiver) = mpsc::channel();
                queue.pending.push_back(Envelope::Setting { work, reply });
                self.shared.changed.notify_all();
                return Ok(receiver);
            }
            ensure!(Instant::now() < deadline, "Writer queue full");
            queue = self
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!("Writer admission poisoned"))?
                .0;
        }
    }
    pub fn submit(
        &self,
        command: SettingCommand,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<WriteReply> {
        self.enqueue(Work::Setting(command), cancelled, wait)
    }
    pub fn reader(&self, wait: Duration) -> Result<ReaderCheckout> {
        let deadline = Instant::now() + wait;
        let mut state = self
            .readers
            .state
            .lock()
            .map_err(|_| anyhow!("Reader pool poisoned"))?;
        loop {
            ensure!(!state.closed, "Storage stopped");
            if let Some(connection) = state.idle.pop() {
                if let Err(error) = schema::configure(&connection, true) {
                    state.idle.push(connection);
                    return Err(error);
                }
                state.active += 1;
                return Ok(ReaderCheckout {
                    connection: Some(connection),
                    pool: self.readers.clone(),
                });
            }
            ensure!(Instant::now() < deadline, "Reader pool full");
            state = self
                .readers
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| anyhow!("Reader pool poisoned"))?
                .0;
        }
    }
}
impl ReaderCheckout {
    pub fn snapshot(&self, tenant: &str, key: &str) -> Result<SettingSnapshot> {
        snapshot(
            self.connection.as_ref().expect("checked out connection"),
            tenant,
            key,
        )
    }
    pub fn get_setting(
        &self,
        tenant: &str,
        key: &str,
        default: Option<&str>,
    ) -> Result<Option<String>> {
        Ok(match self.snapshot(tenant, key)? {
            SettingSnapshot::Stored { value } if !value.is_empty() => Some(value),
            _ => default.map(str::to_owned),
        })
    }
}
impl Drop for ReaderCheckout {
    fn drop(&mut self) {
        let connection = self.connection.take().expect("checked out connection");
        let mut state = self.pool.state.lock().expect("Reader pool poisoned");
        if state.closed {
            drop(connection);
        } else {
            state.idle.push(connection);
        }
        state.active -= 1;
        self.pool.changed.notify_all();
    }
}
impl WriterOwner {
    pub fn open(directory: &Path, limits: Limits) -> Result<(Self, SchemaReady)> {
        let now = time::OffsetDateTime::now_utc();
        let timestamp = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond()
        );
        Self::open_at(directory, limits, &timestamp)
    }

    pub fn open_at(
        directory: &Path,
        limits: Limits,
        seed_timestamp: &str,
    ) -> Result<(Self, SchemaReady)> {
        Self::open_configured(
            directory,
            limits,
            seed_timestamp,
            plan_publication::random_tokens(),
        )
    }
    pub fn open_with_token_allocator(
        directory: &Path,
        limits: Limits,
        tokens: Box<dyn plan_publication::RequiredUnitTokenAllocator>,
    ) -> Result<(Self, SchemaReady)> {
        let now = time::OffsetDateTime::now_utc();
        let timestamp = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond()
        );
        Self::open_configured(directory, limits, &timestamp, tokens)
    }
    fn open_configured(
        directory: &Path,
        limits: Limits,
        seed_timestamp: &str,
        mut tokens: Box<dyn plan_publication::RequiredUnitTokenAllocator>,
    ) -> Result<(Self, SchemaReady)> {
        ensure!(
            limits.queued_writes > 0 && limits.readers > 0,
            "Storage limits must be positive"
        );
        let path = directory.join("print-partner.db");
        schema::preflight(&path, false)?;
        let lease = lease::StorageLease::acquire(directory)?;
        let path = lease.data_dir().join("print-partner.db");
        let version = schema::preflight(&path, true)?;
        for name in ["repos", "sources", "exports", "thumbs", "covers"] {
            std::fs::create_dir_all(lease.data_dir().join(name))?;
        }
        let (mut connection, ready) = schema::initialize(&path, version, seed_timestamp)?;
        jobs::recover(&mut connection)?;
        let mut idle = Vec::new();
        for _ in 0..limits.readers {
            let reader = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            schema::configure(&reader, true)?;
            idle.push(reader);
        }
        let readers = Arc::new(ReaderPool {
            state: Mutex::new(ReaderState {
                closed: false,
                idle,
                active: 0,
            }),
            changed: Condvar::new(),
        });
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue {
                closed: false,
                pending: VecDeque::new(),
            }),
            changed: Condvar::new(),
            capacity: limits.queued_writes,
            orphaned_source_leases: Mutex::new(Vec::new()),
            job_admission: Mutex::new(None),
            import_epoch: AtomicU64::new(0),
            import_quota: Mutex::new(None),
            job_subscriptions: jobs::JobSubscriptions::new(),
        });
        let worker = shared.clone();
        let mut catalog_state = catalog::State::new(lease.data_dir().to_owned());
        let join = thread::spawn(move || {
            loop {
                let scheduled = {
                    let mut queue = worker.queue.lock().expect("Writer admission poisoned");
                    loop {
                        if let Some(scheduled) = schedule(&mut queue.pending, Instant::now()) {
                            worker.changed.notify_all();
                            break Some(scheduled);
                        }
                        if queue.closed && queue.pending.is_empty() {
                            break None;
                        }
                        if let Some(retry) = earliest_auth_retry(&queue.pending) {
                            let wait = retry.saturating_duration_since(Instant::now());
                            queue = worker
                                .changed
                                .wait_timeout(queue, wait)
                                .expect("Writer admission poisoned")
                                .0;
                        } else {
                            queue = worker
                                .changed
                                .wait(queue)
                                .expect("Writer admission poisoned");
                        }
                    }
                };
                let Some(scheduled) = scheduled else {
                    break;
                };
                let envelope = match scheduled {
                    Scheduled::Normal(envelope) => envelope,
                    Scheduled::Auth(work) => {
                        if let Some(retry) = auth::advance(&mut connection, work) {
                            let mut queue = worker.queue.lock().expect("Writer admission poisoned");
                            push_auth_ready(&mut queue.pending, retry);
                            worker.changed.notify_all();
                        }
                        continue;
                    }
                };
                let orphaned = std::mem::take(
                    &mut *worker
                        .orphaned_source_leases
                        .lock()
                        .expect("Source lease recovery poisoned"),
                );
                catalog_state
                    .reap(orphaned)
                    .expect("Invalid orphaned Source lease");
                match envelope {
                    Envelope::BuildGraph { command, reply } => {
                        reply.send(build_graph::execute(&mut connection, command));
                    }
                    Envelope::PlanSave { command, reply } => {
                        let _ = reply.send(plan_save::execute(
                            &mut connection,
                            command,
                            tokens.as_mut(),
                        ));
                    }
                    Envelope::WorkingDraft { command, reply } => {
                        let _ = reply.send(working_drafts::execute(&mut connection, command));
                    }
                    Envelope::Publication { command, reply } => {
                        let _ = reply.send(plan_publication::execute(
                            &mut connection,
                            command,
                            tokens.as_mut(),
                        ));
                    }
                    Envelope::RequiredUnits { command, reply } => {
                        let _ = reply.send(required_units::execute(&mut connection, command));
                    }
                    Envelope::Checkoff { command, reply } => {
                        let _ = reply.send(checkoff_progress::execute(&mut connection, command));
                    }
                    Envelope::Uploads { command, reply } => {
                        let changes_accounting = command.changes_accounting();
                        jobs::begin_observation_collection();
                        let result = uploads::execute(&mut connection, &catalog_state, command);
                        worker
                            .job_subscriptions
                            .publish(jobs::finish_observation_collection());
                        if result.is_ok() && changes_accounting {
                            worker.import_epoch.fetch_add(1, Ordering::AcqRel);
                        }
                        let _ = reply.send(result);
                    }
                    Envelope::Read { command, reply } => {
                        let _ = reply.send(read_model::execute(&mut connection, command));
                    }
                    Envelope::Catalog { command, reply } => {
                        let _ = reply.send(catalog::execute(
                            &mut connection,
                            &mut catalog_state,
                            command,
                        ));
                    }
                    Envelope::CatalogRequest { command, reply } => {
                        let result = catalog::execute(&mut connection, &mut catalog_state, command)
                            .and_then(|r| match r {
                                catalog::Reply::Outcome(o) => Ok(o),
                                _ => Err(anyhow!("Unexpected catalog reply")),
                            });
                        let _ = reply.send(result);
                    }
                    Envelope::Jobs { command, reply } => {
                        let _ = reply.send(jobs::execute(
                            &mut connection,
                            &mut catalog_state,
                            command,
                            &worker.job_subscriptions,
                        ));
                    }
                    Envelope::NativeSecrets { command, reply } => {
                        let _ =
                            reply.send(native_secrets::execute(&mut connection, &worker, command));
                    }
                    Envelope::Setting { work, reply } => {
                        let _ = reply.send(execute(&mut connection, work));
                    }
                    Envelope::AuthReady { .. } => unreachable!(),
                }
            }
            drop(connection);
        });
        Ok((
            Self {
                client: SettingsClient { shared, readers },
                join: Some(join),
                lease: Some(lease),
            },
            ready,
        ))
    }
    pub fn client(&self) -> SettingsClient {
        self.client.clone()
    }
    pub fn backup(&self, destination: &Path) -> Result<()> {
        let lease = self
            .lease
            .as_ref()
            .ok_or_else(|| anyhow!("Storage stopped"))?;
        let parent = destination
            .parent()
            .ok_or_else(|| anyhow!("Backup parent missing"))?
            .canonicalize()?;
        let name = destination
            .file_name()
            .ok_or_else(|| anyhow!("Backup file name missing"))?;
        let managed_runtime = match lease.runtime_dir().canonicalize() {
            Ok(runtime) => parent.starts_with(runtime),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        ensure!(
            !parent.starts_with(lease.data_dir()) && !managed_runtime,
            "Backup destination is inside managed storage"
        );
        let destination = parent.join(name);
        ensure!(
            destination
                .symlink_metadata()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
            "Backup destination must be a new file"
        );
        let reply = self.client.enqueue(
            Work::Backup(destination.to_owned()),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?;
        reply
            .recv()
            .map_err(|_| anyhow!("Writer stopped without backup result"))??;
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        self.client.shared.job_subscriptions.stop_owner();
        {
            let mut queue = self
                .client
                .shared
                .queue
                .lock()
                .map_err(|_| anyhow!("Writer admission poisoned"))?;
            queue.closed = true;
            self.client.shared.changed.notify_all();
        }
        {
            let mut readers = self
                .client
                .readers
                .state
                .lock()
                .map_err(|_| anyhow!("Reader pool poisoned"))?;
            readers.closed = true;
            readers.idle.clear();
            self.client.readers.changed.notify_all();
            while readers.active > 0 {
                readers = self
                    .client
                    .readers
                    .changed
                    .wait(readers)
                    .map_err(|_| anyhow!("Reader pool poisoned"))?;
            }
        }
        if let Some(join) = self.join.take() {
            join.join().map_err(|_| anyhow!("Writer join failed"))?;
        }
        if let Some(lease) = self.lease.take() {
            let released = lease.release();
            ensure!(
                released.marker_removed && released.runtime_removed && released.lock_released,
                "Storage cleanup failed; ownership retained until explicit retry or process exit"
            );
        }
        Ok(())
    }
    pub fn shutdown(mut self) -> Result<()> {
        let result = self.close();
        if result.is_err()
            && let Some(lease) = self.lease.take()
        {
            lease.retain_until_process_exit();
        }
        result
    }
}
impl Drop for WriterOwner {
    fn drop(&mut self) {
        if self.close().is_err()
            && let Some(lease) = self.lease.take()
        {
            lease.retain_until_process_exit();
        }
    }
}

#[cfg(test)]
mod tests;
