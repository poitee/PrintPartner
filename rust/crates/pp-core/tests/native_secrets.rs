use pp_core::native_secrets::{
    MigrationOutcome, NativeSecretMigrator, NativeSecretStore, NativeStoreFailure, PutOutcome,
    StoreError,
};
use pp_storage::{
    Limits, Setting, SettingCommand, WriterOwner,
    native_secrets::{SecretLocator, SecretMaterial},
};
use rusqlite::{Connection, OptionalExtension};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-core-native-secret-{name}-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn set_legacy(owner: &WriterOwner, value: &str) {
    owner
        .client()
        .submit(
            SettingCommand::Set(Setting {
                tenant: "default".into(),
                key: "github_pat".into(),
                value: value.into(),
            }),
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
}

#[derive(Default)]
struct StoreState {
    items: BTreeMap<String, Vec<u8>>,
    writes: Vec<String>,
    reads: Vec<String>,
    put_failure: Option<NativeStoreFailure>,
    read_failure: Option<NativeStoreFailure>,
    read_missing: bool,
    read_mismatch: bool,
}

#[derive(Default)]
struct BlockingCall {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl BlockingCall {
    fn enter_and_wait(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn wait_until_entered(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.0 {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.1 = true;
        self.changed.notify_all();
    }
}

struct InspectingStore {
    database: PathBuf,
    state: Arc<Mutex<StoreState>>,
    blocking: Option<Arc<BlockingCall>>,
}

impl NativeSecretStore for InspectingStore {
    fn put_new_or_verify(
        &mut self,
        locator: &SecretLocator,
        secret: &SecretMaterial,
    ) -> Result<PutOutcome, StoreError> {
        let connection = Connection::open(&self.database)
            .map_err(|_| StoreError::new(NativeStoreFailure::Unavailable))?;
        let persisted: (String, i64, String) = connection
            .query_row(
                "SELECT state,generation,migration_id FROM native_secret_migrations WHERE tenant_id='default' AND purpose='github_pat'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| StoreError::new(NativeStoreFailure::Unavailable))?;
        assert_eq!(persisted.0, "prepared");
        assert_eq!(persisted.1, locator.generation());
        assert!(locator.account().ends_with(&persisted.2));

        if let Some(blocking) = &self.blocking {
            blocking.enter_and_wait();
        }
        let mut state = self.state.lock().unwrap();
        state.writes.push(locator.account().to_owned());
        if let Some(failure) = state.put_failure {
            if failure == NativeStoreFailure::ReplyLost {
                state
                    .items
                    .entry(locator.account().to_owned())
                    .or_insert_with(|| secret.expose().to_vec());
            }
            return Err(StoreError::new(failure));
        }
        match state.items.get(locator.account()) {
            Some(value) if secret.matches_bytes(value) => Ok(PutOutcome::AlreadyPresent),
            Some(_) => Err(StoreError::new(NativeStoreFailure::Conflict)),
            None => {
                state
                    .items
                    .insert(locator.account().to_owned(), secret.expose().to_vec());
                Ok(PutOutcome::Created)
            }
        }
    }

    fn read(&mut self, locator: &SecretLocator) -> Result<Option<SecretMaterial>, StoreError> {
        let mut state = self.state.lock().unwrap();
        state.reads.push(locator.account().to_owned());
        if let Some(failure) = state.read_failure {
            return Err(StoreError::new(failure));
        }
        if state.read_missing {
            return Ok(None);
        }
        if state.read_mismatch {
            return Ok(Some(SecretMaterial::new(vec![0x55; 31])));
        }
        Ok(state
            .items
            .get(locator.account())
            .cloned()
            .map(SecretMaterial::new))
    }
}

fn migrator(
    owner: &WriterOwner,
    root: &Path,
    state: Arc<Mutex<StoreState>>,
) -> NativeSecretMigrator<InspectingStore> {
    NativeSecretMigrator::new(
        owner,
        InspectingStore {
            database: root.join("print-partner.db"),
            state,
            blocking: None,
        },
    )
}

fn row_count(root: &Path, table: &str) -> i64 {
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn legacy_value(owner: &WriterOwner) -> Option<String> {
    owner
        .client()
        .reader(Duration::from_secs(5))
        .unwrap()
        .get_setting("default", "github_pat", None)
        .unwrap()
}

fn stored_legacy_value(root: &Path) -> Option<String> {
    Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='github_pat'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

fn assert_legacy_matches(owner: &WriterOwner, expected: &str) {
    assert!(
        legacy_value(owner).is_some_and(|value| value.as_bytes() == expected.as_bytes()),
        "legacy value did not match"
    );
}

fn assert_persisted_metadata_excludes(root: &Path, sentinel: &str) {
    let connection = Connection::open(root.join("print-partner.db")).unwrap();
    let receipt_contains: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM native_secret_migrations
                 WHERE instr(tenant_id || purpose || migration_id || state, ?1) > 0
            )",
            [sentinel],
            |row| row.get(0),
        )
        .unwrap();
    let job_contains: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM durable_jobs WHERE instr(document, ?1) > 0)",
            [sentinel],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!receipt_contains);
    assert!(!job_contains);
}

#[test]
fn prepared_locator_precedes_native_write_and_survives_reopen() {
    let root = directory("prepared-restart");
    let state = Arc::new(Mutex::new(StoreState::default()));
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);

    assert_eq!(
        migrator(&owner, &root, state.clone())
            .migrate_github_pat(&AtomicBool::new(false))
            .unwrap(),
        MigrationOutcome::LegacyRowRemoved
    );
    let first_locator = state.lock().unwrap().writes[0].clone();
    owner.shutdown().unwrap();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(
        migrator(&owner, &root, state.clone())
            .migrate_github_pat(&AtomicBool::new(false))
            .unwrap(),
        MigrationOutcome::LegacyRowRemoved
    );
    let state = state.lock().unwrap();
    assert_eq!(state.writes, vec![first_locator.clone()]);
    assert_eq!(state.reads, vec![first_locator.clone(), first_locator]);
    drop(state);

    let reader = owner.client().reader(Duration::from_secs(5)).unwrap();
    assert_eq!(
        reader.snapshot("default", "github_pat").unwrap(),
        pp_storage::SettingSnapshot::Missing
    );
    drop(reader);
    owner.shutdown().unwrap();
    assert_persisted_metadata_excludes(&root, &sentinel);
}

#[test]
fn absent_legacy_value_is_stable_across_reopen_without_store_calls() {
    let root = directory("absent");
    let state = Arc::new(Mutex::new(StoreState::default()));
    for _ in 0..2 {
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        assert_eq!(
            migrator(&owner, &root, state.clone())
                .migrate_github_pat(&AtomicBool::new(false))
                .unwrap(),
            MigrationOutcome::Absent
        );
        owner.shutdown().unwrap();
    }
    let state = state.lock().unwrap();
    assert!(state.writes.is_empty());
    assert!(state.reads.is_empty());
    assert_eq!(row_count(&root, "native_secret_migrations"), 0);
}

#[test]
fn cleared_legacy_row_is_absent_across_reopen_without_store_calls() {
    let root = directory("cleared-legacy");
    let state = Arc::new(Mutex::new(StoreState::default()));
    for _ in 0..2 {
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        if stored_legacy_value(&root).is_none() {
            set_legacy(&owner, "");
        }
        assert_eq!(legacy_value(&owner), None);
        assert_eq!(stored_legacy_value(&root).as_deref(), Some(""));
        assert_eq!(
            migrator(&owner, &root, state.clone())
                .migrate_github_pat(&AtomicBool::new(false))
                .unwrap(),
            MigrationOutcome::Absent
        );
        assert_eq!(stored_legacy_value(&root).as_deref(), Some(""));
        assert_eq!(row_count(&root, "native_secret_migrations"), 0);
        owner.shutdown().unwrap();
    }
    let state = state.lock().unwrap();
    assert!(state.writes.is_empty());
    assert!(state.reads.is_empty());
}

#[test]
fn cleared_prepared_row_fails_before_retrying_native_store() {
    let root = directory("cleared-prepared");
    let original = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let state = Arc::new(Mutex::new(StoreState {
        put_failure: Some(NativeStoreFailure::ReplyLost),
        ..StoreState::default()
    }));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &original);
    let error = migrator(&owner, &root, state.clone())
        .migrate_github_pat(&AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Store(NativeStoreFailure::ReplyLost)
    );
    set_legacy(&owner, "");
    assert_eq!(stored_legacy_value(&root).as_deref(), Some(""));
    owner.shutdown().unwrap();

    state.lock().unwrap().put_failure = None;
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let error = migrator(&owner, &root, state.clone())
        .migrate_github_pat(&AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Storage(
            pp_storage::native_secrets::StorageFailure::LegacyChanged
        )
    );
    assert_eq!(stored_legacy_value(&root).as_deref(), Some(""));
    assert_eq!(row_count(&root, "native_secret_migrations"), 1);
    let state = state.lock().unwrap();
    assert_eq!(state.writes.len(), 1);
    assert!(state.reads.is_empty());
    assert_eq!(state.items.len(), 1);
    drop(state);
    owner.shutdown().unwrap();
}

#[test]
fn completed_receipt_refuses_new_legacy_data_before_native_read() {
    let root = directory("completed-new-legacy");
    let state = Arc::new(Mutex::new(StoreState::default()));
    let original = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let replacement = format!("replacement-{}", hex::encode(rand::random::<[u8; 16]>()));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &original);
    assert_eq!(
        migrator(&owner, &root, state.clone())
            .migrate_github_pat(&AtomicBool::new(false))
            .unwrap(),
        MigrationOutcome::LegacyRowRemoved
    );
    set_legacy(&owner, &replacement);
    let error = migrator(&owner, &root, state.clone())
        .migrate_github_pat(&AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Storage(
            pp_storage::native_secrets::StorageFailure::LegacyChanged
        )
    );
    assert_legacy_matches(&owner, &replacement);
    let state = state.lock().unwrap();
    assert_eq!(state.writes.len(), 1);
    assert_eq!(state.reads.len(), 1);
    drop(state);
    owner.shutdown().unwrap();
}

#[test]
fn nonempty_whitespace_is_migrated_byte_exactly() {
    let root = directory("whitespace");
    let state = Arc::new(Mutex::new(StoreState::default()));
    let value = " \t ";
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, value);
    assert_eq!(
        migrator(&owner, &root, state.clone())
            .migrate_github_pat(&AtomicBool::new(false))
            .unwrap(),
        MigrationOutcome::LegacyRowRemoved
    );
    let state = state.lock().unwrap();
    assert_eq!(state.items.len(), 1);
    assert!(
        state
            .items
            .values()
            .any(|stored| stored == value.as_bytes())
    );
    drop(state);
    owner.shutdown().unwrap();
}

#[test]
fn native_failures_keep_prepared_state_and_legacy_row() {
    enum FailureCase {
        Put,
        Read,
        Missing,
        Mismatch,
    }
    for case in [
        FailureCase::Put,
        FailureCase::Read,
        FailureCase::Missing,
        FailureCase::Mismatch,
    ] {
        let root = directory("fail-closed");
        let sentinel = format!(
            "owned-test-token-{}",
            hex::encode(rand::random::<[u8; 16]>())
        );
        let mut store = StoreState::default();
        let expected = match case {
            FailureCase::Put => {
                store.put_failure = Some(NativeStoreFailure::Unavailable);
                pp_core::native_secrets::MigrationFailure::Store(NativeStoreFailure::Unavailable)
            }
            FailureCase::Read => {
                store.read_failure = Some(NativeStoreFailure::Unavailable);
                pp_core::native_secrets::MigrationFailure::Store(NativeStoreFailure::Unavailable)
            }
            FailureCase::Missing => {
                store.read_missing = true;
                pp_core::native_secrets::MigrationFailure::MissingNativeSecret
            }
            FailureCase::Mismatch => {
                store.read_mismatch = true;
                pp_core::native_secrets::MigrationFailure::NativeSecretMismatch
            }
        };
        let state = Arc::new(Mutex::new(store));
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        set_legacy(&owner, &sentinel);
        let error = migrator(&owner, &root, state)
            .migrate_github_pat(&AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.failure(), expected);
        assert!(!format!("{error:?}{error}").contains(&sentinel));
        assert_legacy_matches(&owner, &sentinel);
        assert_eq!(row_count(&root, "native_secret_migrations"), 1);
        owner.shutdown().unwrap();
    }
}

#[test]
fn lost_write_reply_reuses_the_prepared_locator() {
    let root = directory("lost-reply");
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let state = Arc::new(Mutex::new(StoreState {
        put_failure: Some(NativeStoreFailure::ReplyLost),
        ..StoreState::default()
    }));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);
    let error = migrator(&owner, &root, state.clone())
        .migrate_github_pat(&AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Store(NativeStoreFailure::ReplyLost)
    );
    let locator = state.lock().unwrap().writes[0].clone();
    owner.shutdown().unwrap();

    state.lock().unwrap().put_failure = None;
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(
        migrator(&owner, &root, state.clone())
            .migrate_github_pat(&AtomicBool::new(false))
            .unwrap(),
        MigrationOutcome::LegacyRowRemoved
    );
    assert_eq!(state.lock().unwrap().writes, vec![locator.clone(), locator]);
    assert_eq!(legacy_value(&owner), None);
    owner.shutdown().unwrap();
}

#[test]
fn changed_legacy_value_blocks_confirmation_without_removing_native_entry() {
    let root = directory("changed-legacy");
    let original = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let replacement = format!("replacement-{}", hex::encode(rand::random::<[u8; 16]>()));
    let blocking = Arc::new(BlockingCall::default());
    let state = Arc::new(Mutex::new(StoreState::default()));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &original);
    let service = Arc::new(NativeSecretMigrator::new(
        &owner,
        InspectingStore {
            database: root.join("print-partner.db"),
            state: state.clone(),
            blocking: Some(blocking.clone()),
        },
    ));
    let task_service = service.clone();
    let task = thread::spawn(move || task_service.migrate_github_pat(&AtomicBool::new(false)));
    blocking.wait_until_entered();
    set_legacy(&owner, &replacement);
    blocking.release();

    let error = task.join().unwrap().unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Storage(
            pp_storage::native_secrets::StorageFailure::LegacyChanged
        )
    );
    assert_legacy_matches(&owner, &replacement);
    let state = state.lock().unwrap();
    assert_eq!(state.items.len(), 1);
    assert!(
        state
            .items
            .values()
            .any(|value| value == original.as_bytes())
    );
    drop(state);
    owner.shutdown().unwrap();
}

#[test]
fn blocking_store_allows_writer_progress_and_cancel_after_return() {
    let root = directory("blocking-cancel");
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let blocking = Arc::new(BlockingCall::default());
    let state = Arc::new(Mutex::new(StoreState::default()));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);
    let service = Arc::new(NativeSecretMigrator::new(
        &owner,
        InspectingStore {
            database: root.join("print-partner.db"),
            state,
            blocking: Some(blocking.clone()),
        },
    ));
    let task_service = service.clone();
    let task_cancelled = cancelled.clone();
    let task = thread::spawn(move || task_service.migrate_github_pat(&task_cancelled));
    blocking.wait_until_entered();

    let busy = service
        .migrate_github_pat(&AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(
        busy.failure(),
        pp_core::native_secrets::MigrationFailure::Busy
    );

    owner
        .client()
        .submit(
            SettingCommand::Set(Setting {
                tenant: "default".into(),
                key: "unrelated".into(),
                value: "progressed".into(),
            }),
            &AtomicBool::new(false),
            Duration::from_secs(1),
        )
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    cancelled.store(true, Ordering::Release);
    blocking.release();

    let error = task.join().unwrap().unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Cancelled
    );
    assert_legacy_matches(&owner, &sentinel);
    assert_eq!(
        owner
            .client()
            .reader(Duration::from_secs(1))
            .unwrap()
            .get_setting("default", "unrelated", None)
            .unwrap()
            .as_deref(),
        Some("progressed")
    );
    owner.shutdown().unwrap();
}

#[test]
fn conflicting_native_value_keeps_the_legacy_row() {
    let root = directory("conflict");
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let blocking = Arc::new(BlockingCall::default());
    let state = Arc::new(Mutex::new(StoreState::default()));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);
    let service = Arc::new(NativeSecretMigrator::new(
        &owner,
        InspectingStore {
            database: root.join("print-partner.db"),
            state: state.clone(),
            blocking: Some(blocking.clone()),
        },
    ));
    let task_service = service.clone();
    let task = thread::spawn(move || task_service.migrate_github_pat(&AtomicBool::new(false)));
    blocking.wait_until_entered();
    let migration_id: String = Connection::open(root.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT migration_id FROM native_secret_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let account = format!("native-secret/v1/default/github_pat/1/{migration_id}");
    state.lock().unwrap().items.insert(account, vec![0x33; 17]);
    blocking.release();

    let error = task.join().unwrap().unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Store(NativeStoreFailure::Conflict)
    );
    assert_legacy_matches(&owner, &sentinel);
    assert_eq!(state.lock().unwrap().items.len(), 1);
    owner.shutdown().unwrap();
}

#[test]
fn superseded_generation_cannot_remove_legacy_or_native_entries() {
    let root = directory("superseded");
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let blocking = Arc::new(BlockingCall::default());
    let state = Arc::new(Mutex::new(StoreState::default()));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);
    let service = Arc::new(NativeSecretMigrator::new(
        &owner,
        InspectingStore {
            database: root.join("print-partner.db"),
            state: state.clone(),
            blocking: Some(blocking.clone()),
        },
    ));
    let task_service = service.clone();
    let task = thread::spawn(move || task_service.migrate_github_pat(&AtomicBool::new(false)));
    blocking.wait_until_entered();
    let replacement_id = "a".repeat(64);
    let connection = Connection::open(root.join("print-partner.db")).unwrap();
    connection
        .execute(
            "UPDATE native_secret_migrations SET generation=2,migration_id=?1",
            [&replacement_id],
        )
        .unwrap();
    drop(connection);
    let replacement_account = format!("native-secret/v1/default/github_pat/2/{replacement_id}");
    state
        .lock()
        .unwrap()
        .items
        .insert(replacement_account.clone(), vec![0x44; 19]);
    blocking.release();

    let error = task.join().unwrap().unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Storage(
            pp_storage::native_secrets::StorageFailure::Superseded
        )
    );
    assert_legacy_matches(&owner, &sentinel);
    let state = state.lock().unwrap();
    assert_eq!(state.items.len(), 2);
    assert!(state.items.contains_key(&replacement_account));
    drop(state);
    owner.shutdown().unwrap();
}

#[test]
fn storage_stop_during_native_call_cannot_publish_success() {
    let root = directory("stop-during-native");
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let blocking = Arc::new(BlockingCall::default());
    let state = Arc::new(Mutex::new(StoreState::default()));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);
    let service = Arc::new(NativeSecretMigrator::new(
        &owner,
        InspectingStore {
            database: root.join("print-partner.db"),
            state,
            blocking: Some(blocking.clone()),
        },
    ));
    let task_service = service.clone();
    let task = thread::spawn(move || task_service.migrate_github_pat(&AtomicBool::new(false)));
    blocking.wait_until_entered();
    owner.shutdown().unwrap();
    blocking.release();

    let error = task.join().unwrap().unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Storage(
            pp_storage::native_secrets::StorageFailure::Stopped
        )
    );
    let connection = Connection::open(root.join("print-partner.db")).unwrap();
    let value: String = connection
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='github_pat'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        value.as_bytes() == sentinel.as_bytes(),
        "legacy value did not match"
    );
}

#[test]
fn cancellation_before_admission_has_no_external_effect() {
    let root = directory("cancel-before-admission");
    let sentinel = format!(
        "owned-test-token-{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let state = Arc::new(Mutex::new(StoreState::default()));
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    set_legacy(&owner, &sentinel);
    let error = migrator(&owner, &root, state.clone())
        .migrate_github_pat(&AtomicBool::new(true))
        .unwrap_err();
    assert_eq!(
        error.failure(),
        pp_core::native_secrets::MigrationFailure::Storage(
            pp_storage::native_secrets::StorageFailure::Cancelled
        )
    );
    let state = state.lock().unwrap();
    assert!(state.writes.is_empty());
    assert!(state.reads.is_empty());
    drop(state);
    assert_eq!(row_count(&root, "native_secret_migrations"), 0);
    owner.shutdown().unwrap();
}
