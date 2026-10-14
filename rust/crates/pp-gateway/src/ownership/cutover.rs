//! Cutover commits after drain and graceful Node exit, while the storage lease is held.
//! Only HTTP-only operations can switch until Node can honor the ownership record.

use super::{
    Owner,
    manifest::{Disposition, OwnershipIndex},
    open_lease_file, read_lease_file,
};
use pp_compat::CompatExit;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
};

pub const CUTOVER_FILE: &str = "operation-cutover.json";
pub const EVIDENCE_FILE: &str = "operation-cutover-evidence.jsonl";
const RECORD_SCHEMA: &str = "pp-operation-cutover-v1";
const PARITY_SCHEMA: &str = "pp-operation-parity-v1";
const TEMPORARY_PREFIX: &str = ".operation-cutover.";
const TEMPORARY_SUFFIX: &str = ".tmp";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CutoverRecord {
    schema: String,
    manifest_sha256: String,
    operations: BTreeMap<String, RustOwned>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RustOwned {
    parity_sha256: String,
    fixtures: u32,
    participants: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParityReceipt {
    schema: String,
    operation: String,
    manifest_sha256: String,
    fixtures: u32,
    passed: u32,
    failed: u32,
}

impl ParityReceipt {
    fn parse(text: &str) -> Result<Self, CutoverRefusal> {
        let receipt: ParityReceipt =
            serde_json::from_str(text).map_err(|error| CutoverRefusal::ParityMalformed {
                detail: error.to_string(),
            })?;
        if receipt.schema != PARITY_SCHEMA {
            return Err(CutoverRefusal::ParityMalformed {
                detail: format!("unsupported schema {}", receipt.schema),
            });
        }
        if receipt.fixtures == 0 {
            return Err(CutoverRefusal::ParityNoFixtures);
        }
        if receipt.passed != receipt.fixtures || receipt.failed != 0 {
            return Err(CutoverRefusal::ParityFailures {
                fixtures: receipt.fixtures,
                passed: receipt.passed,
                failed: receipt.failed,
            });
        }
        Ok(receipt)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OperationOwners {
    record: Option<CutoverRecord>,
}

impl OperationOwners {
    pub fn node_only() -> Self {
        Self::default()
    }

    pub fn owner_of(&self, participant: &str) -> Owner {
        if self.rust_participants().any(|id| id == participant) {
            Owner::Rust
        } else {
            Owner::Node
        }
    }

    pub fn rust_operations(&self) -> impl Iterator<Item = &str> {
        self.record
            .iter()
            .flat_map(|record| record.operations.keys().map(String::as_str))
    }

    pub fn rust_participants(&self) -> impl Iterator<Item = &str> {
        self.record
            .iter()
            .flat_map(|record| record.operations.values())
            .flat_map(|owned| owned.participants.iter().map(String::as_str))
    }
}

#[derive(Debug)]
pub struct CutoverPlan {
    operation: String,
    next: CutoverRecord,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrainEvidence {
    pub tracked_idle: bool,
    pub gateway_idle: bool,
    pub compat: Option<CompatExit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum CutoverReceipt {
    Committed {
        operation: String,
        participants: usize,
        manifest_sha256: String,
        parity_sha256: String,
        fixtures: u32,
        directory_synced: bool,
    },
    DrainTimedOut {
        operation: String,
        tracked_idle: bool,
        gateway_idle: bool,
    },
    CompatNotReaped {
        operation: String,
    },
    CompatForceKilled {
        operation: String,
    },
    CommitFailed {
        operation: String,
        detail: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum CutoverRefusal {
    FlagOff,
    UnknownOperation,
    NotSwitchable {
        participant: String,
    },
    NodeCannotFence {
        participant: String,
    },
    AlreadyRustOwned,
    ParityMalformed {
        detail: String,
    },
    ParityNoFixtures,
    ParityFailures {
        fixtures: u32,
        passed: u32,
        failed: u32,
    },
    ParityOperationMismatch {
        expected: String,
        actual: String,
    },
    ParityManifestMismatch {
        expected: String,
        actual: String,
    },
    ShutdownInProgress,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum CutoverError {
    Malformed {
        detail: String,
    },
    RecordWithoutFlag,
    RestartManifestChanged {
        recorded: String,
        bundled: String,
    },
    UnknownOperation {
        operation: String,
    },
    NotSwitchable {
        participant: String,
    },
    NodeCannotFence {
        participant: String,
    },
    NoParityFixtures {
        operation: String,
    },
    ParticipantSetMismatch {
        operation: String,
        missing: Vec<String>,
        unexpected: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BootReceipt {
    pub rust_operations: Vec<String>,
    pub abandoned_temporaries: u32,
    pub evidence_saved: bool,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Evidence<'a> {
    Refused {
        operation: &'a str,
        #[serde(flatten)]
        refusal: &'a CutoverRefusal,
    },
    Cutover(&'a CutoverReceipt),
    Boot(&'a BootReceipt),
    BootFailed(&'a CutoverError),
}

enum Blocked<'a> {
    Unknown,
    NotSwitchable(&'a str),
    NodeCannotFence(&'a str),
}

fn switchable<'a>(
    index: &'a OwnershipIndex,
    operation: &str,
) -> Result<BTreeSet<&'a str>, Blocked<'a>> {
    let participants = index.participants_of(operation);
    if participants.is_empty() {
        return Err(Blocked::Unknown);
    }
    if let Some(id) = participants.iter().find(|id| {
        !index
            .lookup(id)
            .is_ok_and(|claim| claim.disposition == Disposition::Owned(Owner::Node))
    }) {
        return Err(Blocked::NotSwitchable(id));
    }
    if let Some(id) = participants.iter().find(|id| !id.starts_with("http.")) {
        return Err(Blocked::NodeCannotFence(id));
    }
    Ok(participants)
}

pub fn plan(
    index: Option<&OwnershipIndex>,
    owners: &OperationOwners,
    operation: &str,
    parity: &str,
) -> Result<CutoverPlan, CutoverRefusal> {
    let index = index.ok_or(CutoverRefusal::FlagOff)?;
    let participants = switchable(index, operation).map_err(|blocked| match blocked {
        Blocked::Unknown => CutoverRefusal::UnknownOperation,
        Blocked::NotSwitchable(id) => CutoverRefusal::NotSwitchable {
            participant: id.to_owned(),
        },
        Blocked::NodeCannotFence(id) => CutoverRefusal::NodeCannotFence {
            participant: id.to_owned(),
        },
    })?;
    if owners.rust_operations().any(|owned| owned == operation) {
        return Err(CutoverRefusal::AlreadyRustOwned);
    }
    let receipt = ParityReceipt::parse(parity)?;
    if receipt.operation != operation {
        return Err(CutoverRefusal::ParityOperationMismatch {
            expected: operation.to_owned(),
            actual: receipt.operation,
        });
    }
    if receipt.manifest_sha256 != index.digest() {
        return Err(CutoverRefusal::ParityManifestMismatch {
            expected: index.digest().to_owned(),
            actual: receipt.manifest_sha256,
        });
    }
    let mut next = owners.record.clone().unwrap_or_else(|| CutoverRecord {
        schema: RECORD_SCHEMA.to_owned(),
        manifest_sha256: index.digest().to_owned(),
        operations: BTreeMap::new(),
    });
    next.operations.insert(
        operation.to_owned(),
        RustOwned {
            parity_sha256: hex::encode(Sha256::digest(parity.as_bytes())),
            fixtures: receipt.fixtures,
            participants: participants.into_iter().map(str::to_owned).collect(),
        },
    );
    Ok(CutoverPlan {
        operation: operation.to_owned(),
        next,
    })
}

impl CutoverPlan {
    pub fn commit(self, data_dir: &Path, drained: DrainEvidence) -> CutoverReceipt {
        let operation = self.operation;
        let DrainEvidence {
            tracked_idle,
            gateway_idle,
            compat,
        } = drained;
        if !tracked_idle || !gateway_idle {
            return CutoverReceipt::DrainTimedOut {
                operation,
                tracked_idle,
                gateway_idle,
            };
        }
        match compat {
            None => return CutoverReceipt::CompatNotReaped { operation },
            // Killed Node work is interrupted business work. Rust must not own
            // the operation on top of a half-finished Node mutation.
            Some(CompatExit::Forced) => return CutoverReceipt::CompatForceKilled { operation },
            Some(CompatExit::Graceful) => {}
        }
        if let Err(error) = write_record(data_dir, &self.next) {
            return CutoverReceipt::CommitFailed {
                operation,
                detail: error.to_string(),
            };
        }
        let directory_synced = fs::File::open(data_dir)
            .and_then(|directory| directory.sync_all())
            .is_ok();
        let owned = &self.next.operations[&operation];
        CutoverReceipt::Committed {
            participants: owned.participants.len(),
            manifest_sha256: self.next.manifest_sha256.clone(),
            parity_sha256: owned.parity_sha256.clone(),
            fixtures: owned.fixtures,
            directory_synced,
            operation,
        }
    }
}

fn write_record(data_dir: &Path, record: &CutoverRecord) -> std::io::Result<()> {
    let encoded = serde_json::to_vec(record)?;
    if encoded.len() as u64 > super::LEASE_FILE_LIMIT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cutover record exceeds read limit",
        ));
    }
    let temporary = data_dir.join(format!(
        "{TEMPORARY_PREFIX}{}{TEMPORARY_SUFFIX}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary)?;
    let written = (|| {
        file.write_all(&encoded)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, data_dir.join(CUTOVER_FILE))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

pub fn recover(
    data_dir: &Path,
    index: Option<&OwnershipIndex>,
) -> Result<(OperationOwners, BootReceipt), CutoverError> {
    let found =
        remove_temporaries(data_dir).and_then(|abandoned| Ok((abandoned, read_record(data_dir)?)));
    if matches!(found, Ok((0, None))) {
        return Ok((
            OperationOwners::node_only(),
            BootReceipt {
                rust_operations: Vec::new(),
                abandoned_temporaries: 0,
                evidence_saved: true,
            },
        ));
    }
    let recovered = found.and_then(|(abandoned_temporaries, text)| {
        let owners = match text {
            Some(text) => admit_record(&text, index)?,
            None => OperationOwners::node_only(),
        };
        let boot = BootReceipt {
            rust_operations: owners.rust_operations().map(str::to_owned).collect(),
            abandoned_temporaries,
            evidence_saved: true,
        };
        Ok((owners, boot))
    });
    match recovered {
        Ok((owners, mut boot)) => {
            boot.evidence_saved = append_evidence(data_dir, &Evidence::Boot(&boot)).is_ok();
            Ok((owners, boot))
        }
        Err(error) => {
            let _ = append_evidence(data_dir, &Evidence::BootFailed(&error));
            Err(error)
        }
    }
}

fn remove_temporaries(data_dir: &Path) -> Result<u32, CutoverError> {
    let failed = |error: std::io::Error| CutoverError::Malformed {
        detail: format!("cutover temporaries {error}"),
    };
    let mut removed = 0;
    for entry in fs::read_dir(data_dir).map_err(failed)? {
        let name = entry.map_err(failed)?.file_name();
        if name.to_str().is_some_and(|name| {
            name.starts_with(TEMPORARY_PREFIX) && name.ends_with(TEMPORARY_SUFFIX)
        }) {
            fs::remove_file(data_dir.join(name)).map_err(failed)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn read_record(data_dir: &Path) -> Result<Option<String>, CutoverError> {
    match open_lease_file(&data_dir.join(CUTOVER_FILE)) {
        Ok(Some(file)) => {
            read_lease_file(file)
                .map(Some)
                .map_err(|error| CutoverError::Malformed {
                    detail: format!("cutover record {error}"),
                })
        }
        Ok(None) => Ok(None),
        Err(error) => Err(CutoverError::Malformed {
            detail: format!("cutover record is not a regular file or cannot be opened: {error}"),
        }),
    }
}

fn admit_record(
    text: &str,
    index: Option<&OwnershipIndex>,
) -> Result<OperationOwners, CutoverError> {
    let index = index.ok_or(CutoverError::RecordWithoutFlag)?;
    let record: CutoverRecord =
        serde_json::from_str(text).map_err(|error| CutoverError::Malformed {
            detail: format!("cutover record {error}"),
        })?;
    if record.schema != RECORD_SCHEMA {
        return Err(CutoverError::Malformed {
            detail: format!("unsupported cutover schema {}", record.schema),
        });
    }
    if record.manifest_sha256 != index.digest() {
        return Err(CutoverError::RestartManifestChanged {
            recorded: record.manifest_sha256,
            bundled: index.digest().to_owned(),
        });
    }
    for (operation, owned) in &record.operations {
        let expected = switchable(index, operation).map_err(|blocked| match blocked {
            Blocked::Unknown => CutoverError::UnknownOperation {
                operation: operation.clone(),
            },
            Blocked::NotSwitchable(id) => CutoverError::NotSwitchable {
                participant: id.to_owned(),
            },
            Blocked::NodeCannotFence(id) => CutoverError::NodeCannotFence {
                participant: id.to_owned(),
            },
        })?;
        if owned.fixtures == 0 {
            return Err(CutoverError::NoParityFixtures {
                operation: operation.clone(),
            });
        }
        let actual: BTreeSet<&str> = owned.participants.iter().map(String::as_str).collect();
        if actual != expected {
            return Err(CutoverError::ParticipantSetMismatch {
                operation: operation.clone(),
                missing: expected
                    .difference(&actual)
                    .map(|id| (*id).to_owned())
                    .collect(),
                unexpected: actual
                    .difference(&expected)
                    .map(|id| (*id).to_owned())
                    .collect(),
            });
        }
    }
    Ok(OperationOwners {
        record: Some(record),
    })
}

pub fn append_evidence(data_dir: &Path, evidence: &Evidence<'_>) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(evidence)?;
    line.push(b'\n');
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = options.open(data_dir.join(EVIDENCE_FILE))?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cutover evidence log is not a regular file",
        ));
    }
    file.write_all(&line)?;
    file.sync_all()
}
