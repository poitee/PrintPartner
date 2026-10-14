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
    assert_eq!(choice.role.as_str(), "support");
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
        parsed.expected_source_state(),
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

#[test]
fn transition_lifecycle_version_reserves_room_for_increment() {
    let request = |version| json!({"kind":"transition","draft_id":1,"transition":"abandon","expected_lifecycle_version":version});
    assert!(serde_json::from_value::<Request>(request(2_147_483_646u64)).is_ok());
    for version in [2_147_483_647u64, u32::MAX as u64] {
        assert!(serde_json::from_value::<Request>(request(version)).is_err());
    }
}

#[test]
fn edit_batches_validate_targets_and_preserve_distinct_fields() {
    let included = |ids| json!({"kind":"set_included","draft_part_ids":ids,"value":true});
    let quantity = |ids| json!({"kind":"set_quantity_override","draft_part_ids":ids,"value":null});
    let request = |decisions| json!({"kind":"edit","draft_id":1,"expected_snapshot_digest":"a".repeat(64),"decisions":decisions});
    for decisions in [
        json!([]),
        json!([included(json!([]))]),
        json!([included(json!([1, 1]))]),
        json!([included(json!([1])), included(json!([1, 2]))]),
        json!([quantity(json!([1])), quantity(json!([1]))]),
    ] {
        assert!(serde_json::from_value::<Request>(request(decisions)).is_err());
    }
    let valid = request(json!([included(json!([1, 2])), quantity(json!([2]))]));
    let parsed: Request = serde_json::from_value(valid.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), valid);
    let valid_limit = request(json!(
        (1..=10000)
            .map(|id| included(json!([id])))
            .collect::<Vec<_>>()
    ));
    assert!(serde_json::from_value::<Request>(valid_limit).is_ok());
    let overflow = request(json!(
        (1..=10001)
            .map(|id| included(json!([id])))
            .collect::<Vec<_>>()
    ));
    assert!(serde_json::from_value::<Request>(overflow).is_err());
}

#[test]
fn source_map_ids_are_safe_for_javascript() {
    for field in [
        "part_choices_by_source_id",
        "excluded_paths_by_source_id",
        "included_paths_by_source_id",
    ] {
        let entries = if field == "part_choices_by_source_id" {
            json!({})
        } else {
            json!([])
        };
        let mut value = json!({});
        value[field] = json!({"9007199254740991":entries.clone()});
        assert!(serde_json::from_value::<RecomputeOptions>(value.clone()).is_ok());
        value[field] = json!({"9007199254740992":entries});
        assert!(serde_json::from_value::<RecomputeOptions>(value).is_err());
    }
}

#[test]
fn publication_preserves_transaction_unavailable_outcome() {
    let value = json!({"kind":"transaction_unavailable"});
    let parsed: pp_contracts::publication::Outcome = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

#[test]
fn rebase_versions_follow_source_state_and_domain_bounds() {
    for state in ["open", "abandoned"] {
        for version in [
            0u64,
            2_147_483_646,
            2_147_483_647,
            2_147_483_648,
            u32::MAX as u64,
        ] {
            let value = json!({"source_draft_id":1,"expected_source_state":state,"expected_source_lifecycle_version":version,"expected_source_snapshot_digest":"a".repeat(64)});
            let valid = version <= 2_147_483_647 && (state != "open" || version < 2_147_483_647);
            let parsed = serde_json::from_value::<RebaseRequest>(value.clone());
            assert_eq!(parsed.is_ok(), valid, "{state} {version}");
            let nested =
                json!({"kind":"rebase","idempotency_key":"rebase-1","request":value.clone()});
            assert_eq!(serde_json::from_value::<Request>(nested).is_ok(), valid);
            if let Ok(parsed) = parsed {
                assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            }
        }
    }
    let default_state = json!({"source_draft_id":1,"expected_source_lifecycle_version":2_147_483_647u64,"expected_source_snapshot_digest":"a".repeat(64)});
    assert!(serde_json::from_value::<RebaseRequest>(default_state).is_ok());
}

#[test]
fn expected_draft_lifecycle_version_is_domain_bounded() {
    use pp_contracts::working_drafts::ExpectedDraft;
    let mut value = json!({"snapshot_digest":"a".repeat(64),"lifecycle_version":2_147_483_647u64,"base":{"revision_id":null,"plan_version":0}});
    assert!(serde_json::from_value::<ExpectedDraft>(value.clone()).is_ok());
    value["lifecycle_version"] = json!(2_147_483_648u64);
    assert!(serde_json::from_value::<ExpectedDraft>(value).is_err());
}

#[test]
fn embedded_idempotency_keys_normalize_and_enforce_route_bounds() {
    for kind in ["recompute", "rebase", "select"] {
        let mut value = match kind {
            "recompute" => json!({"kind":kind,"options":{}}),
            "rebase" => {
                json!({"kind":kind,"request":{"source_draft_id":1,"expected_source_lifecycle_version":0,"expected_source_snapshot_digest":"a".repeat(64)}})
            }
            _ => {
                json!({"kind":kind,"draft_id":1,"request":{"expected_snapshot_digest":"a".repeat(64),"decisions":[]}})
            }
        };
        for key in ["", " \n ", &"k".repeat(161), &"😀".repeat(81)] {
            value["idempotency_key"] = json!(key);
            assert!(
                serde_json::from_value::<Request>(value.clone()).is_err(),
                "{kind}"
            );
        }
        value["idempotency_key"] = json!(" key ");
        let parsed: Request = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["idempotency_key"],
            "key"
        );
    }
}

#[test]
fn recompute_choices_validate_roles_and_nullable_hex_colors() {
    for role in ["", " \n ", &"r".repeat(201), &"😀".repeat(101)] {
        assert!(
            serde_json::from_value::<PartChoice>(json!({"quantity":1,"role":role,"color":null}))
                .is_err()
        );
    }
    for color in ["", "red", "#abc", "#abcdef0", "#abcdeg", "abcdef"] {
        assert!(
            serde_json::from_value::<PartChoice>(
                json!({"quantity":1,"role":"support","color":color})
            )
            .is_err()
        );
    }
    for color in [json!(null), json!("#aBcD09")] {
        let value = json!({"quantity":1,"role":" support ","color":color});
        let parsed: PartChoice = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
}

#[test]
fn build_request_decoding_validates_and_normalizes_names() {
    use pp_contracts::build_identity::CreateBuildRequest;
    for name in ["", " \n ", &"n".repeat(4097)] {
        assert!(serde_json::from_value::<CreateBuildRequest>(json!({"name":name})).is_err());
    }
    let parsed: CreateBuildRequest = serde_json::from_value(json!({"name":"  Kit  "})).unwrap();
    assert_eq!(serde_json::to_value(parsed.name).unwrap(), json!("Kit"));
}

#[test]
fn workspace_failures_preserve_missing_workspace_and_merge_conflicts() {
    use pp_contracts::reconciliation::Outcome;
    for kind in [
        "base_changed",
        "inputs_changed",
        "base_unchanged",
        "not_open",
        "accepted_baseline_required",
        "idempotency_conflict",
    ] {
        let value = json!({"kind":kind});
        let parsed: Outcome = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
    let value = json!({"kind":"merge_conflicts","conflicts":[{"kind":"source_identity","sourcePartId":1,"sourceLayer":"layer"},{"kind":"target_missing","sourcePartId":1,"targetPartIds":[]},{"kind":"target_ambiguous","sourcePartId":1,"targetPartIds":[2,3]},{"kind":"target_collision","sourcePartIds":[1,2],"targetPartId":3},{"kind":"concurrent_decision","sourcePartId":1,"targetPartId":2,"field":"quantityOverride"}]});
    let parsed: Outcome = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

#[test]
fn request_text_matches_ecmascript_trim() {
    use pp_contracts::working_drafts::{IdempotencyKey, Role};
    for character in ['\u{feff}', '\u{a0}', '\u{2000}', '\u{2028}', '\u{2029}'] {
        assert!(IdempotencyKey::try_from(character.to_string()).is_err());
        assert_eq!(
            IdempotencyKey::try_from(format!("{character}key{character}"))
                .unwrap()
                .as_str(),
            "key"
        );
        assert!(Role::try_from(character.to_string()).is_err());
        assert!(BuildName::parse(character.to_string()).is_err());
    }
    for character in ['\u{85}', '\u{180e}', '\u{200b}'] {
        let value = format!("{character}key{character}");
        assert_eq!(
            IdempotencyKey::try_from(value.clone()).unwrap().as_str(),
            value
        );
    }
}

#[test]
fn not_open_apply_outcomes_require_a_closed_state() {
    use pp_contracts::publication::Outcome;
    assert!(serde_json::from_value::<Outcome>(json!({"kind":"not_open","state":"open"})).is_err());
    for state in ["abandoned", "consumed"] {
        let value = json!({"kind":"not_open","state":state});
        let parsed: Outcome = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
}

#[test]
fn untracked_freshness_never_emits_an_empty_reason_list() {
    use pp_contracts::build_identity::{FreshnessReasons, PlanFreshness, PlanUntrackedReason};
    assert!(FreshnessReasons::<PlanUntrackedReason>::try_from(vec![]).is_err());
    let value = PlanFreshness::Untracked {
        accepted_input_set_id: None,
        accepted_at: None,
        reasons: FreshnessReasons::new(PlanUntrackedReason::NoAcceptedInputs, vec![]),
    };
    assert_eq!(
        serde_json::to_value(value).unwrap()["reasons"],
        json!([{"kind":"no_accepted_inputs"}])
    );
}
