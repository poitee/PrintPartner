use super::{
    FilamentImportInput, ImportProvenance, JsInteger, JsText, PrinterImportInput,
    ProcessImportInput, ProfileIdentity, ProfileImport, ProfileImportInner, ProfileKind,
    RawFilamentSource, SlicerKind,
};
use crate::{Envelope, Shared, WriterOwner};
use anyhow::{Error, Result, anyhow};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use std::{
    error::Error as StdError,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[derive(Debug)]
struct CoordinationPoison {
    operation: &'static str,
    message: String,
}

impl fmt::Display for CoordinationPoison {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "profile import coordination poisoned during {}: {}",
            self.operation, self.message
        )
    }
}

impl StdError for CoordinationPoison {}

#[derive(Debug)]
struct TransactionRollbackFailure {
    primary: Error,
    rollback: Error,
}

impl fmt::Display for TransactionRollbackFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "profile import transaction failed: {:#}; rollback also failed: {:#}",
            self.primary, self.rollback
        )
    }
}

impl StdError for TransactionRollbackFailure {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(self.primary.as_ref())
    }
}

fn coordination_poison(operation: &'static str, message: String) -> ProfileImportFailure {
    ProfileImportFailure::Storage {
        source: CoordinationPoison { operation, message }.into(),
    }
}

#[derive(Clone)]
pub struct LocalProfileImporter {
    shared: Arc<Shared>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileImportReceipt {
    identity: ProfileIdentity,
}

impl ProfileImportReceipt {
    pub fn identity(&self) -> &ProfileIdentity {
        &self.identity
    }
}

#[derive(Debug)]
pub enum ProfileImportFailure {
    CancelledBeforeAdmission,
    QueueFull,
    Stopped,
    Storage { source: Error },
    OutcomeUnknown { source: Error },
}

impl fmt::Display for ProfileImportFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CancelledBeforeAdmission => {
                formatter.write_str("Profile import cancelled before admission")
            }
            Self::QueueFull => formatter.write_str("Profile import queue full"),
            Self::Stopped => formatter.write_str("Storage stopped"),
            Self::Storage { .. } => formatter.write_str("Profile import storage failed"),
            Self::OutcomeUnknown { .. } => formatter.write_str("Profile import outcome unknown"),
        }
    }
}

impl std::error::Error for ProfileImportFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage { source } | Self::OutcomeUnknown { source } => Some(source.as_ref()),
            Self::CancelledBeforeAdmission | Self::QueueFull | Self::Stopped => None,
        }
    }
}

pub(crate) struct Command {
    import: ProfileImport,
}

pub(crate) type Reply = mpsc::Sender<Result<ProfileImportReceipt, ProfileImportFailure>>;

impl WriterOwner {
    pub fn local_profile_importer(&self) -> LocalProfileImporter {
        LocalProfileImporter {
            shared: self.client.shared.clone(),
        }
    }
}

impl LocalProfileImporter {
    pub fn import(
        &self,
        import: ProfileImport,
        cancelled: &AtomicBool,
        admission_wait: Duration,
    ) -> Result<ProfileImportReceipt, ProfileImportFailure> {
        let deadline = Instant::now() + admission_wait;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|error| coordination_poison("queue lock", error.to_string()))?;
        loop {
            if queue.closed {
                return Err(ProfileImportFailure::Stopped);
            }
            if cancelled.load(Ordering::Acquire) {
                return Err(ProfileImportFailure::CancelledBeforeAdmission);
            }
            if queue.pending.len() < self.shared.capacity {
                break;
            }
            if Instant::now() >= deadline {
                return Err(ProfileImportFailure::QueueFull);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            queue = self
                .shared
                .changed
                .wait_timeout(queue, remaining.min(Duration::from_millis(5)))
                .map_err(|error| coordination_poison("queue wait", error.to_string()))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::ProfileImport {
            command: Command { import },
            reply,
        });
        self.shared.changed.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|error| ProfileImportFailure::OutcomeUnknown {
                source: error.into(),
            })?
    }
}

pub(crate) fn execute(
    connection: &mut Connection,
    command: Command,
) -> Result<ProfileImportReceipt, ProfileImportFailure> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|source| ProfileImportFailure::Storage {
            source: source.into(),
        })?;
    match transact(&tx, command.import) {
        Ok(identity) => {
            tx.commit()
                .map_err(|source| ProfileImportFailure::OutcomeUnknown {
                    source: source.into(),
                })?;
            Ok(ProfileImportReceipt { identity })
        }
        Err(source) => match tx.rollback() {
            Ok(()) => Err(ProfileImportFailure::Storage { source }),
            Err(rollback) => Err(ProfileImportFailure::OutcomeUnknown {
                source: TransactionRollbackFailure {
                    primary: source,
                    rollback: rollback.into(),
                }
                .into(),
            }),
        },
    }
}

fn transact(tx: &Transaction<'_>, import: ProfileImport) -> Result<ProfileIdentity> {
    let now = time::OffsetDateTime::now_utc();
    let now = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    );
    let identity = match import.0 {
        ProfileImportInner::Printer(input) => upsert_printer(tx, input, &now)?,
        ProfileImportInner::Process(input) => upsert_process(tx, input, &now)?,
        ProfileImportInner::Filament(input) => upsert_filament(tx, input, &now)?,
    };
    Ok(identity)
}

fn provenance(input: &ImportProvenance) -> (String, Option<String>, String, String) {
    (
        text(&input.name),
        input.slicer_version.as_ref().map(text),
        text(&input.resolved_flat_config),
        text(&input.source_path),
    )
}

fn upsert_printer(
    tx: &Transaction<'_>,
    input: PrinterImportInput,
    now: &str,
) -> Result<ProfileIdentity> {
    let (name, version, resolved, source_path) = provenance(&input.provenance);
    let id = tx.query_row(
        "INSERT INTO printer_profiles (tenant_id,name,slicer_format,slicer_version_at_import,nozzle_diameter_mm,extruder_count,raw_json,resolved_flat_config,imported_at,source_path,synced_from_slicer_version,last_synced_at) VALUES ('default',?1,?2,?3,?4,?5,?6,?7,?8,?9,?3,?8) ON CONFLICT(tenant_id,name) DO UPDATE SET slicer_format=excluded.slicer_format,slicer_version_at_import=excluded.slicer_version_at_import,nozzle_diameter_mm=excluded.nozzle_diameter_mm,extruder_count=excluded.extruder_count,raw_json=excluded.raw_json,resolved_flat_config=excluded.resolved_flat_config,source_path=excluded.source_path,synced_from_slicer_version=excluded.synced_from_slicer_version,last_synced_at=excluded.last_synced_at RETURNING id",
        params![name, slicer(input.slicer_format), version, input.nozzle_diameter_mm.as_ref().map(text), input.extruder_count.map(number).unwrap_or(1.0), input.raw_json.as_ref().map(text), resolved, now, source_path],
        |row| row.get(0),
    )?;
    ProfileIdentity::new(ProfileKind::Printer, id)
        .map_err(|error| anyhow!("invalid printer identity: {error:?}"))
}

fn upsert_process(
    tx: &Transaction<'_>,
    input: ProcessImportInput,
    now: &str,
) -> Result<ProfileIdentity> {
    let (name, version, resolved, source_path) = provenance(&input.provenance);
    let id = tx.query_row(
        "INSERT INTO process_profiles (tenant_id,name,slicer_format,compatible_printers,resolved_flat_config,imported_at,source_path,synced_from_slicer_version,last_synced_at) VALUES ('default',?1,?2,?3,?4,?5,?6,?7,?5) ON CONFLICT(tenant_id,name) DO UPDATE SET slicer_format=excluded.slicer_format,compatible_printers=excluded.compatible_printers,resolved_flat_config=excluded.resolved_flat_config,source_path=excluded.source_path,synced_from_slicer_version=excluded.synced_from_slicer_version,last_synced_at=excluded.last_synced_at RETURNING id",
        params![name, slicer(input.slicer_format), input.compatible_printers.as_ref().map(text), resolved, now, source_path, version],
        |row| row.get(0),
    )?;
    ProfileIdentity::new(ProfileKind::Process, id)
        .map_err(|error| anyhow!("invalid process identity: {error:?}"))
}

fn upsert_filament(
    tx: &Transaction<'_>,
    input: FilamentImportInput,
    now: &str,
) -> Result<ProfileIdentity> {
    let (name, version, resolved, source_path) = provenance(&input.provenance);
    let (raw_json, raw_ini) = match input.raw {
        RawFilamentSource::Json(value) => (Some(text(&value)), None),
        RawFilamentSource::Ini(value) => (None, Some(text(&value))),
    };
    let id = tx.query_row(
        "INSERT INTO filament_profiles (tenant_id,name,material_type,material_tier,nozzle_temp_c,bed_temp_c,fan_pct,extrusion_multiplier,pressure_advance,retraction,raw_json,raw_ini,resolved_flat_config,imported_at,source_path,synced_from_slicer_version,last_synced_at) VALUES ('default',?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?12) ON CONFLICT(tenant_id,name) DO UPDATE SET material_type=excluded.material_type,material_tier=excluded.material_tier,nozzle_temp_c=excluded.nozzle_temp_c,bed_temp_c=excluded.bed_temp_c,fan_pct=excluded.fan_pct,extrusion_multiplier=excluded.extrusion_multiplier,pressure_advance=excluded.pressure_advance,retraction=excluded.retraction,raw_json=excluded.raw_json,raw_ini=excluded.raw_ini,resolved_flat_config=excluded.resolved_flat_config,source_path=excluded.source_path,synced_from_slicer_version=excluded.synced_from_slicer_version,last_synced_at=excluded.last_synced_at RETURNING id",
        params![name, text(&input.material_type), input.nozzle_temp_c.map(number), input.bed_temp_c.map(number), input.fan_pct.map(number), input.extrusion_multiplier.as_ref().map(text), input.pressure_advance.as_ref().map(text), input.retraction.as_ref().map(text), raw_json, raw_ini, resolved, now, source_path, version],
        |row| row.get(0),
    )?;
    ProfileIdentity::new(ProfileKind::Filament, id)
        .map_err(|error| anyhow!("invalid filament identity: {error:?}"))
}

fn text(value: &JsText) -> String {
    value.to_string_lossy()
}
fn number(value: JsInteger) -> f64 {
    value.value()
}
fn slicer(value: SlicerKind) -> &'static str {
    match value {
        SlicerKind::Orca => "orca",
        SlicerKind::Prusa => "prusa",
        SlicerKind::Bambu => "bambu",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_failure_retains_both_errors() {
        let error = TransactionRollbackFailure {
            primary: anyhow!("primary transaction error"),
            rollback: anyhow!("secondary rollback error"),
        };

        assert_eq!(error.primary.to_string(), "primary transaction error");
        assert_eq!(error.rollback.to_string(), "secondary rollback error");
        assert!(error.source().is_some());
        assert!(error.to_string().contains("secondary rollback error"));
    }

    #[test]
    fn coordination_poison_is_an_owned_cause() {
        let failure = coordination_poison("queue lock", "poisoned lock".to_owned());
        let ProfileImportFailure::Storage { source } = failure else {
            panic!("coordination poison must be a source-bearing storage failure");
        };

        assert!(source.to_string().contains("queue lock"));
        assert!(source.to_string().contains("poisoned lock"));
    }
}
