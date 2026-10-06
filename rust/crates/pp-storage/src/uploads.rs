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
    },
}

pub(crate) enum AdmissionAuthority {
    Credential(jobs::Credential),
    Preflighted(Box<PreflightedCapture>),
}
impl Command {
    pub(crate) fn changes_accounting(&self) -> bool {
        !matches!(
            self,
            Self::Get { .. }
                | Self::Phase {
                    phase: Phase::Read,
                    ..
                }
        )
    }
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
    ensure!(
        catalog::get(tx, &operation.tenant, operation.source_id)?.is_some(),
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
            let (tenant, actor) = match authority {
                AdmissionAuthority::Credential(credential) => {
                    jobs::actor(&tx, credential, policy, &storage)?
                }
                AdmissionAuthority::Preflighted(preflight) => {
                    let (tenant, actor) =
                        jobs::actor_ref(&tx, &preflight.credential, policy, &storage)?;
                    ensure!(
                        tenant == preflight.tenant && actor == preflight.actor,
                        "Capture authority changed"
                    );
                    (tenant, actor)
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
                let original_rules: Option<String> = tx.query_row(
                    "SELECT imported_paths FROM projects WHERE tenant_id=?1 AND id=?2",
                    params![tenant, id],
                    |r| r.get(0),
                )?;
                let default_rules = original_rules
                    .as_ref()
                    .is_none_or(|s| s.trim().is_empty() || s.trim() == "[]");
                let payload = jobs::Payload::SuppliedSourceImport {
                    project_id: id.try_into()?,
                    operation_key: request.key.clone(),
                    input_version,
                };
                let job = match jobs::user(
                    &tx,
                    &tenant,
                    &actor,
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
                };
                tx.execute("INSERT INTO source_import_operations(tenant,operation_key,actor,intent_digest,source_id,job_id,state,document_version,document) VALUES(?1,?2,?3,?4,?5,?6,'admitted',1,?7)",params![op.tenant,op.key,op.actor,op.intent_digest,op.source_id,op.job_id,serde_json::to_string(&op)?])?;
                tx.execute(
                    "INSERT INTO source_import_quota VALUES(?1,?2,?3,0,0)",
                    params![op.tenant, op.key, i64::try_from(op.reserved_bytes)?],
                )?;
                op
            }
        }
        Command::Phase { lease, phase } => {
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
                    activate(&tx, catalog_state, &mut op)?;
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
            store(&tx, &op)?;
            op
        }
    };
    tx.commit()?;
    Ok(operation)
}
fn activate(tx: &Transaction<'_>, state: &catalog::State, op: &mut Operation) -> Result<()> {
    let a = op
        .artifact
        .as_ref()
        .ok_or_else(|| anyhow!("Missing artifact"))?;
    let now = auth::catalog_timestamp();
    tx.execute("INSERT INTO source_revisions(tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at,completeness) VALUES(?1,?2,?3,?4,?5,?6,'complete') ON CONFLICT DO NOTHING",params![op.tenant,op.source_id,a.upstream_key,a.manifest_digest,a.locator,now])?;
    let(id,digest,locator,synced):(i64,String,String,String)=tx.query_row("SELECT id,manifest_digest,snapshot_locator,synced_at FROM source_revisions WHERE tenant_id=?1 AND project_id=?2 AND upstream_revision_key=?3 AND completeness='complete'",params![op.tenant,op.source_id,a.upstream_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    ensure!(
        digest == a.manifest_digest && locator == a.locator,
        "Accepted revision identity mismatch"
    );
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
                    tx.execute("INSERT INTO source_docs(tenant_id,project_id,path,kind,size_bytes,content_hash,extract_status,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![op.tenant,op.source_id,f.path,f.kind,i64::try_from(f.size)?,&f.sha256[..24],if f.kind=="pdf"{"pending"}else{"na"},now])?;
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
    });
    Ok(())
}
pub(crate) fn source_reserved(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM source_import_operations o JOIN source_import_quota q USING(tenant,operation_key) WHERE o.tenant=?1 AND o.source_id=?2 AND q.settled=0)",params![tenant,id],|r|r.get(0))?)
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
