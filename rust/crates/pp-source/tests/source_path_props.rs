#[path = "support/source_path.rs"]
mod source_path;

use pp_source::{MANIFEST, SourcePath};
use proptest::prelude::*;
use serde::Deserialize;
use source_path::{
    MAX_COMPONENTS, MAX_PATH_BYTES, any_path, reference_accepts, rust_accepts, valid_path,
};

#[derive(Deserialize)]
struct Case {
    path: String,
    accept: bool,
}

fn fixture_cases() -> Vec<Case> {
    serde_json::from_str(include_str!("fixtures/source-path-cases.json")).unwrap()
}

#[test]
fn fixture_cases_match_expected_decisions() {
    let cases = fixture_cases();
    assert!(cases.len() >= 40);
    for case in cases {
        assert_eq!(rust_accepts(&case.path), case.accept, "{:?}", case.path);
        assert_eq!(
            reference_accepts(&case.path),
            case.accept,
            "{:?}",
            case.path
        );
    }
}

#[test]
fn length_and_component_bounds_are_inclusive() {
    assert!(rust_accepts(&"a".repeat(MAX_PATH_BYTES)));
    assert!(!rust_accepts(&"a".repeat(MAX_PATH_BYTES + 1)));
    // 4096 bytes is a UTF-8 byte bound, not a character bound.
    assert!(rust_accepts(&"\u{ac00}".repeat(MAX_PATH_BYTES / 3)));
    assert!(!rust_accepts(&"\u{ac00}".repeat(MAX_PATH_BYTES / 3 + 1)));
    assert!(rust_accepts(&vec!["a"; MAX_COMPONENTS].join("/")));
    assert!(!rust_accepts(&vec!["a"; MAX_COMPONENTS + 1].join("/")));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    #[test]
    fn decision_matches_reference_model(path in any_path()) {
        prop_assert_eq!(rust_accepts(&path), reference_accepts(&path));
    }

    #[test]
    fn valid_paths_round_trip(path in valid_path()) {
        let parsed = SourcePath::try_from(path.clone()).unwrap();
        prop_assert_eq!(parsed.as_str(), path.as_str());
        let json = serde_json::to_string(&parsed).unwrap();
        prop_assert_eq!(&json, &serde_json::to_string(&path).unwrap());
        prop_assert_eq!(serde_json::from_str::<SourcePath>(&json).unwrap(), parsed.clone());
        prop_assert_eq!(String::from(parsed), path);
    }

    #[test]
    fn deserialize_agrees_with_try_from(path in any_path()) {
        let json = serde_json::to_string(&path).unwrap();
        prop_assert_eq!(serde_json::from_str::<SourcePath>(&json).is_ok(), rust_accepts(&path));
    }

    #[test]
    fn forbidden_character_anywhere_rejects(
        path in valid_path(),
        forbidden in prop::sample::select(&['\\', '\0', ':'][..]),
        index in any::<prop::sample::Index>(),
    ) {
        let boundaries: Vec<usize> = path.char_indices().map(|(i, _)| i).chain([path.len()]).collect();
        let mut mutated = path;
        mutated.insert(*index.get(&boundaries), forbidden);
        prop_assert!(!rust_accepts(&mutated), "{:?}", mutated);
    }

    #[test]
    fn structural_mutations_reject(
        path in valid_path(),
        mutation in 0..6usize,
        index in any::<prop::sample::Index>(),
    ) {
        let mut segments: Vec<String> = path.split('/').map(str::to_owned).collect();
        let at = index.index(segments.len() + 1);
        match mutation {
            0 => segments.insert(at, String::new()),
            1 => segments.insert(at, ".".into()),
            2 => segments.insert(at, "..".into()),
            3 => segments.insert(0, MANIFEST.into()),
            4 => segments[0].insert(0, '/'),
            _ => segments.push(String::new()),
        }
        let mutated = segments.join("/");
        prop_assert!(!rust_accepts(&mutated), "{:?}", mutated);
    }

    #[test]
    fn decomposed_text_rejects(path in valid_path(), index in any::<prop::sample::Index>()) {
        let boundaries: Vec<usize> = path.char_indices().map(|(i, _)| i).chain([path.len()]).collect();
        let mut mutated = path;
        // U+0065 U+0301 composes to U+00E9 under NFC.
        mutated.insert_str(*index.get(&boundaries), "e\u{301}");
        prop_assert!(!rust_accepts(&mutated), "{:?}", mutated);
    }

    #[test]
    fn manifest_name_is_reserved_only_as_first_segment(path in valid_path()) {
        let first = format!("{MANIFEST}/{path}");
        let nested = format!("{path}/{MANIFEST}");
        prop_assert!(!rust_accepts(&first));
        prop_assert!(rust_accepts(&nested));
    }
}
