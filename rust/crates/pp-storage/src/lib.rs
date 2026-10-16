#[cfg(feature = "desktop_rebuild")]
mod auth_scheduler;
#[cfg(feature = "desktop_rebuild")]
use auth_scheduler::*;
pub mod auth;
#[cfg(feature = "desktop_rebuild")]
pub mod build_graph;
pub mod catalog;
#[cfg(feature = "desktop_rebuild")]
pub mod features;
pub mod jobs;
pub mod lease;
#[cfg(feature = "desktop_rebuild")]
pub mod manifest_options;
#[cfg(feature = "desktop_rebuild")]
pub mod manifest_text;
#[cfg(feature = "desktop_rebuild")]
pub mod native_secrets;
#[cfg(feature = "desktop_rebuild")]
pub mod profiles;
pub mod read_model;
mod schema;
#[cfg(feature = "desktop_rebuild")]
pub mod working_drafts;
mod writer_admission;

use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
pub use schema::SchemaReady;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
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
const READER_DRAIN: Duration = Duration::from_secs(5);
enum Work {
    Setting(SettingCommand),
    Backup(PathBuf),
}
enum WriterControl {
    PageCount,
    AdmitDiskQuota(u32),
}
enum Envelope {
    #[cfg(feature = "desktop_rebuild")]
    BuildGraph {
        command: build_graph::Command,
        reply: build_graph::Reply,
    },
    #[cfg(feature = "desktop_rebuild")]
    NativeSecrets {
        command: native_secrets::Command,
        reply: native_secrets::Reply,
    },
    #[cfg(feature = "desktop_rebuild")]
    Features {
        command: features::Command,
        reply: mpsc::Sender<Result<features::View>>,
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
    Setting {
        work: Work,
        reply: mpsc::Sender<Result<bool>>,
    },
    Auth {
        command: auth::Command,
        policy: auth::AuthPolicy,
        reply: mpsc::Sender<Result<auth::Reply>>,
    },
    WriterControl {
        control: WriterControl,
        reply: mpsc::Sender<Result<u32>>,
    },
}
#[cfg(feature = "desktop_rebuild")]
fn stop_poisoned_queue(
    error: std::sync::PoisonError<std::sync::MutexGuard<'_, Queue>>,
) -> std::sync::MutexGuard<'_, Queue> {
    let mut queue = error.into_inner();
    queue.closed = true;
    queue.pending.clear();
    for work in queue.auth_ready.drain(..) {
        auth::rebuild::finish_stopped(work);
    }
    queue
}

struct Queue {
    #[cfg(feature = "desktop_rebuild")]
    auth_ready: VecDeque<auth::rebuild::WriterWork>,
    #[cfg(feature = "desktop_rebuild")]
    next: QueueClass,
    closed: bool,
    pending: VecDeque<Envelope>,
}
struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
    capacity: usize,
    job_admission: Mutex<Option<Arc<jobs::WorkerAdmission>>>,
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
fn writer_control(connection: &Connection, control: WriterControl) -> Result<u32> {
    match control {
        WriterControl::PageCount => {
            let pages: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
            u32::try_from(pages).map_err(|_| anyhow!("Database page count exceeds u32"))
        }
        WriterControl::AdmitDiskQuota(max_pages) => {
            // SQLite clamps max_page_count: a value below the current page
            // count becomes that count, and a value above 0xfffffffe becomes
            // 0xfffffffe. Reject both before the PRAGMA so a refusal leaves
            // the previous limit unchanged.
            const SQLITE_MAX_PAGE_COUNT: u32 = 0xffff_fffe;
            ensure!(max_pages > 0, "Disk quota must be positive");
            ensure!(
                max_pages <= SQLITE_MAX_PAGE_COUNT,
                "Disk quota {max_pages} exceeds the SQLite page limit"
            );
            let pages: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
            ensure!(
                i64::from(max_pages) >= pages,
                "Disk quota {max_pages} is below the current database size"
            );
            connection.pragma_update(None, "max_page_count", i64::from(max_pages))?;
            let applied: i64 =
                connection.query_row("PRAGMA max_page_count", [], |row| row.get(0))?;
            ensure!(
                applied == i64::from(max_pages),
                "Disk quota {max_pages} is below the current database size"
            );
            Ok(max_pages)
        }
    }
}
fn execute(
    connection: &mut Connection,
    work: Work,
    admission: writer_admission::Deadline,
) -> Result<bool> {
    let command = match work {
        Work::Setting(command) => command,
        Work::Backup(path) => {
            schema::backup(connection, &path, false)?;
            return Ok(true);
        }
    };
    #[cfg(test)]
    tests::observe_setting(|attempts| attempts.executions += 1);
    let tx = writer_admission::begin_immediate(connection, admission)?;
    let setting = match command {
        SettingCommand::Set(setting) => setting,
        SettingCommand::CompareAndSet { setting, expected } => {
            if snapshot(&tx, &setting.tenant, &setting.key)? != expected {
                #[cfg(test)]
                tests::observe_setting(|attempts| attempts.commits += 1);
                tx.commit()?;
                return Ok(false);
            }
            setting
        }
    };
    #[cfg(test)]
    tests::observe_setting(|attempts| attempts.inserts += 1);
    tx.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value",params![setting.tenant,setting.key,setting.value])?;
    #[cfg(test)]
    tests::observe_setting(|attempts| attempts.commits += 1);
    tx.commit()?;
    Ok(true)
}
impl SettingsClient {
    #[cfg(feature = "desktop_rebuild")]
    pub(crate) fn enqueue_auth(&self, work: auth::rebuild::WriterWork) {
        let mut queue = self.shared.queue.lock().unwrap_or_else(stop_poisoned_queue);
        if queue.closed {
            self.shared.changed.notify_all();
            drop(queue);
            auth::rebuild::finish_stopped(work);
            return;
        }
        queue.auth_ready.push_back(work);
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
        Self::open_with_effect_policy(directory, limits, jobs::EffectAdmissionPolicy::Legacy)
    }

    /// Enforces feature choices for new Spoolman deductions on every worker.
    /// Call this constructor again on reopen to retain admission enforcement.
    #[cfg(feature = "desktop_rebuild")]
    pub fn open_with_job_feature_admission(
        directory: &Path,
        limits: Limits,
    ) -> Result<(Self, SchemaReady)> {
        Self::open_with_effect_policy(
            directory,
            limits,
            jobs::EffectAdmissionPolicy::EnforceFeatures,
        )
    }

    fn open_with_effect_policy(
        directory: &Path,
        limits: Limits,
        effect_policy: jobs::EffectAdmissionPolicy,
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
        Self::open_at_with_effect_policy(directory, limits, &timestamp, effect_policy)
    }

    pub fn open_at(
        directory: &Path,
        limits: Limits,
        seed_timestamp: &str,
    ) -> Result<(Self, SchemaReady)> {
        Self::open_at_with_effect_policy(
            directory,
            limits,
            seed_timestamp,
            jobs::EffectAdmissionPolicy::Legacy,
        )
    }

    fn open_at_with_effect_policy(
        directory: &Path,
        limits: Limits,
        seed_timestamp: &str,
        effect_policy: jobs::EffectAdmissionPolicy,
    ) -> Result<(Self, SchemaReady)> {
        ensure!(
            limits.queued_writes > 0 && limits.readers > 0,
            "Storage limits must be positive"
        );
        let admitted = lease::admit_directory(directory)?;
        admitted.preflight()?;
        let lease = lease::StorageLease::acquire_admitted(admitted)?;
        let path = lease.data_dir().join("print-partner.db");
        let version = lease.preflight()?;
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
                #[cfg(feature = "desktop_rebuild")]
                auth_ready: VecDeque::new(),
                #[cfg(feature = "desktop_rebuild")]
                next: QueueClass::Normal,
                closed: false,
                pending: VecDeque::new(),
            }),
            changed: Condvar::new(),
            capacity: limits.queued_writes,
            job_admission: Mutex::new(None),
        });
        let worker = shared.clone();
        let mut catalog_state = catalog::State::new(lease.data_dir().to_owned());
        let join = thread::spawn(move || {
            loop {
                #[cfg(not(feature = "desktop_rebuild"))]
                let (envelope, admission) = {
                    let mut queue = worker.queue.lock().expect("Writer admission poisoned");
                    while queue.pending.is_empty() && !queue.closed {
                        queue = worker
                            .changed
                            .wait(queue)
                            .expect("Writer admission poisoned");
                    }
                    match queue.pending.pop_front() {
                        Some(envelope) => {
                            let admission = writer_admission::Deadline::at_dequeue();
                            worker.changed.notify_all();
                            (envelope, admission)
                        }
                        None => break,
                    }
                };
                #[cfg(feature = "desktop_rebuild")]
                let scheduled = {
                    let mut queue = worker.queue.lock().unwrap_or_else(stop_poisoned_queue);
                    loop {
                        if let Some(scheduled) = schedule(&mut queue, Instant::now()) {
                            worker.changed.notify_all();
                            break Some((scheduled, writer_admission::Deadline::at_dequeue()));
                        }
                        if queue.closed && queue.pending.is_empty() && queue.auth_ready.is_empty() {
                            break None;
                        }
                        if let Some(retry) = queue
                            .auth_ready
                            .iter()
                            .filter_map(|work| work.retry_at())
                            .min()
                        {
                            let wait = retry.saturating_duration_since(Instant::now());
                            queue = worker
                                .changed
                                .wait_timeout(queue, wait)
                                .map(|(queue, _)| queue)
                                .unwrap_or_else(|error| {
                                    stop_poisoned_queue(std::sync::PoisonError::new(
                                        error.into_inner().0,
                                    ))
                                });
                        } else {
                            queue = worker
                                .changed
                                .wait(queue)
                                .unwrap_or_else(stop_poisoned_queue);
                        }
                    }
                };
                #[cfg(feature = "desktop_rebuild")]
                let Some((scheduled, admission)) = scheduled else {
                    break;
                };
                #[cfg(feature = "desktop_rebuild")]
                let envelope = match scheduled {
                    Scheduled::Normal(envelope) => envelope,
                    Scheduled::Auth(work) => {
                        if let Some(retry) =
                            auth::rebuild::advance(&mut connection, work, admission)
                        {
                            let mut queue = worker.queue.lock().unwrap_or_else(stop_poisoned_queue);
                            queue.auth_ready.push_back(retry);
                            worker.changed.notify_all();
                        }
                        continue;
                    }
                };
                match envelope {
                    #[cfg(feature = "desktop_rebuild")]
                    Envelope::NativeSecrets { command, reply } => {
                        let _ = reply.send(native_secrets::execute(
                            &mut connection,
                            &worker,
                            command,
                            admission,
                        ));
                    }
                    #[cfg(feature = "desktop_rebuild")]
                    Envelope::Features { command, reply } => {
                        let _ = reply.send(features::execute(&mut connection, command, admission));
                    }
                    #[cfg(feature = "desktop_rebuild")]
                    Envelope::BuildGraph { command, reply } => {
                        reply.send(build_graph::execute(&mut connection, command, admission));
                    }
                    Envelope::Read { command, reply } => {
                        let _ = reply.send(read_model::execute(&mut connection, command));
                    }
                    Envelope::Catalog { command, reply } => {
                        let _ = reply.send(catalog::execute(
                            &mut connection,
                            &mut catalog_state,
                            command,
                            admission,
                        ));
                    }
                    Envelope::CatalogRequest { command, reply } => {
                        let result = catalog::execute(
                            &mut connection,
                            &mut catalog_state,
                            command,
                            admission,
                        )
                        .and_then(|r| match r {
                            catalog::Reply::Outcome(o) => Ok(o),
                            _ => Err(anyhow!("Unexpected catalog reply")),
                        });
                        let _ = reply.send(result);
                    }
                    Envelope::Jobs { command, reply } => {
                        let _ = reply.send(jobs::execute(
                            &mut connection,
                            command,
                            effect_policy,
                            admission,
                        ));
                    }
                    Envelope::Setting { work, reply } => {
                        let _ = reply.send(execute(&mut connection, work, admission));
                    }
                    Envelope::Auth {
                        command,
                        policy,
                        reply,
                    } => {
                        let _ =
                            reply.send(auth::execute(&mut connection, command, policy, admission));
                    }
                    Envelope::WriterControl { control, reply } => {
                        let _ = reply.send(writer_control(&connection, control));
                    }
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

    pub fn database_pages(&self) -> Result<u32> {
        self.writer_control(WriterControl::PageCount)
    }

    pub fn admit_disk_quota(&self, max_pages: u32) -> Result<u32> {
        self.writer_control(WriterControl::AdmitDiskQuota(max_pages))
    }

    fn writer_control(&self, control: WriterControl) -> Result<u32> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let receiver = {
            let mut queue = self
                .client
                .shared
                .queue
                .lock()
                .map_err(|_| anyhow!("Writer admission poisoned"))?;
            loop {
                ensure!(!queue.closed, "Storage stopped");
                if queue.pending.len() < self.client.shared.capacity {
                    let (reply, receiver) = mpsc::channel();
                    queue
                        .pending
                        .push_back(Envelope::WriterControl { control, reply });
                    self.client.shared.changed.notify_all();
                    break receiver;
                }
                ensure!(Instant::now() < deadline, "Writer queue full");
                queue = self
                    .client
                    .shared
                    .changed
                    .wait_timeout(queue, Duration::from_millis(5))
                    .map_err(|_| anyhow!("Writer admission poisoned"))?
                    .0;
            }
        };
        receiver
            .recv()
            .map_err(|_| anyhow!("Writer stopped without disk quota result"))?
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
        if self.join.is_none() && self.lease.is_none() {
            return Ok(());
        }
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
        let remaining_readers = {
            let mut readers = self
                .client
                .readers
                .state
                .lock()
                .map_err(|_| anyhow!("Reader pool poisoned"))?;
            readers.closed = true;
            readers.idle.clear();
            self.client.readers.changed.notify_all();
            let deadline = Instant::now() + READER_DRAIN;
            while readers.active > 0 && Instant::now() < deadline {
                readers = self
                    .client
                    .readers
                    .changed
                    .wait_timeout(readers, deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| anyhow!("Reader pool poisoned"))?
                    .0;
            }
            readers.active
        };
        if let Some(join) = self.join.take() {
            join.join().map_err(|_| anyhow!("Writer join failed"))?;
        }
        ensure!(
            remaining_readers == 0,
            "Reader checkouts still active after {}s: {remaining_readers}; ownership retained until process exit",
            READER_DRAIN.as_secs()
        );
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
