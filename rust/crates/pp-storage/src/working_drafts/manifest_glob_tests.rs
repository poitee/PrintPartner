use super::super::observation::BuilderGlob;
use super::{
    Glob, canonicalize_regex_unit, dot_matches, find_masked, find_short_masked, fits,
    wildcard_matches,
};
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

/// `^pattern$` with `*` as `.*` and `?` as `.`, by dynamic programming.
fn regex_matches(pattern: &[u16], key: &[u16]) -> bool {
    let mut row = vec![false; key.len() + 1];
    row[key.len()] = true;
    for unit in pattern.iter().rev() {
        let mut next = vec![false; key.len() + 1];
        for at in (0..=key.len()).rev() {
            let consumed = at < key.len()
                && if *unit == 0x2a || *unit == 0x3f {
                    dot_matches(key[at])
                } else {
                    *unit == key[at]
                };
            next[at] = if *unit == 0x2a {
                row[at] || (consumed && next[at + 1])
            } else {
                consumed && row[at + 1]
            };
        }
        row = next;
    }
    row[0]
}

/// Accept count and FNV-1a digest that `manifest-segments-node.mjs` records
/// for Node's `matchKeyMatches` over the same generated pairs.
fn node_outcomes(generator: &str) -> (usize, u32) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/manifest-segments-node.json"
    ))
    .unwrap();
    let row = &fixture[generator];
    (
        row["accepted"].as_u64().unwrap() as usize,
        row["digest"].as_u64().unwrap() as u32,
    )
}

fn strings(alphabet: &[u16], max_len: u32) -> Vec<Vec<u16>> {
    let mut all = vec![Vec::new()];
    let mut layer = vec![Vec::new()];
    for _ in 0..max_len {
        layer = layer
            .iter()
            .flat_map(|prefix| {
                alphabet.iter().map(move |unit| {
                    let mut next: Vec<u16> = prefix.clone();
                    next.push(*unit);
                    next
                })
            })
            .collect();
        all.extend(layer.iter().cloned());
    }
    all
}

#[test]
fn segment_search_matches_regex_semantics_exhaustively() {
    let patterns = strings(&[0x61, 0x62, 0x0a, 0x3f, 0x2a], 5);
    let keys = strings(&[0x61, 0x62, 0x0a], 6);
    let (mut accepted, mut digest) = (0, 0x811c_9dc5_u32);
    for pattern in &patterns {
        for key in &keys {
            let expected = regex_matches(pattern, key);
            assert_eq!(
                wildcard_matches(pattern, key, &mut 0),
                expected,
                "{pattern:x?}, {key:x?}"
            );
            accepted += usize::from(expected);
            digest = (digest ^ u32::from(expected)).wrapping_mul(0x0100_0193);
        }
    }
    assert_eq!((patterns.len(), keys.len()), (3906, 1093));
    assert_eq!((accepted, digest), node_outcomes("exhaustive"));
}

#[test]
fn segment_search_matches_regex_semantics_on_long_keys() {
    let mut seed = 748_u32;
    let mut next = |bound: usize| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as usize % bound
    };
    let units = [
        0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x62, 0x62, 0x62, 0x62, 0x62, 0x2028,
    ];
    let (mut accepted, mut digest) = (0, 0x811c_9dc5_u32);
    for case in 0..4000 {
        let key: Vec<u16> = (0..case % 400).map(|_| units[next(units.len())]).collect();
        // Derive the pattern from the key so about half the cases match.
        let mut pattern = Vec::new();
        let mut at = 0;
        while at < key.len() {
            // Every other pair of cases spaces stars far enough apart that
            // segments outgrow Shift-And and take the NTT search.
            match next(if case % 4 < 2 { 16 } else { 256 }) {
                _ if !dot_matches(key[at]) => {
                    pattern.push(key[at]);
                    at += 1;
                }
                0 => {
                    pattern.push(0x2a);
                    let stop = (at + next(24)).min(key.len());
                    while at < stop && dot_matches(key[at]) {
                        at += 1;
                    }
                }
                1..=3 => {
                    pattern.push(0x3f);
                    at += 1;
                }
                _ => {
                    pattern.push(key[at]);
                    at += 1;
                }
            }
        }
        if case % 2 == 1 && !pattern.is_empty() {
            let at = next(pattern.len());
            pattern[at] = units[next(units.len())];
        }
        let expected = regex_matches(&pattern, &key);
        assert_eq!(
            wildcard_matches(&pattern, &key, &mut 0),
            expected,
            "case {case}: {pattern:x?}, {key:x?}"
        );
        accepted += usize::from(expected);
        digest = (digest ^ u32::from(expected)).wrapping_mul(0x0100_0193);
    }
    assert_eq!((accepted, digest), node_outcomes("longKeys"));
}

#[test]
fn long_masked_segments_match_node() {
    let mut seed = 1748_u32;
    let mut next = |bound: usize| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as usize % bound
    };
    let (mut accepted, mut digest) = (0, 0x811c_9dc5_u32);
    for case in 0..1000 {
        let mut key: Vec<u16> = (0..130 + next(400))
            .map(|_| [0x61, 0x61, 0x61, 0x62][next(4)])
            .collect();
        let from = next(key.len() - 129);
        let len = 65 + next(key.len() - from - 64);
        for _ in 0..next(4) {
            key[from + next(len)] = 0x2028;
        }
        let mut segment = key[from..from + len].to_vec();
        for _ in 0..1 + next(len) {
            let at = next(len);
            if dot_matches(segment[at]) {
                segment[at] = 0x3f;
            }
        }
        if case % 4 == 1 {
            let at = next(len);
            segment[at] = [0x61, 0x62][next(2)];
        }
        if case % 4 == 2
            && let Some(at) = segment.iter().position(|unit| *unit == 0x2028)
        {
            segment[at] = 0x3f;
        }
        if case % 4 == 3 {
            let at = next(key.len());
            key[at] = 0x2028;
        }
        if !segment.contains(&0x3f) {
            let at = segment.iter().position(|unit| dot_matches(*unit)).unwrap();
            segment[at] = 0x3f;
        }
        let pattern = [&[0x2a][..], &segment, &[0x2a]].concat();
        let expected = regex_matches(&pattern, &key);
        assert_eq!(
            wildcard_matches(&pattern, &key, &mut 0),
            expected,
            "case {case}: {pattern:x?}, {key:x?}"
        );
        accepted += usize::from(expected);
        digest = (digest ^ u32::from(expected)).wrapping_mul(0x0100_0193);
    }
    assert_eq!((accepted, digest), node_outcomes("longMasked"));
}

#[test]
fn masked_searches_find_the_leftmost_start() {
    let leftmost = |needle: &[u16], haystack: &[u16]| {
        (0..=haystack.len().checked_sub(needle.len())?)
            .find(|start| fits(needle, &haystack[*start..start + needle.len()], &mut 0))
    };
    let needles: Vec<_> = strings(&[0x61, 0x62, 0x0a, 0x3f], 4)
        .into_iter()
        .filter(|needle| needle.contains(&0x3f))
        .collect();
    let haystacks = strings(&[0x61, 0x62, 0x0a], 6);
    let mut found = 0;
    for needle in &needles {
        for haystack in &haystacks {
            let expected = leftmost(needle, haystack);
            let short = find_short_masked(needle, haystack, &mut 0);
            let long = find_masked(needle, haystack, &mut 0);
            assert_eq!(
                (short, long),
                (expected, expected),
                "{needle:x?}, {haystack:x?}"
            );
            found += usize::from(expected.is_some());
        }
    }
    assert_eq!((needles.len(), haystacks.len(), found), (220, 1093, 35222));
    let mut seed = 870_u32;
    let mut next = |bound: usize| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as usize % bound
    };
    let mut found = 0;
    for case in 0..200 {
        let haystack: Vec<u16> = (0..130 + next(400))
            .map(|_| [0x61, 0x61, 0x61, 0x62, 0x2028][next(5)])
            .collect();
        let start = next(haystack.len() - 129);
        let mut needle = haystack[start..start + 65 + next(haystack.len() - start - 64)].to_vec();
        // Even cases mask units so the copied window still matches; odd cases
        // also change one literal, which usually moves or removes the match.
        for _ in 0..1 + next(needle.len()) {
            let at = next(needle.len());
            if dot_matches(needle[at]) {
                needle[at] = 0x3f;
            }
        }
        if case % 2 == 1 {
            let at = next(needle.len());
            needle[at] = [0x61, 0x62][next(2)];
        }
        if !needle.contains(&0x3f) {
            let at = needle.iter().position(|unit| dot_matches(*unit)).unwrap();
            needle[at] = 0x3f;
        }
        let expected = leftmost(&needle, &haystack);
        assert!(needle.len() > 64);
        assert_eq!(
            find_masked(&needle, &haystack, &mut 0),
            expected,
            "case {case}"
        );
        found += usize::from(expected.is_some());
    }
    assert_eq!(found, 134);
}

#[test]
fn matcher_steps_grow_linearly_for_literal_and_quasilinearly_for_masked_segments() {
    let steps = |pattern: String, key: String| {
        let (matched, work) = Glob::new(&ManifestText::from(pattern)).counted_matches(&key);
        assert!(!matched);
        work
    };
    for (name, family, bound) in [
        (
            "ticket",
            (|n: usize| (format!("*{}b", "a".repeat(n / 2)), "a".repeat(n)))
                as fn(usize) -> (String, String),
            2.1,
        ),
        (
            "literal",
            |n: usize| (format!("*{}b*", "a".repeat(n / 2)), "a".repeat(n)),
            2.1,
        ),
        (
            "short-masked",
            |n: usize| (format!("*{}b*", "a?".repeat(31)), "a".repeat(n)),
            2.1,
        ),
        (
            "masked",
            |n: usize| (format!("*{}b*", "a?".repeat(n / 4)), "a".repeat(n)),
            2.3,
        ),
        (
            "many-masked",
            |n: usize| (format!("*{}b*", "a?*".repeat(n / 8)), "a".repeat(n)),
            2.3,
        ),
    ] {
        let counts: Vec<_> = [2048, 4096, 8192]
            .map(|n| {
                let (pattern, key) = family(n);
                steps(pattern, key)
            })
            .to_vec();
        for pair in counts.windows(2) {
            let ratio = pair[1] as f64 / pair[0] as f64;
            assert!(ratio < bound, "{name}: {counts:?} doubles by {ratio:.2}");
        }
        eprintln!("{name}: steps {counts:?} for n = 2048, 4096, 8192");
    }
}
