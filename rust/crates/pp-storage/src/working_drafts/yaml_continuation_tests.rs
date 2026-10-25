#![cfg(test)]

use super::observation::{PreparationBudget, PreparationLimits, ReadFailure};
use super::yaml::{Document, Node};
use serde_json::Value;
use std::sync::atomic::AtomicBool;

fn json(doc: &Document, id: usize, budget: &mut PreparationBudget<'_>) -> Value {
    let text = |s: &crate::manifest_text::JsText| String::from_utf16(s.units()).unwrap();
    match doc.node(id, budget).unwrap() {
        Node::Null => Value::Null,
        Node::Bool(b) => (*b).into(),
        Node::Number(n) if n.fract() == 0.0 && n.abs() < 9e15 => (*n as i64).into(),
        Node::Number(n) => (*n).into(),
        Node::String(s) => text(s).into(),
        Node::Sequence(items) => items.iter().map(|id| json(doc, *id, budget)).collect(),
        Node::Mapping(entries) => entries
            .iter()
            .map(|(key, id)| (text(key), json(doc, *id, budget)))
            .collect(),
        Node::Alias(_) => unreachable!("node resolves aliases"),
    }
}

#[test]
fn yaml_quoted_continuations_match_js_yaml() {
    let corpus = include_str!("../../tests/fixtures/yaml-quoted-continuations-node.jsonl");
    let cancel = AtomicBool::new(false);
    let mut mismatches = Vec::new();
    for row in corpus.lines() {
        let (block, prefix, suffix, cases): (String, String, String, Vec<Vec<Value>>) =
            serde_json::from_str(row).unwrap();
        for case in cases {
            let source = format!("{prefix}{}{suffix}", case[0].as_str().unwrap());
            let expected = Some(&case[1]).filter(|value| !value.is_null());
            let parked = case.get(2).and_then(Value::as_str);
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let actual = match Document::parse(source.as_bytes(), &mut budget) {
                Ok(doc) => Some(json(&doc, doc.root, &mut budget)),
                Err(ReadFailure::InvalidDocument) => None,
                Err(err) => panic!("{block}: {source:?}: {err:?}"),
            };
            // A parked accept may still be refused, but never read as a different value.
            if actual.as_ref() != expected && !(parked.is_some() && actual.is_none()) {
                mismatches.push(format!("{block}: {source:?} gave {actual:?}"));
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
