//! Live data formats and whether Node can take an operation back from Rust.
//!
//! A rollback returns an operation to Node after Rust wrote its resources.
//! Node can resume only when it reads every format Rust leaves behind. Code
//! maps each resource to one format. The manifest declares the newest version
//! each side handles. A format with no Rust writer has no rollback.
use super::resources::{FileFamily, ResourceId};
use super::{AdmissionError, SOURCE_SYNC_LIVE_FORMAT};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LiveFormatId {
    SqliteSchema,
    SourceRevisionWorkspace,
    SourceCovers,
}

impl LiveFormatId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SqliteSchema => "sqlite-schema",
            Self::SourceRevisionWorkspace => "source-revision-workspace",
            Self::SourceCovers => "source-covers",
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
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LiveFormat {
    pub node_reads: u32,
    /// `null` when no Rust writer exists. `deserialize_with` makes the field
    /// required, so an omitted writer is malformed rather than `None`.
    #[serde(deserialize_with = "Option::deserialize")]
    pub rust_writes: Option<u32>,
}

impl LiveFormat {
    pub fn rollback_compatible(self) -> bool {
        self.rust_writes
            .is_some_and(|written| written <= self.node_reads)
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
}

impl LiveFormats {
    pub(super) fn get(&self, id: LiveFormatId) -> LiveFormat {
        match id {
            LiveFormatId::SqliteSchema => self.sqlite_schema,
            LiveFormatId::SourceRevisionWorkspace => self.source_revision_workspace,
            LiveFormatId::SourceCovers => self.source_covers,
        }
    }

    pub(super) fn admit(self) -> Result<Self, AdmissionError> {
        for id in [
            LiveFormatId::SqliteSchema,
            LiveFormatId::SourceRevisionWorkspace,
            LiveFormatId::SourceCovers,
        ] {
            let format = self.get(id);
            if format.node_reads == 0 || format.rust_writes == Some(0) {
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
