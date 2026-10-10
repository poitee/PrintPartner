use insta::{Settings, assert_json_snapshot};
use pp_api_types::{parse_identity, parse_receipt, parse_request};
use serde_json::Value;

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

// Ids and timestamps vary between fixture regenerations; digests and
// versions stay visible so a changed value still shows up in the diff.
fn with_redactions(snapshot: impl FnOnce()) {
    let mut settings = Settings::clone_current();
    settings.add_redaction(".**.profile_id", "[profile_id]");
    settings.add_redaction(".**.draft_id", "[draft_id]");
    settings.add_redaction(".**.revision_id", "[revision_id]");
    settings.add_redaction(".**.applied_at", "[timestamp]");
    settings.bind(snapshot);
}

#[test]
fn accepted_requests_serialize_stably() {
    for name in ACCEPTED {
        let request = parse_request(&fixture(name).to_string()).unwrap();
        let value = serde_json::to_value(request).unwrap();
        with_redactions(|| {
            assert_json_snapshot!(format!("request-{name}"), value);
        });
    }
}

#[test]
fn rejected_requests_report_stable_boundary_errors() {
    for name in REJECTED {
        let error = parse_request(&fixture(name).to_string()).unwrap_err();
        let value = serde_json::to_value(error).unwrap();
        with_redactions(|| {
            assert_json_snapshot!(format!("reject-{name}"), value);
        });
    }
}

#[test]
fn receipt_serializes_stably() {
    let receipt = parse_receipt(&fixture("receipt-valid").to_string()).unwrap();
    let value = serde_json::to_value(receipt).unwrap();
    with_redactions(|| {
        assert_json_snapshot!("receipt-valid", value);
    });
}

#[test]
fn identity_serializes_stably() {
    let identity = parse_identity(&fixture("identity-open").to_string()).unwrap();
    let value = serde_json::to_value(identity).unwrap();
    with_redactions(|| {
        assert_json_snapshot!("identity-open", value);
    });
}
