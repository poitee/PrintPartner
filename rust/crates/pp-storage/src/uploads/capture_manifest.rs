//! Capture-manifest inventory inspection and serialization (GRE-768).
//!
//! Binds a captured payload to a closed wire document through
//! [`CapturedInputV2`], then exposes public inventory inspection. Journal
//! resolution against admitted operations remains GRE-769.

use super::{
    AdmissionLimits, CaptureId, CapturedInputV2, CapturedPayloadV1, File, Sha256Digest, Target,
    serialized_digest, validate_admission_limits,
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
#[allow(
    dead_code,
    reason = "closed wire shape; GRE-769 resolve reads the remaining identity fields"
)]
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
#[derive(Debug)]
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

/// Inspect capture-manifest bytes without admitting an import.
pub fn inspect_capture_manifest(bytes: &[u8]) -> Result<CaptureManifestInventory> {
    let manifest: CaptureManifestV1 =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid capture manifest"))?;
    ensure!(manifest.manifest_version == 1, "Invalid capture manifest");
    validate_admission_limits(manifest.admission_limits, None)?;
    super::files(
        &manifest.requested_files,
        manifest.admission_limits.max_input_bytes,
    )?;
    let paths = manifest
        .requested_files
        .into_iter()
        .map(|file| file.path)
        .collect();
    Ok(CaptureManifestInventory {
        paths,
        max_input_bytes: manifest.admission_limits.max_input_bytes,
    })
}

#[allow(
    dead_code,
    reason = "serialize path exercised in unit tests; GRE-769+ callers consume the bound bytes"
)]
pub(crate) struct BoundCaptureManifest {
    input: CapturedInputV2,
    bytes: Vec<u8>,
}

#[allow(
    dead_code,
    reason = "serialize path exercised in unit tests; GRE-769+ callers consume the bound bytes"
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
    reason = "serialize path exercised in unit tests; GRE-769+ callers consume the bound bytes"
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
