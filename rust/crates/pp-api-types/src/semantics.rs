//! Boundary adapters for constraints/defaults which structural DTOs cannot enforce.
use crate::{BoundaryError, generated};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::sync::LazyLock;

fn validator(schema: &str) -> jsonschema::Validator {
    jsonschema::options()
        .should_validate_formats(true)
        .build(&serde_json::from_str::<Value>(schema).expect("checked-in schema JSON"))
        .expect("supported draft-7 schema")
}
macro_rules! schema_validator {
    ($name:ident, $file:literal) => {
        static $name: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
            validator(include_str!(concat!(
                "../../../../web/scripts/desktop-contracts/schemas/",
                $file
            )))
        });
    };
}
schema_validator!(REQUEST, "save-request.input.schema.json");
schema_validator!(RECEIPT, "apply-receipt.output.schema.json");
schema_validator!(IDENTITY, "draft-identity.output.schema.json");
schema_validator!(PROBE_INPUT, "semantic-fixture.input.schema.json");
schema_validator!(PROBE_OUTPUT, "semantic-fixture.output.schema.json");

fn error(category: &str, detail: impl ToString) -> BoundaryError {
    BoundaryError {
        category: category.into(),
        field: "$".into(),
        detail: detail.to_string(),
    }
}

fn validate_dto<T: DeserializeOwned>(
    text: &str,
    normalized: impl Serialize,
    schema: &jsonschema::Validator,
) -> Result<(), BoundaryError> {
    let input: Value = serde_json::from_str(text).map_err(|e| error("invalid_json", e))?;
    schema
        .validate(&input)
        .map_err(|e| error("wire_schema", e))?;
    // Zod accepts integral float lexemes; the validated native boundary has
    // already normalized these to integer JSON before typify deserialization.
    let _: T = serde_json::from_value(
        serde_json::to_value(normalized).map_err(|e| error("generated_dto", e))?,
    )
    .map_err(|e| error("generated_dto", e))?;
    Ok(())
}

pub(crate) fn request(
    text: &str,
    value: &crate::SavePlanChoicesRequest,
) -> Result<(), BoundaryError> {
    validate_dto::<generated::save_request_input::Dto>(text, value, &REQUEST)
}
pub(crate) fn receipt(
    text: &str,
    value: &crate::ApplyPlanDraftReceipt,
) -> Result<(), BoundaryError> {
    validate_dto::<generated::apply_receipt_output::Dto>(text, value, &RECEIPT)
}
pub(crate) fn identity(text: &str, value: &crate::PlanDraftIdentity) -> Result<(), BoundaryError> {
    validate_dto::<generated::draft_identity_output::Dto>(text, value, &IDENTITY)
}

/// Conformance probe only (no route): parse input, strip unknown keys, apply
/// the Zod default only on omission, validate the relational check and output.
pub fn parse_semantic_fixture(text: &str) -> Result<Value, BoundaryError> {
    let mut input: Value = serde_json::from_str(text).map_err(|e| error("invalid_json", e))?;
    PROBE_INPUT
        .validate(&input)
        .map_err(|e| error("wire_schema", e))?;
    let object = input
        .as_object_mut()
        .ok_or_else(|| error("invalid_shape", "expected object"))?;
    object.retain(|key, _| {
        [
            "optional",
            "nullable",
            "defaulted",
            "mode",
            "integer",
            "date",
            "text",
        ]
        .contains(&key.as_str())
    });
    object.entry("defaulted").or_insert(Value::from(3));
    // typify's primitive integers do not accept 1.0, whereas Zod does.
    for field in ["integer", "defaulted"] {
        let value = object[field].as_f64().expect("schema-validated integer") as u64;
        object.insert(field.into(), Value::from(value));
    }
    if object["mode"] == "write" && object["defaulted"] == 0 {
        return Err(error("semantic_write", "write_requires_positive_default"));
    }
    PROBE_OUTPUT
        .validate(&input)
        .map_err(|e| error("wire_schema", e))?;
    let _: generated::semantic_fixture_output::Dto =
        serde_json::from_value(input.clone()).map_err(|e| error("generated_dto", e))?;
    Ok(input)
}
