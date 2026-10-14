#![cfg(feature = "desktop_rebuild")]

use pp_core::profile_interpreter::{
    PendingProfile, ProfileDocument, ProfileInterpretError, ProfileInterpretation,
    interpret_profile,
};
use pp_storage::profiles::{ProfileImport, ProfileKind, SlicerKind};
use serde_json::Value;

fn document(bytes: &[u8], kind: ProfileKind) -> ProfileDocument<'_> {
    ProfileDocument::new(bytes, kind, SlicerKind::Orca, "<owned-fixture>").unwrap()
}

fn serialized(import: ProfileImport) -> String {
    serde_json::to_string(&import).unwrap()
}

fn ready(bytes: &[u8], kind: ProfileKind) -> Value {
    let ProfileInterpretation::Ready(import) = interpret_profile(document(bytes, kind)).unwrap()
    else {
        panic!("expected a ready import");
    };
    serde_json::from_str(&serialized(import)).unwrap()
}

fn pending(bytes: &[u8], kind: ProfileKind) -> PendingProfile {
    let ProfileInterpretation::NeedsParent(pending) =
        interpret_profile(document(bytes, kind)).unwrap()
    else {
        panic!("expected one parent request");
    };
    pending
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
fn json_and_ini_flattening_use_child_metadata_and_first_scalars() {
    let json = ready(
        br#"{"name":"","print_settings_id":"Fallback","type":"print","version":2,"compatible_printers":[{"value":["Machine","Ignored"]}],"enabled":true,"empty":[],"null":null,"unknown":{"other":1},"__proto__":"ignored"}"#,
        ProfileKind::Printer,
    );
    assert_eq!(json["kind"], "process");
    assert_eq!(json["provenance"]["name"], "Fallback");
    assert_eq!(json["provenance"]["slicer_version"], "2");
    assert_eq!(json["compatible_printers"], "Machine");
    assert_eq!(json["provenance"]["source_path"], "<owned-fixture>");
    assert_eq!(
        json["provenance"]["resolved_flat_config"],
        r#"{"name":"","print_settings_id":"Fallback","type":"print","version":"2","compatible_printers":"Machine","enabled":"true"}"#
    );
    let raw = "\u{feff}; generated by\tPrusaSlicer\t2.8.1\n# ignored=yes\n name = PLA\n temperature = 210.5 C\n bed_temperature = 60.5\n fan_always_on = 1\n key = a=b\n =ignored\nnot a setting\n";
    let ini = ready(raw.as_bytes(), ProfileKind::Filament);
    assert_eq!(ini["provenance"]["slicer_version"], "2.8.1");
    assert_eq!(ini["provenance"]["name"], "PLA");
    assert_eq!(ini["nozzle_temp_c"], 211.0);
    assert_eq!(ini["bed_temp_c"], 61.0);
    assert_eq!(ini["fan_pct"], 100.0);
    assert_eq!(ini["raw"], serde_json::json!({"format":"ini","value":raw}));
    assert_eq!(
        ini["provenance"]["resolved_flat_config"],
        r#"{"name":"PLA","temperature":"210.5 C","bed_temperature":"60.5","fan_always_on":"1","key":"a=b"}"#
    );
}

#[test]
fn one_parent_merges_config_but_cannot_supply_typed_child_fields() {
    let child = br#"{"name":"Child","inherits":"Parent","type":"printer","shared":"child"}"#;
    let actual: Value = serde_json::from_str(&serialized(
        pending(child, ProfileKind::Filament)
            .finish_with_parent(br#"{"name":"Parent","inherits":"Grandparent","type":"filament","version":"9","nozzle_diameter":"0.4","extruder_count":2,"shared":"parent"}"#)
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(actual["kind"], "printer");
    assert_eq!(actual["provenance"]["name"], "Child");
    assert_eq!(actual["provenance"]["slicer_version"], Value::Null);
    assert_eq!(actual["nozzle_diameter_mm"], Value::Null);
    assert_eq!(actual["extruder_count"], Value::Null);
    assert_eq!(actual["raw_json"], std::str::from_utf8(child).unwrap());
    let own = r#"{"name":"Child","inherits":"Parent","type":"printer","shared":"child"}"#;
    assert_eq!(
        actual["provenance"]["resolved_flat_config"],
        r#"{"name":"Child","inherits":"Parent","type":"printer","version":"9","nozzle_diameter":"0.4","extruder_count":"2","shared":"child"}"#
    );
    let oversized = vec![b' '; 8 * 1024 * 1024 + 1];
    for parent in [b"{bad".as_slice(), b"null", oversized.as_slice()] {
        let fallback: Value = serde_json::from_str(&serialized(
            pending(child, ProfileKind::Process)
                .finish_with_parent(parent)
                .unwrap(),
        ))
        .unwrap();
        assert_eq!(fallback["provenance"]["resolved_flat_config"], own);
    }
    let missing: Value = serde_json::from_str(&serialized(
        pending(child, ProfileKind::Process)
            .finish_without_parent()
            .unwrap(),
    ))
    .unwrap();
    assert_eq!(missing["provenance"]["resolved_flat_config"], own);
}

#[test]
fn duplicate_values_keep_first_key_position_and_node_index_order() {
    let duplicate = ready(br#"{"a":"first","a":null}"#, ProfileKind::Process);
    assert_eq!(duplicate["provenance"]["resolved_flat_config"], "{}");
    let actual = ready(
        br#"{"z":1,"9":"nine","2":"two","01":"leading","z":2,"a":"first","a":null,"4294967295":"not index","0":"zero"}"#,
        ProfileKind::Process,
    );
    assert_eq!(
        actual["provenance"]["resolved_flat_config"],
        r#"{"0":"zero","2":"two","9":"nine","z":"2","01":"leading","4294967295":"not index"}"#
    );
}

#[test]
fn numeric_stringification_and_projection_follow_javascript() {
    let numeric = ready(
        br#"{"unsafe":9007199254740993,"huge":1e308,"overflow":1e400,"small":1e-7,"large":1e21,"negativeZero":-0}"#,
        ProfileKind::Process,
    );
    assert_eq!(
        numeric["provenance"]["resolved_flat_config"],
        r#"{"unsafe":"9007199254740992","huge":"1e+308","overflow":"Infinity","small":"1e-7","large":"1e+21","negativeZero":"0"}"#
    );
    let printer = ready(
        br#"{"type":"machine","nozzle_diameter":"1e21mm","extruder_count":"9007199254740993tail"}"#,
        ProfileKind::Process,
    );
    assert_eq!(printer["nozzle_diameter_mm"], "1e+21");
    assert_eq!(printer["extruder_count"], 9_007_199_254_740_992_f64);
    let fractional = ready(
        br#"{"nozzle_diameter":"Infinity","nozzle_diameter_mm":".4mm","extruder_count":"-1.9"}"#,
        ProfileKind::Printer,
    );
    assert_eq!(fractional["nozzle_diameter_mm"], "0.4");
    assert_eq!(fractional["extruder_count"], -1.0);
    for (temperature, expected) in [
        ("0.49999999999999994", 0.0),
        ("4503599627370497", 4_503_599_627_370_497_f64),
        ("1e308", 1e308),
    ] {
        let raw = format!(r#"{{"name":"PLA","nozzle_temperature":{temperature}}}"#);
        assert_eq!(
            ready(raw.as_bytes(), ProfileKind::Filament)["nozzle_temp_c"],
            expected
        );
    }
}

#[test]
fn many_retained_keys_preserve_values_in_json_and_ini() {
    let prefix = "k".repeat(256);
    let pairs: Vec<_> = (0..16_384)
        .map(|i| (format!("{prefix}{i}"), i.to_string()))
        .collect();
    let json = serde_json::to_string(
        &pairs
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect::<serde_json::Map<_, _>>(),
    );
    let ini = pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}\n"))
        .collect::<String>();
    for raw in [json.unwrap(), ini] {
        let imported = ready(raw.as_bytes(), ProfileKind::Process);
        let flat: Value = serde_json::from_str(
            imported["provenance"]["resolved_flat_config"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(flat.as_object().unwrap().len(), 16_384);
        assert_eq!(flat[format!("{prefix}0")], "0");
        assert_eq!(flat[format!("{prefix}16383")], "16383");
    }
}

#[test]
fn retained_raw_ini_is_bounded_before_serialization() {
    let raw = format!(";{}", "\u{0001}".repeat(3 * 1024 * 1024));
    assert_eq!(
        interpret_profile(document(raw.as_bytes(), ProfileKind::Filament)).err(),
        Some(ProfileInterpretError::RawDocumentTooLarge)
    );
    assert_eq!(
        ready(b";\x01\nname=PLA", ProfileKind::Filament)["raw"]["value"],
        ";\u{0001}\nname=PLA"
    );
}

#[test]
fn json_tree_entry_budget_is_shared() {
    let array = format!("[{}]", vec!["0"; 8_192].join(","));
    let smaller = format!("[{}]", vec!["0"; 8_189].join(","));
    let boundary = format!(r#"{{"value":[{array},{smaller}]}}"#);
    assert_eq!(
        ready(boundary.as_bytes(), ProfileKind::Process)["provenance"]["resolved_flat_config"],
        r#"{"value":"0"}"#
    );
    let object = format!(
        "{{{}}}",
        (0..8_192)
            .map(|i| format!(r#""k{i}":null"#))
            .collect::<Vec<_>>()
            .join(",")
    );
    for child in [array, object] {
        let raw = format!(r#"{{"ignored":[{child},{child}]}}"#);
        assert_eq!(
            interpret_profile(document(raw.as_bytes(), ProfileKind::Process)).unwrap_err(),
            ProfileInterpretError::TooManyEntries
        );
    }
}

#[test]
fn json_arrays_are_bounded_before_flattening() {
    let raw = format!(r#"{{"ignored":[{}]}}"#, vec!["null"; 16_385].join(","));
    assert!(matches!(
        interpret_profile(document(raw.as_bytes(), ProfileKind::Process)),
        Err(ProfileInterpretError::TooManyEntries)
    ));
    let raw = format!(r#"{{"value":[{}]}}"#, vec!["0"; 16_383].join(","));
    assert_eq!(
        ready(raw.as_bytes(), ProfileKind::Process)["provenance"]["resolved_flat_config"],
        r#"{"value":"0"}"#
    );
}

#[test]
fn json_object_entry_limits_apply_before_flattening() {
    let properties = (0..16_384)
        .map(|index| format!(r#""k{index}":null"#))
        .collect::<Vec<_>>()
        .join(",");
    let raw = format!(r#"{{{properties},"extra":null}}"#);
    assert!(matches!(
        interpret_profile(document(raw.as_bytes(), ProfileKind::Process)),
        Err(ProfileInterpretError::TooManyEntries)
    ));
    let nested = format!(r#"{{"ignored":{raw}}}"#);
    assert!(matches!(
        interpret_profile(document(nested.as_bytes(), ProfileKind::Process)),
        Err(ProfileInterpretError::TooManyEntries)
    ));
    let duplicate = format!(r#"{{{properties},"k0":"final"}}"#);
    assert_eq!(
        ready(duplicate.as_bytes(), ProfileKind::Process)["provenance"]["resolved_flat_config"],
        r#"{"k0":"final"}"#
    );
}

#[test]
fn public_errors_bound_malformed_input_depth_keys_scalars_and_entries() {
    assert!(matches!(
        ProfileDocument::new(b"{}", ProfileKind::Process, SlicerKind::Orca, ""),
        Err(ProfileInterpretError::EmptySourceLabel)
    ));
    for raw in [
        r#"{"x":01}"#,
        r#"{"x":1.}"#,
        r#"{"x":1e}"#,
        r#"{"x":"\uXY00"}"#,
        "{} trailing",
        "{\"x\":true,}",
    ] {
        assert_eq!(
            interpret_profile(document(raw.as_bytes(), ProfileKind::Process)).unwrap_err(),
            ProfileInterpretError::InvalidJson,
            "{raw}"
        );
    }
    let cases = [
        (
            " ".repeat(8 * 1024 * 1024 + 1),
            ProfileInterpretError::DocumentTooLarge,
        ),
        (
            format!(r#"{{"x":{}{}}}"#, "[".repeat(129), "]".repeat(129)),
            ProfileInterpretError::JsonNestingLimit,
        ),
        (
            format!(r#"{{"x":{}"leaf"{}}}"#, "[".repeat(65), "]".repeat(65)),
            ProfileInterpretError::ScalarDepthLimit,
        ),
        (
            format!("{}=value", "k".repeat(64 * 1024 + 1)),
            ProfileInterpretError::KeyTooLarge,
        ),
        (
            format!("x={}", "v".repeat(1024 * 1024 + 1)),
            ProfileInterpretError::ScalarTooLarge,
        ),
        (
            (0..16_385).map(|i| format!("k{i}=v\n")).collect(),
            ProfileInterpretError::TooManyEntries,
        ),
    ];
    for (raw, expected) in cases {
        assert_eq!(
            interpret_profile(document(raw.as_bytes(), ProfileKind::Process)).unwrap_err(),
            expected
        );
    }
    assert_eq!(
        ready(b"{}", ProfileKind::Process)["provenance"]["name"],
        "Unnamed"
    );
}

#[test]
fn captured_surrogate_parent_request_and_flat_config_preserve_utf16() {
    let raw = br#"{"name":"\uD800","low":"\uDC00","pair":"\uD83D\uDE00","key\uD800":"value\uDC00","type":"pro\uD800cess","inherits":"Parent\uD800","config":{"value":"x\uD800"}}"#;
    let pending = pending(raw, ProfileKind::Process);
    assert_eq!(
        pending.request().file_stem().as_utf16(),
        [80, 97, 114, 101, 110, 116, 0xd800]
    );
    let actual = serialized(pending.finish_without_parent().unwrap());
    assert!(actual.starts_with(r#"{"kind":"process"#));
    let expected = r#"{"name":"\ud800","low":"\udc00","pair":"😀","key\ud800":"value\udc00","type":"pro\ud800cess","inherits":"Parent\ud800","config":"x\ud800"}"#;
    assert!(
        actual.contains(&format!(
            "\"resolved_flat_config\":{}",
            serde_json::to_string(expected).unwrap()
        )),
        "{actual}"
    );
}

#[test]
fn invalid_utf8_uses_node_replacement_before_json_parsing() {
    for (invalid, expected) in [
        (vec![0xff], "�"),
        (vec![0xc0, 0xaf], "��"),
        (vec![0xe2, 0x28, 0xa1], "�(�"),
    ] {
        let mut bytes = br#"{"name":""#.to_vec();
        bytes.extend(invalid);
        bytes.extend(br#""}"#);
        let actual = ready(&bytes, ProfileKind::Process);
        assert_eq!(actual["provenance"]["name"], expected);
        assert_eq!(
            actual["provenance"]["resolved_flat_config"],
            format!(r#"{{"name":"{expected}"}}"#)
        );
    }
}
