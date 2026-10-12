use insta::assert_json_snapshot;
use pp_api_types::{BoundaryError, parse_identity, parse_receipt, parse_request};
use serde_json::{Map, Value, json};

const FIXTURE: &str =
    include_str!("../../../../web/packages/contracts/test-fixtures/desktop/autosave-v1.json");

const ACCEPTED: [&str; 5] = [
    "included-false",
    "quantity-null-reset",
    "quantity-10000-number",
    "empty-base",
    "observed-open-draft",
];

const REJECTED: [&str; 7] = [
    "quantity-0-number",
    "quantity-1-string",
    "empty-base-version-mismatch",
    "observed-draft-base-mismatch",
    "duplicate-field",
    "unknown-root-key",
    "source-layer-omitted",
];

const ID_KEYS: [&str; 3] = ["profile_id", "draft_id", "revision_id"];
const TIMESTAMP_KEYS: [&str; 1] = ["applied_at"];

fn fixture(name: &str) -> Value {
    let corpus: Value = serde_json::from_str(FIXTURE).unwrap();
    corpus["normalized"]["schema_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()["input"]
        .clone()
}

// Replaces populated ids and timestamps with placeholders while keeping
// nulls, so a regression that starts emitting an id (or drops a null) still
// changes the snapshot. Digests and versions stay visible on purpose.
fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => redact_object(map),
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

fn redact_object(map: &mut Map<String, Value>) {
    for (key, child) in map.iter_mut() {
        if child.is_null() {
            continue;
        }
        if let Some(id) = ID_KEYS.iter().find(|id| *id == key) {
            *child = json!(format!("[{id}]"));
        } else if TIMESTAMP_KEYS.contains(&key.as_str()) {
            *child = json!("[timestamp]");
        } else {
            redact(child);
        }
    }
}

// The parser appends " at line N column M", which shifts whenever a fixture
// id changes width. Keep the message itself, drop the location suffix.
fn boundary_error_value(error: BoundaryError) -> Value {
    let detail = error
        .detail
        .split(" at line ")
        .next()
        .unwrap_or_default()
        .to_owned();
    json!({
        "category": error.category,
        "field": error.field,
        "detail": detail,
    })
}

#[test]
fn accepted_requests_serialize_stably() {
    for name in ACCEPTED {
        let request = parse_request(&fixture(name).to_string()).unwrap();
        let mut value = serde_json::to_value(request).unwrap();
        redact(&mut value);
        assert_json_snapshot!(format!("request-{name}"), value);
    }
}

#[test]
fn rejected_requests_report_stable_boundary_errors() {
    for name in REJECTED {
        let error = parse_request(&fixture(name).to_string()).unwrap_err();
        assert_json_snapshot!(format!("reject-{name}"), boundary_error_value(error));
    }
}

#[test]
fn receipt_serializes_stably() {
    let receipt = parse_receipt(&fixture("receipt-valid").to_string()).unwrap();
    let mut value = serde_json::to_value(receipt).unwrap();
    redact(&mut value);
    assert_json_snapshot!("receipt-valid", value);
}

#[test]
fn identity_serializes_stably() {
    let identity = parse_identity(&fixture("identity-open").to_string()).unwrap();
    let mut value = serde_json::to_value(identity).unwrap();
    redact(&mut value);
    assert_json_snapshot!("identity-open", value);
}
