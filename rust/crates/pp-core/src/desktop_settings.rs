//! User settings the compatibility child reads from its environment (the
//! `Owner::DesktopSettings` entries in `pp_compat::settings`). They live in a versioned
//! `desktop-settings.json` beside `desktop.toml`, which keeps only the port. Core reads them
//! once at startup, so a change takes effect the next time Print Partner starts. Only these
//! six paths can be stored; secrets have no field here and never reach this file.

use crate::state_file;
use anyhow::{Context, Result, bail, ensure};
use pp_storage::lease::StorageLease;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

const FILE: &str = "desktop-settings.json";
const MAX_VALUE_BYTES: usize = 4096;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DesktopSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker_socket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slicer_bambu_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slicer_orca_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slicer_prusa_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesktopSetting {
    ExchangeDir(Option<String>),
    DockerSocket(Option<String>),
    ComposeFile(Option<String>),
    SlicerBambuDir(Option<String>),
    SlicerOrcaDir(Option<String>),
    SlicerPrusaDir(Option<String>),
}

impl DesktopSettings {
    /// Environment pairs for the compatibility child, one per stored setting.
    pub fn env(&self) -> Vec<(&'static str, String)> {
        [
            ("PP_EXCHANGE_DIR", &self.exchange_dir),
            ("DOCKER_SOCKET", &self.docker_socket),
            ("PP_COMPOSE_FILE", &self.compose_file),
            ("SLICER_BAMBU_DIR", &self.slicer_bambu_dir),
            ("SLICER_ORCA_DIR", &self.slicer_orca_dir),
            ("SLICER_PRUSA_DIR", &self.slicer_prusa_dir),
        ]
        .into_iter()
        .filter_map(|(name, value)| value.clone().map(|value| (name, value)))
        .collect()
    }

    fn values(&self) -> [&Option<String>; 6] {
        [
            &self.exchange_dir,
            &self.docker_socket,
            &self.compose_file,
            &self.slicer_bambu_dir,
            &self.slicer_orca_dir,
            &self.slicer_prusa_dir,
        ]
    }
}

/// A stored path must be absolute, without `..`, control characters or more than 4 KiB.
/// It does not have to exist yet: a slicer or Docker can be installed after it is set.
fn validate(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= MAX_VALUE_BYTES,
        "Desktop setting path is empty or too long"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "Desktop setting path contains a control character"
    );
    let path = Path::new(value);
    ensure!(path.is_absolute(), "Desktop setting path must be absolute");
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        bail!("Desktop setting path must not contain ..");
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u8,
    settings: DesktopSettings,
}

fn decode(snapshot: Option<&state_file::Snapshot>) -> Result<DesktopSettings> {
    let Some(snapshot) = snapshot else {
        return Ok(DesktopSettings::default());
    };
    let document: Document =
        serde_json::from_slice(&snapshot.bytes).context("Invalid desktop settings")?;
    ensure!(
        document.version == 1,
        "Unsupported desktop settings version"
    );
    for value in document.settings.values().into_iter().flatten() {
        validate(value)?;
    }
    Ok(document.settings)
}

pub(super) fn read(owner: &StorageLease) -> Result<DesktopSettings> {
    decode(state_file::read(owner, FILE)?.as_ref())
}

pub(super) fn update(owner: &StorageLease, field: DesktopSetting) -> Result<DesktopSettings> {
    update_with(owner, field, |_| Ok(()))
}

fn update_with(
    owner: &StorageLease,
    field: DesktopSetting,
    boundary: impl FnMut(state_file::Boundary) -> Result<()>,
) -> Result<DesktopSettings> {
    let previous = state_file::read(owner, FILE)?;
    let mut settings = decode(previous.as_ref())?;
    let (slot, value) = match field {
        DesktopSetting::ExchangeDir(value) => (&mut settings.exchange_dir, value),
        DesktopSetting::DockerSocket(value) => (&mut settings.docker_socket, value),
        DesktopSetting::ComposeFile(value) => (&mut settings.compose_file, value),
        DesktopSetting::SlicerBambuDir(value) => (&mut settings.slicer_bambu_dir, value),
        DesktopSetting::SlicerOrcaDir(value) => (&mut settings.slicer_orca_dir, value),
        DesktopSetting::SlicerPrusaDir(value) => (&mut settings.slicer_prusa_dir, value),
    };
    if let Some(value) = &value {
        validate(value)?;
    }
    *slot = value;
    let bytes = serde_json::to_vec(&Document {
        version: 1,
        settings: settings.clone(),
    })?;
    state_file::publish_with(owner, FILE, &bytes, previous.as_ref(), boundary)?;
    Ok(settings)
}

#[cfg(test)]
mod tests;
