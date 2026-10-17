//! Live data formats and whether Node can take an operation back from Rust.
//!
//! A rollback returns an operation to Node after Rust wrote its resources.
//! Node can resume only when it reads every format Rust leaves behind. Code
//! maps each resource to one format. The manifest declares the newest version
//! each side handles, or explicitly says Rust never writes the format.
use super::resources::{FileFamily, ResourceId};
use super::{AdmissionError, SOURCE_SYNC_LIVE_FORMAT};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LiveFormatId {
    SqliteSchema,
    SourceRevisionWorkspace,
    SourceCovers,
    KitCatalog,
    PathHints,
    CommunityManifests,
}

impl LiveFormatId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SqliteSchema => "sqlite-schema",
            Self::SourceRevisionWorkspace => "source-revision-workspace",
            Self::SourceCovers => "source-covers",
            Self::KitCatalog => "kit-catalog",
            Self::PathHints => "path-hints",
            Self::CommunityManifests => "community-manifests",
        }
    }
}

impl ResourceId {
    pub fn live_format(self) -> LiveFormatId {
        match self {
            // Every table lives in one database stamped with one schema version.
            Self::Table(_) => LiveFormatId::SqliteSchema,
            Self::File(FileFamily::SourceWorkspace) => LiveFormatId::SourceRevisionWorkspace,
            Self::File(FileFamily::SourceCovers) => LiveFormatId::SourceCovers,
            Self::File(FileFamily::KitCatalog) => LiveFormatId::KitCatalog,
            Self::File(FileFamily::PathHints) => LiveFormatId::PathHints,
            Self::File(FileFamily::CommunityManifests) => LiveFormatId::CommunityManifests,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RustWrites {
    Version(u32),
    Never,
    Unknown,
}

impl<'de> Deserialize<'de> for RustWrites {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct WriterVisitor;

        impl serde::de::Visitor<'_> for WriterVisitor {
            type Value = RustWrites;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(r#"a Rust format version, "none", or null"#)
            }

            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                u32::try_from(value)
                    .map(RustWrites::Version)
                    .map_err(E::custom)
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                match value {
                    "none" => Ok(RustWrites::Never),
                    other => Err(E::unknown_variant(other, &["none"])),
                }
            }

            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(RustWrites::Unknown)
            }
        }

        deserializer.deserialize_any(WriterVisitor)
    }
}

impl RustWrites {
    pub(super) fn version(self) -> Option<u32> {
        match self {
            Self::Version(version) => Some(version),
            Self::Never | Self::Unknown => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LiveFormat {
    pub node_reads: u32,
    /// Required: a version, explicit "none" for no writer by design, or null for unknown.
    pub rust_writes: RustWrites,
}

impl LiveFormat {
    pub fn rollback_compatible(self) -> bool {
        match self.rust_writes {
            RustWrites::Version(written) => written <= self.node_reads,
            RustWrites::Never => true,
            RustWrites::Unknown => false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LiveFormats {
    #[serde(rename = "sqlite-schema")]
    sqlite_schema: LiveFormat,
    #[serde(rename = "source-revision-workspace")]
    source_revision_workspace: LiveFormat,
    #[serde(rename = "source-covers")]
    source_covers: LiveFormat,
    #[serde(rename = "kit-catalog")]
    kit_catalog: LiveFormat,
    #[serde(rename = "path-hints")]
    path_hints: LiveFormat,
    #[serde(rename = "community-manifests")]
    community_manifests: LiveFormat,
}

impl LiveFormats {
    pub(super) fn get(&self, id: LiveFormatId) -> LiveFormat {
        match id {
            LiveFormatId::SqliteSchema => self.sqlite_schema,
            LiveFormatId::SourceRevisionWorkspace => self.source_revision_workspace,
            LiveFormatId::SourceCovers => self.source_covers,
            LiveFormatId::KitCatalog => self.kit_catalog,
            LiveFormatId::PathHints => self.path_hints,
            LiveFormatId::CommunityManifests => self.community_manifests,
        }
    }

    pub(super) fn admit(self) -> Result<Self, AdmissionError> {
        for id in [
            LiveFormatId::SqliteSchema,
            LiveFormatId::SourceRevisionWorkspace,
            LiveFormatId::SourceCovers,
            LiveFormatId::KitCatalog,
            LiveFormatId::PathHints,
            LiveFormatId::CommunityManifests,
        ] {
            let format = self.get(id);
            if format.node_reads == 0 || format.rust_writes == RustWrites::Version(0) {
                return Err(AdmissionError::Malformed(format!(
                    "live format {} has version 0",
                    id.as_str()
                )));
            }
        }
        let workspace = format!(
            "source-revision-workspace-v{}",
            self.source_revision_workspace.node_reads
        );
        if workspace != SOURCE_SYNC_LIVE_FORMAT {
            return Err(AdmissionError::UnknownLiveFormat { value: workspace });
        }
        Ok(self)
    }
}
