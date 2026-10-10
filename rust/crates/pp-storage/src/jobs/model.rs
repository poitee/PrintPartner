use super::FilenameExport;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobKind {
    Sync,
    ImportScan,
    ExtractSourceDocs,
    CheckSourceUpdates,
    ExportStlPack,
    ExportChecklistHtml,
    ExportKitBundle,
    #[serde(rename = "export-accepted-plate-3mf")]
    ExportAcceptedPlate3mf,
    #[serde(rename = "export-direct-3mf")]
    ExportDirect3mf,
    PrinterUpload,
}
impl JobKind {
    pub const ALL: [Self; 10] = [
        Self::Sync,
        Self::ImportScan,
        Self::ExtractSourceDocs,
        Self::CheckSourceUpdates,
        Self::ExportStlPack,
        Self::ExportChecklistHtml,
        Self::ExportKitBundle,
        Self::ExportAcceptedPlate3mf,
        Self::ExportDirect3mf,
        Self::PrinterUpload,
    ];
    pub fn effect_class(self) -> EffectClass {
        match self {
            Self::PrinterUpload => EffectClass::UncertainExternal,
            Self::CheckSourceUpdates => EffectClass::RecoverableExternal,
            _ => EffectClass::LocalStaging,
        }
    }
    pub fn name(self) -> String {
        serde_json::to_value(self)
            .expect("enum")
            .as_str()
            .expect("string")
            .into()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    ReadOnly,
    LocalStaging,
    RecoverableExternal,
    UncertainExternal,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum Payload {
    Sync {
        project_ids: Option<Vec<u64>>,
    },
    ImportScan {
        project_id: u64,
    },
    ExtractSourceDocs {
        project_id: u64,
    },
    CheckSourceUpdates {},
    ExportStlPack {
        profile_id: u64,
        #[serde(default)]
        missing_only: bool,
        #[serde(default)]
        group_by: GroupBy,
        #[serde(default)]
        unit_tokens: Vec<String>,
        filename_grouping: Option<FilenameExport>,
    },
    ExportChecklistHtml {
        profile_id: u64,
    },
    ExportKitBundle {
        profile_id: u64,
        #[serde(default)]
        include_print_progress: bool,
    },
    #[serde(rename = "export-accepted-plate-3mf")]
    ExportAcceptedPlate3mf {
        profile_id: u64,
        expected_plate_revision_id: u64,
    },
    #[serde(rename = "export-direct-3mf")]
    ExportDirect3mf {
        profile_id: u64,
        tokens: Vec<String>,
    },
    PrinterUpload {
        printer_id: String,
        artifact_path: String,
        filename: String,
        #[serde(default)]
        start: bool,
        profile_id: Option<u64>,
        host_name: Option<String>,
        #[serde(default)]
        checkoff_units: Vec<CheckoffUnit>,
        #[serde(default)]
        unlabeled_names: Vec<String>,
    },
    PrinterStart(PrinterStartRequest),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrinterStartRequest {
    pub uploaded_job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binding: Option<PrinterStartBinding>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrinterStartBinding {
    printer_id: String,
    upload_effect: EffectReceipt,
}
impl PrinterStartRequest {
    pub fn new(uploaded_job_id: impl Into<String>) -> Self {
        Self {
            uploaded_job_id: uploaded_job_id.into(),
            binding: None,
        }
    }
    pub fn printer_id(&self) -> Option<&str> {
        self.binding
            .as_ref()
            .map(|binding| binding.printer_id.as_str())
    }
    pub fn upload_effect(&self) -> Option<&EffectReceipt> {
        self.binding.as_ref().map(|binding| &binding.upload_effect)
    }
    fn validate_common(&self) -> Result<()> {
        text(&self.uploaded_job_id, 128)
    }
    fn validate_request(&self) -> Result<()> {
        self.validate_common()?;
        ensure!(
            self.binding.is_none(),
            "Printer start binding is server-owned"
        );
        Ok(())
    }
    fn validate_stored(&self) -> Result<()> {
        self.validate_common()?;
        let binding = self
            .binding
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Missing printer start binding"))?;
        text(&binding.printer_id, 128)?;
        let effect = &binding.upload_effect;
        ensure!(
            effect.intent.operation == EffectOperation::PrinterUpload
                && effect.intent.target == binding.printer_id
                && effect.attempt > 0
                && effect.generation > 0,
            "Invalid printer start binding"
        );
        ensure!(
            matches!(effect.outcome()?, EffectOutcome::Confirmed(_)),
            "Invalid printer start binding"
        );
        digest(&effect.intent.basis_hash)?;
        digest(&effect.intent.content_hash)?;
        let receipt = effect
            .receipt
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Missing upload receipt"))?;
        receipt.validate()?;
        ensure!(
            receipt.content_hash == effect.intent.content_hash
                && receipt.target == effect.intent.target,
            "Upload receipt mismatch"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum GroupBy {
    Color,
    #[default]
    ColorDir,
}
fn id(value: u64) -> Result<()> {
    ensure!(
        value > 0 && value <= 9_007_199_254_740_991,
        "Invalid identifier"
    );
    Ok(())
}
pub(super) fn text(value: &str, max: usize) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control),
        "Invalid bounded text"
    );
    Ok(())
}
pub(super) fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)),
        "Invalid digest"
    );
    Ok(())
}
impl Payload {
    pub fn kind(&self) -> JobKind {
        match self {
            Self::Sync { .. } => JobKind::Sync,
            Self::ImportScan { .. } => JobKind::ImportScan,
            Self::ExtractSourceDocs { .. } => JobKind::ExtractSourceDocs,
            Self::CheckSourceUpdates {} => JobKind::CheckSourceUpdates,
            Self::ExportStlPack { .. } => JobKind::ExportStlPack,
            Self::ExportChecklistHtml { .. } => JobKind::ExportChecklistHtml,
            Self::ExportKitBundle { .. } => JobKind::ExportKitBundle,
            Self::ExportAcceptedPlate3mf { .. } => JobKind::ExportAcceptedPlate3mf,
            Self::ExportDirect3mf { .. } => JobKind::ExportDirect3mf,
            Self::PrinterUpload { .. } => JobKind::PrinterUpload,
            Self::PrinterStart(_) => JobKind::PrinterUpload,
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            serde_json::to_vec(self)?.len() <= 65536,
            "Payload too large"
        );
        match self {
            Self::Sync { project_ids } => {
                if let Some(ids) = project_ids {
                    ensure!(ids.len() <= 1000, "Too many sources");
                    for value in ids {
                        id(*value)?;
                    }
                }
            }
            Self::ImportScan { project_id } | Self::ExtractSourceDocs { project_id } => {
                id(*project_id)?
            }
            Self::CheckSourceUpdates {} => {}
            Self::ExportStlPack {
                profile_id,
                unit_tokens: tokens,
                ..
            }
            | Self::ExportDirect3mf { profile_id, tokens } => {
                id(*profile_id)?;
                ensure!(tokens.len() <= 1000, "Too many units");
                let mut seen = std::collections::HashSet::new();
                for token in tokens {
                    ensure!(
                        token.len() == 36
                            && token.starts_with("ppu_")
                            && token[4..]
                                .bytes()
                                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)),
                        "Invalid Required-unit token"
                    );
                    ensure!(seen.insert(token), "Duplicate unit");
                }
            }
            Self::ExportChecklistHtml { profile_id } | Self::ExportKitBundle { profile_id, .. } => {
                id(*profile_id)?
            }
            Self::ExportAcceptedPlate3mf {
                profile_id,
                expected_plate_revision_id,
            } => {
                id(*profile_id)?;
                id(*expected_plate_revision_id)?;
            }
            Self::PrinterUpload {
                printer_id,
                artifact_path,
                filename,
                profile_id,
                ..
            } => {
                text(printer_id, 128)?;
                text(artifact_path, 1024)?;
                text(filename, 255)?;
                ensure!(
                    !filename.contains(['/', '\\'])
                        && [".gcode", ".bgcode", ".gco"]
                            .iter()
                            .any(|ext| filename.to_ascii_lowercase().ends_with(ext)),
                    "Invalid printer filename"
                );
                if let Some(value) = profile_id {
                    id(*value)?;
                }
            }
            Self::PrinterStart(request) => request.validate_request()?,
        }
        if let Self::ExportDirect3mf { tokens, .. } = self {
            ensure!(!tokens.is_empty(), "Direct export requires units");
        }
        if let Self::ExportStlPack {
            filename_grouping: Some(grouping),
            ..
        } = self
        {
            grouping.validate()?;
        }
        if let Self::PrinterUpload {
            host_name,
            checkoff_units,
            unlabeled_names,
            ..
        } = self
        {
            if let Some(host) = host_name {
                text(host, 200)?;
            }
            ensure!(
                checkoff_units.len() <= 1000 && unlabeled_names.len() <= 200,
                "Too many printer units"
            );
            let mut seen = std::collections::HashSet::new();
            for unit in checkoff_units {
                id(unit.part_id)?;
                ensure!(
                    unit.unit_index <= 9_007_199_254_740_991
                        && seen.insert((unit.part_id, unit.unit_index)),
                    "Invalid checkoff unit"
                );
                if let Some(name) = &unit.object_name {
                    text(name, 200)?;
                }
            }
            for name in unlabeled_names {
                text(name, 200)?;
            }
        }
        Ok(())
    }
    pub(super) fn validate_stored(&self) -> Result<()> {
        ensure!(
            serde_json::to_vec(self)?.len() <= 65536,
            "Payload too large"
        );
        match self {
            Self::PrinterStart(request) => request.validate_stored(),
            _ => self.validate(),
        }
    }
    pub(super) fn bind_printer_start(
        &mut self,
        printer_id: String,
        upload_effect: EffectReceipt,
    ) -> Result<()> {
        let Self::PrinterStart(request) = self else {
            return Ok(());
        };
        ensure!(request.binding.is_none(), "Printer start already bound");
        request.binding = Some(PrinterStartBinding {
            printer_id,
            upload_effect,
        });
        request.validate_stored()
    }
    pub(super) fn resource(&self) -> String {
        match self {
            Self::PrinterUpload { printer_id, .. } => format!("printer:{printer_id}"),
            Self::PrinterStart(request) => request
                .printer_id()
                .map(|id| format!("printer:{id}"))
                .unwrap_or_default(),
            Self::ImportScan { project_id } | Self::ExtractSourceDocs { project_id } => {
                format!("source:{project_id}")
            }
            Self::Sync {
                project_ids: Some(ids),
            } if ids.len() == 1 => format!("source:{}", ids[0]),
            Self::Sync { .. } | Self::CheckSourceUpdates {} => "source:*".into(),
            _ => String::new(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistentState {
    Queued,
    Running,
    EffectAdmitted,
    ReconciliationRequired,
    UploadedOnly,
    Succeeded,
    Failed,
    Cancelled,
}
impl PersistentState {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::EffectAdmitted => "effect_admitted",
            Self::ReconciliationRequired => "reconciliation_required",
            Self::UploadedOnly => "uploaded_only",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::UploadedOnly | Self::Succeeded | Self::Failed | Self::Cancelled
        )
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectIntent {
    pub operation: EffectOperation,
    pub basis_hash: String,
    pub content_hash: String,
    pub target: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectOperation {
    LocalArtifact,
    SourceRefresh,
    PrinterUpload,
    PrinterUploadAndStart,
    PrinterStart,
    SpoolmanDeduction,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectReceipt {
    pub intent: EffectIntent,
    pub attempt: i64,
    pub generation: i64,
    pub confirmed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub no_effect: bool,
    pub receipt: Option<ResultArtifact>,
}
fn is_false(value: &bool) -> bool {
    !*value
}
pub enum EffectOutcome<'a> {
    Unresolved,
    Confirmed(&'a ResultArtifact),
    Denied,
}
impl EffectReceipt {
    pub(super) fn outcome(&self) -> Result<EffectOutcome<'_>> {
        match (self.confirmed, self.no_effect, self.receipt.as_ref()) {
            (false, false, None) => Ok(EffectOutcome::Unresolved),
            (true, false, Some(receipt)) => Ok(EffectOutcome::Confirmed(receipt)),
            (false, true, None) => Ok(EffectOutcome::Denied),
            _ => Err(anyhow::anyhow!("Invalid effect outcome")),
        }
    }
    pub(super) fn confirm(&mut self, receipt: ResultArtifact) -> Result<()> {
        ensure!(
            matches!(self.outcome()?, EffectOutcome::Unresolved),
            "Effect already resolved"
        );
        self.confirmed = true;
        self.receipt = Some(receipt);
        Ok(())
    }
    pub(super) fn deny(&mut self) -> Result<()> {
        ensure!(
            matches!(self.outcome()?, EffectOutcome::Unresolved),
            "Effect already resolved"
        );
        self.no_effect = true;
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultArtifact {
    pub receipt_id: String,
    pub content_hash: String,
    pub target: String,
}
impl ResultArtifact {
    pub(super) fn validate(&self) -> Result<()> {
        text(&self.receipt_id, 128)?;
        digest(&self.content_hash)?;
        text(&self.target, 1024)
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct JobRecord {
    pub job_id: String,
    pub tenant: String,
    pub kind: JobKind,
    pub payload_version: u32,
    pub payload: Payload,
    pub state: PersistentState,
    pub state_version: i64,
    pub attempt: i64,
    pub generation: i64,
    pub lease_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub cancel_requested: bool,
    pub progress: Option<u8>,
    pub effects: Vec<EffectReceipt>,
    pub result: Option<ResultArtifact>,
    pub recovery: Option<String>,
    #[serde(skip)]
    pub(crate) fence: Option<String>,
    #[serde(skip)]
    pub(crate) worker: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct JobSnapshot {
    pub job_id: String,
    pub kind: JobKind,
    pub status: &'static str,
    pub message: &'static str,
    pub progress: Option<u8>,
    pub result: Option<ResultArtifact>,
    pub error: Option<&'static str>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}
impl JobRecord {
    pub(super) fn validate_state(&self) -> Result<()> {
        for effect in &self.effects {
            let outcome = effect.outcome()?;
            digest(&effect.intent.basis_hash)?;
            digest(&effect.intent.content_hash)?;
            text(&effect.intent.target, 1024)?;
            if let EffectOutcome::Confirmed(receipt) = outcome {
                receipt.validate()?;
                ensure!(
                    receipt.content_hash == effect.intent.content_hash
                        && receipt.target == effect.intent.target,
                    "Effect receipt mismatch"
                );
            }
            ensure!(
                !effect.no_effect || self.state.terminal(),
                "Denied effect requires terminal job"
            );
        }
        ensure!(
            self.state != PersistentState::UploadedOnly || self.uploaded_only_proof().is_some(),
            "Invalid uploaded-only job"
        );
        Ok(())
    }
    pub(super) fn uploaded_only_proof(&self) -> Option<UploadedProof<'_>> {
        let Payload::PrinterUpload {
            printer_id,
            start: true,
            ..
        } = &self.payload
        else {
            return None;
        };
        let mut upload = None;
        let mut starts = 0;
        for effect in &self.effects {
            let outcome = effect.outcome().ok()?;
            match effect.intent.operation {
                EffectOperation::PrinterUpload => {
                    if upload.is_some()
                        || effect.intent.target != *printer_id
                        || !matches!(outcome, EffectOutcome::Confirmed(_))
                    {
                        return None;
                    }
                    upload = Some(effect);
                }
                EffectOperation::PrinterStart => {
                    starts += 1;
                    if starts > 1 || !matches!(outcome, EffectOutcome::Denied) {
                        return None;
                    }
                }
                EffectOperation::SpoolmanDeduction => {
                    if matches!(outcome, EffectOutcome::Unresolved) {
                        return None;
                    }
                }
                _ => return None,
            }
        }
        let upload = upload?;
        let receipt = match upload.outcome().ok()? {
            EffectOutcome::Confirmed(receipt) => receipt,
            _ => return None,
        };
        if receipt.content_hash != upload.intent.content_hash
            || receipt.target != upload.intent.target
        {
            return None;
        }
        (self.result.as_ref() == Some(receipt)).then_some(UploadedProof { printer_id, upload })
    }
    pub fn snapshot(&self) -> JobSnapshot {
        let (status, message) = match self.state {
            PersistentState::Queued => ("pending", "Waiting for a compatible worker"),
            PersistentState::Running => ("running", "Running"),
            PersistentState::EffectAdmitted => ("running", "Operation in progress"),
            PersistentState::ReconciliationRequired => (
                "error",
                match self.kind.effect_class() {
                    EffectClass::UncertainExternal => {
                        "Check the printer or Spoolman outcome before retrying"
                    }
                    EffectClass::LocalStaging => "Verify the saved result before retrying",
                    EffectClass::RecoverableExternal | EffectClass::ReadOnly => {
                        "Check the previous outcome before retrying"
                    }
                },
            ),
            PersistentState::UploadedOnly => ("done", "Uploaded only; print not started"),
            PersistentState::Succeeded => ("done", "Complete"),
            PersistentState::Failed => ("error", "Job failed"),
            PersistentState::Cancelled => ("cancelled", "Cancelled before effects"),
        };
        JobSnapshot {
            job_id: self.job_id.clone(),
            kind: self.kind,
            status,
            message,
            progress: self.progress,
            result: self.result.clone(),
            error: (status == "error").then_some(message),
            finished_at: self.finished_at.map(timestamp),
            updated_at: timestamp(self.updated_at),
        }
    }
}
pub(super) struct UploadedProof<'a> {
    pub printer_id: &'a str,
    pub upload: &'a EffectReceipt,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub version: i64,
    pub at: i64,
    pub state: String,
    pub event: String,
}
#[derive(Clone, Copy, Debug, Serialize)]
pub enum LocalCommit {
    ReadOnly,
    Committed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    ConfirmSucceeded,
    ConfirmNoEffect,
    Abandon,
}

fn timestamp(seconds: i64) -> String {
    let time = time::OffsetDateTime::from_unix_timestamp(seconds).expect("persisted UTC timestamp");
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second()
    )
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckoffUnit {
    pub part_id: u64,
    pub unit_index: u64,
    pub object_name: Option<String>,
}

impl std::fmt::Debug for JobRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.snapshot().fmt(f)
    }
}

#[derive(Clone, Debug)]
pub struct JobListQuery {
    pub limit: u16,
    pub status: Option<String>,
    pub since: Option<i64>,
    pub profile_id: Option<u64>,
    pub before: Option<(i64, String)>,
}
impl Default for JobListQuery {
    fn default() -> Self {
        Self {
            limit: 100,
            status: None,
            since: None,
            profile_id: None,
            before: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ReconciliationRecord {
    pub version: i64,
    pub subject: String,
    pub generation: i64,
    pub effect_hash: String,
    pub basis_hash: String,
    pub target: String,
    pub decision: String,
    pub receipt: Option<ResultArtifact>,
    pub at: i64,
}
