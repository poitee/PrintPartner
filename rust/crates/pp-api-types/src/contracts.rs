//! Reverse-generation proof. Production route ownership remains unchanged.
use crate::{MAX_SAFE_INTEGER, WireInteger, WireText, required_nullable};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Read,
    Write,
}

fn default_count() -> WireInteger<0, 10> {
    WireInteger::new(3).expect("bounded default")
}
fn optional_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
pub struct SemanticFixture {
    #[serde(
        default,
        deserialize_with = "optional_text",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "codegen", schemars(with = "String"))]
    optional: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "codegen",
        schemars(with = "crate::autosave::RequiredNullable<String>")
    )]
    nullable: Option<String>,
    #[serde(default = "default_count")]
    defaulted: WireInteger<0, 10>,
    mode: Mode,
    integer: WireInteger<0, MAX_SAFE_INTEGER>,
    date: CalendarDate,
    text: WireText<1, 4>,
}

#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct CalendarDate(String);
impl<'de> Deserialize<'de> for CalendarDate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let date = chrono::NaiveDate::parse_from_str(&text, "%Y-%m-%d")
            .map_err(serde::de::Error::custom)?;
        if date.format("%Y-%m-%d").to_string() != text || text.len() != 10 {
            return Err(serde::de::Error::custom("invalid_calendar_date"));
        }
        Ok(Self(text))
    }
}
#[cfg(feature = "codegen")]
impl schemars::JsonSchema for CalendarDate {
    fn schema_name() -> String {
        "CalendarDate".into()
    }
    fn json_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        schemars::schema::SchemaObject {
            instance_type: Some(schemars::schema::InstanceType::String.into()),
            format: Some("date".into()),
            ..Default::default()
        }
        .into()
    }
}
impl SemanticFixture {
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Self = serde_json::from_str(text).map_err(|error| error.to_string())?;
        if matches!(value.mode, Mode::Write) && value.defaulted.get() == 0 {
            return Err("write_requires_positive_default".into());
        }
        Ok(value)
    }
}

/// Uses the actual native DTO deserializers and their TryFrom refinements,
/// independently of semantics.rs and the old Zod-exported schema validators.
pub fn parse_native(parser: &str, text: &str) -> Result<serde_json::Value, String> {
    fn parse<T: serde::de::DeserializeOwned + Serialize>(
        text: &str,
    ) -> Result<serde_json::Value, String> {
        let value: T = serde_json::from_str(text).map_err(|error| error.to_string())?;
        serde_json::to_value(value).map_err(|error| error.to_string())
    }
    match parser {
        "parseSavePlanChoicesRequest" => parse::<crate::SavePlanChoicesRequest>(text),
        "parseApplyPlanDraftReceipt" => parse::<crate::ApplyPlanDraftReceipt>(text),
        "parsePlanDraftIdentity" => parse::<crate::PlanDraftIdentity>(text),
        "semanticFixtureSchema" => SemanticFixture::parse(text)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        _ => Err(format!("Unsupported native contract {parser}")),
    }
}

#[cfg(feature = "codegen")]
pub fn export() -> serde_json::Value {
    use serde_json::json;
    let mut roots = serde_json::Map::new();
    roots.insert(
        "basis".into(),
        serde_json::to_value(schemars::schema_for!(crate::PlanDraftBasis)).unwrap(),
    );
    roots.insert(
        "identity".into(),
        serde_json::to_value(schemars::schema_for!(crate::PlanDraftIdentity)).unwrap(),
    );
    roots.insert(
        "request".into(),
        serde_json::to_value(schemars::schema_for!(crate::SavePlanChoicesRequest)).unwrap(),
    );
    roots.insert(
        "receipt".into(),
        serde_json::to_value(schemars::schema_for!(crate::ApplyPlanDraftReceipt)).unwrap(),
    );
    roots.insert(
        "probe".into(),
        serde_json::to_value(schemars::schema_for!(SemanticFixture)).unwrap(),
    );
    json!({"generator": "rust-contracts-zod/1", "schemars": "0.8.22", "dialect": "http://json-schema.org/draft-07/schema#", "roots": roots,
      "refinements": {"PlanDraftBasis":"basis-consistency", "SavePlanChoicesRequest":"request-consistency", "SemanticFixture":"write-positive-default"}})
}
