#![cfg(feature = "desktop_rebuild")]

use pp_contracts::{
    build_identity::BuildName,
    reconciliation::ReconciliationRequest,
    working_drafts::{PartChoice, RebaseRequest, RecomputeOptions, Request, SourceState},
};
use serde_json::json;

#[test]
fn build_names_trim_and_enforce_character_bounds() {
    assert_eq!(BuildName::parse("  Kit  ".into()).unwrap().as_str(), "Kit");
    assert!(BuildName::parse(" \n ".into()).is_err());
    assert!(BuildName::parse("a".repeat(4096)).is_ok());
    assert!(BuildName::parse("a".repeat(4097)).is_err());
}

#[test]
fn reconciliation_preserves_decisions_and_rejects_duplicate_targets() {
    let decision = json!({"kind":"replace","target_draft_part_id":1});
    let valid = json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[decision.clone()]});
    let parsed: ReconciliationRequest = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(parsed.expected_snapshot_digest().as_str(), "a".repeat(64));
    assert_eq!(parsed.decisions()[0].target().get(), 1);
    assert_eq!(serde_json::to_value(parsed).unwrap(), valid);
    let duplicate =
        json!({"expected_snapshot_digest":"a".repeat(64),"decisions":[decision.clone(),decision]});
    assert!(serde_json::from_value::<ReconciliationRequest>(duplicate).is_err());
    let too_many = json!({"expected_snapshot_digest":"a".repeat(64),"decisions":(1..=10001).map(|id|json!({"kind":"replace","target_draft_part_id":id})).collect::<Vec<_>>()});
    assert!(serde_json::from_value::<ReconciliationRequest>(too_many).is_err());
}

#[test]
fn reconciliation_requires_nullable_fields_and_utf16_text_bounds() {
    use pp_contracts::reconciliation::{Conflict, PartView, Text};
    let valid = json!({"draft_part_id":1,"base_revision_part_id":null,"part_key":"key","filename":"part.stl","relative_path":"part.stl","source_layer":"","role":"","quantity_inferred":1,"quantity_override":null,"quantity_effective":1,"included":true});
    let parsed: PartView = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), valid);
    for field in ["base_revision_part_id", "quantity_override"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<PartView>(missing).is_err());
    }
    assert!(serde_json::from_value::<Text<1, 1>>(json!("😀")).is_err());
    assert_eq!(
        serde_json::from_value::<Text<1, 2>>(json!("😀"))
            .unwrap()
            .as_str(),
        "😀"
    );
    assert!(serde_json::from_value::<Conflict>(json!({"kind":"ambiguous_exact_match","target_draft_part_id":1,"candidate_revision_part_ids":[]})).is_err());
}

#[test]
fn recompute_defaults_preserve_manifest_and_explicit_choices() {
    let options: RecomputeOptions = serde_json::from_value(json!({})).unwrap();
    assert!(options.apply_manifest);
    assert!(!options.prefer_accepted);
    assert!(options.part_choices_by_source_id.is_none());
    assert!(RecomputeOptions::default().apply_manifest);
    let options: RecomputeOptions = serde_json::from_value(json!({"apply_manifest":false,"prefer_accepted":true,"part_choices_by_source_id":{"12":{"part.stl":{"quantity":2,"role":"support","color":null}}}})).unwrap();
    assert!(!options.apply_manifest);
    assert!(options.prefer_accepted);
    let choice = &options.part_choices_by_source_id.unwrap()[&12]["part.stl"];
    assert_eq!(choice.quantity.get(), 2);
    assert_eq!(choice.role, "support");
    assert_eq!(choice.color, None);
}

#[test]
fn source_maps_reject_noncanonical_or_nonpositive_ids() {
    for field in [
        "part_choices_by_source_id",
        "excluded_paths_by_source_id",
        "included_paths_by_source_id",
    ] {
        for key in ["0", "-1", "01", "+1", "invalid", "9223372036854775808"] {
            let entries = if field == "part_choices_by_source_id" {
                json!({})
            } else {
                json!([])
            };
            let mut value = json!({});
            value[field] = json!({key: entries});
            assert!(
                serde_json::from_value::<RecomputeOptions>(value).is_err(),
                "{field} {key}"
            );
        }
    }
}

#[test]
fn draft_requests_reject_authority_fields_and_preserve_source_state_default() {
    assert!(serde_json::from_value::<Request>(json!({"kind":"list","tenant_id":1})).is_err());
    let parsed: RebaseRequest = serde_json::from_value(json!({"source_draft_id":1,"expected_source_lifecycle_version":0,"expected_source_snapshot_digest":"a".repeat(64)})).unwrap();
    assert!(matches!(
        parsed.expected_source_state,
        SourceState::Abandoned
    ));
    assert_eq!(
        serde_json::to_value(parsed).unwrap()["expected_source_state"],
        "abandoned"
    );
    assert!(serde_json::from_value::<PartChoice>(json!({"quantity":1,"role":"support"})).is_err());
    assert!(
        serde_json::from_value::<PartChoice>(json!({"quantity":1,"role":"support","color":null}))
            .is_ok()
    );
}
