use super::ManifestInputDetail;
use super::json::{self, JsText, JsonError, JsonLimit, JsonValue, OrderedObject};
use crate::manifest_text::{OptionGroupId, VariantId};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct KitManifest {
    name: Option<JsText>,
    layers: Vec<JsText>,
    base_source_id: Option<JsText>,
    addon_source_ids: Vec<JsText>,
    selections: OrderedObject<Selection>,
    include: Vec<JsText>,
    exclude: Vec<JsText>,
    replacements: OrderedObject<JsText>,
    choice_tree: Vec<JsonValue>,
    category_links: Vec<JsonValue>,
}

#[derive(Debug, Clone, PartialEq)]
enum Selection {
    Scalar(JsText),
    Array(Vec<JsText>),
}

impl Selection {
    fn values(&self) -> Box<dyn Iterator<Item = &JsText> + '_> {
        match self {
            Self::Scalar(value) => Box::new(std::iter::once(value)),
            Self::Array(values) => Box::new(values.iter()),
        }
    }

    fn write_json(&self, output: &mut Vec<u8>) {
        match self {
            Self::Scalar(value) => value.write_json(output),
            Self::Array(values) => write_text_array(values, output),
        }
    }
}

impl KitManifest {
    pub fn from_request(bytes: &[u8]) -> Result<Self, ManifestInputDetail> {
        let value = json::parse(bytes).map_err(request_error)?;
        let JsonValue::Object(wrapper) = value else {
            return Err("kit is required".into());
        };
        let Some(value) = wrapper.get("kit") else {
            return Err("kit is required".into());
        };
        let JsonValue::Object(kit) = value else {
            return Err("kit must be an object".into());
        };
        parse_kit(kit)
    }

    pub fn from_stored(raw: &str) -> Result<KitManifest, ManifestInputDetail> {
        let value = json::parse(raw.as_bytes()).map_err(stored_error)?;
        let JsonValue::Object(kit) = value else {
            return Err("stored kit is malformed".into());
        };
        parse_kit(&kit).map_err(|_| "stored kit is malformed".into())
    }

    pub(super) fn from_stored_or_empty(raw: &str) -> Result<KitManifest, JsonLimit> {
        match json::parse(raw.as_bytes()) {
            Ok(JsonValue::Object(kit)) => Ok(parse_kit(&kit).unwrap_or_default()),
            Ok(_) | Err(JsonError::Syntax) => Ok(KitManifest::default()),
            Err(JsonError::Limit(limit)) => Err(limit),
        }
    }
}

fn request_error(error: JsonError) -> ManifestInputDetail {
    match error {
        JsonError::Syntax => "Request is invalid".into(),
        JsonError::Limit(JsonLimit::Bytes) => "Request body too large".into(),
        JsonError::Limit(JsonLimit::Depth) => "kit JSON exceeds the supported depth limit".into(),
        JsonError::Limit(JsonLimit::Nodes) => "kit JSON exceeds the supported node limit".into(),
    }
}

fn stored_error(error: JsonError) -> ManifestInputDetail {
    match error {
        JsonError::Syntax => "stored kit is malformed".into(),
        JsonError::Limit(JsonLimit::Bytes) => "stored kit exceeds the supported byte limit".into(),
        JsonError::Limit(JsonLimit::Depth) => "stored kit exceeds the supported depth limit".into(),
        JsonError::Limit(JsonLimit::Nodes) => "stored kit exceeds the supported node limit".into(),
    }
}

fn parse_kit(object: &OrderedObject<JsonValue>) -> Result<KitManifest, ManifestInputDetail> {
    Ok(KitManifest {
        name: nullable_text(object, "name")?,
        layers: text_array(object, "layers")?,
        base_source_id: nullable_text(object, "base_source_id")?,
        addon_source_ids: text_array(object, "addon_source_ids")?,
        selections: selections(object)?,
        include: text_array(object, "include")?,
        exclude: text_array(object, "exclude")?,
        replacements: replacements(object)?,
        choice_tree: dynamic_array(object, "choice_tree")?,
        category_links: dynamic_array(object, "category_links")?,
    })
}

fn nullable_text(
    object: &OrderedObject<JsonValue>,
    key: &str,
) -> Result<Option<JsText>, ManifestInputDetail> {
    match object.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Text(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("kit.{key} must be a string or null").into()),
    }
}

fn text_array(
    object: &OrderedObject<JsonValue>,
    key: &str,
) -> Result<Vec<JsText>, ManifestInputDetail> {
    match object.get(key) {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(|value| match value {
                JsonValue::Text(value) => Ok(value.clone()),
                _ => Err(format!("kit.{key} must be an array of strings").into()),
            })
            .collect(),
        Some(_) => Err(format!("kit.{key} must be an array of strings").into()),
    }
}

fn selections(
    object: &OrderedObject<JsonValue>,
) -> Result<OrderedObject<Selection>, ManifestInputDetail> {
    let Some(value) = object.get("selections") else {
        return Ok(OrderedObject::default());
    };
    let JsonValue::Object(groups) = value else {
        return Err("kit.selections must be an object".into());
    };
    let mut output = OrderedObject::default();
    for (group, value) in groups.iter() {
        if group.is_ecmascript_blank() {
            return Err("kit.selections group id is required".into());
        }
        let selection = match value {
            JsonValue::Text(value) => Selection::Scalar(normalized_variant(group, value.clone())?),
            JsonValue::Array(values) => {
                let mut normalized = Vec::with_capacity(values.len());
                let mut unique = BTreeSet::new();
                for value in values {
                    let JsonValue::Text(value) = value else {
                        return Err(selection_error(group));
                    };
                    let value = normalized_variant(group, value.clone())?;
                    if !unique.insert(value.units().to_vec()) {
                        return Err(selection_error(group));
                    }
                    normalized.push(value);
                }
                Selection::Array(normalized)
            }
            _ => return Err(selection_error(group)),
        };
        output.insert(group.clone(), selection);
    }
    Ok(output)
}

fn normalized_variant(group: &JsText, value: JsText) -> Result<JsText, ManifestInputDetail> {
    let value = value.trim_ecmascript();
    if value.units().is_empty() {
        return Err(selection_error(group));
    }
    Ok(value)
}

fn selection_error(group: &JsText) -> ManifestInputDetail {
    ManifestInputDetail::group(group, " must contain unique nonempty variant ids")
}

fn replacements(
    object: &OrderedObject<JsonValue>,
) -> Result<OrderedObject<JsText>, ManifestInputDetail> {
    let Some(value) = object.get("replacements") else {
        return Ok(OrderedObject::default());
    };
    let JsonValue::Object(values) = value else {
        return Err("kit.replacements must be an object".into());
    };
    let mut output = OrderedObject::default();
    for (key, value) in values.iter() {
        let JsonValue::Text(value) = value else {
            return Err("kit.replacements must map strings to strings".into());
        };
        output.insert(key.clone(), value.clone());
    }
    Ok(output)
}

fn dynamic_array(
    object: &OrderedObject<JsonValue>,
    key: &str,
) -> Result<Vec<JsonValue>, ManifestInputDetail> {
    match object.get(key) {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(values)) => Ok(values.clone()),
        Some(_) => Err(format!("kit.{key} must be an array").into()),
    }
}

impl KitManifest {
    pub fn selection_projection(&self) -> Vec<(OptionGroupId, Vec<VariantId>)> {
        self.selections
            .iter()
            .map(|(group, selection)| {
                (
                    OptionGroupId(group.clone()),
                    selection
                        .values()
                        .map(|value| VariantId(value.clone()))
                        .collect(),
                )
            })
            .collect()
    }

    pub(super) fn insert_default_selection(
        &mut self,
        group: OptionGroupId,
        values: Vec<VariantId>,
        scalar: bool,
    ) {
        if self.selections.iter().any(|(key, _)| *key == group.0) {
            return;
        }
        let selection = match values.as_slice() {
            [value] if scalar => Selection::Scalar(value.0.clone()),
            _ => Selection::Array(values.into_iter().map(|value| value.0).collect()),
        };
        self.selections.insert(group.0, selection);
    }

    pub(super) fn write_selections_json(&self, output: &mut Vec<u8>) {
        self.selections
            .write_json(output, |selection, output| selection.write_json(output));
    }

    pub fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'{');
        write_key("name", output);
        write_nullable_text(self.name.as_ref(), output);
        output.push(b',');
        write_key("layers", output);
        write_text_array(&self.layers, output);
        output.push(b',');
        write_key("base_source_id", output);
        write_nullable_text(self.base_source_id.as_ref(), output);
        output.push(b',');
        write_key("addon_source_ids", output);
        write_text_array(&self.addon_source_ids, output);
        output.push(b',');
        write_key("selections", output);
        self.write_selections_json(output);
        output.push(b',');
        write_key("include", output);
        write_text_array(&self.include, output);
        output.push(b',');
        write_key("exclude", output);
        write_text_array(&self.exclude, output);
        output.push(b',');
        write_key("replacements", output);
        self.replacements
            .write_json(output, |value, output| value.write_json(output));
        output.push(b',');
        write_key("choice_tree", output);
        write_dynamic_array(&self.choice_tree, output);
        output.push(b',');
        write_key("category_links", output);
        write_dynamic_array(&self.category_links, output);
        output.push(b'}');
    }
}

fn write_key(key: &str, output: &mut Vec<u8>) {
    JsText::scalar(key).write_json(output);
    output.push(b':');
}

fn write_nullable_text(value: Option<&JsText>, output: &mut Vec<u8>) {
    match value {
        Some(value) => value.write_json(output),
        None => output.extend_from_slice(b"null"),
    }
}

fn write_text_array(values: &[JsText], output: &mut Vec<u8>) {
    output.push(b'[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(b',');
        }
        value.write_json(output);
    }
    output.push(b']');
}

fn write_dynamic_array(values: &[JsonValue], output: &mut Vec<u8>) {
    output.push(b'[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(b',');
        }
        value.write_json(output);
    }
    output.push(b']');
}
