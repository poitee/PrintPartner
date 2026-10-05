use crate::{Envelope, SettingsClient, Shared, WriterOwner};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{
    error::Error,
    fmt,
    sync::{Arc, atomic::AtomicBool, mpsc},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

const TENANT: &str = "default";
const PURPOSE: &str = "github_pat";
const LEGACY_KEY: &str = "github_pat";
const SERVICE: &str = "com.poitee.printpartner";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretLocator {
    service: &'static str,
    account: String,
    generation: i64,
}

impl SecretLocator {
    pub fn service(&self) -> &str {
        self.service
    }

    pub fn account(&self) -> &str {
        &self.account
    }

    pub fn generation(&self) -> i64 {
        self.generation
    }
}

pub struct SecretMaterial(Vec<u8>);

impl SecretMaterial {
    pub fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn matches(&self, other: &Self) -> bool {
        self.matches_bytes(other.expose())
    }

    pub fn matches_bytes(&self, other: &[u8]) -> bool {
        self.0.len() == other.len() && bool::from(self.0.ct_eq(other))
    }
}

impl Drop for SecretMaterial {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub struct PreparedSecret {
    locator: SecretLocator,
    material: SecretMaterial,
    migration_id: String,
    legacy_rowid: i64,
    owner: Arc<Shared>,
}

impl PreparedSecret {
    pub fn locator(&self) -> &SecretLocator {
        &self.locator
    }

    pub fn material(&self) -> &SecretMaterial {
        &self.material
    }
}

pub enum MigrationPreparation {
    Absent,
    Prepared(PreparedSecret),
    LegacyRowRemoved(SecretLocator),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageFailure {
    Cancelled,
    Stopped,
    QueueFull,
    Database,
    PreparedLegacyMissing,
    LegacyChanged,
    Superseded,
}

#[derive(Debug)]
pub struct StorageError(StorageFailure);

impl StorageError {
    pub fn failure(&self) -> StorageFailure {
        self.0
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.0 {
            StorageFailure::Cancelled => "native secret migration cancelled",
            StorageFailure::Stopped => "native secret migration storage stopped",
            StorageFailure::QueueFull => "native secret migration writer queue full",
            StorageFailure::Database => "native secret migration database failure",
            StorageFailure::PreparedLegacyMissing => {
                "prepared native secret migration has no legacy row"
            }
            StorageFailure::LegacyChanged => "legacy native secret source changed",
            StorageFailure::Superseded => "native secret migration generation was superseded",
        })
    }
}

impl Error for StorageError {}

pub struct NativeSecretMigrationClient {
    storage: SettingsClient,
}

pub(crate) enum Command {
    Prepare {
        owner: Arc<Shared>,
    },
    Confirm {
        owner: Arc<Shared>,
        prepared: PreparedSecret,
    },
}

pub(crate) enum Outcome {
    Preparation(MigrationPreparation),
    Confirmed,
}

pub(crate) type Reply = mpsc::Sender<Result<Outcome, StorageError>>;

struct MigrationReceiptRow {
    state: String,
    generation: i64,
    migration_id: String,
    legacy_rowid: i64,
}

fn locator(migration_id: &str, generation: i64) -> SecretLocator {
    SecretLocator {
        service: SERVICE,
        account: format!("native-secret/v1/{TENANT}/{PURPOSE}/{generation}/{migration_id}"),
        generation,
    }
}

fn database_error<T>(result: rusqlite::Result<T>) -> Result<T, StorageError> {
    result.map_err(|_| StorageError(StorageFailure::Database))
}

fn load_receipt(connection: &Connection) -> Result<Option<MigrationReceiptRow>, StorageError> {
    database_error(
        connection
            .query_row(
                "SELECT state,generation,migration_id,legacy_rowid
                   FROM native_secret_migrations
                  WHERE tenant_id=?1 AND purpose=?2",
                params![TENANT, PURPOSE],
                |row| {
                    Ok(MigrationReceiptRow {
                        state: row.get(0)?,
                        generation: row.get(1)?,
                        migration_id: row.get(2)?,
                        legacy_rowid: row.get(3)?,
                    })
                },
            )
            .optional(),
    )
}

fn prepare(connection: &mut Connection, owner: Arc<Shared>) -> Result<Outcome, StorageError> {
    let tx = database_error(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let receipt = load_receipt(&tx)?;
    let legacy = || {
        database_error(
            tx.query_row(
                "SELECT rowid,value FROM app_settings WHERE tenant_id=?1 AND key=?2",
                params![TENANT, LEGACY_KEY],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional(),
        )
    };
    match receipt {
        Some(receipt) if receipt.state == "prepared" => {
            let Some((current_rowid, value)) = legacy()? else {
                return Err(StorageError(StorageFailure::PreparedLegacyMissing));
            };
            if current_rowid != receipt.legacy_rowid || value.is_empty() {
                return Err(StorageError(StorageFailure::LegacyChanged));
            }
            database_error(tx.commit())?;
            Ok(Outcome::Preparation(MigrationPreparation::Prepared(
                PreparedSecret {
                    locator: locator(&receipt.migration_id, receipt.generation),
                    material: SecretMaterial::new(value.into_bytes()),
                    migration_id: receipt.migration_id,
                    legacy_rowid: receipt.legacy_rowid,
                    owner,
                },
            )))
        }
        Some(receipt) if receipt.state == "legacy_row_removed" => {
            if legacy()?.is_some() {
                return Err(StorageError(StorageFailure::LegacyChanged));
            }
            database_error(tx.commit())?;
            Ok(Outcome::Preparation(
                MigrationPreparation::LegacyRowRemoved(locator(
                    &receipt.migration_id,
                    receipt.generation,
                )),
            ))
        }
        Some(_) => Err(StorageError(StorageFailure::Database)),
        None => {
            let Some((legacy_rowid, value)) = legacy()? else {
                database_error(tx.commit())?;
                return Ok(Outcome::Preparation(MigrationPreparation::Absent));
            };
            if value.is_empty() {
                database_error(tx.commit())?;
                return Ok(Outcome::Preparation(MigrationPreparation::Absent));
            }
            let generation = 1;
            let migration_id = hex::encode(rand::random::<[u8; 32]>());
            database_error(tx.execute(
                "INSERT INTO native_secret_migrations(
                    tenant_id,purpose,generation,migration_id,state,legacy_rowid
                 ) VALUES(?1,?2,?3,?4,'prepared',?5)",
                params![TENANT, PURPOSE, generation, migration_id, legacy_rowid],
            ))?;
            database_error(tx.commit())?;
            Ok(Outcome::Preparation(MigrationPreparation::Prepared(
                PreparedSecret {
                    locator: locator(&migration_id, generation),
                    material: SecretMaterial::new(value.into_bytes()),
                    migration_id,
                    legacy_rowid,
                    owner,
                },
            )))
        }
    }
}

fn confirm(connection: &mut Connection, prepared: PreparedSecret) -> Result<Outcome, StorageError> {
    let tx = database_error(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let Some(receipt) = load_receipt(&tx)? else {
        return Err(StorageError(StorageFailure::Superseded));
    };
    if receipt.generation != prepared.locator.generation
        || receipt.migration_id != prepared.migration_id
        || receipt.legacy_rowid != prepared.legacy_rowid
    {
        return Err(StorageError(StorageFailure::Superseded));
    }
    if receipt.state == "legacy_row_removed" {
        let legacy_exists: bool = database_error(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE tenant_id=?1 AND key=?2)",
            params![TENANT, LEGACY_KEY],
            |row| row.get(0),
        ))?;
        if legacy_exists {
            return Err(StorageError(StorageFailure::LegacyChanged));
        }
        database_error(tx.commit())?;
        return Ok(Outcome::Confirmed);
    }
    if receipt.state != "prepared" {
        return Err(StorageError(StorageFailure::Database));
    }
    let current: Option<(i64, String)> = database_error(
        tx.query_row(
            "SELECT rowid,value FROM app_settings WHERE tenant_id=?1 AND key=?2",
            params![TENANT, LEGACY_KEY],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional(),
    )?;
    let Some((current_rowid, current_value)) = current else {
        return Err(StorageError(StorageFailure::PreparedLegacyMissing));
    };
    if current_rowid != prepared.legacy_rowid
        || !prepared.material.matches_bytes(current_value.as_bytes())
    {
        return Err(StorageError(StorageFailure::LegacyChanged));
    }
    let deleted = database_error(tx.execute(
        "DELETE FROM app_settings
          WHERE rowid=?1 AND tenant_id=?2 AND key=?3 AND value=?4",
        params![prepared.legacy_rowid, TENANT, LEGACY_KEY, current_value],
    ))?;
    if deleted != 1 {
        return Err(StorageError(StorageFailure::LegacyChanged));
    }
    let updated = database_error(tx.execute(
        "UPDATE native_secret_migrations
            SET state='legacy_row_removed'
          WHERE tenant_id=?1 AND purpose=?2 AND generation=?3
            AND migration_id=?4 AND state='prepared' AND legacy_rowid=?5",
        params![
            TENANT,
            PURPOSE,
            receipt.generation,
            receipt.migration_id,
            prepared.legacy_rowid
        ],
    ))?;
    if updated != 1 {
        return Err(StorageError(StorageFailure::Superseded));
    }
    database_error(tx.commit())?;
    Ok(Outcome::Confirmed)
}

pub(crate) fn execute(
    connection: &mut Connection,
    storage: &Arc<Shared>,
    command: Command,
) -> Result<Outcome, StorageError> {
    let owner = match &command {
        Command::Prepare { owner } | Command::Confirm { owner, .. } => owner,
    };
    if !Arc::ptr_eq(storage, owner) {
        return Err(StorageError(StorageFailure::Superseded));
    }
    match command {
        Command::Prepare { owner } => prepare(connection, owner),
        Command::Confirm { prepared, .. } => {
            if !Arc::ptr_eq(storage, &prepared.owner) {
                return Err(StorageError(StorageFailure::Superseded));
            }
            confirm(connection, prepared)
        }
    }
}

impl NativeSecretMigrationClient {
    fn submit(
        &self,
        command: Command,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<mpsc::Receiver<Result<Outcome, StorageError>>, StorageError> {
        let deadline = Instant::now() + wait;
        let mut queue = self
            .storage
            .shared
            .queue
            .lock()
            .map_err(|_| StorageError(StorageFailure::Stopped))?;
        loop {
            if queue.closed {
                return Err(StorageError(StorageFailure::Stopped));
            }
            if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                return Err(StorageError(StorageFailure::Cancelled));
            }
            if queue.pending.len() < self.storage.shared.capacity {
                let (reply, receiver) = mpsc::channel();
                queue
                    .pending
                    .push_back(Envelope::NativeSecrets { command, reply });
                self.storage.shared.changed.notify_all();
                return Ok(receiver);
            }
            if Instant::now() >= deadline {
                return Err(StorageError(StorageFailure::QueueFull));
            }
            queue = self
                .storage
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| StorageError(StorageFailure::Stopped))?
                .0;
        }
    }

    pub fn prepare(
        &self,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<MigrationPreparation, StorageError> {
        let receiver = self.submit(
            Command::Prepare {
                owner: self.storage.shared.clone(),
            },
            cancelled,
            wait,
        )?;
        match receiver
            .recv()
            .map_err(|_| StorageError(StorageFailure::Stopped))??
        {
            Outcome::Preparation(preparation) => Ok(preparation),
            Outcome::Confirmed => Err(StorageError(StorageFailure::Database)),
        }
    }

    pub fn confirm(
        &self,
        prepared: PreparedSecret,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<(), StorageError> {
        let receiver = self.submit(
            Command::Confirm {
                owner: self.storage.shared.clone(),
                prepared,
            },
            cancelled,
            wait,
        )?;
        match receiver
            .recv()
            .map_err(|_| StorageError(StorageFailure::Stopped))??
        {
            Outcome::Confirmed => Ok(()),
            Outcome::Preparation(_) => Err(StorageError(StorageFailure::Database)),
        }
    }
}

impl WriterOwner {
    pub fn native_secret_migration(&self) -> NativeSecretMigrationClient {
        NativeSecretMigrationClient {
            storage: self.client(),
        }
    }
}
