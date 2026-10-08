use super::{ProfileKind, ProfileLibraryItem, ProfileProjectionRow, project_library};
use crate::{ReaderCheckout, SettingsClient, WriterOwner, auth};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Transaction, TransactionBehavior, params};
use serde::Serialize;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct ProfileLibraryAccess {
    client: SettingsClient,
    policy: auth::AuthPolicy,
}

#[derive(Clone)]
pub struct ProfileLibraryKeyAccess {
    access: ProfileLibraryAccess,
    tenant: String,
}

pub struct ProfileLibraryClient {
    client: SettingsClient,
    authority: ProfileLibraryAuthority,
}

enum ProfileLibraryAuthority {
    Session {
        secret: auth::Secret,
        policy: auth::AuthPolicy,
    },
    Key {
        tenant: String,
        secret: auth::Secret,
    },
    PhysicalOwner,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProfileLibraryRequest;

#[derive(Debug, Serialize)]
pub struct ProfileLibraryResult {
    profiles: Vec<ProfileLibraryItem>,
}

impl ProfileLibraryResult {
    pub fn profiles(&self) -> &[ProfileLibraryItem] {
        &self.profiles
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileLibraryFailure {
    ReaderBusy,
    Stopped,
    Cancelled,
    Storage,
}

impl std::fmt::Display for ProfileLibraryFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ReaderBusy => "Profile library reader busy",
            Self::Stopped => "Storage stopped",
            Self::Cancelled => "Profile library read cancelled",
            Self::Storage => "Profile library unavailable",
        })
    }
}

impl std::error::Error for ProfileLibraryFailure {}

impl WriterOwner {
    pub fn profile_library_access(&self, policy: auth::AuthPolicy) -> Result<ProfileLibraryAccess> {
        auth::validate_policy(policy)?;
        Ok(ProfileLibraryAccess {
            client: self.client(),
            policy,
        })
    }

    pub fn profile_library_key_access(
        &self,
        policy: auth::AuthPolicy,
        tenant: String,
    ) -> Result<ProfileLibraryKeyAccess> {
        ensure!(
            !tenant.is_empty() && tenant.len() <= 512,
            auth::AuthFailure::SessionRequired
        );
        Ok(ProfileLibraryKeyAccess {
            access: self.profile_library_access(policy)?,
            tenant,
        })
    }

    pub fn local_profile_library(&self) -> ProfileLibraryClient {
        ProfileLibraryClient {
            client: self.client(),
            authority: ProfileLibraryAuthority::PhysicalOwner,
        }
    }
}

impl ProfileLibraryAccess {
    pub fn session(&self, secret: auth::Secret) -> ProfileLibraryClient {
        ProfileLibraryClient {
            client: self.client.clone(),
            authority: ProfileLibraryAuthority::Session {
                secret,
                policy: self.policy,
            },
        }
    }
}

impl ProfileLibraryKeyAccess {
    pub fn key(&self, secret: auth::Secret) -> ProfileLibraryClient {
        ProfileLibraryClient {
            client: self.access.client.clone(),
            authority: ProfileLibraryAuthority::Key {
                tenant: self.tenant.clone(),
                secret,
            },
        }
    }
}

impl ProfileLibraryClient {
    pub fn read(
        &self,
        _request: ProfileLibraryRequest,
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<ProfileLibraryResult> {
        let mut checkout = checkout(&self.client, cancelled, wait)?;
        ensure!(
            !cancelled.load(Ordering::Acquire),
            ProfileLibraryFailure::Cancelled
        );
        let connection = checkout
            .connection
            .as_mut()
            .expect("checked out connection");
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let tenant = self.authority.tenant(&tx)?;
        ensure!(
            !cancelled.load(Ordering::Acquire),
            ProfileLibraryFailure::Cancelled
        );
        let profiles = project_library(read_rows(&tx, &tenant)?);
        tx.commit()?;
        Ok(ProfileLibraryResult { profiles })
    }
}

impl ProfileLibraryAuthority {
    fn tenant(&self, tx: &Transaction<'_>) -> Result<String> {
        match self {
            Self::Session { secret, policy } => auth::read_session_tenant(tx, secret, *policy),
            Self::Key { tenant, secret } => auth::read_key_tenant(tx, tenant, secret),
            Self::PhysicalOwner => Ok("default".to_owned()),
        }
    }
}

fn checkout(
    client: &SettingsClient,
    cancelled: &AtomicBool,
    wait: Duration,
) -> Result<ReaderCheckout> {
    let deadline = Instant::now() + wait;
    let mut state = client
        .readers
        .state
        .lock()
        .map_err(|_| anyhow!(ProfileLibraryFailure::Storage))?;
    loop {
        ensure!(!state.closed, ProfileLibraryFailure::Stopped);
        ensure!(
            !cancelled.load(Ordering::Acquire),
            ProfileLibraryFailure::Cancelled
        );
        if let Some(connection) = state.idle.pop() {
            if let Err(error) = crate::schema::configure(&connection, true) {
                state.idle.push(connection);
                return Err(error.context(ProfileLibraryFailure::Storage));
            }
            state.active += 1;
            return Ok(ReaderCheckout {
                connection: Some(connection),
                pool: client.readers.clone(),
            });
        }
        ensure!(Instant::now() < deadline, ProfileLibraryFailure::ReaderBusy);
        let remaining = deadline.saturating_duration_since(Instant::now());
        state = client
            .readers
            .changed
            .wait_timeout(state, remaining.min(Duration::from_millis(5)))
            .map_err(|_| anyhow!(ProfileLibraryFailure::Storage))?
            .0;
    }
}

fn read_rows(tx: &Transaction<'_>, tenant: &str) -> Result<Vec<ProfileProjectionRow>> {
    let mut rows = Vec::new();
    read_kind(
        tx,
        "SELECT id,name,slicer_format,NULL,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at FROM printer_profiles WHERE tenant_id=?1",
        tenant,
        ProfileKind::Printer,
        &mut rows,
    )?;
    read_kind(
        tx,
        "SELECT id,name,slicer_format,NULL,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at FROM process_profiles WHERE tenant_id=?1",
        tenant,
        ProfileKind::Process,
        &mut rows,
    )?;
    read_kind(
        tx,
        "SELECT id,name,NULL,material_type,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at FROM filament_profiles WHERE tenant_id=?1",
        tenant,
        ProfileKind::Filament,
        &mut rows,
    )?;
    Ok(rows)
}

fn read_kind(
    tx: &Transaction<'_>,
    sql: &str,
    tenant: &str,
    kind: ProfileKind,
    rows: &mut Vec<ProfileProjectionRow>,
) -> Result<()> {
    let mut statement = tx.prepare(sql)?;
    let mapped = statement.query_map(params![tenant], |row| {
        Ok(ProfileProjectionRow {
            id: row.get(0)?,
            kind,
            name: row.get(1)?,
            slicer_format: row.get(2)?,
            material_type: row.get(3)?,
            source_path: row.get(4)?,
            resolved_flat_config: row.get(5)?,
            synced_from_slicer_version: row.get(6)?,
            last_synced_at: row.get(7)?,
            imported_at: row.get(8)?,
        })
    })?;
    rows.extend(mapped.collect::<rusqlite::Result<Vec<_>>>()?);
    Ok(())
}
