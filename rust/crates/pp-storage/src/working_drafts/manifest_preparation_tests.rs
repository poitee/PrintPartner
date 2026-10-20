#![cfg(test)]

use super::super::observation::{PreparationLimits, Resource};
use super::*;
use crate::manifest_text::PartManifestMetadata;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn manifest_blank_scan_accepts_ecmascript_whitespace() {
    let whitespace = "\u{0009}\u{000a}\u{000b}\u{000c}\u{000d}\u{0020}\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
    let mut inputs = vec![
        String::new(),
        whitespace.to_owned(),
        " ".repeat(1024 * 1024),
    ];
    inputs.extend(whitespace.chars().map(|c| c.to_string()));
    for input in inputs {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(
            &cancelled,
            PreparationLimits {
                nodes: 0,
                visits: 0,
                total_document_bytes: 0,
                ..PreparationLimits::default()
            },
        )
        .unwrap();
        let manifest = parse(input.as_bytes(), &mut b).unwrap();
        assert_eq!(manifest.project, None, "{input:?}");
        assert!(manifest.rules.is_empty());
        assert!(manifest.groups.is_empty());
        assert!(manifest.selections.is_empty());
        assert!(manifest.selection_shapes.is_empty());
    }
}

#[test]
fn manifest_blank_scan_rejects_non_ecmascript_whitespace() {
    for input in ["\u{0085}", "\u{180e}", "\u{200b}", "\u{10009}", "\u{1f600}"] {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        assert!(
            matches!(
                parse(input.as_bytes(), &mut b),
                Err(ReadFailure::InvalidDocument)
            ),
            "{input:?}"
        );
    }
}

#[test]
fn manifest_blank_scan_preserves_lossy_utf8_parsing() {
    let cancelled = AtomicBool::new(false);
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let manifest = parse(b"project: \xff\n", &mut b).unwrap();
    assert_eq!(
        manifest.project.unwrap().as_scalar().as_deref(),
        Some("\u{fffd}")
    );
    for input in [b" \xff ".as_slice(), b"\xc2", b"\xed\xa0\x80", b"\xf0\x9f"] {
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        assert!(matches!(
            parse(input, &mut b),
            Err(ReadFailure::InvalidDocument)
        ));
    }
}

#[test]
fn manifest_blank_scan_checks_document_budget_and_cancellation_first() {
    for input in [b"  ".as_slice(), b"\xff\xff"] {
        let cancelled = AtomicBool::new(false);
        let limits = PreparationLimits {
            document_bytes: 1,
            ..PreparationLimits::default()
        };
        let mut b = PreparationBudget::new(&cancelled, limits).unwrap();
        assert!(matches!(
            parse(input, &mut b),
            Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
        ));
        let mut b = PreparationBudget::new(&cancelled, limits).unwrap();
        b.cancel_after_checks(0);
        assert!(matches!(parse(input, &mut b), Err(ReadFailure::Cancelled)));
    }
}

fn cases() -> impl Iterator<Item = Value> {
    include_str!("../../tests/fixtures/preparation-prereqs-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
}

fn selection_json(selections: &Selections) -> String {
    let mut out = vec![b'['];
    for (index, (key, ids)) in selections.iter().enumerate() {
        if index != 0 {
            out.push(b',');
        }
        out.push(b'[');
        key.0.write_json(&mut out);
        out.extend_from_slice(b",[");
        for (index, id) in ids.iter().enumerate() {
            if index != 0 {
                out.push(b',');
            }
            id.0.write_json(&mut out);
        }
        out.extend_from_slice(b"]]");
    }
    out.push(b']');
    String::from_utf8(out).unwrap()
}

#[test]
fn kit_selections_match_literal_node_results() {
    for case in cases().filter(|case| case["kind"] == "kit") {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        let selections = kit(case["raw"].as_str().map(str::to_owned), &mut b).unwrap();
        assert_eq!(
            selection_json(&selections),
            case["result"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn optional_documents_match_literal_node_results() {
    for case in cases().filter(|case| case["kind"] == "optional") {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        let read = case["yaml"].as_str().map_or(DocumentRead::Missing, |s| {
            DocumentRead::Bytes(s.as_bytes().to_vec())
        });
        let result = optional_document(&read, &mut b).unwrap().map(|doc| {
            json!({
                "project": doc.project.and_then(|text| text.as_scalar()), "rules": doc.rules.len(),
            })
        });
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            case["result"],
            "{case}"
        );
    }
    let cancelled = AtomicBool::new(false);
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    assert!(
        optional_document(
            &DocumentRead::Skipped(std::io::ErrorKind::PermissionDenied),
            &mut b
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn manifest_apply_matches_literal_node_results() {
    for case in cases().filter(|case| case["kind"] == "apply") {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        let docs: Vec<_> = case["docs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|doc| {
                (
                    doc["name"].as_str().unwrap().to_owned(),
                    "repo".to_owned(),
                    optional_document(
                        &DocumentRead::Bytes(doc["yaml"].as_str().unwrap().as_bytes().to_vec()),
                        &mut b,
                    )
                    .unwrap()
                    .unwrap(),
                )
            })
            .collect();
        let groups = if case["groups"].is_object() {
            let yaml = serde_json::to_vec(&json!({"option_groups":case["groups"]})).unwrap();
            parse(&yaml, &mut b).unwrap().groups
        } else {
            Vec::new()
        };
        let selections = kit(case["raw"].as_str().map(str::to_owned), &mut b).unwrap();
        let mut parts: Vec<_> = case["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| {
                let mut scalar = part.clone();
                for key in ["requirement", "optionGroupId", "manifestSource"] {
                    scalar.as_object_mut().unwrap().remove(key);
                }
                DraftPart::new(
                    scalar,
                    PartManifestMetadata {
                        requirement: part["requirement"]
                            .as_str()
                            .map(|s| ManifestText::from(s.to_owned())),
                        option_group_id: part["optionGroupId"]
                            .as_str()
                            .map(|s| OptionGroupId(JsText::scalar(s))),
                        manifest_source: part["manifestSource"].as_str().map(str::to_owned),
                    },
                )
            })
            .collect();
        apply(&mut parts, &docs, groups, selections, &mut b).unwrap();
        let result: Vec<_> = parts.iter().map(|part| json!({
            "partKey":part["partKey"], "included":part["included"], "sourceLayer":part["sourceLayer"],
            "requirement":part.manifest.requirement.as_ref().and_then(|s| s.as_scalar()),
            "optionGroupId":part.manifest.option_group_id.as_ref().and_then(|s| s.0.as_scalar()),
            "manifestSource":part.manifest.manifest_source,
        })).collect();
        assert_eq!(json!(result), case["result"], "{}", case["name"]);
    }
}

#[test]
fn preparation_manifest_helpers_propagate_budget_and_cancellation() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        document_bytes: 1,
        ..PreparationLimits::default()
    };
    let mut b = PreparationBudget::new(&cancelled, limits).unwrap();
    assert!(matches!(
        optional_document(&DocumentRead::Bytes(b"{}".to_vec()), &mut b),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    let mut b = PreparationBudget::new(&cancelled, limits).unwrap();
    assert!(matches!(
        kit(Some("{}".into()), &mut b),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    let mut b = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            nodes: 0,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        kit(Some("{}".into()), &mut b),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
    let mut parts = [DraftPart::new(
        json!({"partKey":"a.stl", "included":true}),
        PartManifestMetadata::default(),
    )];
    let mut b = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            entries: 0,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        apply(&mut parts, &[], vec![], vec![], &mut b),
        Err(ReadFailure::LimitExceeded(Resource::Entries))
    ));
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let docs = [(
        "Frame".into(),
        "repo".into(),
        parse(b"parts: ['*.stl']", &mut b).unwrap(),
    )];
    let mut b = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            visits: 1,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        apply(&mut parts, &docs, vec![], vec![], &mut b),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));
    let comparison_work = |comparison_work| {
        PreparationBudget::new(
            &cancelled,
            PreparationLimits {
                comparison_work,
                ..PreparationLimits::default()
            },
        )
        .unwrap()
    };
    let mut b = comparison_work(26);
    apply(&mut parts, &docs, vec![], vec![], &mut b).unwrap();
    let mut b = comparison_work(25);
    assert!(matches!(
        apply(&mut parts, &docs, vec![], vec![], &mut b),
        Err(ReadFailure::LimitExceeded(Resource::ComparisonWork))
    ));
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    cancelled.store(true, Ordering::Release);
    assert!(matches!(
        optional_document(&DocumentRead::Bytes(b"{}".to_vec()), &mut b),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(kit(None, &mut b), Err(ReadFailure::Cancelled)));
    assert!(matches!(
        apply(&mut [], &[], vec![], vec![], &mut b),
        Err(ReadFailure::Cancelled)
    ));
}

fn variant_group_scale(count: usize) -> (Vec<DraftPart>, Groups) {
    let paths: Vec<String> = (0..count)
        .map(|i| {
            format!("Voron-2/STLs/Gantry/X_Axis/XY_Joints/[a]_xy_joint_part_{i:04}_option_x1.stl")
        })
        .collect();
    let mut groups = serde_json::Map::new();
    for g in 0..20 {
        let variants: Vec<_> = (0..3)
            .map(|v| json!({"id": format!("v{v}"), "parts": [&paths[g * 6 + v * 2], &paths[g * 6 + v * 2 + 1]]}))
            .collect();
        groups.insert(
            format!("group_{g}"),
            json!({"rule": "pick_one", "variants": variants}),
        );
    }
    let cancelled = AtomicBool::new(false);
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let yaml = serde_json::to_vec(&json!({"option_groups": groups})).unwrap();
    let groups = parse(&yaml, &mut b).unwrap().groups;
    let parts = paths
        .iter()
        .map(|p| {
            DraftPart::new(
                json!({"partKey": p, "included": true, "sourceLayer": "0:Voron"}),
                PartManifestMetadata::default(),
            )
        })
        .collect();
    (parts, groups)
}

#[test]
fn apply_compares_variant_paths_up_to_the_visit_limit() {
    for count in [250, 480] {
        let (mut parts, groups) = variant_group_scale(count);
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        apply(&mut parts, &[], groups, vec![], &mut b).unwrap();
        let included = parts.iter().filter(|p| p["included"] == true).count();
        assert_eq!(included, count - 120, "{count} parts");
        assert_eq!(parts[119]["included"], false);
        assert_eq!(parts[120]["included"], true);
    }
    let (mut parts, groups) = variant_group_scale(520);
    let cancelled = AtomicBool::new(false);
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    assert!(matches!(
        apply(&mut parts, &[], groups, vec![], &mut b),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));
}

#[test]
fn apply_refuses_quadratic_comparisons_by_work_not_bytes() {
    let cancelled = AtomicBool::new(false);
    let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let rule = format!("parts: ['*{}b']", "a".repeat(2047));
    let docs = [(
        "F".into(),
        "repo".into(),
        parse(rule.as_bytes(), &mut b).unwrap(),
    )];
    let key = "a".repeat(4096);
    let mut parts: Vec<_> = (0..100)
        .map(|_| {
            DraftPart::new(
                json!({"partKey": key, "included": true, "sourceLayer": "0:F"}),
                PartManifestMetadata::default(),
            )
        })
        .collect();
    assert!(matches!(
        apply(&mut parts, &docs, vec![], vec![], &mut b),
        Err(ReadFailure::LimitExceeded(Resource::ComparisonWork))
    ));
}

#[test]
fn apply_charges_raw_pattern_units_before_trimming() {
    let cancelled = AtomicBool::new(false);
    let limits = PreparationLimits {
        comparison_work: 1 << 22,
        ..PreparationLimits::default()
    };
    let mut b = PreparationBudget::new(&cancelled, limits).unwrap();
    let yaml =
        serde_json::to_vec(&json!({"parts": [format!("{}b", " ".repeat(960_000))]})).unwrap();
    let docs: Vec<_> = (0..2)
        .map(|_| ("F".into(), "repo".into(), parse(&yaml, &mut b).unwrap()))
        .collect();
    let mut parts: Vec<_> = (0..10)
        .map(|_| {
            DraftPart::new(
                json!({"partKey": "a.stl", "included": true, "sourceLayer": "0:F"}),
                PartManifestMetadata::default(),
            )
        })
        .collect();
    assert!(matches!(
        apply(&mut parts, &docs, vec![], vec![], &mut b),
        Err(ReadFailure::LimitExceeded(Resource::ComparisonWork))
    ));
}

#[test]
fn apply_charges_option_group_merging() {
    let cancelled = AtomicBool::new(false);
    let budget = |visits| {
        PreparationBudget::new(
            &cancelled,
            PreparationLimits {
                visits,
                ..PreparationLimits::default()
            },
        )
        .unwrap()
    };
    let groups: serde_json::Map<_, _> = (0..10_000)
        .map(|i| (format!("group_{i}"), json!({})))
        .collect();
    let yaml = serde_json::to_vec(&json!({ "option_groups": groups })).unwrap();
    let many = [(
        "F".into(),
        "repo".into(),
        parse(&yaml, &mut budget(100_000)).unwrap(),
    )];
    assert!(matches!(
        apply(&mut [], &many, vec![], vec![], &mut budget(2)),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));
    let cancelling = AtomicBool::new(false);
    let mut b = PreparationBudget::new(&cancelling, PreparationLimits::default()).unwrap();
    b.cancel_after_checks(100);
    assert!(matches!(
        apply(&mut [], &many, vec![], vec![], &mut b),
        Err(ReadFailure::Cancelled)
    ));

    let docs = [(
        "F".into(),
        "repo".into(),
        parse(
            b"option_groups: { tool: { variants: [{ id: a }] } }",
            &mut budget(100_000),
        )
        .unwrap(),
    )];
    let inferred = parse(
        b"option_groups: { tool: { variants: [{ id: a, parts: [a.stl] }] }, other: {} }",
        &mut budget(100_000),
    )
    .unwrap()
    .groups;
    // Two document visits, copying the repository group and its variant, merging
    // that group, then the duplicate inferred group, its existing variant, its
    // incoming variant, one incoming path, the new group, and one sort per merge.
    apply(&mut [], &docs, inferred.clone(), vec![], &mut budget(12)).unwrap();
    assert!(matches!(
        apply(&mut [], &docs, inferred, vec![], &mut budget(11)),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));

    // Copying a document's groups charges every path before the merge sees them.
    let paths: Vec<_> = (0..10_000).map(|i| format!("p{i}.stl")).collect();
    let yaml = serde_json::to_vec(
        &json!({"option_groups": {"tool": {"variants": [{"id": "a", "parts": paths}]}}}),
    )
    .unwrap();
    let wide = [(
        "F".into(),
        "repo".into(),
        parse(&yaml, &mut budget(100_000)).unwrap(),
    )];
    apply(&mut [], &wide, vec![], vec![], &mut budget(10_007)).unwrap();
    assert!(matches!(
        apply(&mut [], &wide, vec![], vec![], &mut budget(10_006)),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));

    // Each merge charges its sort, even with nothing incoming.
    let comparison_work = |comparison_work| {
        PreparationBudget::new(
            &cancelled,
            PreparationLimits {
                comparison_work,
                ..PreparationLimits::default()
            },
        )
        .unwrap()
    };
    let mut target = many[0].2.groups.clone();
    merge(&mut target, vec![], &mut comparison_work(10_000)).unwrap();
    assert!(matches!(
        merge(&mut target, vec![], &mut comparison_work(9_999)),
        Err(ReadFailure::LimitExceeded(Resource::ComparisonWork))
    ));
}

#[test]
fn kit_charges_stored_json_to_the_preparation_budget() {
    let raw = || Some(r#"{"selections":{"tool":"a","tool":["b"]}}"#.to_owned());
    let cancelled = AtomicBool::new(false);
    let budget = |limits| PreparationBudget::new(&cancelled, limits).unwrap();
    let limits = |nodes, depth| PreparationLimits {
        nodes,
        depth,
        ..PreparationLimits::default()
    };
    // Root, its key, selections, both tool keys, "a", the array and "b".
    assert_eq!(
        selection_json(&kit(raw(), &mut budget(limits(8, 3))).unwrap()),
        r#"[["tool",["b"]]]"#
    );
    assert!(matches!(
        kit(raw(), &mut budget(limits(7, 3))),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
    assert!(matches!(
        kit(raw(), &mut budget(limits(8, 2))),
        Err(ReadFailure::LimitExceeded(Resource::Depth))
    ));
    let mut b = budget(PreparationLimits::default());
    b.cancel_after_checks(3);
    assert!(matches!(kit(raw(), &mut b), Err(ReadFailure::Cancelled)));
}

#[test]
fn optional_documents_report_cancellation_for_every_read() {
    let reads = [
        DocumentRead::Missing,
        DocumentRead::Skipped(std::io::ErrorKind::PermissionDenied),
        DocumentRead::Bytes(b"project: Frame".to_vec()),
        DocumentRead::Bytes(b"{".to_vec()),
    ];
    let cancelled = AtomicBool::new(true);
    for (index, read) in reads.iter().enumerate() {
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        assert!(
            matches!(optional_document(read, &mut b), Err(ReadFailure::Cancelled)),
            "read {index}"
        );
    }
    // Cancelling after any check still refuses; only an uncancelled attempt reads as absent.
    for (index, read) in reads.iter().enumerate().skip(2) {
        for checks in 0.. {
            let cancelled = AtomicBool::new(false);
            let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
            b.cancel_after_checks(checks);
            match optional_document(read, &mut b) {
                Err(ReadFailure::Cancelled) => {}
                Ok(_) => {
                    assert!(
                        !cancelled.load(Ordering::Acquire),
                        "read {index} at {checks}"
                    );
                    break;
                }
                Err(error) => panic!("read {index} at {checks}: {error}"),
            }
        }
    }
}
