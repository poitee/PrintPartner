use super::super::observation::BuilderGlob;
use super::canonicalize_regex_unit;
use crate::manifest_text::{JsText, ManifestText};
use serde_json::Value;
use std::collections::BTreeMap;
use std::hint::black_box;
use std::time::{Duration, Instant};

#[test]
fn builder_globs_match_node_differential_corpus() {
    let corpus = include_str!("../../tests/fixtures/manifest-globs-node.jsonl");
    let mut mismatches = Vec::new();
    for (index, row) in corpus.lines().enumerate() {
        let (name, units, key, expected): (String, Vec<u16>, String, bool) =
            serde_json::from_str(row).unwrap();
        let pattern = ManifestText(JsText::from_units(units));
        let actual = BuilderGlob::new(&pattern).matches(&key);
        if actual != expected {
            mismatches.push(format!(
                "row {index} ({name}): {:?}, {key:?}: expected {expected}, got {actual}",
                pattern.units()
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn builder_glob_case_mappings_match_node_tables() {
    let mut tables = BTreeMap::<_, BTreeMap<u32, Value>>::new();
    for row in include_str!("../../tests/fixtures/manifest-case-node.jsonl").lines() {
        let (block, entries): (String, Vec<_>) = serde_json::from_str(row).unwrap();
        let (kind, _) = block.split_once(' ').unwrap();
        tables.entry(kind.to_owned()).or_default().extend(entries);
    }
    // A non-unicode /i RegExp matches two units when they canonicalize equally;
    // Node pins each unit to the smallest unit in its class.
    let mut smallest = BTreeMap::new();
    for unit in 0..=u16::MAX {
        smallest
            .entry(canonicalize_regex_unit(unit))
            .or_insert(unit);
    }
    let mut mismatches = Vec::new();
    for unit in 0..=u16::MAX {
        let expected = tables["ignore-case"]
            .get(&u32::from(unit))
            .map_or(unit, |value| {
                u16::try_from(value.as_u64().unwrap()).unwrap()
            });
        let actual = smallest[&canonicalize_regex_unit(unit)];
        if actual != expected {
            mismatches.push(format!(
                "/i {unit:#06x}: Node {expected:#06x}, Rust {actual:#06x}"
            ));
        }
    }
    for scalar in (0..=0x10_ffff).filter_map(char::from_u32) {
        let expected: Vec<u16> = tables["lowercase"].get(&u32::from(scalar)).map_or_else(
            || scalar.encode_utf16(&mut [0; 2]).to_vec(),
            |value| serde_json::from_value(value.clone()).unwrap(),
        );
        let actual: Vec<u16> = scalar
            .to_lowercase()
            .collect::<String>()
            .encode_utf16()
            .collect();
        if actual != expected {
            mismatches.push(format!(
                "toLowerCase {:#x}: Node {expected:x?}, Rust {actual:x?}",
                u32::from(scalar)
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
#[ignore = "run in an exclusive landing slot for timing"]
fn builder_glob_backtracking_probe() {
    let key = "a".repeat(30);
    for k in [8, 10, 12, 64] {
        let pattern = ManifestText::from(format!("{}*b", "*a".repeat(k)));
        let mut timings = Vec::new();
        for _ in 0..5 {
            let start = Instant::now();
            assert!(!black_box(
                BuilderGlob::new(black_box(&pattern)).matches(black_box(&key))
            ));
            timings.push(start.elapsed());
        }
        timings.sort();
        eprintln!(
            "k={k}, median={:?}, range={:?}..={:?}, 5 correct non-matches",
            timings[2], timings[0], timings[4]
        );
        let bound = if cfg!(debug_assertions) {
            Duration::from_secs(2)
        } else {
            Duration::from_millis(10)
        };
        assert!(timings[4] < bound, "k={k}: {:?} >= {bound:?}", timings[4]);
    }
}

#[test]
fn builder_glob_rejects_adversarial_stars_within_debug_bound() {
    let pattern = ManifestText::from(format!("{}*b", "*a".repeat(64)));
    let start = Instant::now();
    assert!(!BuilderGlob::new(&pattern).matches(&"a".repeat(30)));
    assert!(start.elapsed() < Duration::from_secs(2));
}
