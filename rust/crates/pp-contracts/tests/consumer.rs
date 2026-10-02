use pp_contracts::*;
use serde_json::{Value, json};

fn golden(name: &str) -> Value {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../web/packages/contracts/test-fixtures/desktop/autosave-v1.json"
    ))
    .unwrap();
    corpus["normalized"]["schema_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == name)
        .unwrap()["input"]
        .clone()
}

#[test]
fn external_consumer_reads_typed_request_and_constructs_exact_receipt() {
    let request = parse_request(&golden("quantity-null-reset").to_string()).unwrap();
    assert!(request.expected_draft().is_none());
    assert_eq!(request.expected_base().plan_version().get(), 1);
    assert_eq!(request.expected_base().revision_id().unwrap().get(), 1);
    assert!(request.remap_checkoff_links());
    let decision = &request.decisions()[0];
    assert!(!decision.target().part_key().is_empty());
    assert!(!decision.target().relative_path().is_empty());
    assert!(decision.target().source_layer().is_none());
    assert!(matches!(
        decision,
        PlanChoice::SetQuantityOverride { value: None, .. }
    ));
    let expected = golden("receipt-valid");
    let parsed = parse_receipt(&expected.to_string()).unwrap();
    let receipt = ApplyPlanDraftReceipt::new(ReceiptFields {
        profile_id: parsed.profile_id(),
        draft_id: parsed.draft_id(),
        revision_id: parsed.revision_id(),
        plan_version: parsed.plan_version(),
        draft_lifecycle_version: parsed.draft_lifecycle_version(),
        revision_digest: Digest::new(parsed.revision_digest().as_str().to_owned()).unwrap(),
        required_unit_mapping_digest: Digest::new(
            parsed.required_unit_mapping_digest().as_str().to_owned(),
        )
        .unwrap(),
        applied_at: WireText::new(parsed.applied_at().to_owned()).unwrap(),
    });
    assert_eq!(serde_json::to_value(receipt).unwrap(), expected);
}

#[test]
fn public_construction_and_deserialization_cannot_bypass_invariants() {
    assert!(PositiveId::new(0).is_err());
    assert!(Quantity::new(10001).is_err());
    assert!(Digest::new("A".repeat(64)).is_err());
    assert!(WireText::<1, 100>::new(String::new()).is_err());
    assert!(PlanDraftBasis::new(None, Version::new(1).unwrap()).is_err());
    let empty = PlanDraftBasis::new(None, Version::new(0).unwrap()).unwrap();
    assert!(SavePlanChoicesRequest::new(empty.clone(), None, false, vec![]).is_err());
    let target = FileTarget::new(
        WireText::new("part".into()).unwrap(),
        WireText::new("part.stl".into()).unwrap(),
        None,
    );
    let choice = PlanChoice::SetIncluded {
        target,
        value: true,
    };
    assert!(
        SavePlanChoicesRequest::new(
            empty.clone(),
            None,
            false,
            vec![choice.clone(), choice.clone()]
        )
        .is_err()
    );
    let identity = PlanDraftIdentity::new(
        PositiveId::new(1).unwrap(),
        DraftState::Consumed,
        Version::new(0).unwrap(),
        Digest::new("a".repeat(64)).unwrap(),
        empty.clone(),
    );
    assert_eq!(identity.draft_id().get(), 1);
    assert_eq!(identity.lifecycle_version().get(), 0);
    assert_eq!(identity.snapshot_digest().as_str(), "a".repeat(64));
    assert_eq!(identity.base(), &empty);
    assert_eq!(identity.state(), &DraftState::Consumed);
    assert!(SavePlanChoicesRequest::new(empty, Some(identity), false, vec![choice]).is_err());
    let mut invalid = golden("quantity-null-reset");
    invalid["expected_base"] = json!({ "revision_id": null, "plan_version": 1 });
    assert!(serde_json::from_value::<SavePlanChoicesRequest>(invalid).is_err());
}

#[test]
fn malformed_scalar_text_rejected_and_valid_pairs_preserved() {
    let request = golden("quantity-null-reset");
    for malformed in [r"\ud800", r"\udfff", r"\udfff\ud800"] {
        let mut input = request.clone();
        input["decisions"][0]["target"]["source_layer"] = json!("PLACEHOLDER");
        let raw = input.to_string().replace("PLACEHOLDER", malformed);
        assert_eq!(
            parse_request(&raw).unwrap_err().category,
            "invalid_unicode_scalar_text"
        );
    }
    let mut input = request;
    input["decisions"][0]["target"]["source_layer"] = json!("a🙂é");
    let raw = input.to_string().replace('🙂', r"\ud83d\ude42");
    assert_eq!(
        serde_json::to_value(parse_request(&raw).unwrap()).unwrap(),
        input
    );
}
