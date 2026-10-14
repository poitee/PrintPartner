#![cfg(feature = "desktop_rebuild")]

use pp_core::profile_interpreter::{ProfileDocument, ProfileInterpretation, interpret_profile};
use pp_storage::profiles::{ProfileKind, SlicerKind};
use serde_json::Value;

const CAPTURE: &str = include_str!("fixtures/profile-parser/node-capture.json");

fn document<'a>(bytes: &'a [u8], kind: ProfileKind) -> ProfileDocument<'a> {
    ProfileDocument::new(bytes, kind, SlicerKind::Orca, "<owned-fixture>").unwrap()
}

fn serialized(import: pp_storage::profiles::ProfileImport) -> String {
    serde_json::to_string(&import).unwrap()
}

fn capture_case<'a>(capture: &'a Value, group: &str, id: &str) -> &'a Value {
    capture["direct"][group]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == id)
        .unwrap()
}

#[test]
fn interpreter_matches_captured_rounding_edges() {
    let capture: Value = serde_json::from_str(CAPTURE).unwrap();
    let filaments = capture["repository"]["writerTables"]["filament"]
        .as_array()
        .unwrap();
    for (raw, name) in [
        (
            br#"{"name":"Below Half PLA","type":"filament","nozzle_temperature":0.49999999999999994}"#.as_slice(),
            "Below Half PLA",
        ),
        (
            br#"{"name":"Large Integral PLA","type":"filament","nozzle_temperature":4503599627370497}"#.as_slice(),
            "Large Integral PLA",
        ),
    ] {
        let expected = &filaments
            .iter()
            .find(|row| row["name"] == name)
            .unwrap()["nozzleTempC"];
        let import = match interpret_profile(document(raw, ProfileKind::Filament)).unwrap() {
            ProfileInterpretation::Ready(import) => import,
            ProfileInterpretation::NeedsParent(_) => panic!("no parent"),
        };
        let actual: Value = serde_json::from_str(&serialized(import)).unwrap();
        assert_eq!(
            actual["nozzle_temp_c"].as_f64().unwrap(),
            expected.as_f64().unwrap(),
            "profile {name}"
        );
    }
}

#[test]
fn interpreter_matches_captured_parent_merge_and_own_projection() {
    let child = br#"{"name":"Child \uD800","inherits":"UnicodeParent","type":"process","shared":"child","config\uD800":"value\uDC00","compatible_printers":["Machine \uD800","Ignored"]}"#;
    let pending = match interpret_profile(document(child, ProfileKind::Process)).unwrap() {
        ProfileInterpretation::NeedsParent(pending) => pending,
        ProfileInterpretation::Ready(_) => panic!("child must request exactly one parent"),
    };
    assert_eq!(
        pending.request().file_stem().to_string_lossy(),
        "UnicodeParent"
    );
    let actual = serialized(
        pending
            .finish_with_parent(
                br#"{"name":"Parent \uD800","parent\uD800":"value\uDC00","shared":"parent"}"#,
            )
            .unwrap(),
    );
    let captured: Value = serde_json::from_str(CAPTURE).unwrap();
    let expected = captured["repository"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| {
            row["sourcePath"]
                .as_str()
                .is_some_and(|path| path.ends_with("UnicodeChild.json"))
        })
        .unwrap()["resolvedFlatConfig"]
        .as_str()
        .unwrap();
    let expected_json_string = serde_json::to_string(expected).unwrap();
    assert!(actual.contains(&format!("\"resolved_flat_config\":{expected_json_string}")));
    assert!(actual.contains(r#""compatible_printers":"Machine \ud800""#));
}

#[test]
fn interpreter_matches_captured_numeric_object_and_surrogate_profile() {
    let capture: Value = serde_json::from_str(CAPTURE).unwrap();
    let numeric = capture_case(&capture, "json", "numeric-edges");
    let import = match interpret_profile(document(
        numeric["raw"].as_str().unwrap().as_bytes(),
        ProfileKind::Process,
    ))
    .unwrap()
    {
        ProfileInterpretation::Ready(import) => import,
        ProfileInterpretation::NeedsParent(_) => panic!("numeric object has no parent"),
    };
    let actual: Value = serde_json::from_str(&serialized(import)).unwrap();
    assert_eq!(
        actual["provenance"]["resolved_flat_config"]
            .as_str()
            .unwrap(),
        numeric["result"]["json"].as_str().unwrap()
    );

    let surrogate = capture_case(&capture, "json", "surrogate-fields");
    let pending = match interpret_profile(document(
        surrogate["raw"].as_str().unwrap().as_bytes(),
        ProfileKind::Process,
    ))
    .unwrap()
    {
        ProfileInterpretation::NeedsParent(pending) => pending,
        ProfileInterpretation::Ready(_) => panic!("captured inherits must request a parent"),
    };
    assert_eq!(
        pending.request().file_stem().as_utf16(),
        [80, 97, 114, 101, 110, 116, 0xd800]
    );
    let actual = serialized(pending.finish_without_parent().unwrap());
    let expected = surrogate["result"]["json"].as_str().unwrap();
    assert!(actual.contains(&format!(
        "\"resolved_flat_config\":{}",
        serde_json::to_string(expected).unwrap()
    )));
    assert!(actual.starts_with(r#"{"kind":"process"#));
}

#[test]
fn duplicate_json_key_uses_only_the_final_node_value() {
    let capture: Value = serde_json::from_str(CAPTURE).unwrap();
    let duplicate = capture_case(&capture, "json", "duplicate-to-null");
    let import = match interpret_profile(document(
        duplicate["raw"].as_str().unwrap().as_bytes(),
        ProfileKind::Process,
    ))
    .unwrap()
    {
        ProfileInterpretation::Ready(import) => import,
        ProfileInterpretation::NeedsParent(_) => panic!("no parent"),
    };
    let actual: Value = serde_json::from_str(&serialized(import)).unwrap();
    assert_eq!(
        actual["provenance"]["resolved_flat_config"]
            .as_str()
            .unwrap(),
        duplicate["result"]["json"].as_str().unwrap()
    );
}

#[test]
fn interpreter_matches_captured_node_utf8_replacement() {
    let capture: Value = serde_json::from_str(CAPTURE).unwrap();
    let cases: [(&str, &[u8]); 3] = [
        (
            "Utf8Ff.json",
            &[
                0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
            ],
        ),
        (
            "Utf8Overlong.json",
            &[
                0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d,
            ],
        ),
        (
            "Utf8Continuation.json",
            &[
                0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xe2, 0x28, 0xa1, 0x22, 0x7d,
            ],
        ),
    ];
    for (filename, bytes) in cases {
        let expected = capture["repository"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["sourcePath"].as_str().unwrap().ends_with(filename))
            .unwrap();
        let import = match interpret_profile(document(bytes, ProfileKind::Process)).unwrap() {
            ProfileInterpretation::Ready(import) => import,
            ProfileInterpretation::NeedsParent(_) => panic!("no parent"),
        };
        let actual: Value = serde_json::from_str(&serialized(import)).unwrap();
        assert_eq!(
            actual["provenance"]["name"].as_str().unwrap(),
            expected["name"].as_str().unwrap()
        );
        assert_eq!(
            actual["provenance"]["resolved_flat_config"]
                .as_str()
                .unwrap(),
            expected["resolvedFlatConfig"].as_str().unwrap()
        );
    }
}
