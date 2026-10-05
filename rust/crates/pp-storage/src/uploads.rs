use crate::{
    Envelope, SettingsClient, WriterOwner,
    auth::{self, AuthPolicy},
    catalog, jobs,
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

mod capture_manifest;

pub use capture_manifest::{CaptureManifestInventory, inspect_capture_manifest};
use capture_manifest::{bind_capture_manifest, resolve_capture_manifest};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Existing {
        source_id: i64,
    },
    Create {
        metadata: Box<catalog::CreateSource>,
    },
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct CaptureId(String);

impl CaptureId {
    pub fn new(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        ensure!(
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control),
            "Invalid capture identifier"
        );
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CaptureId {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl fmt::Debug for CaptureId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CaptureId([redacted])")
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct Sha256Digest(String);

impl Sha256Digest {
    fn new(value: String) -> Result<Self> {
        digest(&value)?;
        Ok(Self(value))
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Sha256Digest([redacted])")
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelativePathsTransitionV1 {
    NodeJsonArrayStringFilterBooleanV1,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum LabelSelectionV1 {
    TrimmedRelativeThenSlashFilenameThenOrdinalStlV1,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BackslashBoundaryV1 {
    ReplaceWithSlashAtLabelBoundaryV1,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CanonicalPathsV1 {
    SourcePathNfcCaseFoldPrefixV1,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ArchiveLabelsV1 {
    NfcAtAcquisition,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FilePolicyV1 {
    policy_version: u32,
    relative_paths_transition: RelativePathsTransitionV1,
    label_selection: LabelSelectionV1,
    backslash_boundary: BackslashBoundaryV1,
    canonical_paths: CanonicalPathsV1,
    max_raw_input_bytes: u64,
    max_prepared_bytes: u64,
    max_files: u32,
    max_multipart_parts: u32,
    max_metadata_bytes: u64,
}

impl FilePolicyV1 {
    fn fixed() -> Self {
        Self {
            policy_version: 1,
            relative_paths_transition:
                RelativePathsTransitionV1::NodeJsonArrayStringFilterBooleanV1,
            label_selection: LabelSelectionV1::TrimmedRelativeThenSlashFilenameThenOrdinalStlV1,
            backslash_boundary: BackslashBoundaryV1::ReplaceWithSlashAtLabelBoundaryV1,
            canonical_paths: CanonicalPathsV1::SourcePathNfcCaseFoldPrefixV1,
            max_raw_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
            max_files: 10_000,
            max_multipart_parts: 10_001,
            max_metadata_bytes: 65_536,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ZipPolicyV1 {
    policy_version: u32,
    archive_labels: ArchiveLabelsV1,
    canonical_paths: CanonicalPathsV1,
    max_raw_input_bytes: u64,
    max_prepared_bytes: u64,
    max_zip_entries: u32,
}

impl ZipPolicyV1 {
    fn fixed() -> Self {
        Self {
            policy_version: 1,
            archive_labels: ArchiveLabelsV1::NfcAtAcquisition,
            canonical_paths: CanonicalPathsV1::SourcePathNfcCaseFoldPrefixV1,
            max_raw_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
            max_zip_entries: 10_000,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CapturedPayloadKindV1 {
    Files {
        paths: Vec<String>,
        policy: FilePolicyV1,
    },
    Zip {
        path: String,
        policy: ZipPolicyV1,
    },
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct CapturedPayloadV1(CapturedPayloadKindV1);

impl fmt::Debug for CapturedPayloadV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CapturedPayloadV1([redacted])")
    }
}

impl CapturedPayloadV1 {
    pub fn files(paths: Vec<String>) -> Self {
        Self(CapturedPayloadKindV1::Files {
            paths,
            policy: FilePolicyV1::fixed(),
        })
    }

    pub fn zip(path: String) -> Self {
        Self(CapturedPayloadKindV1::Zip {
            path,
            policy: ZipPolicyV1::fixed(),
        })
    }

    fn requested_paths(&self) -> Vec<&str> {
        match &self.0 {
            CapturedPayloadKindV1::Files { paths, .. } => {
                paths.iter().map(String::as_str).collect()
            }
            CapturedPayloadKindV1::Zip { path, .. } => vec![path],
        }
    }

    fn validate_policy(&self) -> Result<()> {
        ensure!(
            match &self.0 {
                CapturedPayloadKindV1::Files { policy, .. } => {
                    policy == &FilePolicyV1::fixed()
                }
                CapturedPayloadKindV1::Zip { policy, .. } => {
                    policy == &ZipPolicyV1::fixed()
                }
            },
            "Unsupported capture policy"
        );
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PolicyBindingV1<'a> {
    Files { policy: &'a FilePolicyV1 },
    Zip { policy: &'a ZipPolicyV1 },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdmissionLimits {
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
}

fn validate_admission_limits(limits: AdmissionLimits, quota: Option<u64>) -> Result<()> {
    ensure!(
        limits.max_input_bytes > 0
            && limits.max_input_bytes <= 256 * 1024 * 1024
            && limits.max_prepared_bytes > 0
            && limits.max_prepared_bytes <= 1024 * 1024 * 1024,
        "Invalid import limits"
    );
    let minimum = limits
        .max_input_bytes
        .checked_add(3 * limits.max_prepared_bytes)
        .and_then(|value| value.checked_add(16 * 1024 * 1024))
        .ok_or_else(|| anyhow!("Quota overflow"))?;
    ensure!(
        limits.reserved_bytes >= minimum
            && quota.is_none_or(|quota| limits.reserved_bytes <= quota),
        "Import quota exceeded"
    );
    Ok(())
}

#[derive(Serialize)]
struct CaptureManifestBindingV1<'a> {
    manifest_version: u32,
    capture_id: &'a CaptureId,
    operation_key: &'a str,
    actor: &'a str,
    target_digest: &'a Sha256Digest,
    input: &'a CapturedPayloadV1,
    admission_limits: AdmissionLimits,
    policy_digest: &'a Sha256Digest,
    requested_files: &'a [File],
    requested_digest: &'a Sha256Digest,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CapturedInputV2 {
    capture_version: u32,
    capture_id: CaptureId,
    payload: CapturedPayloadV1,
    policy_digest: Sha256Digest,
    target_digest: Sha256Digest,
    manifest_digest: Sha256Digest,
}

impl fmt::Debug for CapturedInputV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedInputV2")
            .field("capture_version", &self.capture_version)
            .field("capture_id", &self.capture_id)
            .field("payload", &self.payload)
            .field("policy_digest", &self.policy_digest)
            .field("target_digest", &self.target_digest)
            .field("manifest_digest", &self.manifest_digest)
            .finish()
    }
}

fn serialized_digest(value: &impl Serialize) -> Result<Sha256Digest> {
    Sha256Digest::new(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn capture_manifest_digest(binding: CaptureManifestBindingV1<'_>) -> Result<Sha256Digest> {
    serialized_digest(&("pp-source-capture-binding-v1", binding))
}

struct CaptureBindingDigests {
    policy_digest: Sha256Digest,
    manifest_digest: Sha256Digest,
}

fn calculate_capture_binding(
    capture_id: &CaptureId,
    operation_key: &str,
    actor: &str,
    target_digest: &Sha256Digest,
    input: &CapturedPayloadV1,
    admission_limits: AdmissionLimits,
    requested_files: &[File],
) -> Result<CaptureBindingDigests> {
    let requested_digest = serialized_digest(&requested_files)?;
    let policy_digest = input.policy_digest()?;
    let manifest_digest = capture_manifest_digest(CaptureManifestBindingV1 {
        manifest_version: 1,
        capture_id,
        operation_key,
        actor,
        target_digest,
        input,
        admission_limits,
        policy_digest: &policy_digest,
        requested_files,
        requested_digest: &requested_digest,
    })?;
    Ok(CaptureBindingDigests {
        policy_digest,
        manifest_digest,
    })
}

struct AdmissionDigests {
    requested_digest: Sha256Digest,
    intent_digest: Sha256Digest,
}

fn calculate_admission_digests(
    admission: &Admission,
    requested_files: &[File],
) -> Result<AdmissionDigests> {
    Ok(AdmissionDigests {
        requested_digest: serialized_digest(&requested_files)?,
        intent_digest: serialized_digest(&(admission, requested_files))?,
    })
}

impl CapturedInputV2 {
    pub fn bind(
        capture_id: CaptureId,
        payload: CapturedPayloadV1,
        actor: &str,
        operation_key: &str,
        target: &Target,
        admission_limits: AdmissionLimits,
        requested_files: &[File],
    ) -> Result<Self> {
        payload.validate_policy()?;
        let target_digest = serialized_digest(&("pp-source-import-target-v1", target))?;
        let binding = calculate_capture_binding(
            &capture_id,
            operation_key,
            actor,
            &target_digest,
            &payload,
            admission_limits,
            requested_files,
        )?;
        Ok(Self {
            capture_version: 1,
            capture_id,
            payload,
            policy_digest: binding.policy_digest,
            target_digest,
            manifest_digest: binding.manifest_digest,
        })
    }

    fn validate(
        &self,
        actor: &str,
        operation_key: &str,
        target: Option<&Target>,
        admission_limits: AdmissionLimits,
        requested_files: &[File],
    ) -> Result<()> {
        ensure!(self.capture_version == 1, "Unsupported capture version");
        self.payload.validate_policy()?;
        let binding = calculate_capture_binding(
            &self.capture_id,
            operation_key,
            actor,
            &self.target_digest,
            &self.payload,
            admission_limits,
            requested_files,
        )?;
        ensure!(
            binding.policy_digest == self.policy_digest,
            "Capture policy digest mismatch"
        );
        if let Some(target) = target {
            ensure!(
                serialized_digest(&("pp-source-import-target-v1", target))? == self.target_digest,
                "Capture target digest mismatch"
            );
        }
        ensure!(
            binding.manifest_digest == self.manifest_digest,
            "Capture manifest digest mismatch"
        );
        Ok(())
    }
}

impl CapturedPayloadV1 {
    fn policy_digest(&self) -> Result<Sha256Digest> {
        let binding = match &self.0 {
            CapturedPayloadKindV1::Files { policy, .. } => PolicyBindingV1::Files { policy },
            CapturedPayloadKindV1::Zip { policy, .. } => PolicyBindingV1::Zip { policy },
        };
        serialized_digest(&("pp-source-acquisition-policy-v1", binding))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordedArchiveLabels {
    LegacyStrict,
    CapturedNfcAtAcquisition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZipInputRef<'a> {
    pub path: &'a str,
    pub labels: RecordedArchiveLabels,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Files { paths: Vec<String> },
    Zip { path: String },
    Captured(CapturedInputV2),
}

impl Input {
    pub fn version(&self) -> u32 {
        match self {
            Self::Files { .. } | Self::Zip { .. } => 1,
            Self::Captured(_) => 2,
        }
    }

    pub fn requested_paths(&self) -> Vec<&str> {
        match self {
            Self::Files { paths } => paths.iter().map(String::as_str).collect(),
            Self::Zip { path } => vec![path],
            Self::Captured(captured) => captured.payload.requested_paths(),
        }
    }

    pub fn zip_input(&self) -> Option<ZipInputRef<'_>> {
        match self {
            Self::Files { .. } => None,
            Self::Zip { path } => Some(ZipInputRef {
                path,
                labels: RecordedArchiveLabels::LegacyStrict,
            }),
            Self::Captured(captured) => match &captured.payload.0 {
                CapturedPayloadKindV1::Files { .. } => None,
                CapturedPayloadKindV1::Zip { path, .. } => Some(ZipInputRef {
                    path,
                    labels: RecordedArchiveLabels::CapturedNfcAtAcquisition,
                }),
            },
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub key: String,
    pub target: Target,
    pub input: Input,
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Basis {
    pub current_source_revision_id: Option<i64>,
    pub url: String,
    pub branch: String,
    pub tag: Option<String>,
    pub source_kind: String,
    pub source_type: String,
    pub local_path: Option<String>,
    pub last_commit_sha: Option<String>,
    pub legacy_manifest_cutover: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Admitted,
    OwnedInputReady,
    Published,
    Activated,
    Conflict,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OwnedInput {
    pub locator: String,
    pub digest: String,
    pub files: Vec<File>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub tenant: String,
    pub source_id: i64,
    pub upstream_key: String,
    pub manifest_digest: String,
    pub locator: String,
    pub stored_bytes: u64,
    pub files: Vec<File>,
    pub suggested_rules: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceAuthorityRevision {
    pub version: u8,
    pub source_configuration_version: i64,
    pub activation_observation_digest: String,
    pub input_digest: String,
    pub producer_version: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Postprocessing {
    NotActivated,
    DocumentMetadataIndexed,
    DocumentMetadataIndexedPdfPending,
    IndexError,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub tenant: String,
    pub operation_key: String,
    pub job_id: String,
    pub source_id: i64,
    pub revision_id: i64,
    pub artifact: Artifact,
    pub basis: Basis,
    pub activated: bool,
    pub applied_at: String,
    pub postprocessing: Postprocessing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_revision: Option<SourceAuthorityRevision>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub tenant: String,
    pub actor: String,
    pub key: String,
    pub intent_digest: String,
    pub source_id: i64,
    pub job_id: String,
    pub input_version: u32,
    pub input: Input,
    pub requested_files: Vec<File>,
    pub requested_digest: String,
    pub state: State,
    pub basis: Basis,
    pub default_rules: bool,
    pub original_rules: Option<String>,
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
    pub owned: Option<OwnedInput>,
    pub artifact: Option<Artifact>,
    pub receipt: Option<Receipt>,
    pub cleanup_settled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_revision: Option<SourceAuthorityRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_cursor: Option<i64>,
}
#[derive(Clone, Debug)]
pub enum Phase {
    Read,
    Owned(OwnedInput),
    Published(Artifact),
    Activate,
    Cleanup,
    Fail,
}
impl Phase {
    fn observation_name(&self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Owned(_) => "owned",
            Self::Published(_) => "published",
            Self::Activate => "activated",
            Self::Cleanup => "cleanup",
            Self::Fail => "failed",
        }
    }
}

struct SourceObservationContext {
    job_id: String,
    attempt_generation: i64,
    attempt_fence: Option<String>,
    revision_id: Option<i64>,
    receipt_activated: Option<bool>,
    cancel_requested: bool,
}

impl SourceObservationContext {
    fn claimed(job: &jobs::JobRecord, lease: &jobs::AttemptLease, op: &Operation) -> Self {
        Self {
            job_id: job.job_id.clone(),
            attempt_generation: lease.generation(),
            attempt_fence: Some(lease.fence().to_owned()),
            revision_id: op.receipt.as_ref().map(|receipt| receipt.revision_id),
            receipt_activated: op.receipt.as_ref().map(|receipt| receipt.activated),
            cancel_requested: job.cancel_requested,
        }
    }

    fn targeted_refusal(job: &jobs::JobRecord) -> Self {
        Self {
            job_id: job.job_id.clone(),
            attempt_generation: job.generation,
            attempt_fence: None,
            revision_id: None,
            receipt_activated: None,
            cancel_requested: job.cancel_requested,
        }
    }
}

struct SourceDocumentProvenance<'a> {
    revision_id: i64,
    input_digest: &'a str,
    producer_version: &'a str,
}
pub(crate) enum Command {
    Admit {
        authority: AdmissionAuthority,
        policy: AuthPolicy,
        storage: Arc<crate::Shared>,
        request: Admission,
        expected_files: Vec<File>,
        disk_bytes: u64,
        accounting_epoch: u64,
        quota: u64,
    },
    Get {
        credential: jobs::Credential,
        policy: AuthPolicy,
        storage: Arc<crate::Shared>,
        key: String,
    },
    Phase {
        lease: jobs::AttemptLease,
        phase: Phase,
        policy: AuthPolicy,
    },
}

pub(crate) enum AdmissionAuthority {
    Credential(jobs::Credential),
    Preflighted(Box<PreflightedCapture>),
}
#[derive(Clone)]
pub struct ImportClient {
    storage: SettingsClient,
    policy: AuthPolicy,
    quota: u64,
}

pub struct PreflightedCapture {
    pub(crate) credential: jobs::Credential,
    pub(crate) tenant: String,
    pub(crate) actor: String,
    pub(crate) target: Target,
    pub(crate) replay: Option<Box<Operation>>,
}

pub struct PreparedCapturedAdmission {
    preflight: PreflightedCapture,
    request: Admission,
    expected_files: Vec<File>,
    manifest: Vec<u8>,
}

impl PreflightedCapture {
    pub fn replay(&self) -> Option<&Operation> {
        self.replay.as_deref()
    }

    pub fn prepare(
        self,
        capture_id: CaptureId,
        operation_key: String,
        payload: CapturedPayloadV1,
        limits: AdmissionLimits,
        expected_files: Vec<File>,
    ) -> Result<PreparedCapturedAdmission> {
        let bound = bind_capture_manifest(
            capture_id,
            payload,
            &self.actor,
            &operation_key,
            &self.target,
            limits,
            &expected_files,
        )?;
        let (captured, manifest) = bound.into_parts();
        let request = Admission {
            key: operation_key,
            target: self.target.clone(),
            input: Input::Captured(captured),
            reserved_bytes: limits.reserved_bytes,
            max_input_bytes: limits.max_input_bytes,
            max_prepared_bytes: limits.max_prepared_bytes,
        };
        Ok(PreparedCapturedAdmission {
            preflight: self,
            request,
            expected_files,
            manifest,
        })
    }
}

impl PreparedCapturedAdmission {
    pub fn manifest(&self) -> &[u8] {
        &self.manifest
    }
}

pub struct ResolvedCapturedClaim {
    manifest: Vec<u8>,
    inventory: Vec<File>,
    tenant: String,
    operation_key: String,
    job_id: String,
}

pub enum CaptureJournalCorrelation {
    ExactAdmitted(ResolvedCapturedClaim),
    ExactOwnedOrLater,
    Absent,
    MismatchRepairRequired,
}

impl WriterOwner {
    pub fn imports(&self, policy: AuthPolicy, quota: u64) -> Result<ImportClient> {
        ensure!(
            quota > 0 && quota <= 64 * 1024 * 1024 * 1024,
            "Invalid desktop quota"
        );
        self.auth_with_policy(policy)?;
        let mut configured = self
            .client
            .shared
            .import_quota
            .lock()
            .map_err(|_| anyhow!("Import quota poisoned"))?;
        ensure!(
            configured.is_none_or(|q| q == quota),
            "Import quota already configured"
        );
        *configured = Some(quota);
        Ok(ImportClient {
            storage: self.client(),
            policy,
            quota,
        })
    }
    pub fn import_repos_root(&self) -> Result<std::path::PathBuf> {
        Ok(self
            .lease
            .as_ref()
            .ok_or_else(|| anyhow!("Storage stopped"))?
            .data_dir()
            .join("repos"))
    }
}
impl ImportClient {
    pub fn accounting_epoch(&self) -> u64 {
        self.storage.shared.import_epoch.load(Ordering::Acquire)
    }
    pub fn admit(
        &self,
        credential: jobs::Credential,
        request: Admission,
        expected_files: Vec<File>,
        disk_bytes: u64,
        accounting_epoch: u64,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Admit {
                authority: AdmissionAuthority::Credential(credential),
                policy: self.policy,
                storage: self.storage.shared.clone(),
                request,
                expected_files,
                disk_bytes,
                accounting_epoch,
                quota: self.quota,
            },
            cancelled,
        )
    }

    pub fn preflight_capture(
        &self,
        credential: jobs::Credential,
        operation_key: String,
        target: Target,
        payload: CapturedPayloadV1,
        limits: AdmissionLimits,
    ) -> Result<PreflightedCapture> {
        jobs::preflight_capture(
            &self.storage,
            jobs::CapturePreflightRequest {
                credential,
                operation_key,
                target,
                payload,
                limits,
            },
            self.policy,
            self.storage.shared.clone(),
        )
    }

    pub fn admit_prepared(
        &self,
        prepared: PreparedCapturedAdmission,
        disk_bytes: u64,
        accounting_epoch: u64,
    ) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Admit {
                authority: AdmissionAuthority::Preflighted(Box::new(prepared.preflight)),
                policy: self.policy,
                storage: self.storage.shared.clone(),
                request: prepared.request,
                expected_files: prepared.expected_files,
                disk_bytes,
                accounting_epoch,
                quota: self.quota,
            },
            &AtomicBool::new(false),
        )
    }

    pub fn correlate_capture_manifest(
        &self,
        manifest: Vec<u8>,
        inventory: Vec<File>,
    ) -> Result<CaptureJournalCorrelation> {
        jobs::correlate_capture(&self.storage, manifest, inventory)
    }
    pub fn get(&self, credential: jobs::Credential, key: String) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Get {
                credential,
                policy: self.policy,
                storage: self.storage.shared.clone(),
                key,
            },
            &AtomicBool::new(false),
        )
    }
}

pub(crate) fn validate_capture_target(
    tx: &Transaction<'_>,
    tenant: &str,
    target: &mut Target,
) -> Result<()> {
    match target {
        Target::Existing { source_id } => {
            catalog::validate_capture_existing(tx, tenant, *source_id)
        }
        Target::Create { metadata } => catalog::validate_capture_create(tx, tenant, metadata),
    }
}

pub(crate) fn preflight_capture_target(
    tx: &Transaction<'_>,
    tenant: &str,
    actor: &str,
    operation_key: &str,
    target: &mut Target,
    payload: &CapturedPayloadV1,
    limits: AdmissionLimits,
) -> Result<Option<Box<Operation>>> {
    validate_admission_limits(limits, None)?;
    ensure!(
        !operation_key.is_empty()
            && operation_key.len() <= 128
            && !operation_key.chars().any(char::is_control),
        "Invalid operation key"
    );
    if let Target::Create { metadata } = target {
        catalog::normalize_capture_create(metadata)?;
    }
    if let Some(prior) = load(tx, tenant, operation_key)? {
        ensure!(prior.actor == actor, "Import belongs to another actor");
        let Input::Captured(captured) = &prior.input else {
            anyhow::bail!("Import idempotency conflict");
        };
        ensure!(&captured.payload == payload, "Import idempotency conflict");
        captured.validate(
            actor,
            operation_key,
            Some(target),
            limits,
            &prior.requested_files,
        )?;
        Ok(Some(Box::new(prior)))
    } else {
        validate_capture_target(tx, tenant, target)?;
        Ok(None)
    }
}
pub(crate) fn submit(
    storage: &SettingsClient,
    command: Command,
    cancelled: &AtomicBool,
) -> Result<Operation> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut queue = storage
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
        if queue.pending.len() < storage.shared.capacity {
            let (reply, rx) = mpsc::channel();
            queue
                .pending
                .push_back(Envelope::Uploads { command, reply });
            storage.shared.changed.notify_all();
            drop(queue);
            return rx
                .recv()
                .map_err(|_| anyhow!("Import commit outcome unknown"))?;
        }
        ensure!(Instant::now() < deadline, "Writer queue full");
        queue = storage
            .shared
            .changed
            .wait_timeout(queue, Duration::from_millis(5))
            .map_err(|_| anyhow!("Writer admission poisoned"))?
            .0;
    }
}
fn load(tx: &Transaction<'_>, tenant: &str, key: &str) -> Result<Option<Operation>> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT document FROM source_import_operations WHERE tenant=?1 AND operation_key=?2",
            params![tenant, key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| {
        let op: Operation = serde_json::from_str(&s)?;
        validate_operation(&op)?;
        Ok(op)
    })
    .transpose()
}
fn store(tx: &Transaction<'_>, op: &Operation) -> Result<()> {
    validate_operation(op)?;
    let state = serde_json::to_value(&op.state)?
        .as_str()
        .unwrap()
        .to_owned();
    tx.execute("UPDATE source_import_operations SET state=?3,document=?4 WHERE tenant=?1 AND operation_key=?2",params![op.tenant,op.key,state,serde_json::to_string(op)?])?;
    Ok(())
}
fn basis(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<Basis> {
    Ok(tx.query_row("SELECT current_source_revision_id,url,branch,tag,source_kind,source_type,local_path,last_commit_sha,legacy_manifest_cutover FROM projects WHERE tenant_id=?1 AND id=?2",params![tenant,id],|r|Ok(Basis{current_source_revision_id:r.get(0)?,url:r.get(1)?,branch:r.get(2)?,tag:r.get(3)?,source_kind:r.get(4)?,source_type:r.get(5)?,local_path:r.get(6)?,last_commit_sha:r.get(7)?,legacy_manifest_cutover:r.get(8)?}))?)
}
fn source_authority_revision(
    tx: &Transaction<'_>,
    tenant: &str,
    source_id: i64,
    basis: &Basis,
    input_digest: &str,
) -> Result<SourceAuthorityRevision> {
    let source_configuration_version: i64 = tx.query_row(
        "SELECT source_configuration_version FROM projects WHERE tenant_id=?1 AND id=?2",
        params![tenant, source_id],
        |row| row.get(0),
    )?;
    ensure!(
        source_configuration_version > 0,
        "Invalid Source configuration version"
    );
    digest(input_digest)?;
    Ok(SourceAuthorityRevision {
        version: 1,
        source_configuration_version,
        activation_observation_digest: hex::encode(Sha256::digest(serde_json::to_vec(basis)?)),
        input_digest: input_digest.into(),
        producer_version: "supplied-source-import-v1".into(),
    })
}

fn validate_source_authority_revision(tx: &Transaction<'_>, operation: &Operation) -> Result<()> {
    let revision = operation
        .authority_revision
        .as_ref()
        .ok_or_else(|| anyhow!("Legacy Source operation requires repair"))?;
    ensure!(
        revision.version == 1
            && revision.producer_version == "supplied-source-import-v1"
            && revision.source_configuration_version > 0,
        "Unsupported Source authority revision"
    );
    digest(&revision.activation_observation_digest)?;
    digest(&revision.input_digest)?;
    ensure!(
        revision.input_digest == operation.requested_digest
            && revision.activation_observation_digest
                == hex::encode(Sha256::digest(serde_json::to_vec(&operation.basis)?)),
        "Source authority revision binding mismatch"
    );
    let current: i64 = tx.query_row(
        "SELECT source_configuration_version FROM projects WHERE tenant_id=?1 AND id=?2",
        params![operation.tenant, operation.source_id],
        |row| row.get(0),
    )?;
    ensure!(
        current == revision.source_configuration_version,
        "Source configuration changed after admission"
    );
    Ok(())
}

fn digest(s: &str) -> Result<()> {
    ensure!(
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "Invalid digest"
    );
    Ok(())
}
fn path(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s.len() <= 4096
            && !s.contains(['\\', ':', '\0'])
            && !s.starts_with('/')
            && s.split('/').all(|p| !p.is_empty() && p != "." && p != ".."),
        "Invalid relative path"
    );
    Ok(())
}
fn files(files: &[File], max: u64) -> Result<()> {
    ensure!(!files.is_empty() && files.len() <= 10000, "Invalid files");
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    for f in files {
        path(&f.path)?;
        digest(&f.sha256)?;
        ensure!(names.insert(&f.path), "Duplicate file");
        total = total
            .checked_add(f.size)
            .ok_or_else(|| anyhow!("Input size overflow"))?;
    }
    ensure!(total <= max, "Input limit");
    Ok(())
}

pub(crate) fn correlate_capture(
    tx: &Transaction<'_>,
    manifest: Vec<u8>,
    inventory: Vec<File>,
) -> Result<CaptureJournalCorrelation> {
    let identity = capture_manifest::capture_manifest_identity(&manifest)?;
    let documents = tx
        .prepare("SELECT document FROM source_import_operations ORDER BY rowid")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for document in documents {
        let operation: Operation = serde_json::from_str(&document)?;
        validate_operation(&operation)?;
        let Input::Captured(captured) = &operation.input else {
            continue;
        };
        if captured.capture_id != identity.capture_id {
            continue;
        }
        if operation.key != identity.operation_key || operation.actor != identity.actor {
            return Ok(CaptureJournalCorrelation::MismatchRepairRequired);
        }
        if resolve_capture_manifest(&manifest, &operation, &inventory).is_err() {
            return Ok(CaptureJournalCorrelation::MismatchRepairRequired);
        }
        if operation.state == State::Admitted {
            return Ok(CaptureJournalCorrelation::ExactAdmitted(
                ResolvedCapturedClaim {
                    manifest,
                    inventory,
                    tenant: operation.tenant,
                    operation_key: operation.key,
                    job_id: operation.job_id,
                },
            ));
        }
        return Ok(CaptureJournalCorrelation::ExactOwnedOrLater);
    }

    let jobs = tx
        .prepare("SELECT document FROM durable_jobs ORDER BY rowid")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for document in jobs {
        let job: jobs::JobRecord = serde_json::from_str(&document)?;
        if matches!(
            &job.payload,
            jobs::Payload::SuppliedSourceImport {
                operation_key,
                input_version: 2,
                ..
            } if operation_key == &identity.operation_key
        ) {
            return Ok(CaptureJournalCorrelation::MismatchRepairRequired);
        }
    }
    Ok(CaptureJournalCorrelation::Absent)
}

pub(crate) fn validate_resolved_claim(
    tx: &Transaction<'_>,
    claim: &ResolvedCapturedClaim,
) -> Result<String> {
    let operation = load(tx, &claim.tenant, &claim.operation_key)?
        .ok_or_else(|| anyhow!("Captured import requires repair"))?;
    ensure!(
        operation.state == State::Admitted && operation.job_id == claim.job_id,
        "Captured import requires repair"
    );
    resolve_capture_manifest(&claim.manifest, &operation, &claim.inventory)
        .map_err(|_| anyhow!("Captured import requires repair"))?;
    let job = jobs::load_for_capture_claim(tx, &claim.job_id)?;
    ensure!(
        job.tenant == operation.tenant
            && job.job_id == operation.job_id
            && matches!(
                &job.payload,
                jobs::Payload::SuppliedSourceImport {
                    project_id,
                    operation_key,
                    input_version: 2,
                } if *project_id as i64 == operation.source_id
                    && operation_key == &operation.key
            ),
        "Captured import requires repair"
    );
    Ok(claim.job_id.clone())
}

pub(crate) fn execute(
    conn: &mut Connection,
    catalog_state: &catalog::State,
    command: Command,
) -> Result<Operation> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let operation = match command {
        Command::Get {
            credential,
            policy,
            storage,
            key,
        } => {
            let (tenant, actor) = jobs::actor(&tx, credential, policy, &storage)?;
            let op = load(&tx, &tenant, &key)?.ok_or_else(|| anyhow!("Import not found"))?;
            ensure!(op.actor == actor, "Import belongs to another actor");
            op
        }
        Command::Admit {
            authority,
            policy,
            storage,
            mut request,
            expected_files,
            disk_bytes,
            accounting_epoch,
            quota,
        } => {
            ensure!(
                storage.import_epoch.load(Ordering::Acquire) == accounting_epoch,
                "Import accounting changed; retry admission"
            );
            let (tenant, actor, original_authority) = match authority {
                AdmissionAuthority::Credential(credential) => {
                    auth::authority::admit(&tx, credential, policy, &storage)?
                }
                AdmissionAuthority::Preflighted(preflight) => {
                    let (preflight_tenant, preflight_actor) =
                        jobs::actor_ref(&tx, &preflight.credential, policy, &storage)?;
                    ensure!(
                        preflight_tenant == preflight.tenant && preflight_actor == preflight.actor,
                        "Capture authority changed"
                    );
                    let (tenant, actor, authority) =
                        auth::authority::admit(&tx, preflight.credential, policy, &storage)?;
                    ensure!(
                        tenant == preflight_tenant && actor == preflight_actor,
                        "Capture authority changed"
                    );
                    (tenant, actor, authority)
                }
            };
            ensure!(
                !request.key.is_empty()
                    && request.key.len() <= 128
                    && !request.key.chars().any(char::is_control),
                "Invalid operation key"
            );
            files(&expected_files, request.max_input_bytes)?;
            if let Input::Captured(captured) = &request.input {
                ensure!(
                    request.input.requested_paths()
                        == expected_files
                            .iter()
                            .map(|file| file.path.as_str())
                            .collect::<Vec<_>>()
                        && expected_files.iter().all(|file| file.kind == "input"),
                    "Capture inventory mismatch"
                );
                captured.validate(
                    &actor,
                    &request.key,
                    Some(&request.target),
                    AdmissionLimits {
                        reserved_bytes: request.reserved_bytes,
                        max_input_bytes: request.max_input_bytes,
                        max_prepared_bytes: request.max_prepared_bytes,
                    },
                    &expected_files,
                )?;
            }
            let admission_digests = calculate_admission_digests(&request, &expected_files)?;
            let requested_digest = admission_digests.requested_digest.0;
            let intent_digest = admission_digests.intent_digest.0;
            if let Some(prior) = load(&tx, &tenant, &request.key)? {
                ensure!(
                    prior.actor == actor && prior.intent_digest == intent_digest,
                    "Import idempotency conflict"
                );
                prior
            } else {
                validate_capture_target(&tx, &tenant, &mut request.target)?;
                validate_admission_limits(
                    AdmissionLimits {
                        reserved_bytes: request.reserved_bytes,
                        max_input_bytes: request.max_input_bytes,
                        max_prepared_bytes: request.max_prepared_bytes,
                    },
                    Some(quota),
                )?;
                let pending:i64=tx.query_row("SELECT COALESCE(SUM(reserved_bytes),0) FROM source_import_quota WHERE settled=0",[],|r|r.get(0))?;
                ensure!(
                    disk_bytes
                        .checked_add(pending as u64)
                        .and_then(|v| v.checked_add(request.reserved_bytes))
                        .is_some_and(|v| v <= quota),
                    "Owner import quota exceeded"
                );
                let paths = request.input.requested_paths();
                ensure!(
                    !paths.is_empty() && paths.len() <= 10000,
                    "Invalid supplied input"
                );
                for p in paths {
                    path(p)?;
                }
                let input_version = request.input.version();
                let id = match request.target {
                    Target::Existing { source_id } => source_id,
                    Target::Create { metadata } => match catalog::run(
                        &tx,
                        catalog_state,
                        &tenant,
                        catalog::Request::CreateCatalogSource { source: *metadata },
                    )? {
                        catalog::Outcome::Source(Some(s)) => s.id,
                        _ => unreachable!(),
                    },
                };
                let basis = basis(&tx, &tenant, id)?;
                let authority_revision =
                    source_authority_revision(&tx, &tenant, id, &basis, &requested_digest)?;
                let original_rules: Option<String> = tx.query_row(
                    "SELECT imported_paths FROM projects WHERE tenant_id=?1 AND id=?2",
                    params![tenant, id],
                    |r| r.get(0),
                )?;
                let default_rules = original_rules.is_none();
                let payload = jobs::Payload::SuppliedSourceImport {
                    project_id: id.try_into()?,
                    operation_key: request.key.clone(),
                    input_version,
                };
                let job = match jobs::user_with_authority(
                    &tx,
                    &tenant,
                    &actor,
                    original_authority,
                    jobs::UserOperation::Enqueue {
                        key: format!(
                            "source-import:{}",
                            hex::encode(Sha256::digest(request.key.as_bytes()))
                        ),
                        payload_version: 1,
                        payload,
                    },
                )? {
                    jobs::Outcome::Job(job, _) => job,
                    _ => unreachable!(),
                };
                let op = Operation {
                    tenant,
                    actor,
                    key: request.key,
                    intent_digest,
                    source_id: id,
                    job_id: job.job_id,
                    input_version,
                    input: request.input,
                    requested_files: expected_files,
                    requested_digest,
                    state: State::Admitted,
                    basis,
                    default_rules,
                    original_rules,
                    reserved_bytes: request.reserved_bytes,
                    max_input_bytes: request.max_input_bytes,
                    max_prepared_bytes: request.max_prepared_bytes,
                    owned: None,
                    artifact: None,
                    receipt: None,
                    cleanup_settled: false,
                    authority_revision: Some(authority_revision),
                    observation_cursor: Some(0),
                };
                tx.execute("INSERT INTO source_import_operations(tenant,operation_key,actor,intent_digest,source_id,job_id,state,document_version,document) VALUES(?1,?2,?3,?4,?5,?6,'admitted',1,?7)",params![op.tenant,op.key,op.actor,op.intent_digest,op.source_id,op.job_id,serde_json::to_string(&op)?])?;
                tx.execute(
                    "INSERT INTO source_import_quota VALUES(?1,?2,?3,0,0)",
                    params![op.tenant, op.key, i64::try_from(op.reserved_bytes)?],
                )?;
                op
            }
        }
        Command::Phase {
            lease,
            phase,
            policy,
        } => {
            let mut job = jobs::claimed_job(&tx, &lease)?;
            let (source_id, key, input_version) = match &job.payload {
                jobs::Payload::SuppliedSourceImport {
                    project_id,
                    operation_key,
                    input_version,
                } => (*project_id as i64, operation_key.clone(), *input_version),
                _ => return Err(anyhow!("Not supplied Source import")),
            };
            let mut op =
                load(&tx, &job.tenant, &key)?.ok_or_else(|| anyhow!("Missing import operation"))?;
            ensure!(
                op.job_id == job.job_id
                    && op.source_id == source_id
                    && op.input_version == input_version,
                "Import job binding mismatch"
            );
            let phase_name = phase.observation_name();
            if let Err(error) = jobs::revalidate_source_authority(&tx, &job, policy) {
                let context = SourceObservationContext::claimed(&job, &lease, &op);
                if jobs::commit_source_authority_refusal(&tx, &mut job, &error)? {
                    record_observation(&tx, &mut op, "authority_refused", context)?;
                    store(&tx, &op)?;
                    tx.commit()
                        .map_err(|_| anyhow!(jobs::JobFailure::CommitUnknown))?;
                }
                return Err(error);
            }
            if matches!(&phase, Phase::Activate) {
                validate_source_authority_revision(&tx, &op)?;
            }
            ensure!(
                !job.cancel_requested
                    || matches!(phase, Phase::Cleanup | Phase::Fail | Phase::Read),
                "Import cancelled"
            );
            match phase {
                Phase::Read => {}
                Phase::Owned(owned) => {
                    ensure!(op.state == State::Admitted, "Input already captured");
                    ensure!(
                        owned.locator == format!(".pp-imports/{}", op.job_id),
                        "Owned locator mismatch"
                    );
                    digest(&owned.digest)?;
                    files(&owned.files, op.max_input_bytes)?;
                    ensure!(
                        owned.files == op.requested_files && owned.digest == op.requested_digest,
                        "Supplied input changed after admission"
                    );
                    op.owned = Some(owned);
                    op.state = State::OwnedInputReady;
                }
                Phase::Published(artifact) => {
                    ensure!(op.state == State::OwnedInputReady, "Input not ready");
                    ensure!(
                        artifact.tenant == op.tenant
                            && artifact.source_id == op.source_id
                            && artifact.locator
                                == format!("{}/revisions/{}", op.source_id, artifact.upstream_key),
                        "Artifact binding mismatch"
                    );
                    digest(&artifact.upstream_key)?;
                    digest(&artifact.manifest_digest)?;
                    files(&artifact.files, op.max_prepared_bytes)?;
                    ensure!(
                        artifact.stored_bytes <= op.reserved_bytes,
                        "Artifact quota exceeded"
                    );
                    op.artifact = Some(artifact);
                    op.state = State::Published;
                }
                Phase::Activate => {
                    ensure!(op.state == State::Published, "Artifact not published");
                    activate(&tx, catalog_state, &mut op, &lease)?;
                }
                Phase::Fail => {
                    ensure!(op.receipt.is_none(), "Import already completed");
                    op.state = if job.cancel_requested {
                        State::Cancelled
                    } else {
                        State::Failed
                    };
                }
                Phase::Cleanup => {
                    ensure!(
                        matches!(
                            op.state,
                            State::Activated | State::Conflict | State::Failed | State::Cancelled
                        ),
                        "Import is not settled"
                    );
                    op.cleanup_settled = true;
                    tx.execute("UPDATE source_import_quota SET reserved_bytes=0,retained_bytes=?3,settled=1 WHERE tenant=?1 AND operation_key=?2",params![op.tenant,op.key,i64::try_from(op.artifact.as_ref().map_or(0,|a|a.stored_bytes))?])?;
                    job.state = match op.state {
                        State::Activated => jobs::PersistentState::Succeeded,
                        State::Cancelled => jobs::PersistentState::Cancelled,
                        _ => jobs::PersistentState::Failed,
                    };
                    jobs::save(&tx, &mut job, "source_import_settled")?;
                }
            }
            if !matches!(phase_name, "read") {
                let context = SourceObservationContext::claimed(&job, &lease, &op);
                record_observation(&tx, &mut op, phase_name, context)?;
            }
            store(&tx, &op)?;
            op
        }
    };
    tx.commit()?;
    Ok(operation)
}
fn record_observation(
    tx: &Transaction<'_>,
    op: &mut Operation,
    phase: &str,
    context: SourceObservationContext,
) -> Result<()> {
    if op.authority_revision.is_none() {
        return Ok(());
    }
    let cursor = op
        .observation_cursor
        .ok_or_else(|| anyhow!("Missing U10 observation cursor"))?
        .checked_add(1)
        .ok_or_else(|| anyhow!("U10 observation cursor overflow"))?;
    tx.execute(
        "INSERT INTO source_revision_observations(tenant_id,operation_key,cursor,phase,job_id,attempt_generation,attempt_fence,revision_id,receipt_activated,cancel_requested,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![op.tenant, op.key, cursor, phase, context.job_id, context.attempt_generation, context.attempt_fence, context.revision_id, context.receipt_activated, context.cancel_requested, auth::catalog_timestamp()],
    )?;
    op.observation_cursor = Some(cursor);
    Ok(())
}

pub(crate) fn record_targeted_authority_refusal(
    tx: &Transaction<'_>,
    job: &jobs::JobRecord,
) -> Result<()> {
    let (source_id, operation_key, input_version) = match &job.payload {
        jobs::Payload::SuppliedSourceImport {
            project_id,
            operation_key,
            input_version,
        } => (*project_id as i64, operation_key, *input_version),
        _ => return Err(anyhow!("Targeted refusal is not a supplied Source import")),
    };
    let Some(mut op) = load(tx, &job.tenant, operation_key)? else {
        return Ok(());
    };
    ensure!(
        op.job_id == job.job_id && op.source_id == source_id && op.input_version == input_version,
        "Import job binding mismatch"
    );
    record_observation(
        tx,
        &mut op,
        "authority_refused",
        SourceObservationContext::targeted_refusal(job),
    )?;
    store(tx, &op)
}
fn activate(
    tx: &Transaction<'_>,
    state: &catalog::State,
    op: &mut Operation,
    lease: &jobs::AttemptLease,
) -> Result<()> {
    let a = op
        .artifact
        .as_ref()
        .ok_or_else(|| anyhow!("Missing artifact"))?;
    let now = auth::catalog_timestamp();
    let authority_revision = op
        .authority_revision
        .as_ref()
        .ok_or_else(|| anyhow!("Legacy Source operation requires repair"))?;
    tx.execute("INSERT INTO source_revisions(tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at,completeness,source_configuration_version,activation_observation_digest,input_digest,producer_version) VALUES(?1,?2,?3,?4,?5,?6,'complete',?7,?8,?9,?10) ON CONFLICT DO NOTHING",params![op.tenant,op.source_id,a.upstream_key,a.manifest_digest,a.locator,now,authority_revision.source_configuration_version,authority_revision.activation_observation_digest,authority_revision.input_digest,authority_revision.producer_version])?;
    let(id,digest,locator,synced):(i64,String,String,String)=tx.query_row("SELECT id,manifest_digest,snapshot_locator,synced_at FROM source_revisions WHERE tenant_id=?1 AND project_id=?2 AND upstream_revision_key=?3 AND completeness='complete'",params![op.tenant,op.source_id,a.upstream_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    ensure!(
        digest == a.manifest_digest && locator == a.locator,
        "Accepted revision identity mismatch"
    );
    tx.execute(
        "INSERT INTO source_revision_attempts(tenant_id,operation_key,job_id,source_id,revision_id,source_configuration_version,activation_observation_digest,input_digest,producer_version,attempt_generation,attempt_fence,activated,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12)",
        params![op.tenant,op.key,op.job_id,op.source_id,id,authority_revision.source_configuration_version,authority_revision.activation_observation_digest,authority_revision.input_digest,authority_revision.producer_version,lease.generation(),lease.fence(),now],
    )?;
    tx.execute(
        "INSERT INTO source_revision_artifacts(revision_id,artifact_kind,input_digest,producer_version,artifact_digest) VALUES(?1,'snapshot_manifest',?2,?3,?4) ON CONFLICT DO NOTHING",
        params![id,authority_revision.input_digest,authority_revision.producer_version,a.manifest_digest],
    )?;
    let b = &op.basis;
    let local = state
        .directory
        .join("repos")
        .join(&a.locator)
        .to_string_lossy()
        .into_owned();
    let version = a.upstream_key.clone();
    let changed=tx.execute("UPDATE projects SET current_source_revision_id=?3,local_path=?4,last_commit_sha=?5,last_synced_at=?6 WHERE tenant_id=?1 AND id=?2 AND current_source_revision_id IS ?7 AND url=?8 AND branch=?9 AND tag IS ?10 AND source_kind=?11 AND source_type=?12 AND local_path IS ?13 AND last_commit_sha IS ?14 AND legacy_manifest_cutover=?15",params![op.tenant,op.source_id,id,local,version,synced,b.current_source_revision_id,b.url,b.branch,b.tag,b.source_kind,b.source_type,b.local_path,b.last_commit_sha,b.legacy_manifest_cutover])?;
    let activated = changed == 1;
    let mut postprocessing = Postprocessing::NotActivated;
    if activated {
        let document_provenance = SourceDocumentProvenance {
            revision_id: id,
            input_digest: &authority_revision.input_digest,
            producer_version: &authority_revision.producer_version,
        };
        let raw: Option<String> = tx.query_row(
            "SELECT metadata_json FROM projects WHERE tenant_id=?1 AND id=?2",
            params![op.tenant, op.source_id],
            |r| r.get(0),
        )?;
        let mut metadata = raw
            .and_then(|s| {
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok()
            })
            .unwrap_or_default();
        metadata.insert(
            "remote_update_status".into(),
            serde_json::json!("up_to_date"),
        );
        metadata.insert("remote_checked_at".into(), serde_json::json!(now));
        metadata.remove("sync_error");
        metadata.remove("sync_required");
        tx.execute(
            "UPDATE projects SET metadata_json=?3 WHERE tenant_id=?1 AND id=?2",
            params![op.tenant, op.source_id, serde_json::to_string(&metadata)?],
        )?;
        let current_rules: Option<String> = tx.query_row(
            "SELECT imported_paths FROM projects WHERE tenant_id=?1 AND id=?2",
            params![op.tenant, op.source_id],
            |r| r.get(0),
        )?;
        if op.default_rules && current_rules == op.original_rules && !a.suggested_rules.is_empty() {
            catalog::run(
                tx,
                state,
                &op.tenant,
                catalog::Request::SaveImportRules {
                    id: op.source_id,
                    rules: a.suggested_rules.clone(),
                },
            )?;
        }
        tx.execute_batch("SAVEPOINT import_docs")?;
        let docs = (|| -> Result<()> {
            tx.execute(
                "DELETE FROM source_docs WHERE tenant_id=?1 AND project_id=?2",
                params![op.tenant, op.source_id],
            )?;
            let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
                .map_err(|e| anyhow!("{e}"))?;
            let mut ordered = a.files.iter().collect::<Vec<_>>();
            ordered.sort_by(|a, b| {
                (a.kind != "readme")
                    .cmp(&(b.kind != "readme"))
                    .then_with(|| collator.compare(&a.path, &b.path))
            });
            for f in ordered {
                if ["readme", "md", "pdf"].contains(&f.kind.as_str()) {
                    tx.execute("INSERT INTO source_docs(tenant_id,project_id,path,kind,size_bytes,content_hash,extract_status,source_revision_id,input_digest,producer_version,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![op.tenant,op.source_id,f.path,f.kind,i64::try_from(f.size)?,&f.sha256[..24],if f.kind=="pdf"{"pending"}else{"na"},document_provenance.revision_id,document_provenance.input_digest,document_provenance.producer_version,now])?;
                }
            }
            Ok(())
        })();
        postprocessing = if docs.is_ok() {
            tx.execute_batch("RELEASE import_docs")?;
            if a.files.iter().any(|f| f.kind == "pdf") {
                Postprocessing::DocumentMetadataIndexedPdfPending
            } else {
                Postprocessing::DocumentMetadataIndexed
            }
        } else {
            tx.execute_batch("ROLLBACK TO import_docs; RELEASE import_docs")?;
            Postprocessing::IndexError
        };
    }
    op.state = if activated {
        State::Activated
    } else {
        State::Conflict
    };
    op.receipt = Some(Receipt {
        tenant: op.tenant.clone(),
        operation_key: op.key.clone(),
        job_id: op.job_id.clone(),
        source_id: op.source_id,
        revision_id: id,
        artifact: a.clone(),
        basis: op.basis.clone(),
        activated,
        applied_at: now,
        postprocessing,
        authority_revision: Some(authority_revision.clone()),
    });
    if activated {
        tx.execute(
            "UPDATE source_revision_attempts SET activated=1 WHERE tenant_id=?1 AND operation_key=?2",
            params![op.tenant, op.key],
        )?;
    }
    Ok(())
}
pub(crate) fn source_reserved(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM source_import_operations o JOIN source_import_quota q USING(tenant,operation_key) WHERE o.tenant=?1 AND o.source_id=?2 AND q.settled=0)",params![tenant,id],|r|r.get(0))?)
}

#[derive(Debug, PartialEq, Eq)]
struct ColumnDefinition {
    declared_type: String,
    not_null: bool,
    default_value: Option<String>,
    primary_key: bool,
}

fn column_definition(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<ColumnDefinition> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                ColumnDefinition {
                    declared_type: row.get(2)?,
                    not_null: row.get::<_, i64>(3)? != 0,
                    default_value: row.get(4)?,
                    primary_key: row.get::<_, i64>(5)? != 0,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    columns
        .into_iter()
        .find_map(|(name, definition)| (name == column).then_some(definition))
        .ok_or_else(|| anyhow!("Missing Source revision column {table}.{column}"))
}

fn normalize_schema_sql(sql: &str) -> String {
    let mut literal = false;
    let mut normalized = String::new();
    for character in sql.chars() {
        if character == '\'' {
            literal = !literal;
        }
        if literal || character == '\'' {
            normalized.push(character);
        } else if !character.is_ascii_whitespace() {
            normalized.extend(character.to_lowercase());
        }
    }
    normalized
}

fn column_schema_sql(connection: &Connection, table: &str, column: &str) -> Result<String> {
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    let body = &sql[sql
        .find('(')
        .ok_or_else(|| anyhow!("Missing table definition"))?
        + 1..];
    let mut depth = 0;
    let mut literal = false;
    let mut start = 0;
    for (index, character) in body.char_indices() {
        if character == '\'' {
            literal = !literal;
        }
        if literal {
            continue;
        }
        if character == '(' {
            depth += 1;
        } else if (character == ',' || character == ')') && depth == 0 {
            let definition = body[start..index].trim();
            if definition.split_whitespace().next() == Some(column) {
                return Ok(normalize_schema_sql(definition));
            }
            start = index + 1;
        } else if character == ')' {
            depth -= 1;
        }
    }
    Err(anyhow!("Missing Source column definition {table}.{column}"))
}

pub(crate) fn validate_schema(conn: &Connection, version: u64) -> Result<()> {
    let names = [
        "source_import_operations",
        "source_import_source",
        "source_import_quota",
        "source_import_quota_pending",
    ];
    if version < 36 {
        for name in names {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [name],
                |r| r.get(0),
            )?;
            ensure!(!present, "Unexpected Source import schema");
        }
        return Ok(());
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(include_str!("uploads/schema.sql"))?;
    for name in names {
        let sql: String =
            conn.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })?;
        let canonical: String =
            expected.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })?;
        ensure!(sql == canonical, "Source import schema mismatch");
    }
    if version >= 38 {
        let expected = Connection::open_in_memory()?;
        expected.execute_batch(
            "CREATE TABLE projects(\
               id INTEGER PRIMARY KEY,\
               source_configuration_version INTEGER NOT NULL DEFAULT 1\
             );\
             CREATE TABLE source_revisions(\
               id INTEGER PRIMARY KEY,\
               source_configuration_version INTEGER,\
               activation_observation_digest TEXT,\
               input_digest TEXT,\
               producer_version TEXT\
             );\
             CREATE TABLE source_docs(\
               id INTEGER PRIMARY KEY,\
               source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE RESTRICT,\
               input_digest TEXT,\
               producer_version TEXT CHECK ((source_revision_id IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_revision_id IS NOT NULL AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL))\
             );\
             CREATE TABLE source_import_operations(\
               tenant TEXT NOT NULL, operation_key TEXT NOT NULL,\
               PRIMARY KEY(tenant, operation_key)\
             );",
        )?;
        expected.execute_batch(include_str!("remote_sources/schema.sql"))?;
        for name in [
            "source_revision_attempts",
            "source_revision_artifacts",
            "source_revision_observations",
            "trg_source_revisions_provenance_immutable_update",
            "trg_source_revisions_provenance_immutable_delete",
            "trg_source_revision_attempts_immutable_update",
            "trg_source_revision_attempts_immutable_delete",
            "trg_source_revision_artifacts_immutable_update",
            "trg_source_revision_artifacts_immutable_delete",
            "trg_source_revision_observations_immutable_update",
            "trg_source_revision_observations_immutable_delete",
        ] {
            let sql: String =
                conn.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                    r.get(0)
                })?;
            let canonical: String =
                expected.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                    r.get(0)
                })?;
            ensure!(
                normalize_schema_sql(&sql) == normalize_schema_sql(&canonical),
                "Source revision journal schema mismatch"
            );
        }
        for (table, column) in [
            ("projects", "source_configuration_version"),
            ("source_revisions", "source_configuration_version"),
            ("source_revisions", "activation_observation_digest"),
            ("source_revisions", "input_digest"),
            ("source_revisions", "producer_version"),
            ("source_docs", "source_revision_id"),
            ("source_docs", "input_digest"),
            ("source_docs", "producer_version"),
        ] {
            ensure!(
                column_definition(conn, table, column)?
                    == column_definition(&expected, table, column)?,
                "Source revision column schema mismatch"
            );
            ensure!(
                column_schema_sql(conn, table, column)?
                    == column_schema_sql(&expected, table, column)?,
                "Source revision column constraint mismatch"
            );
        }
        let partial_document_provenance: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_docs WHERE NOT ((source_revision_id IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_revision_id IS NOT NULL AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL)))",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            !partial_document_provenance,
            "Partial Source document provenance"
        );
        let partial_revision_provenance: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_revisions WHERE NOT ((source_configuration_version IS NULL AND activation_observation_digest IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_configuration_version IS NOT NULL AND activation_observation_digest IS NOT NULL AND length(activation_observation_digest) = 64 AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL)))",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            !partial_revision_provenance,
            "Partial Source revision provenance"
        );
        let invalid_observation_context: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_revision_observations WHERE attempt_generation <= 0 OR cancel_requested NOT IN (0,1) OR receipt_activated NOT IN (0,1) OR (receipt_activated IS NOT NULL AND revision_id IS NULL))",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            !invalid_observation_context,
            "Invalid Source observation context"
        );
    }
    let orphans:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM source_import_quota q LEFT JOIN source_import_operations o USING(tenant,operation_key) WHERE o.tenant IS NULL)",[],|r|r.get(0))?;
    ensure!(!orphans, "Orphan Source quota");
    let rows=conn.prepare("SELECT tenant,operation_key,actor,intent_digest,source_id,job_id,state,document_version,document FROM source_import_operations")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,u32>(7)?,r.get::<_,String>(8)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (t, k, a, d, s, j, state, v, raw) in rows {
        let op: Operation = serde_json::from_str(&raw)?;
        ensure!(
            v == 1
                && t == op.tenant
                && k == op.key
                && a == op.actor
                && d == op.intent_digest
                && s == op.source_id
                && j == op.job_id
                && serde_json::to_value(&op.state)? == state,
            "Corrupt Source import journal"
        );
        validate_operation(&op)?;
        let document: String = conn.query_row("SELECT document FROM durable_jobs WHERE id=?1 UNION ALL SELECT archived_document FROM durable_job_keys WHERE job_id=?1 AND archived_document IS NOT NULL LIMIT 1",[&j],|r|r.get(0))?;
        let job: jobs::JobRecord = serde_json::from_str(&document)?;
        ensure!(
            job.payload_version == 1
                && job.job_id == j
                && job.tenant == t
                && job.payload
                    == jobs::Payload::SuppliedSourceImport {
                        project_id: s.try_into()?,
                        operation_key: k.clone(),
                        input_version: op.input_version
                    },
            "Import job binding mismatch"
        );
        ensure!(
            !op.cleanup_settled || job.state.terminal(),
            "Import completion job mismatch"
        );
        let retained: i64 = conn.query_row(
            "SELECT retained_bytes FROM source_import_quota WHERE tenant=?1 AND operation_key=?2",
            params![t, k],
            |r| r.get(0),
        )?;
        ensure!(
            retained
                == if op.cleanup_settled {
                    i64::try_from(op.artifact.as_ref().map_or(0, |a| a.stored_bytes))?
                } else {
                    0
                },
            "Retained quota mismatch"
        );
        digest(&d)?;
        let(q,settled):(i64,bool)=conn.query_row("SELECT reserved_bytes,settled FROM source_import_quota WHERE tenant=?1 AND operation_key=?2",params![t,k],|r|Ok((r.get(0)?,r.get(1)?)))?;
        ensure!(
            settled == op.cleanup_settled
                && q == if settled {
                    0
                } else {
                    i64::try_from(op.reserved_bytes)?
                },
            "Corrupt Source quota journal"
        );
    }
    Ok(())
}

#[cfg(test)]
mod captured_digest_tests {
    use super::*;

    #[test]
    fn changed_typed_policy_preserves_inventory_and_changes_bound_digests() {
        let files = vec![File {
            path: "upload.zip".into(),
            size: 3,
            sha256: "a".repeat(64),
            kind: "input".into(),
        }];
        let capture_id = CaptureId::new("capture-policy-proof").unwrap();
        let limits = AdmissionLimits {
            reserved_bytes: 3_506_438_144,
            max_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
        };
        let original_payload = CapturedPayloadV1::zip("upload.zip".into());
        let mut changed_payload = original_payload.clone();
        match &mut changed_payload.0 {
            CapturedPayloadKindV1::Zip { policy, .. } => policy.max_zip_entries = 9_999,
            CapturedPayloadKindV1::Files { .. } => panic!("ZIP policy proof requires ZIP payload"),
        }
        assert!(changed_payload.validate_policy().is_err());

        let target = Target::Existing { source_id: 42 };
        let original_input = CapturedInputV2::bind(
            capture_id.clone(),
            original_payload,
            "physical-owner",
            "policy-proof",
            &target,
            limits,
            &files,
        )
        .unwrap();
        original_input
            .validate(
                "physical-owner",
                "policy-proof",
                Some(&target),
                limits,
                &files,
            )
            .unwrap();
        let changed_binding = calculate_capture_binding(
            &capture_id,
            "policy-proof",
            "physical-owner",
            &original_input.target_digest,
            &changed_payload,
            limits,
            &files,
        )
        .unwrap();
        let changed_input = CapturedInputV2 {
            capture_version: 1,
            capture_id,
            payload: changed_payload,
            policy_digest: changed_binding.policy_digest,
            target_digest: original_input.target_digest.clone(),
            manifest_digest: changed_binding.manifest_digest,
        };
        let original_admission = Admission {
            key: "policy-proof".into(),
            target: Target::Existing { source_id: 42 },
            input: Input::Captured(original_input.clone()),
            reserved_bytes: limits.reserved_bytes,
            max_input_bytes: limits.max_input_bytes,
            max_prepared_bytes: limits.max_prepared_bytes,
        };
        let changed_admission = Admission {
            key: "policy-proof".into(),
            target: Target::Existing { source_id: 42 },
            input: Input::Captured(changed_input.clone()),
            reserved_bytes: limits.reserved_bytes,
            max_input_bytes: limits.max_input_bytes,
            max_prepared_bytes: limits.max_prepared_bytes,
        };
        let original_digests = calculate_admission_digests(&original_admission, &files).unwrap();
        let changed_digests = calculate_admission_digests(&changed_admission, &files).unwrap();

        assert_eq!(
            original_digests.requested_digest,
            changed_digests.requested_digest
        );
        assert_ne!(original_input.policy_digest, changed_input.policy_digest);
        assert_ne!(
            original_input.manifest_digest,
            changed_input.manifest_digest
        );
        assert_ne!(
            serde_json::to_vec(&original_admission.input).unwrap(),
            serde_json::to_vec(&changed_admission.input).unwrap()
        );
        assert_ne!(
            original_digests.intent_digest,
            changed_digests.intent_digest
        );
    }
}

fn validate_operation(op: &Operation) -> Result<()> {
    ensure!(
        op.source_id > 0 && !op.key.is_empty() && op.key.len() <= 128 && !op.actor.is_empty(),
        "Invalid import identity"
    );
    digest(&op.job_id)?;
    digest(&op.intent_digest)?;
    digest(&op.requested_digest)?;
    if let Some(authority_revision) = &op.authority_revision {
        ensure!(
            authority_revision.version == 1
                && authority_revision.source_configuration_version > 0
                && authority_revision.producer_version == "supplied-source-import-v1"
                && authority_revision.input_digest == op.requested_digest
                && authority_revision.activation_observation_digest
                    == hex::encode(Sha256::digest(serde_json::to_vec(&op.basis)?)),
            "Invalid Source authority revision"
        );
        digest(&authority_revision.activation_observation_digest)?;
        digest(&authority_revision.input_digest)?;
        ensure!(
            op.observation_cursor.is_some_and(|cursor| cursor >= 0),
            "Invalid U10 cursor"
        );
    } else {
        ensure!(
            op.observation_cursor.is_none(),
            "Legacy Source cursor without authority revision"
        );
    }
    files(&op.requested_files, op.max_input_bytes)?;
    ensure!(
        hex::encode(Sha256::digest(serde_json::to_vec(&op.requested_files)?))
            == op.requested_digest,
        "Input digest mismatch"
    );
    match &op.input {
        Input::Files { .. } | Input::Zip { .. } => {
            ensure!(op.input_version == 1, "Invalid import input version");
        }
        Input::Captured(captured) => {
            ensure!(op.input_version == 2, "Invalid import input version");
            captured.validate(
                &op.actor,
                &op.key,
                None,
                AdmissionLimits {
                    reserved_bytes: op.reserved_bytes,
                    max_input_bytes: op.max_input_bytes,
                    max_prepared_bytes: op.max_prepared_bytes,
                },
                &op.requested_files,
            )?;
        }
    }
    let paths = op.input.requested_paths();
    ensure!(
        paths
            == op
                .requested_files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>()
            && op.requested_files.iter().all(|f| f.kind == "input"),
        "Input binding mismatch"
    );
    if let Some(owned) = &op.owned {
        ensure!(
            owned.locator == format!(".pp-imports/{}", op.job_id)
                && owned.digest == op.requested_digest
                && owned.files == op.requested_files,
            "Owned input binding mismatch"
        );
    }
    if let Some(a) = &op.artifact {
        digest(&a.upstream_key)?;
        digest(&a.manifest_digest)?;
        files(&a.files, op.max_prepared_bytes)?;
        ensure!(
            a.tenant == op.tenant
                && a.source_id == op.source_id
                && a.locator == format!("{}/revisions/{}", op.source_id, a.upstream_key)
                && a.stored_bytes <= op.reserved_bytes
                && a.files
                    .iter()
                    .all(|f| ["stl", "artifact", "readme", "md", "pdf"].contains(&f.kind.as_str())),
            "Artifact binding mismatch"
        );
    }
    if let Some(r) = &op.receipt {
        ensure!(
            r.tenant == op.tenant
                && r.source_id == op.source_id
                && r.operation_key == op.key
                && r.job_id == op.job_id
                && r.revision_id > 0
                && r.basis == op.basis
                && Some(&r.artifact) == op.artifact.as_ref()
                && r.activated == (op.state == State::Activated),
            "Receipt binding mismatch"
        );
        ensure!(
            r.authority_revision == op.authority_revision,
            "Receipt authority revision mismatch"
        );
        ensure!(
            match r.postprocessing {
                Postprocessing::NotActivated => !r.activated && op.state == State::Conflict,
                Postprocessing::DocumentMetadataIndexed =>
                    r.activated && !r.artifact.files.iter().any(|f| f.kind == "pdf"),
                Postprocessing::DocumentMetadataIndexedPdfPending =>
                    r.activated && r.artifact.files.iter().any(|f| f.kind == "pdf"),
                Postprocessing::IndexError => r.activated,
            },
            "Receipt postprocessing mismatch"
        );
    }
    ensure!(
        match op.state {
            State::Admitted => op.owned.is_none() && op.artifact.is_none() && op.receipt.is_none(),
            State::OwnedInputReady =>
                op.owned.is_some() && op.artifact.is_none() && op.receipt.is_none(),
            State::Published => op.owned.is_some() && op.artifact.is_some() && op.receipt.is_none(),
            State::Activated | State::Conflict =>
                op.owned.is_some() && op.artifact.is_some() && op.receipt.is_some(),
            State::Failed | State::Cancelled => op.receipt.is_none(),
        },
        "Invalid import state"
    );
    ensure!(
        !op.cleanup_settled
            || matches!(
                op.state,
                State::Activated | State::Conflict | State::Failed | State::Cancelled
            ),
        "Unsettled import cleanup"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Postprocessing;

    #[test]
    fn postprocessing_preserves_all_durable_wire_values() {
        for (state, wire) in [
            (Postprocessing::NotActivated, "not_activated"),
            (
                Postprocessing::DocumentMetadataIndexed,
                "document_metadata_indexed",
            ),
            (
                Postprocessing::DocumentMetadataIndexedPdfPending,
                "document_metadata_indexed_pdf_pending",
            ),
            (Postprocessing::IndexError, "index_error"),
        ] {
            let encoded = serde_json::to_string(&state).unwrap();
            assert_eq!(encoded, format!("\"{wire}\""));
            assert_eq!(
                serde_json::from_str::<Postprocessing>(&encoded).unwrap(),
                state
            );
        }
    }

    #[test]
    fn postprocessing_rejects_obsolete_and_unknown_values() {
        for wire in ["complete", "unknown", "", "DocumentMetadataIndexed"] {
            assert!(serde_json::from_value::<Postprocessing>(serde_json::json!(wire)).is_err());
        }
    }
}
