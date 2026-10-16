#![cfg(test)]

use super::observation::{
    BuilderGroup, BuilderGroups, BuilderVariant, PreparationBudget, PreparationLimits, ReadFailure,
    Resource, builder_path_matches, infer_builder_siblings, merge_builder_groups,
    parse_builder_hints, parse_builder_manifest,
};
use crate::manifest_text::ManifestText;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

fn text(value: &ManifestText) -> String {
    value.as_scalar().unwrap()
}

fn variant_shape(variant: &BuilderVariant) -> Value {
    json!({
        "id": variant.id.0.as_scalar().unwrap(),
        "label": variant.label.as_ref().map(text),
        "parts": variant.parts.iter().map(text).collect::<Vec<_>>(),
        "excludes": variant.excludes.iter().map(text).collect::<Vec<_>>(),
    })
}

fn group_shape(group: &BuilderGroup) -> Value {
    json!({
        "rule": group.rule,
        "label": group.label.as_ref().map(text),
        "parts": group.parts.iter().map(text).collect::<Vec<_>>(),
        "variants": group.variants.iter().map(variant_shape).collect::<Vec<_>>(),
        "min": group.min,
        "max": group.max,
    })
}

fn groups_shape(groups: &BuilderGroups) -> Value {
    Value::Array(
        groups
            .iter()
            .map(|(id, group)| json!([id.0.as_scalar().unwrap(), group_shape(group)]))
            .collect(),
    )
}

#[test]
fn builder_manifest_preserves_node_coercions_defaults_and_selection_shapes() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let manifest = parse_builder_manifest(
        br#"
project: [Frame, null, 2]
parts:
  - '*.stl'
  - { match: [a, null, b], requirement: false, option_group: 7, default_included: [] }
  - { ignored: true }
  - 9
addons:
  - { project: addon, source_id: 4, parts: [{ match: addon.stl, requirement: optional }] }
option_groups:
  extras:
    rule: pick_n
    label: 12
    parts: [true, null, [a, b], {a: b}]
    min: 0
    max: 2
    variants:
      - { id: ' a ', label: false, parts: [a.stl], excludes: [no.stl] }
      - { id: 2 }
      - { id: ' ' }
      - ignored
      - []
  tool: {}
selections:
  extras: [' a ', '2']
  tool: ' b '
"#,
        &mut budget,
    )
    .unwrap();
    assert_eq!(manifest.project.as_ref().map(text), Some("Frame,,2".into()));
    assert_eq!(
        manifest
            .rules
            .iter()
            .map(|rule| json!([
                text(&rule.pattern),
                rule.requirement.as_ref().map(text),
                rule.group.as_ref().and_then(|id| id.0.as_scalar()),
            ]))
            .collect::<Vec<_>>(),
        vec![
            json!(["*.stl", null, null]),
            json!(["a,,b", "false", "7"]),
            json!(["addon.stl", "optional", null]),
        ]
    );
    assert_eq!(
        groups_shape(&manifest.groups),
        json!([
            ["extras", {"rule":"pick_n", "label":"12", "parts":["true", "null", "a,b", "[object Object]"],
                "variants":[
                    {"id":"a", "label":"false", "parts":["a.stl"], "excludes":["no.stl"]},
                    {"id":"2", "label":null, "parts":[], "excludes":[]}
                ], "min":0, "max":2}],
            ["tool", {"rule":"pick_one", "label":null, "parts":[], "variants":[], "min":null, "max":null}]
        ])
    );
    assert_eq!(
        manifest
            .selections
            .iter()
            .map(|(id, variants)| json!([
                id.0.as_scalar().unwrap(),
                variants
                    .iter()
                    .map(|v| v.0.as_scalar().unwrap())
                    .collect::<Vec<_>>()
            ]))
            .collect::<Vec<_>>(),
        vec![json!(["extras", ["a", "2"]]), json!(["tool", ["b"]])]
    );
    assert_eq!(
        manifest
            .selection_shapes
            .iter()
            .map(|(id, scalar)| { (id.0.as_scalar().unwrap(), *scalar) })
            .collect::<Vec<_>>(),
        vec![("extras".into(), false), ("tool".into(), true)]
    );
}

#[test]
fn builder_manifest_rejects_node_invalid_structures_bounds_and_defaults() {
    for source in [
        "- invalid",
        "null",
        "option_groups: []",
        "option_groups: null",
        "option_groups: { extras: invalid }",
        "option_groups: { extras: { rule: invalid } }",
        "option_groups: { extras: { min: '1' } }",
        "option_groups: { extras: { min: -1 } }",
        "option_groups: { extras: { rule: pick_n, min: 2, max: 1 } }",
        "option_groups: { extras: { max: 2 } }",
        "option_groups: { extras: { min: 2 } }",
        "option_groups: { extras: { rule: pick_n, max: 1.5 } }",
        "option_groups: { extras: { rule: pick_n, max: 9007199254740992 } }",
        "option_groups: { extras: { rule: pick_n, min: .inf } }",
        "selections: null",
        "selections: []",
        "selections: { ' ': a }",
        "selections: { tool: [] }",
        "selections: { tool: [a, ' a '] }",
        "selections: { tool: [1] }",
        "selections: { tool: '' }",
        "option_groups: { tool: {} }\nselections: { tool: [a, b] }",
        "option_groups: { extras: { rule: pick_any, max: 1 } }\nselections: { extras: [a, b] }",
        "addons: [null]",
    ] {
        let cancelled = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        assert!(
            matches!(
                parse_builder_manifest(source.as_bytes(), &mut budget),
                Err(ReadFailure::InvalidDocument)
            ),
            "{source}"
        );
    }
}

#[test]
fn builder_manifest_accepts_empty_documents_and_safe_integer_bounds() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    for source in ["", " \n\t", "\u{feff}"] {
        let manifest = parse_builder_manifest(source.as_bytes(), &mut budget).unwrap();
        assert_eq!(groups_shape(&manifest.groups), json!([]));
        assert!(
            manifest.project.is_none()
                && manifest.rules.is_empty()
                && manifest.selections.is_empty()
        );
    }
    let manifest = parse_builder_manifest(
        b"option_groups: { extras: { rule: pick_any, max: 9007199254740991 } }",
        &mut budget,
    )
    .unwrap();
    assert_eq!(manifest.groups[0].1.max, Some(9007199254740991));
}

#[test]
fn builder_manifest_and_hints_preserve_utf16_identifiers() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let manifest = parse_builder_manifest(
        br#"option_groups: { "\uD800": { variants: [{ id: "\uDC00" }] } }
selections: { "\uD800": "\uDC00" }"#,
        &mut budget,
    )
    .unwrap();
    assert_eq!(manifest.groups[0].0.0.units(), [0xd800]);
    assert_eq!(manifest.groups[0].1.variants[0].id.0.units(), [0xdc00]);
    assert_eq!(manifest.selections[0].1[0].0.units(), [0xdc00]);
    let hints = parse_builder_hints(
        br#"version: 1
rules: [{path: "\uD800", option_group: "\uDC00", variant_id: "\uD800"}]"#,
        &mut budget,
    )
    .unwrap();
    assert_eq!(hints[0].0.0.units(), [0xd800]);
    assert_eq!(hints[0].1.0.units(), [0xdc00]);
    assert_eq!(hints[0].2.0.units(), [0xd800]);
}

#[test]
fn builder_groups_merge_node_precedence_duplicates_and_property_order() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let mut target = parse_builder_manifest(
        br#"option_groups:
  tool:
    rule: pick_n
    min: 0
    label: ''
    parts: [base.stl, base.stl, same.stl]
    variants:
      - { id: a, label: old, parts: [discarded.stl] }
      - { id: a, label: '', parts: [a.stl, a.stl], excludes: [x.stl, x.stl] }
      - { id: b, label: Existing, parts: [b.stl] }
  '10': {}"#,
        &mut budget,
    )
    .unwrap()
    .groups;
    let incoming = parse_builder_manifest(
        br#"option_groups:
  tool:
    rule: pick_any
    label: Incoming
    min: 1
    max: 3
    parts: [same.stl, next.stl]
    variants:
      - { id: a, label: A, parts: [a.stl, next.stl], excludes: [x.stl, y.stl] }
      - { id: b, label: Replaced, parts: [b2.stl] }
      - { id: c, parts: [c.stl] }
  '2': {}
  extra: {}"#,
        &mut budget,
    )
    .unwrap()
    .groups;
    merge_builder_groups(&mut target, incoming);
    assert_eq!(
        target
            .iter()
            .map(|(id, _)| id.0.as_scalar().unwrap())
            .collect::<Vec<_>>(),
        ["2", "10", "tool", "extra"]
    );
    assert_eq!(
        group_shape(&target[2].1),
        json!({
            "rule":"pick_n", "label":"Incoming", "parts":["base.stl", "same.stl", "next.stl"],
            "min":0, "max":3, "variants":[
                {"id":"a", "label":"A", "parts":["a.stl", "next.stl"], "excludes":["x.stl", "y.stl"]},
                {"id":"b", "label":"Existing", "parts":["b.stl", "b2.stl"], "excludes":[]},
                {"id":"c", "label":null, "parts":["c.stl"], "excludes":[]}
            ]
        })
    );
}

#[test]
fn builder_path_matches_node_globs_and_basename_fallback() {
    for (pattern, path, expected) in [
        ("  PART?.STL ", "Folder\\Part1.stl", true),
        ("folder/*.stl", "folder/deep/part.stl", true),
        ("folder/*.stl", "other/part.stl", false),
        ("part[1].stl", "a/part[1].stl", true),
        ("part[1].stl", "a/part1.stl", false),
        ("a+b.stl", "a+b.stl", true),
        ("\u{feff}a.stl\u{feff}", "a.stl", true),
        ("\u{85}a.stl", "a.stl", false),
        ("*.stl", "x\ny.stl", false),
        ("part?.stl", "part12.stl", false),
        ("a/b.stl", "deep/a/b.stl", false),
    ] {
        assert_eq!(
            builder_path_matches(&ManifestText::from(pattern.to_owned()), path),
            expected,
            "{pattern:?}, {path:?}"
        );
    }
}

#[test]
fn builder_hints_trim_node_strings_and_reject_unsupported_fields() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let rules = parse_builder_hints(
        br#"version: 1
rules:
  - { path: ' A/*.stl ', option_group: ' tool ', variant_id: ' a ', label: ' Label ' }
  - { path: b.stl, option_group: tool, variant_id: b }"#,
        &mut budget,
    )
    .unwrap();
    assert_eq!(
        rules
            .into_iter()
            .map(|(path, group, variant, label)| json!([
                text(&path),
                group.0.as_scalar().unwrap(),
                variant.0.as_scalar().unwrap(),
                label.as_ref().map(text)
            ]))
            .collect::<Vec<_>>(),
        vec![
            json!(["A/*.stl", "tool", "a", "Label"]),
            json!(["b.stl", "tool", "b", null])
        ]
    );
    for source in [
        "version: 2\nrules: []",
        "version: '1'\nrules: []",
        "rules: []",
        "version: 1\nrules: {}",
        "version: 1\nrules: []\nextra: true",
        "version: 1\nrules: [null]",
        "version: 1\nrules: [{path: a}]",
        "version: 1\nrules: [{path: a, option_group: g, variant_id: v, extra: 1}]",
        "version: 1\nrules: [{path: 1, option_group: g, variant_id: v}]",
        "version: 1\nrules: [{path: a, option_group: ' ', variant_id: v}]",
        "version: 1\nrules: [{path: a, option_group: g, variant_id: v, label: null}]",
    ] {
        let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        assert!(
            matches!(
                parse_builder_hints(source.as_bytes(), &mut budget),
                Err(ReadFailure::InvalidDocument)
            ),
            "{source}"
        );
    }
}

#[test]
fn builder_siblings_use_the_landed_budgeted_inference() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    let paths = ["Options/A/a.stl".into(), "Options/B/b.stl".into()];
    let groups = infer_builder_siblings(&paths, &mut budget).unwrap();
    assert_eq!(
        groups_shape(&groups),
        json!([["options", {
            "rule":"pick_one", "label":"Options", "parts":[], "min":null, "max":null,
            "variants":[
                {"id":"a", "label":"A", "parts":["Options/A/*"], "excludes":[]},
                {"id":"b", "label":"B", "parts":["Options/B/*"], "excludes":[]}
            ]
        }]])
    );
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            nodes: 2,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        infer_builder_siblings(&paths, &mut budget),
        Err(ReadFailure::LimitExceeded(Resource::Nodes))
    ));
}

#[test]
fn builder_parsing_shares_rule_budgets_and_checks_cancellation_for_blank_input() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            rules: 2,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    let manifest = parse_builder_manifest(b"parts: [a.stl]", &mut budget).unwrap();
    assert_eq!(text(&manifest.rules[0].pattern), "a.stl");
    let hints = parse_builder_hints(
        b"version: 1\nrules: [{path: b, option_group: g, variant_id: v}]",
        &mut budget,
    )
    .unwrap();
    assert_eq!(text(&hints[0].0), "b");
    assert!(matches!(
        parse_builder_manifest(b"parts: [c.stl]", &mut budget),
        Err(ReadFailure::LimitExceeded(Resource::Rules))
    ));
    let cancelled = AtomicBool::new(true);
    let mut budget = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
    assert!(matches!(
        parse_builder_manifest(b"", &mut budget),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        parse_builder_hints(b"version: 1\nrules: []", &mut budget),
        Err(ReadFailure::Cancelled)
    ));
    assert!(matches!(
        infer_builder_siblings(&[], &mut budget),
        Err(ReadFailure::Cancelled)
    ));
}

#[test]
fn builder_parsing_refuses_input_size_visits_and_alias_expansion() {
    let cancelled = AtomicBool::new(false);
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            document_bytes: 3,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        parse_builder_manifest(b"    ", &mut budget),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            visits: 0,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        parse_builder_manifest(b"{}", &mut budget),
        Err(ReadFailure::LimitExceeded(Resource::Visits))
    ));
    let source = format!("parts: [&s '{}', *s, *s, *s]", "x".repeat(100));
    let mut budget = PreparationBudget::new(
        &cancelled,
        PreparationLimits {
            total_document_bytes: 1000,
            ..PreparationLimits::default()
        },
    )
    .unwrap();
    assert!(matches!(
        parse_builder_manifest(source.as_bytes(), &mut budget),
        Err(ReadFailure::LimitExceeded(Resource::DocumentBytes))
    ));
}
