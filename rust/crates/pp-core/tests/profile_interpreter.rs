use pp_core::profile_interpreter::{
    ProfileDocument, ProfileInterpretError, ProfileInterpretation, interpret_profile,
};
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
fn node_capture_has_expected_schema_and_exercises_real_watcher_and_route() {
    let capture: Value = serde_json::from_str(CAPTURE).unwrap();
    assert_eq!(capture["schema"], "printpartner.profile-parser-capture.v2");
    assert_eq!(capture["route"]["status"], 200);
    assert_eq!(capture["repository"]["rows"].as_array().unwrap().len(), 14);
    assert_eq!(capture["runtime"]["locale"], "en-US");

    let direct = capture["direct"]["json"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "surrogate-fields")
        .unwrap();
    assert_eq!(
        direct["result"]["json"],
        r#"{"name":"\ud800","low":"\udc00","pair":"😀","key\ud800":"value\udc00","type":"pro\ud800cess","inherits":"Parent\ud800","config":"x\ud800"}"#
    );

    let child = capture["repository"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| {
            row["sourcePath"]
                .as_str()
                .unwrap()
                .ends_with("UnicodeChild.json")
        })
        .unwrap();
    assert_eq!(child["name"], "Child �");
    assert!(
        child["resolvedFlatConfig"]
            .as_str()
            .unwrap()
            .contains(r#""name":"Child \ud800""#)
    );
    assert!(
        capture["route"]["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| {
                row.as_object().unwrap().len() == 8
                    && row.get("sourcePath").is_none()
                    && row.get("resolvedFlatConfig").is_none()
            })
    );
    let printer = &capture["repository"]["writerTables"]["printer"][0];
    assert_eq!(printer["nozzleDiameterMm"], "1e+21");
    assert_eq!(printer["extruderCount"], 9_007_199_254_740_992_f64);
    assert!(printer["rawIni"].is_null());
    let huge = capture["repository"]["writerTables"]["filament"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "Huge PLA")
        .unwrap();
    assert_eq!(huge["nozzleTempC"], 1e308);
    assert_eq!(huge["materialTier"], 1);
    let filaments = capture["repository"]["writerTables"]["filament"]
        .as_array()
        .unwrap();
    assert_eq!(
        filaments
            .iter()
            .find(|row| row["name"] == "Below Half PLA")
            .unwrap()["nozzleTempC"],
        0
    );
    assert_eq!(
        filaments
            .iter()
            .find(|row| row["name"] == "Large Integral PLA")
            .unwrap()["nozzleTempC"],
        4_503_599_627_370_497_f64
    );
    for (id, expected) in [
        ("ini-version-tabs", Some("2.8.1")),
        ("ini-version-line-breaks", Some("2.3.2")),
        ("ini-version-unicode-whitespace", Some("1.9")),
        ("ini-version-attached", None),
        ("ini-version-later-valid", Some("2.4.0")),
    ] {
        let result: Value = serde_json::from_str(
            capture_case(&capture, "profile", id)["result"]["json"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["version"].as_str(), expected, "capture case {id}");
    }
    assert_eq!(capture["measurements"]["fixtureCount"], 14);
    assert_eq!(
        capture["measurements"]["representativeProducerSamples"],
        serde_json::json!([
            "numeric-printer",
            "bambu-producer-sample",
            "prusa-producer-sample"
        ])
    );
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
            actual["nozzle_temp_c"].as_f64(),
            expected.as_f64(),
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
fn interpreter_preserves_lone_surrogates_in_values_keys_and_resolved_json() {
    let child = br#"{"name":"Child \uD800","inherits":"UnicodeParent","type":"process","config\uD800":"value\uDC00","compatible_printers":["Machine \uD800","Ignored"]}"#;
    let pending = match interpret_profile(document(child, ProfileKind::Process)).unwrap() {
        ProfileInterpretation::NeedsParent(pending) => pending,
        ProfileInterpretation::Ready(_) => panic!("child must request a parent"),
    };
    assert_eq!(
        pending.request().file_stem().as_utf16(),
        "UnicodeParent".encode_utf16().collect::<Vec<_>>()
    );
    let actual = serialized(
        pending
            .finish_with_parent(br#"{"name":"Parent \uD800","parent\uD800":"value\uDC00"}"#)
            .unwrap(),
    );
    assert!(actual.contains(r#""name":"Child \ud800""#));
    assert!(actual.contains(r#""compatible_printers":"Machine \ud800""#));
    assert!(
        actual.contains(r#"\"parent\\ud800\":\"value\\udc00\""#),
        "{actual}"
    );
    assert!(
        actual.contains(r#"\"config\\ud800\":\"value\\udc00\""#),
        "{actual}"
    );
    assert!(!actual.contains('�'));
}

#[test]
fn parent_top_level_string_spreads_utf16_units_like_node() {
    let pending = match interpret_profile(document(
        br#"{"name":"Child","inherits":"Parent"}"#,
        ProfileKind::Process,
    ))
    .unwrap()
    {
        ProfileInterpretation::NeedsParent(pending) => pending,
        ProfileInterpretation::Ready(_) => panic!("child must request a parent"),
    };
    let actual = serialized(pending.finish_with_parent(br#""\uD83D\uDE00""#).unwrap());
    assert!(
        actual.contains(r#"{\"0\":\"\\ud83d\",\"1\":\"\\ude00\""#),
        "{actual}"
    );
}

#[test]
fn json_number_overflow_matches_javascript_stringification() {
    let import = match interpret_profile(document(
        br#"{"name":"Overflow","compatible_printers":1e400}"#,
        ProfileKind::Process,
    ))
    .unwrap()
    {
        ProfileInterpretation::Ready(import) => import,
        ProfileInterpretation::NeedsParent(_) => panic!("no parent"),
    };
    let actual = serialized(import);
    assert!(actual.contains(r#""compatible_printers":"Infinity""#));
    assert!(actual.contains(r#"\"compatible_printers\":\"Infinity\""#));
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
        actual["provenance"]["resolved_flat_config"],
        numeric["result"]["json"]
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
        actual["provenance"]["resolved_flat_config"],
        duplicate["result"]["json"]
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
        assert_eq!(actual["provenance"]["name"], expected["name"]);
        assert_eq!(
            actual["provenance"]["resolved_flat_config"],
            expected["resolvedFlatConfig"]
        );
    }
}

#[test]
fn interpreter_keeps_node_numeric_and_material_rules() {
    let raw = br#"{"name":"Fancy PLA","type":"filament","nozzle_temperature":-0.5,"bed_temperature":60.5,"fan_pct":-1.5,"filament_flow_ratio":"0.98"}"#;
    let import = match interpret_profile(document(raw, ProfileKind::Process)).unwrap() {
        ProfileInterpretation::Ready(import) => import,
        ProfileInterpretation::NeedsParent(_) => panic!("no parent"),
    };
    let actual = serialized(import);
    assert!(actual.contains("\"material_type\":\"PLA\""));
    assert!(actual.contains("\"nozzle_temp_c\":0.0"));
    assert!(actual.contains("\"bed_temp_c\":61.0"));
    assert!(actual.contains("\"fan_pct\":-1.0"));
}

#[test]
fn invalid_own_json_is_a_typed_error_but_invalid_parent_falls_back_to_child() {
    assert_eq!(
        interpret_profile(document(b"{not json", ProfileKind::Process)).unwrap_err(),
        ProfileInterpretError::InvalidJson
    );
    let pending = match interpret_profile(document(
        br#"{"name":"Child","inherits":"Parent"}"#,
        ProfileKind::Process,
    ))
    .unwrap()
    {
        ProfileInterpretation::NeedsParent(pending) => pending,
        ProfileInterpretation::Ready(_) => panic!("parent expected"),
    };
    let actual = serialized(pending.finish_with_parent(b"not json").unwrap());
    assert!(actual.contains("\"name\":\"Child\""));
}

#[test]
fn negative_controls_reject_lexical_sort_and_rust_half_rounding() {
    let capture: Value = serde_json::from_str(CAPTURE).unwrap();
    let node_order = capture["collation"].as_array().unwrap();
    let node_e = node_order.iter().position(|name| name == "é").unwrap();
    let node_z = node_order.iter().position(|name| name == "z").unwrap();
    assert!(node_e < node_z);
    assert!(
        "é" > "z",
        "a UTF-8 lexical comparator disagrees with the Node capture"
    );
    assert_eq!(
        (-0.5_f64).round(),
        -1.0,
        "Rust round is the wrong half rule"
    );
}
