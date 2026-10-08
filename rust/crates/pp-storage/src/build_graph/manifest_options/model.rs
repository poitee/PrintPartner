use super::ManifestInputDetail;
use super::json::{self, JsText, JsonError, JsonLimit, JsonValue, OrderedObject};
use crate::manifest_text::{ManifestText, OptionGroupId, VariantId};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

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
    fn len(&self) -> usize {
        match self {
            Self::Scalar(_) => 1,
            Self::Array(values) => values.len(),
        }
    }

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

#[derive(Debug, Clone)]
pub(super) struct KitManifestPatch(KitManifest);

impl KitManifestPatch {
    pub(super) fn from_request(bytes: &[u8]) -> Result<Self, ManifestInputDetail> {
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
        parse_kit(kit).map(Self)
    }

    pub(super) fn from_stored(raw: &str) -> Result<KitManifest, ManifestInputDetail> {
        let value = json::parse(raw.as_bytes()).map_err(stored_error)?;
        let JsonValue::Object(kit) = value else {
            return Err("stored kit is malformed".into());
        };
        parse_kit(&kit).map_err(|_| "stored kit is malformed".into())
    }

    pub(super) fn into_empty_defaults(self) -> KitManifest {
        self.0
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
    pub(super) fn selection_projection(
        &self,
    ) -> Vec<(
        crate::manifest_text::OptionGroupId,
        Vec<crate::manifest_text::VariantId>,
    )> {
        self.selections
            .iter()
            .map(|(group, selection)| {
                (
                    crate::manifest_text::OptionGroupId(group.clone()),
                    selection
                        .values()
                        .map(|value| crate::manifest_text::VariantId(value.clone()))
                        .collect(),
                )
            })
            .collect()
    }

    pub(super) fn selection_entries(&self) -> impl Iterator<Item = (&JsText, usize)> {
        self.selections
            .iter()
            .map(|(group, selection)| (group, selection.len()))
    }

    pub(super) fn insert_default_selection(
        &mut self,
        group: crate::manifest_text::OptionGroupId,
        values: Vec<crate::manifest_text::VariantId>,
        scalar: bool,
    ) {
        let group = group.0;
        if self.selections.contains_key(&group) {
            return;
        }
        let mut values = values.into_iter().map(|value| value.0).collect::<Vec<_>>();
        let selection = if scalar && values.len() == 1 {
            Selection::Scalar(values.remove(0))
        } else {
            Selection::Array(values)
        };
        self.selections.insert(group, selection);
    }

    #[cfg(test)]
    pub(crate) fn name_scalar(&self) -> Option<String> {
        self.name.as_ref().and_then(JsText::as_scalar)
    }

    pub(super) fn write_json(&self, output: &mut Vec<u8>) {
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
        self.selections
            .write_json(output, |selection, output| selection.write_json(output));
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

#[derive(Debug, Clone, PartialEq)]
pub struct ManifestBuilder {
    pub(super) profile_id: i64,
    pub(super) sources: Vec<ManifestSource>,
    pub(super) resolved_selections: KitManifest,
    pub(super) merged_option_groups: BTreeMap<OptionGroupId, ManifestOptionGroup>,
}

impl ManifestBuilder {
    pub(super) fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'{');
        field("profile_id", &self.profile_id, output);
        output.extend_from_slice(b",\"sources\":");
        array(&self.sources, output, |source, output| {
            source.write_json(output)
        });
        output.extend_from_slice(b",\"resolved_selections\":");
        self.resolved_selections
            .selections
            .write_json(output, |selection, output| selection.write_json(output));
        output.extend_from_slice(b",\"merged_option_groups\":");
        groups(&self.merged_option_groups, output);
        output.push(b'}');
    }
}

fn field<T: Serialize>(key: &str, value: &T, output: &mut Vec<u8>) {
    write_key(key, output);
    output.extend_from_slice(&serde_json::to_vec(value).expect("ordinary manifest field"));
}
fn array<T>(values: &[T], output: &mut Vec<u8>, write: impl Fn(&T, &mut Vec<u8>)) {
    output.push(b'[');
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            output.push(b',');
        }
        write(value, output);
    }
    output.push(b']');
}
fn texts(values: &[ManifestText], output: &mut Vec<u8>) {
    array(values, output, |text, output| text.0.write_json(output));
}
fn label(value: Option<&ManifestText>, output: &mut Vec<u8>) {
    write_nullable_text(value.map(|text| &text.0), output);
}
fn groups(values: &BTreeMap<OptionGroupId, ManifestOptionGroup>, output: &mut Vec<u8>) {
    output.push(b'{');
    let mut ordered = values.iter().collect::<Vec<_>>();
    ordered.sort_by(|(a, _), (b, _)| {
        std::char::decode_utf16(a.0.units().iter().copied())
            .map(|unit| {
                unit.map(u32::from)
                    .unwrap_or_else(|error| u32::from(error.unpaired_surrogate()))
            })
            .cmp(
                std::char::decode_utf16(b.0.units().iter().copied()).map(|unit| {
                    unit.map(u32::from)
                        .unwrap_or_else(|error| u32::from(error.unpaired_surrogate()))
                }),
            )
    });
    for (i, (id, value)) in ordered.into_iter().enumerate() {
        if i > 0 {
            output.push(b',');
        }
        id.0.write_json(output);
        output.push(b':');
        value.write_json(output);
    }
    output.push(b'}');
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ManifestSource {
    pub source_id: i64,
    pub layer_type: String,
    pub name: String,
    pub role: String,
    pub url: String,
    pub exists: bool,
    pub path: &'static str,
    pub yaml: String,
    pub document: ManifestDocument,
    pub scanned_parts: Vec<ManifestPart>,
}
impl ManifestSource {
    fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'{');
        field("source_id", &self.source_id, output);
        output.push(b',');
        field("layer_type", &self.layer_type, output);
        output.push(b',');
        field("name", &self.name, output);
        output.push(b',');
        field("role", &self.role, output);
        output.push(b',');
        field("url", &self.url, output);
        output.push(b',');
        field("exists", &self.exists, output);
        output.push(b',');
        field("path", &self.path, output);
        output.push(b',');
        field("yaml", &self.yaml, output);
        output.extend_from_slice(b",\"document\":");
        self.document.write_json(output);
        output.push(b',');
        field("scanned_parts", &self.scanned_parts, output);
        output.push(b'}');
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ManifestDocument {
    pub format: &'static str,
    pub version: u32,
    pub project: String,
    pub option_groups: BTreeMap<OptionGroupId, ManifestOptionGroup>,
}
impl ManifestDocument {
    fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'{');
        field("format", &self.format, output);
        output.push(b',');
        field("version", &self.version, output);
        output.push(b',');
        field("project", &self.project, output);
        output.extend_from_slice(b",\"option_groups\":");
        groups(&self.option_groups, output);
        output.push(b'}');
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ManifestOptionGroup {
    pub rule: String,
    pub label: Option<ManifestText>,
    pub parts: Vec<ManifestText>,
    pub min: Option<u64>,
    pub max: Option<u64>,
    pub variants: Vec<ManifestVariant>,
}
impl ManifestOptionGroup {
    fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'{');
        field("rule", &self.rule, output);
        output.extend_from_slice(b",\"label\":");
        label(self.label.as_ref(), output);
        output.extend_from_slice(b",\"parts\":");
        texts(&self.parts, output);
        output.push(b',');
        field("min", &self.min, output);
        output.push(b',');
        field("max", &self.max, output);
        output.extend_from_slice(b",\"variants\":");
        array(&self.variants, output, |variant, output| {
            variant.write_json(output)
        });
        output.push(b'}');
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ManifestVariant {
    pub id: VariantId,
    pub label: Option<ManifestText>,
    pub parts: Vec<ManifestText>,
    pub excludes: Vec<ManifestText>,
    pub source_id: Option<i64>,
    pub source_name: Option<String>,
    pub sources: Option<Vec<ManifestVariantSource>>,
}
impl ManifestVariant {
    fn write_json(&self, output: &mut Vec<u8>) {
        output.extend_from_slice(b"{\"id\":");
        self.id.0.write_json(output);
        output.extend_from_slice(b",\"label\":");
        label(self.label.as_ref(), output);
        output.extend_from_slice(b",\"parts\":");
        texts(&self.parts, output);
        output.extend_from_slice(b",\"excludes\":");
        texts(&self.excludes, output);
        if let Some(value) = self.source_id {
            output.push(b',');
            field("source_id", &value, output);
        }
        if let Some(value) = &self.source_name {
            output.push(b',');
            field("source_name", value, output);
        }
        if let Some(value) = &self.sources {
            output.push(b',');
            field("sources", value, output);
        }
        output.push(b'}');
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct ManifestVariantSource {
    pub source_id: i64,
    pub source_name: String,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct ManifestPart {
    #[serde(rename = "match")]
    pub match_key: String,
    pub relative_path: String,
}

#[cfg(test)]
mod scalar_group_order_tests {
    use super::*;
    #[test]
    fn builder_scalar_supplementary_and_private_use_order_equals_legacy_btree_bytes() {
        let mut typed = BTreeMap::new();
        let mut legacy = BTreeMap::new();
        for key in ["😀", "\u{e000}"] {
            typed.insert(
                OptionGroupId(JsText::scalar(key)),
                ManifestOptionGroup {
                    rule: "pick_one".into(),
                    label: None,
                    parts: vec![],
                    min: None,
                    max: None,
                    variants: vec![],
                },
            );
            legacy.insert(key.to_owned(),serde_json::json!({"rule":"pick_one","label":null,"parts":[],"min":null,"max":null,"variants":[]}));
        }
        let mut bytes = Vec::new();
        groups(&typed, &mut bytes);
        assert_eq!(bytes, serde_json::to_vec(&legacy).unwrap());
    }
}
