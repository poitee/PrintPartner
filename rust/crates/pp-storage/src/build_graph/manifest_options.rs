mod json;
mod model;
mod observation;

use model::KitManifestPatch;
pub use model::{KitManifest, ManifestBuilder};

use anyhow::{Result, ensure};
pub(super) use observation::CapturedManifestGraph;
use observation::ObservedBuilder;
use pp_contracts::PositiveId;
use rusqlite::{OptionalExtension, Transaction, params};

#[derive(Debug, Clone)]
pub enum ManifestOptionsCommand {
    ReadKit { build: PositiveId },
    SaveKit { build: PositiveId, request: Vec<u8> },
    ReadBuilder { build: PositiveId },
}

#[derive(Debug, Clone)]
pub enum ManifestOptionsOutcome {
    Kit {
        profile_id: i64,
        kit: Box<KitManifest>,
    },
    Saved {
        profile_id: i64,
        kit: Box<KitManifest>,
    },
    Builder(Box<ManifestBuilder>),
    MissingBuild,
    InvalidInput {
        detail: ManifestInputDetail,
    },
    StaleObservation,
    ObservationFailed {
        detail: String,
    },
}

#[derive(Debug, Clone)]
pub struct ManifestInputDetail(crate::manifest_text::JsText);
impl From<&str> for ManifestInputDetail {
    fn from(value: &str) -> Self {
        Self(crate::manifest_text::JsText::scalar(value))
    }
}
impl From<String> for ManifestInputDetail {
    fn from(value: String) -> Self {
        Self(crate::manifest_text::JsText::scalar(&value))
    }
}
impl ManifestInputDetail {
    pub(super) fn group(group: &crate::manifest_text::JsText, suffix: &str) -> Self {
        let mut units = "kit.selections.".encode_utf16().collect::<Vec<_>>();
        units.extend_from_slice(group.units());
        units.extend(suffix.encode_utf16());
        Self(crate::manifest_text::JsText::from_units(units))
    }
    pub fn into_body(self) -> ManifestJsonBody {
        let mut output = b"{\"detail\":".to_vec();
        self.0.write_json(&mut output);
        output.push(b'}');
        ManifestJsonBody(output)
    }
    #[cfg(test)]
    pub(super) fn scalar_detail(&self) -> Option<String> {
        self.0.as_scalar()
    }
}

pub struct ManifestJsonBody(Vec<u8>);

#[derive(Debug)]
pub enum ManifestOptionsFailure {
    MissingBuild,
    InvalidInput { detail: ManifestInputDetail },
    StaleObservation,
    ObservationFailed { detail: String },
}

impl ManifestJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

impl ManifestOptionsOutcome {
    pub fn into_success_body(self) -> Result<ManifestJsonBody, ManifestOptionsFailure> {
        let mut output = Vec::new();
        match self {
            Self::Kit { profile_id, kit } | Self::Saved { profile_id, kit } => {
                output.extend_from_slice(b"{\"profile_id\":");
                output.extend_from_slice(profile_id.to_string().as_bytes());
                output.extend_from_slice(b",\"kit\":");
                kit.write_json(&mut output);
                output.push(b'}');
            }
            Self::Builder(builder) => builder.write_json(&mut output),
            Self::MissingBuild => return Err(ManifestOptionsFailure::MissingBuild),
            Self::InvalidInput { detail } => {
                return Err(ManifestOptionsFailure::InvalidInput { detail });
            }
            Self::StaleObservation => return Err(ManifestOptionsFailure::StaleObservation),
            Self::ObservationFailed { detail } => {
                return Err(ManifestOptionsFailure::ObservationFailed { detail });
            }
        }
        Ok(ManifestJsonBody(output))
    }
}

pub(super) enum PreparedManifestCommand {
    Builder {
        captured: CapturedManifestGraph,
        observed: ObservedBuilder,
    },
    Save {
        captured: CapturedManifestGraph,
        kit: KitManifest,
    },
}

pub(super) enum ManifestPreparationFailure {
    InvalidInput { detail: ManifestInputDetail },
    ObservationFailed { detail: String },
}

impl ManifestPreparationFailure {
    pub(super) fn into_outcome(self) -> ManifestOptionsOutcome {
        match self {
            Self::InvalidInput { detail } => ManifestOptionsOutcome::InvalidInput { detail },
            Self::ObservationFailed { detail } => {
                ManifestOptionsOutcome::ObservationFailed { detail }
            }
        }
    }
}

pub(super) fn build(command: &ManifestOptionsCommand) -> i64 {
    match command {
        ManifestOptionsCommand::ReadKit { build }
        | ManifestOptionsCommand::ReadBuilder { build }
        | ManifestOptionsCommand::SaveKit { build, .. } => build.get() as i64,
    }
}

pub(super) fn capture(
    tx: &Transaction<'_>,
    tenant: &str,
    command: &ManifestOptionsCommand,
) -> Result<Option<CapturedManifestGraph>> {
    observation::capture(tx, tenant, build(command))
}

pub(super) fn observe(
    captured: &CapturedManifestGraph,
    reads: Option<&dyn crate::working_drafts::observation::DraftReads>,
    limits: crate::working_drafts::observation::PreparationLimits,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::result::Result<ObservedBuilder, crate::working_drafts::observation::ReadFailure> {
    observation::observe(captured, reads, limits, cancelled)
}

pub(super) fn parse_save(
    command: &ManifestOptionsCommand,
) -> std::result::Result<Option<KitManifest>, ManifestPreparationFailure> {
    match command {
        ManifestOptionsCommand::SaveKit { request, .. } => KitManifestPatch::from_request(request)
            .map(KitManifestPatch::into_empty_defaults)
            .map(Some)
            .map_err(|detail| ManifestPreparationFailure::InvalidInput { detail }),
        ManifestOptionsCommand::ReadBuilder { .. } => Ok(None),
        ManifestOptionsCommand::ReadKit { .. } => {
            Err(ManifestPreparationFailure::ObservationFailed {
                detail: "manifest command preparation mismatch".into(),
            })
        }
    }
}

pub(super) fn prepare(
    command: &ManifestOptionsCommand,
    captured: CapturedManifestGraph,
    observed: ObservedBuilder,
    parsed_kit: Option<KitManifest>,
) -> std::result::Result<PreparedManifestCommand, ManifestPreparationFailure> {
    match command {
        ManifestOptionsCommand::ReadBuilder { .. } => {
            Ok(PreparedManifestCommand::Builder { captured, observed })
        }
        ManifestOptionsCommand::SaveKit { .. } => {
            let Some(kit) = parsed_kit else {
                return Err(ManifestPreparationFailure::ObservationFailed {
                    detail: "parsed kit manifest is missing".into(),
                });
            };
            observation::validate_known_selections(&kit, &observed.builder)
                .map_err(|detail| ManifestPreparationFailure::InvalidInput { detail })?;
            Ok(PreparedManifestCommand::Save { captured, kit })
        }
        ManifestOptionsCommand::ReadKit { .. } => {
            Err(ManifestPreparationFailure::ObservationFailed {
                detail: "manifest command preparation mismatch".into(),
            })
        }
    }
}

pub(super) fn stamps_match(first: &ObservedBuilder, second: &ObservedBuilder) -> bool {
    first.stamps == second.stamps
}

pub(super) fn read(
    tx: &Transaction<'_>,
    tenant: &str,
    command: &ManifestOptionsCommand,
) -> Result<ManifestOptionsOutcome> {
    let ManifestOptionsCommand::ReadKit { build } = command else {
        return Ok(ManifestOptionsOutcome::ObservationFailed {
            detail: "manifest read command requires preparation".into(),
        });
    };
    let build = build.get() as i64;
    if !exists(tx, tenant, build)? {
        return Ok(ManifestOptionsOutcome::MissingBuild);
    }
    Ok(ManifestOptionsOutcome::Kit {
        profile_id: build,
        kit: Box::new(stored_kit(tx, tenant, build)),
    })
}

pub(super) fn finish(
    tx: &Transaction<'_>,
    tenant: &str,
    prepared: PreparedManifestCommand,
    now: &str,
) -> Result<ManifestOptionsOutcome> {
    let captured = match &prepared {
        PreparedManifestCommand::Builder { captured, .. }
        | PreparedManifestCommand::Save { captured, .. } => captured,
    };
    ensure!(
        captured.tenant == tenant,
        "Authentication principal changed"
    );
    if !observation::basis_matches(tx, captured)? {
        return Ok(ManifestOptionsOutcome::StaleObservation);
    }
    match prepared {
        PreparedManifestCommand::Builder { observed, .. } => {
            Ok(ManifestOptionsOutcome::Builder(Box::new(observed.builder)))
        }
        PreparedManifestCommand::Save { captured, kit } => {
            let mut value = Vec::new();
            kit.write_json(&mut value);
            let value = String::from_utf8(value).expect("manifest JSON is valid UTF-8");
            tx.execute(
                "INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value",
                params![tenant, key(captured.build), value],
            )?;
            ensure!(
                tx.execute(
                    "UPDATE build_profiles SET config_modified_at=?1 WHERE tenant_id=?2 AND id=?3",
                    params![now, tenant, captured.build],
                )? == 1,
                "Build freshness update failed"
            );
            Ok(ManifestOptionsOutcome::Saved {
                profile_id: captured.build,
                kit: Box::new(kit),
            })
        }
    }
}

pub(super) fn is_read(command: &ManifestOptionsCommand) -> bool {
    matches!(command, ManifestOptionsCommand::ReadKit { .. })
}

fn key(build: i64) -> String {
    format!("kit_manifest_{build}")
}

fn exists(tx: &Transaction<'_>, tenant: &str, build: i64) -> Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM build_profiles WHERE tenant_id=?1 AND id=?2)",
        params![tenant, build],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn stored_kit(tx: &Transaction<'_>, tenant: &str, build: i64) -> KitManifest {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id=?1 AND key=?2",
            params![tenant, key(build)],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    raw.and_then(|raw| KitManifestPatch::from_stored(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn stored_selection_projection(
    raw: Option<String>,
) -> Vec<(
    crate::manifest_text::OptionGroupId,
    Vec<crate::manifest_text::VariantId>,
)> {
    raw.and_then(|raw| KitManifestPatch::from_stored(&raw).ok())
        .unwrap_or_default()
        .selection_projection()
}
