use super::super::observation::builder_path_matches;
use crate::manifest_text::{JsText, ManifestText};
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
        let actual = builder_path_matches(&pattern, &key);
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
#[ignore = "run in an exclusive landing slot for timing"]
fn builder_glob_backtracking_probe() {
    let key = "a".repeat(30);
    for k in [8, 10, 12, 64] {
        let pattern = ManifestText::from(format!("{}*b", "*a".repeat(k)));
        let mut timings = Vec::new();
        for _ in 0..5 {
            let start = Instant::now();
            assert!(!black_box(builder_path_matches(
                black_box(&pattern),
                black_box(&key)
            )));
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
    assert!(!builder_path_matches(&pattern, &"a".repeat(30)));
    assert!(start.elapsed() < Duration::from_secs(2));
}
