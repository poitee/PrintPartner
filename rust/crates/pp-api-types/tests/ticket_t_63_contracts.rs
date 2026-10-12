use pp_api_types::contracts::parse_native;
use serde_json::Value;

fn check(cases: &[Value], probe: bool) {
    assert!(!cases.is_empty());
    for case in cases {
        let text = case["raw_input"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| case["input"].to_string());
        let parser = if probe {
            "semanticFixtureSchema"
        } else {
            case["parser"].as_str().unwrap()
        };
        let result = parse_native(parser, &text);
        let accepted = if probe {
            case["accepted"].as_bool().unwrap()
        } else {
            case["outcome"]["kind"] == "accepted"
        };
        assert_eq!(result.is_ok(), accepted, "{}: {result:?}", case["name"]);
        if let Ok(value) = result {
            let output = if probe {
                &case["output"]
            } else {
                &case["outcome"]["parsed"]
            };
            assert_eq!(&value, output, "{}", case["name"]);
        }
    }
}
#[test]
fn ticket_t_63_contracts_native_semantic_corpus() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../web/packages/contracts/test-fixtures/t9/semantics.json"
    ))
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 34);
    check(cases, true);
}
#[test]
fn ticket_t_63_contracts_native_autosave_corpus() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../web/packages/contracts/test-fixtures/desktop/autosave-v1.json"
    ))
    .unwrap();
    let cases = corpus["normalized"]["schema_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 41);
    check(cases, false);
}
#[test]
fn ticket_t_63_contracts_native_supplemental_corpus() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../web/scripts/rust-contracts/supplemental.json"
    ))
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 50);
    check(cases, false);
}
#[test]
fn ticket_t_63_contracts_required_null_is_not_optional() {
    let input = r#"{"mode":"read","integer":1,"date":"2024-02-29","text":"ok"}"#;
    assert!(parse_native("semanticFixtureSchema", input).is_err());
    let input = r#"{"nullable":null,"optional":null,"mode":"read","integer":1,"date":"2024-02-29","text":"ok"}"#;
    assert!(parse_native("semanticFixtureSchema", input).is_err());
}

#[test]
fn ticket_t_63_contracts_integral_float_preserves_safe_max_receipt() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../web/packages/contracts/test-fixtures/desktop/autosave-v1.json"
    ))
    .unwrap();
    let mut input = corpus["normalized"]["schema_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "receipt-valid")
        .unwrap()["input"]
        .clone();
    input["profile_id"] = pp_api_types::MAX_SAFE_INTEGER.into();
    let text = input.to_string().replace(
        "\"profile_id\":9007199254740991",
        "\"profile_id\":9007199254740991.0",
    );
    assert!(text.contains("9007199254740991.0"));
    let result = parse_native("parseApplyPlanDraftReceipt", &text).unwrap();
    assert_eq!(result, input);
}

#[cfg(feature = "codegen")]
#[test]
fn ticket_t_63_contracts_rust_schema_artifact_rejects_drift() {
    let checked: Value = serde_json::from_str(include_str!(
        "../../../../web/scripts/rust-contracts/schemas.json"
    ))
    .unwrap();
    assert_eq!(pp_api_types::contracts::export(), checked);
}

#[cfg(feature = "codegen")]
#[test]
fn ticket_t_63_contracts_schema_cli_rejects_planted_drift() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "pp-rust-schema-{}-{nonce}.json",
        std::process::id()
    ));
    let bytes = include_str!("../../../../web/scripts/rust-contracts/schemas.json");
    std::fs::write(&path, bytes).unwrap();
    let check = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_export-rust-contracts"))
            .arg("--check")
            .arg(&path)
            .output()
            .unwrap()
    };
    assert!(check().status.success());
    std::fs::write(&path, format!("{bytes}\n")).unwrap();
    let result = check();
    std::fs::remove_file(path).unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8(result.stderr)
            .unwrap()
            .contains("Rust contract schema drift")
    );
}
