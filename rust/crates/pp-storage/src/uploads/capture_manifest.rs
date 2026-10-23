//! Capture-manifest inventory inspection, serialization, and journal resolve
//! (GRE-768 / GRE-769).
//!
//! Binds a captured payload to a closed wire document through
//! [`CapturedInputV2`], inspects inventory only after digest integrity checks,
//! and resolves presented bytes against an admitted journal [`Operation`].

use super::{
    AdmissionLimits, CaptureId, CapturedInputV2, CapturedPayloadV1, File, Operation, Sha256Digest,
    Target, serialized_digest, target_digest, validate_admission_limits,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct CaptureManifestWire<'a> {
    manifest_version: u32,
    capture_id: &'a CaptureId,
    operation_key: &'a str,
    actor: &'a str,
    target: &'a Target,
    target_digest: &'a Sha256Digest,
    input: &'a CapturedPayloadV1,
    admission_limits: AdmissionLimits,
    policy_digest: &'a Sha256Digest,
    requested_files: &'a [File],
    requested_digest: &'a Sha256Digest,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureManifestV1 {
    manifest_version: u32,
    capture_id: CaptureId,
    operation_key: String,
    actor: String,
    target: Target,
    target_digest: Sha256Digest,
    input: CapturedPayloadV1,
    admission_limits: AdmissionLimits,
    policy_digest: Sha256Digest,
    requested_files: Vec<File>,
    requested_digest: Sha256Digest,
}

/// Inventory projection of a capture-manifest document.
#[derive(Debug, PartialEq, Eq)]
pub struct CaptureManifestInventory {
    paths: Vec<String>,
    max_input_bytes: u64,
}

impl CaptureManifestInventory {
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    pub fn max_input_bytes(&self) -> u64 {
        self.max_input_bytes
    }
}

fn inventory_of(manifest: &CaptureManifestV1) -> CaptureManifestInventory {
    CaptureManifestInventory {
        paths: manifest
            .requested_files
            .iter()
            .map(|file| file.path.clone())
            .collect(),
        max_input_bytes: manifest.admission_limits.max_input_bytes,
    }
}

fn ensure_payload_matches_inventory(manifest: &CaptureManifestV1) -> Result<()> {
    let payload_paths = manifest.input.requested_paths();
    let inventory_paths: Vec<&str> = manifest
        .requested_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    ensure!(
        payload_paths == inventory_paths,
        "Capture inventory mismatch"
    );
    Ok(())
}

/// Decode wire bytes and recompute digests before trusting inventory or identity.
fn verify_capture_manifest(bytes: &[u8]) -> Result<CaptureManifestV1> {
    let manifest: CaptureManifestV1 =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid capture manifest"))?;
    ensure!(manifest.manifest_version == 1, "Invalid capture manifest");
    validate_admission_limits(manifest.admission_limits, None)?;
    super::files(
        &manifest.requested_files,
        manifest.admission_limits.max_input_bytes,
    )?;
    manifest.input.validate()?;
    ensure_payload_matches_inventory(&manifest)?;

    let requested_digest = Sha256Digest::new(serialized_digest(&manifest.requested_files)?)?;
    ensure!(
        requested_digest == manifest.requested_digest,
        "Capture requested digest mismatch"
    );
    ensure!(
        target_digest(&manifest.target)? == manifest.target_digest,
        "Capture target digest mismatch"
    );
    ensure!(
        manifest.input.policy_digest()? == manifest.policy_digest,
        "Capture policy digest mismatch"
    );

    let bound = CapturedInputV2::bind(
        manifest.capture_id.clone(),
        manifest.input.clone(),
        &manifest.actor,
        &manifest.operation_key,
        &manifest.target,
        manifest.admission_limits,
        &manifest.requested_files,
    )?;
    ensure!(
        bound.policy_digest == manifest.policy_digest
            && bound.target_digest == manifest.target_digest,
        "Capture manifest digest mismatch"
    );
    Ok(manifest)
}

/// Inspect capture-manifest bytes without admitting an import.
pub fn inspect_capture_manifest(bytes: &[u8]) -> Result<CaptureManifestInventory> {
    Ok(inventory_of(&verify_capture_manifest(bytes)?))
}

/// Resolve capture-manifest bytes against an admitted journal operation.
///
/// Compares manifest identity (actor, operation key, target, policy digests,
/// inventory) with the recorded operation. Refuses without writing on any
/// mismatch or digest integrity failure.
pub fn resolve_capture_manifest(
    bytes: &[u8],
    operation: &Operation,
) -> Result<CaptureManifestInventory> {
    let manifest = verify_capture_manifest(bytes)?;
    ensure!(manifest.actor == operation.actor, "Capture actor mismatch");
    ensure!(
        manifest.operation_key == operation.key,
        "Capture operation key mismatch"
    );
    ensure!(
        manifest.admission_limits.reserved_bytes == operation.reserved_bytes
            && manifest.admission_limits.max_input_bytes == operation.max_input_bytes
            && manifest.admission_limits.max_prepared_bytes == operation.max_prepared_bytes,
        "Capture admission limits mismatch"
    );
    ensure!(
        manifest.requested_files == operation.requested_files,
        "Capture inventory mismatch"
    );
    ensure!(
        manifest.requested_digest == Sha256Digest::new(operation.requested_digest.clone())?,
        "Capture requested digest mismatch"
    );
    match &manifest.target {
        Target::Existing { source_id } => {
            ensure!(*source_id == operation.source_id, "Capture target mismatch");
        }
        Target::Create { .. } => {
            return Err(anyhow::anyhow!("Capture target mismatch"));
        }
    }

    let bound = CapturedInputV2::bind(
        manifest.capture_id.clone(),
        manifest.input.clone(),
        &manifest.actor,
        &manifest.operation_key,
        &manifest.target,
        manifest.admission_limits,
        &manifest.requested_files,
    )?;
    bound.validate(
        &operation.actor,
        &operation.key,
        Some(&Target::Existing {
            source_id: operation.source_id,
        }),
        AdmissionLimits {
            reserved_bytes: operation.reserved_bytes,
            max_input_bytes: operation.max_input_bytes,
            max_prepared_bytes: operation.max_prepared_bytes,
        },
        &operation.requested_files,
    )?;
    ensure!(
        bound.policy_digest == manifest.policy_digest
            && bound.target_digest == manifest.target_digest,
        "Capture manifest digest mismatch"
    );

    let rebound = bind_capture_manifest(
        manifest.capture_id.clone(),
        manifest.input.clone(),
        &manifest.actor,
        &manifest.operation_key,
        &manifest.target,
        manifest.admission_limits,
        &manifest.requested_files,
    )?;
    ensure!(rebound.bytes() == bytes, "Capture manifest mismatch");

    Ok(inventory_of(&manifest))
}

#[allow(
    dead_code,
    reason = "serialize path exercised in unit tests; GRE-770+ callers consume the bound parts"
)]
pub(crate) struct BoundCaptureManifest {
    input: CapturedInputV2,
    bytes: Vec<u8>,
}

#[allow(
    dead_code,
    reason = "serialize path exercised in unit tests; GRE-770+ callers consume the bound parts"
)]
impl BoundCaptureManifest {
    pub(crate) fn input(&self) -> &CapturedInputV2 {
        &self.input
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn into_parts(self) -> (CapturedInputV2, Vec<u8>) {
        (self.input, self.bytes)
    }
}

/// Serialize a capture manifest through the existing captured binding.
#[allow(
    dead_code,
    reason = "serialize path exercised in unit tests; GRE-770+ callers consume the bound parts"
)]
pub(crate) fn bind_capture_manifest(
    capture_id: CaptureId,
    payload: CapturedPayloadV1,
    actor: &str,
    operation_key: &str,
    target: &Target,
    limits: AdmissionLimits,
    requested_files: &[File],
) -> Result<BoundCaptureManifest> {
    validate_admission_limits(limits, None)?;
    super::files(requested_files, limits.max_input_bytes)?;
    let input = CapturedInputV2::bind(
        capture_id,
        payload,
        actor,
        operation_key,
        target,
        limits,
        requested_files,
    )?;
    let requested_digest = Sha256Digest::new(serialized_digest(&requested_files)?)?;
    let bytes = serde_json::to_vec(&CaptureManifestWire {
        manifest_version: 1,
        capture_id: &input.capture_id,
        operation_key,
        actor,
        target,
        target_digest: &input.target_digest,
        input: &input.payload,
        admission_limits: limits,
        policy_digest: &input.policy_digest,
        requested_files,
        requested_digest: &requested_digest,
    })?;
    Ok(BoundCaptureManifest { input, bytes })
}
