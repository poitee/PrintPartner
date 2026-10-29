//! Every operation participant the desktop runtime can reach, with one owner.
//!
//! The index joins three bundled documents. `ownership-manifest.json` groups
//! participants into operations. `operations.json` is the gateway's HTTP route
//! registry, generated from the Fastify route union. Each route's validated
//! `owner` and `operation` supply its registry claim. Explicit manifest groups
//! take precedence, and HEAD inherits its GET group. The Source Sync manifest is
//! the Node admission record. A participant claimed twice, an HTTP alias group
//! split across operations, a claim on a route the registry does not have, and a
//! Rust owner all fail admission. A lookup for an unclaimed participant fails
//! instead of defaulting to Node.

use super::live_formats::LiveFormats;
use super::resources::{Coverage, Declarations, ResourceSet};
use super::{
    AdmissionError, BUNDLED_SOURCE_SYNC_MANIFEST, Owner, SOURCE_SYNC_OPERATION,
    SOURCE_SYNC_PARTICIPANTS,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MANIFEST_SCHEMA: &str = "pp-ownership-manifest-v2";
const BUNDLED_MANIFEST: &str = include_str!("../../ownership-manifest.json");
const BUNDLED_OPERATIONS: &str = include_str!("../../operations.json");
const PARTICIPANT_KINDS: &[&str] = &[
    "http",
    "tool",
    "mcp",
    "assistant",
    "job",
    "startup",
    "worker",
    "migration",
    // A write Node makes while it stops, or inside a route another operation
    // owns. Node checks the cutover record at that call.
    "shutdown",
    "reconcile",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Owned(Owner),
    /// The gateway answers the route itself and never forwards it.
    Gateway,
    /// The gateway refuses the route with a desktop-unavailable reason.
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub operation: String,
    pub disposition: Disposition,
}

#[derive(Debug)]
pub struct OwnershipIndex {
    claims: BTreeMap<String, Claim>,
    resources: BTreeMap<String, Coverage>,
    live_formats: LiveFormats,
    digest: String,
}

impl OwnershipIndex {
    pub fn lookup(&self, participant: &str) -> Result<&Claim, AdmissionError> {
        self.claims
            .get(participant)
            .ok_or_else(|| AdmissionError::UnknownParticipant {
                id: participant.to_string(),
            })
    }

    pub fn resources_for(&self, participant: &str) -> Result<&ResourceSet, AdmissionError> {
        let claim = self.lookup(participant)?;
        match &self.resources[&claim.operation] {
            Coverage::Reviewed(resources) => Ok(resources),
            Coverage::Unresolved => Err(AdmissionError::UnresolvedResources {
                operation: claim.operation.clone(),
            }),
        }
    }

    /// Admit returning `participant`'s operation from Rust to Node.
    ///
    /// Every resource must declare that Rust never writes its format, or a Rust
    /// version Node reads. Unresolved resources refuse, as does any format
    /// Node cannot read. Tables sort first, so the database schema reports
    /// before file formats.
    pub fn admit_rollback(&self, participant: &str) -> Result<&ResourceSet, AdmissionError> {
        let resources = self.resources_for(participant)?;
        for resource in resources {
            let id = resource.live_format();
            let format = self.live_formats.get(id);
            if !format.rollback_compatible() {
                return Err(AdmissionError::IncompatibleLiveFormat {
                    operation: self.claims[participant].operation.clone(),
                    format: id.as_str().to_string(),
                    node_reads: format.node_reads,
                    rust_writes: format.rust_writes.version(),
                });
            }
        }
        Ok(resources)
    }

    pub fn claims(&self) -> &BTreeMap<String, Claim> {
        &self.claims
    }

    /// sha256 over the three admitted documents. Parity receipts and cutover
    /// records bind to this value.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// Every participant claimed by `operation`, including HEAD twins and
    /// registry aliases. Empty means the operation is unknown.
    pub fn participants_of(&self, operation: &str) -> BTreeSet<&str> {
        self.claims
            .iter()
            .filter(|(_, claim)| claim.operation == operation)
            .map(|(id, _)| id.as_str())
            .collect()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    operations: Vec<OperationEntry>,
    node_participants: NodeParticipants,
    resources: Declarations,
    live_formats: LiveFormats,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationEntry {
    operation: String,
    owner: String,
    participants: Vec<String>,
}

/// Node participants not yet grouped with others. Each is its own operation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeParticipants {
    tool: Vec<String>,
    mcp: Vec<String>,
    assistant: Vec<String>,
    job: Vec<String>,
    startup: Vec<String>,
    worker: Vec<String>,
    migration: Vec<String>,
}

#[derive(Deserialize)]
struct Registry {
    routes: Vec<RegisteredRoute>,
    denied: Vec<RouteKey>,
    gateway_owned: Vec<RouteKey>,
}

#[derive(Deserialize)]
struct RegisteredRoute {
    method: String,
    path: String,
    owner: String,
    operation: String,
}

#[derive(Deserialize)]
struct RouteKey {
    method: String,
    path: String,
}

pub fn admit_bundled_manifest() -> Result<OwnershipIndex, AdmissionError> {
    admit_manifest_documents(
        BUNDLED_MANIFEST,
        BUNDLED_OPERATIONS,
        BUNDLED_SOURCE_SYNC_MANIFEST,
    )
}

pub fn admit_manifest_documents(
    manifest: &str,
    operations: &str,
    source_sync: &str,
) -> Result<OwnershipIndex, AdmissionError> {
    let digest = length_prefixed_documents_digest(&[
        ("ownership-manifest.json", manifest),
        ("operations.json", operations),
        ("source-sync-ownership.json", source_sync),
    ]);
    let manifest: Manifest = serde_json::from_str(manifest)
        .map_err(|error| AdmissionError::Malformed(error.to_string()))?;
    let registry: Registry = serde_json::from_str(operations)
        .map_err(|error| AdmissionError::Malformed(format!("operations.json: {error}")))?;
    if manifest.schema != MANIFEST_SCHEMA {
        return Err(AdmissionError::Malformed(format!(
            "unsupported schema {}",
            manifest.schema
        )));
    }

    let mut claims = BTreeMap::new();
    let mut operations_seen = BTreeSet::new();
    for entry in &manifest.operations {
        if !operations_seen.insert(entry.operation.as_str()) {
            return Err(AdmissionError::Malformed(format!(
                "operation {} is declared twice",
                entry.operation
            )));
        }
        let owner = Owner::parse(&entry.owner)?;
        if owner == Owner::Rust {
            return Err(AdmissionError::UnsupportedRustOwner {
                participant: entry.operation.clone(),
            });
        }
        for id in &entry.participants {
            claim(&mut claims, id, &entry.operation, Disposition::Owned(owner))?;
        }
    }
    let source_sync = admit_source_sync(&manifest, source_sync)?;

    let node = &manifest.node_participants;
    for (kind, names) in [
        ("tool", &node.tool),
        ("mcp", &node.mcp),
        ("assistant", &node.assistant),
        ("job", &node.job),
        ("startup", &node.startup),
        ("worker", &node.worker),
        ("migration", &node.migration),
    ] {
        for name in names {
            let id = format!("{kind}.{name}");
            claim(&mut claims, &id, &id, Disposition::Owned(Owner::Node))?;
        }
    }

    let explicit_http: BTreeSet<String> = claims
        .keys()
        .filter(|id| id.starts_with("http."))
        .cloned()
        .collect();
    let mut registered = BTreeSet::new();
    let mut alias_groups: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for route in &registry.routes {
        let id = http_id(&route.method, &route.path);
        if route.owner != "compat" {
            return Err(AdmissionError::UnknownOwner {
                value: route.owner.clone(),
            });
        }
        let registry_claim = Claim {
            operation: format!("http:{}", route.operation),
            disposition: Disposition::Owned(Owner::parse(&route.owner)?),
        };
        if !registered.insert(id.clone()) {
            return Err(AdmissionError::DuplicateParticipant { id });
        }
        // Fastify answers HEAD with the GET handler, so HEAD shares the GET guard.
        let inherited = (route.method == "HEAD")
            .then(|| http_id("GET", &route.path))
            .and_then(|get| claims.get(&get).cloned());
        let assigned = claims
            .get(&id)
            .cloned()
            .or(inherited)
            .unwrap_or(registry_claim);
        claims.insert(id, assigned.clone());
        alias_groups
            .entry(route.operation.as_str())
            .or_default()
            .insert(assigned.operation);
    }
    for (routes, operation, disposition) in [
        (&registry.denied, "gateway.denied", Disposition::Refused),
        (
            &registry.gateway_owned,
            "gateway.owned",
            Disposition::Gateway,
        ),
    ] {
        for route in routes {
            claim(
                &mut claims,
                &http_id(&route.method, &route.path),
                operation,
                disposition,
            )?;
        }
    }
    if let Some(stale) = explicit_http.difference(&registered).next() {
        return Err(AdmissionError::UnknownParticipant { id: stale.clone() });
    }
    for (group, owners) in &alias_groups {
        if owners.len() > 1 {
            let mut owners = owners.iter();
            return Err(AdmissionError::ConflictingParticipant {
                operation: (*group).to_string(),
                left: owners.next().cloned().unwrap_or_default(),
                right: owners.next().cloned().unwrap_or_default(),
            });
        }
    }
    let resources = manifest.resources.admit(&claims, &source_sync)?;
    let live_formats = manifest.live_formats.admit()?;
    Ok(OwnershipIndex {
        claims,
        resources,
        live_formats,
        digest,
    })
}

fn length_prefixed_documents_digest(documents: &[(&str, &str)]) -> String {
    let mut hasher = Sha256::new();
    for (name, text) in documents {
        for part in [name, text] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part.as_bytes());
        }
    }
    hex::encode(hasher.finalize())
}

/// The grouped `source.sync` entry must be exactly the Node admission record.
fn admit_source_sync(
    manifest: &Manifest,
    source_sync: &str,
) -> Result<super::AdmittedOperation, AdmissionError> {
    let admitted = super::admit_observed(source_sync, SOURCE_SYNC_PARTICIPANTS)?;
    let entry = manifest
        .operations
        .iter()
        .find(|entry| entry.operation == SOURCE_SYNC_OPERATION)
        .ok_or_else(|| AdmissionError::UnknownOperation {
            value: SOURCE_SYNC_OPERATION.to_string(),
        })?;
    if Owner::parse(&entry.owner)? != admitted.owner {
        return Err(AdmissionError::ConflictingParticipant {
            operation: SOURCE_SYNC_OPERATION.to_string(),
            left: entry.owner.clone(),
            right: admitted.owner.as_str().to_string(),
        });
    }
    let declared: BTreeSet<String> = entry.participants.iter().cloned().collect();
    if declared != admitted.participant_ids {
        return Err(AdmissionError::ParticipantSetMismatch {
            missing: admitted
                .participant_ids
                .difference(&declared)
                .cloned()
                .collect(),
            unexpected: declared
                .difference(&admitted.participant_ids)
                .cloned()
                .collect(),
        });
    }
    Ok(admitted)
}

fn claim(
    claims: &mut BTreeMap<String, Claim>,
    id: &str,
    operation: &str,
    disposition: Disposition,
) -> Result<(), AdmissionError> {
    let kind = id.split_once('.').map(|(kind, _)| kind).unwrap_or(id);
    if !PARTICIPANT_KINDS.contains(&kind) {
        return Err(AdmissionError::UnknownParticipantKind {
            value: kind.to_string(),
        });
    }
    if let Some(existing) = claims.get(id) {
        return Err(if existing.operation == operation {
            AdmissionError::DuplicateParticipant { id: id.to_string() }
        } else {
            AdmissionError::ConflictingParticipant {
                operation: id.to_string(),
                left: existing.operation.clone(),
                right: operation.to_string(),
            }
        });
    }
    claims.insert(
        id.to_string(),
        Claim {
            operation: operation.to_string(),
            disposition,
        },
    );
    Ok(())
}

fn http_id(method: &str, path: &str) -> String {
    format!("http.{method} {path}")
}
