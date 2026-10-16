#[cfg(test)]
mod fixture_tests;
pub(crate) mod model;
mod storage;
mod view;

use pp_domain::PositiveId;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Decision {
    SelectExactPredecessor {
        target_draft_part_id: PositiveId,
        predecessor_revision_part_id: PositiveId,
    },
    AcceptPriorCompletion {
        target_draft_part_id: PositiveId,
        predecessor_revision_part_id: PositiveId,
    },
    Replace {
        target_draft_part_id: PositiveId,
    },
}

impl Decision {
    pub(crate) fn target(&self) -> PositiveId {
        match self {
            Self::SelectExactPredecessor {
                target_draft_part_id,
                ..
            }
            | Self::AcceptPriorCompletion {
                target_draft_part_id,
                ..
            }
            | Self::Replace {
                target_draft_part_id,
            } => *target_draft_part_id,
        }
    }
}
