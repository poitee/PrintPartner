#![cfg(feature = "desktop_rebuild")]

use pp_storage::working_drafts::observation::{
    PreparationBudget, PreparationLimits, ReadFailure, Resource,
};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn budgets_charge_cumulatively_and_observe_cancellation() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        entries: 2,
        path_bytes: 6,
        artifact_bytes: 6,
        document_bytes: 4,
        total_document_bytes: 6,
        ..PreparationLimits::default()
    };
    let mut budget = PreparationBudget::new(&cancelled, limits).unwrap();
    budget.entry(0, 3).unwrap();
    budget.entry(1, 3).unwrap();
    assert!(matches!(
        budget.entry(0, 0),
        Err(ReadFailure::LimitExceeded(Resource::Entries))
    ));
    budget.artifact(6, 4).unwrap();
    assert!(matches!(
        budget.artifact(6, 3),
        Err(ReadFailure::LimitExceeded(Resource::ArtifactBytes))
    ));
    budget.document(4, 4).unwrap();
    assert!(matches!(
        budget.document(3, 3),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    cancelled.store(true, Ordering::Release);
    assert!(matches!(budget.check(), Err(ReadFailure::Cancelled)));
    assert!(matches!(budget.entry(0, 0), Err(ReadFailure::Cancelled)));
}

#[test]
fn limits_cannot_exceed_reference_caps() {
    let cancelled = AtomicBool::new(false);
    let max = PreparationLimits::default();
    let mut oversized = [max; 10];
    oversized[0].entries += 1;
    oversized[1].depth += 1;
    oversized[2].path += 1;
    oversized[3].path_bytes += 1;
    oversized[4].artifact_bytes += 1;
    oversized[5].document_bytes += 1;
    oversized[6].total_document_bytes += 1;
    oversized[7].nodes += 1;
    oversized[8].visits += 1;
    oversized[9].rules += 1;
    for limits in oversized {
        assert!(matches!(limits.validate(), Err(ReadFailure::InvalidGrant)));
        assert!(matches!(
            PreparationBudget::new(&cancelled, limits),
            Err(ReadFailure::InvalidGrant)
        ));
    }
    assert!(PreparationBudget::new(&cancelled, max).is_ok());
}

#[test]
fn zero_limits_reject_work_but_allow_empty_reads() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        entries: 0,
        depth: 0,
        path: 0,
        path_bytes: 0,
        artifact_bytes: 0,
        document_bytes: 0,
        total_document_bytes: 0,
        nodes: 0,
        visits: 0,
        rules: 0,
    };
    let mut budget = PreparationBudget::new(&cancelled, limits).unwrap();
    budget.artifact(0, 0).unwrap();
    budget.document(0, 0).unwrap();
    budget.expansion(0).unwrap();
    assert!(matches!(
        budget.entry(0, 0),
        Err(ReadFailure::LimitExceeded(Resource::Entries))
    ));
    assert!(matches!(
        budget.node(0),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
    assert!(matches!(
        budget.visit(0),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));
    assert!(matches!(
        budget.rule(),
        Err(ReadFailure::LimitExceeded(Resource::Rules))
    ));
}

#[test]
fn path_depth_and_aggregate_path_limits_are_inclusive() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        path: 3,
        path_bytes: 6,
        depth: 1,
        ..PreparationLimits::default()
    };
    let mut budget = PreparationBudget::new(&cancelled, limits).unwrap();
    assert!(matches!(
        budget.entry(2, 0),
        Err(ReadFailure::LimitExceeded(Resource::Depth))
    ));
    assert!(matches!(
        budget.entry(0, 4),
        Err(ReadFailure::LimitExceeded(Resource::Path))
    ));
    budget.entry(1, 3).unwrap();
    budget.entry(1, 3).unwrap();
    assert!(matches!(
        budget.entry(0, 1),
        Err(ReadFailure::LimitExceeded(Resource::PathBytes))
    ));
}

#[test]
fn parsing_limits_cover_nodes_visits_rules_and_expansion() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        depth: 1,
        nodes: 1,
        visits: 1,
        rules: 1,
        total_document_bytes: 2,
        ..PreparationLimits::default()
    };
    let mut budget = PreparationBudget::new(&cancelled, limits).unwrap();
    assert!(matches!(
        budget.node(2),
        Err(ReadFailure::LimitExceeded(Resource::Depth))
    ));
    assert!(matches!(
        budget.visit(2),
        Err(ReadFailure::LimitExceeded(Resource::Depth))
    ));
    // Depth refusals consume a visit/node in the reference implementation.
    let mut budget = PreparationBudget::new(&cancelled, limits).unwrap();
    budget.node(1).unwrap();
    budget.visit(1).unwrap();
    budget.rule().unwrap();
    budget.expansion(2).unwrap();
    assert!(matches!(
        budget.node(0),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
    assert!(matches!(
        budget.visit(0),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));
    assert!(matches!(
        budget.rule(),
        Err(ReadFailure::LimitExceeded(Resource::Rules))
    ));
    assert!(matches!(
        budget.expansion(1),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
}

#[test]
fn per_file_and_aggregate_byte_caps_are_independent() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        artifact_bytes: 4,
        document_bytes: 2,
        total_document_bytes: 4,
        ..PreparationLimits::default()
    };
    let mut budget = PreparationBudget::new(&cancelled, limits).unwrap();
    assert!(matches!(
        budget.artifact(5, 0),
        Err(ReadFailure::LimitExceeded(Resource::ArtifactBytes))
    ));
    assert!(matches!(
        budget.document(3, 0),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    budget.artifact(4, 2).unwrap();
    budget.artifact(4, 2).unwrap();
    budget.document(2, 2).unwrap();
    budget.document(2, 2).unwrap();
    budget.expansion(4).unwrap();
    assert!(matches!(
        budget.artifact(1, 1),
        Err(ReadFailure::LimitExceeded(Resource::ArtifactBytes))
    ));
    assert!(matches!(
        budget.document(1, 1),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
}

#[test]
fn oversized_charges_never_wrap_back_under_the_cap() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    budget.artifact(1, 1).unwrap();
    budget.document(1, 1).unwrap();
    budget.expansion(1).unwrap();
    assert!(matches!(
        budget.artifact(u64::MAX, usize::MAX),
        Err(ReadFailure::LimitExceeded(Resource::ArtifactBytes))
    ));
    assert!(matches!(
        budget.artifact(0, 1),
        Err(ReadFailure::LimitExceeded(Resource::ArtifactBytes))
    ));
    assert!(matches!(
        budget.document(usize::MAX, usize::MAX),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    assert!(matches!(
        budget.document(0, 1),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    assert!(matches!(
        budget.expansion(usize::MAX),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
}

#[test]
fn cancellation_precedes_all_resource_checks() {
    let cancelled = AtomicBool::new(true);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    assert!(matches!(
        budget.entry(usize::MAX, usize::MAX),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        budget.artifact(u64::MAX, usize::MAX),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        budget.document(usize::MAX, usize::MAX),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        budget.expansion(usize::MAX),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        budget.node(usize::MAX),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        budget.visit(usize::MAX),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(budget.rule(), Err(ReadFailure::Cancelled)));
}
