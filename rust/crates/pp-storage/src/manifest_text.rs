use anyhow::{Result, bail, ensure};
use rusqlite::types::{Value, ValueRef};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct JsText(Vec<u16>);

impl JsText {
    pub(crate) fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }

    pub(crate) fn scalar(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }

    pub(crate) fn units(&self) -> &[u16] {
        &self.0
    }

    pub(crate) fn identifier_label(&self) -> ManifestText {
        ManifestText(Self(
            self.0
                .iter()
                .map(|unit| if *unit == 0x5f { 0x20 } else { *unit })
                .collect(),
        ))
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn as_scalar(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }

    pub(crate) fn trim_ecmascript(mut self) -> Self {
        let start = self
            .0
            .iter()
            .position(|unit| !is_ecmascript_whitespace(*unit))
            .unwrap_or(self.0.len());
        let end = self
            .0
            .iter()
            .rposition(|unit| !is_ecmascript_whitespace(*unit))
            .map_or(start, |index| index + 1);
        self.0 = self.0[start..end].to_vec();
        self
    }

    pub(crate) fn is_ecmascript_blank(&self) -> bool {
        self.0.iter().all(|unit| is_ecmascript_whitespace(*unit))
    }

    pub(crate) fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'"');
        let mut index = 0;
        while index < self.0.len() {
            let unit = self.0[index];
            match unit {
                0x0022 => output.extend_from_slice(br#"\""#),
                0x005c => output.extend_from_slice(br#"\\"#),
                0x0008 => output.extend_from_slice(br#"\b"#),
                0x0009 => output.extend_from_slice(br#"\t"#),
                0x000a => output.extend_from_slice(br#"\n"#),
                0x000c => output.extend_from_slice(br#"\f"#),
                0x000d => output.extend_from_slice(br#"\r"#),
                0x0000..=0x001f => write_escape(unit, output),
                0xd800..=0xdbff
                    if self
                        .0
                        .get(index + 1)
                        .is_some_and(|next| matches!(next, 0xdc00..=0xdfff)) =>
                {
                    let next = self.0[index + 1];
                    let scalar =
                        0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(next) - 0xdc00);
                    let value = char::from_u32(scalar).expect("paired surrogate");
                    let mut bytes = [0; 4];
                    output.extend_from_slice(value.encode_utf8(&mut bytes).as_bytes());
                    index += 1;
                }
                0xd800..=0xdfff => write_escape(unit, output),
                _ => {
                    let value = char::from_u32(u32::from(unit)).expect("BMP scalar");
                    let mut bytes = [0; 4];
                    output.extend_from_slice(value.encode_utf8(&mut bytes).as_bytes());
                }
            }
            index += 1;
        }
        output.push(b'"');
    }

    pub(crate) fn array_index(&self) -> Option<u32> {
        if self.0.is_empty()
            || self.0.iter().any(|unit| !matches!(unit, 0x30..=0x39))
            || (self.0.len() > 1 && self.0[0] == 0x30)
        {
            return None;
        }
        let mut value = 0u64;
        for unit in &self.0 {
            value = value
                .checked_mul(10)?
                .checked_add(u64::from(*unit - 0x30))?;
        }
        (value <= u64::from(u32::MAX - 1)).then_some(value as u32)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct OptionGroupId(pub(crate) JsText);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct VariantId(pub(crate) JsText);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManifestText(pub(crate) JsText);

impl From<String> for OptionGroupId {
    fn from(value: String) -> Self {
        Self(JsText::scalar(&value))
    }
}
impl From<String> for VariantId {
    fn from(value: String) -> Self {
        Self(JsText::scalar(&value))
    }
}
impl From<String> for ManifestText {
    fn from(value: String) -> Self {
        Self(JsText::scalar(&value))
    }
}
impl std::ops::Deref for ManifestText {
    type Target = JsText;
    fn deref(&self) -> &JsText {
        &self.0
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct PartManifestMetadata {
    pub(crate) requirement: Option<ManifestText>,
    pub(crate) option_group_id: Option<OptionGroupId>,
    pub(crate) manifest_source: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DraftPart {
    pub(crate) scalar: serde_json::Value,
    pub(crate) manifest: PartManifestMetadata,
}

impl std::ops::Deref for DraftPart {
    type Target = serde_json::Value;
    fn deref(&self) -> &Self::Target {
        &self.scalar
    }
}
impl std::ops::DerefMut for DraftPart {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.scalar
    }
}

impl DraftPart {
    pub(crate) fn new(scalar: serde_json::Value, manifest: PartManifestMetadata) -> Self {
        assert!(
            [
                "requirement",
                "optionGroupId",
                "option_group_id",
                "manifestSource",
                "manifest_source"
            ]
            .iter()
            .all(|field| scalar.get(*field).is_none())
        );
        Self { scalar, manifest }
    }

    pub(crate) fn same_field(&self, other: &Self, field: &str) -> bool {
        match field {
            "requirement" => self.manifest.requirement == other.manifest.requirement,
            "optionGroupId" | "option_group_id" => {
                self.manifest.option_group_id == other.manifest.option_group_id
            }
            "manifestSource" | "manifest_source" => {
                self.manifest.manifest_source == other.manifest.manifest_source
            }
            _ => self.scalar[field] == other.scalar[field],
        }
    }

    pub(crate) fn projected(&self, fields: &[&str]) -> Self {
        let scalar = fields
            .iter()
            .filter(|field| {
                !matches!(
                    **field,
                    "requirement"
                        | "optionGroupId"
                        | "manifestSource"
                        | "option_group_id"
                        | "manifest_source"
                )
            })
            .map(|field| ((*field).to_owned(), self.scalar[*field].clone()))
            .collect();
        Self::new(serde_json::Value::Object(scalar), self.manifest.clone())
    }

    pub(crate) fn json_fields(&self, fields: &[&str], snake: bool) -> Vec<u8> {
        let names = fields
            .iter()
            .map(|field| {
                let name = if snake {
                    let mut name = String::new();
                    for c in field.chars() {
                        if c.is_ascii_uppercase() {
                            name.push('_');
                            name.push(c.to_ascii_lowercase());
                        } else {
                            name.push(c);
                        }
                    }
                    name
                } else {
                    (*field).to_owned()
                };
                (name, *field)
            })
            .collect::<Vec<_>>();

        let mut output = vec![b'{'];
        for (index, (name, field)) in names.iter().enumerate() {
            if index > 0 {
                output.push(b',');
            }
            JsText::scalar(name).write_json(&mut output);
            output.push(b':');
            match *field {
                "requirement" => write_nullable(
                    self.manifest.requirement.as_ref().map(|v| &v.0),
                    &mut output,
                ),
                "optionGroupId" | "option_group_id" => write_nullable(
                    self.manifest.option_group_id.as_ref().map(|v| &v.0),
                    &mut output,
                ),
                "manifestSource" | "manifest_source" => output.extend_from_slice(
                    &serde_json::to_vec(&self.manifest.manifest_source).expect("manifest source"),
                ),
                _ => output.extend_from_slice(
                    &serde_json::to_vec(&self.scalar[*field]).expect("scalar part field"),
                ),
            }
        }
        output.push(b'}');
        output
    }

    pub(crate) fn sql_fields(&self, fields: &[&str]) -> anyhow::Result<Vec<(String, Value)>> {
        fields
            .iter()
            .map(|field| {
                Ok((
                    (*field).to_owned(),
                    match *field {
                        "requirement" => self
                            .manifest
                            .requirement
                            .as_ref()
                            .map_or(Value::Null, |v| v.0.sqlite_value()),
                        "optionGroupId" | "option_group_id" => self
                            .manifest
                            .option_group_id
                            .as_ref()
                            .map_or(Value::Null, |v| v.0.sqlite_value()),
                        "manifestSource" | "manifest_source" => self
                            .manifest
                            .manifest_source
                            .clone()
                            .map_or(Value::Null, Value::Text),
                        _ => match &self.scalar[*field] {
                            serde_json::Value::Null => Value::Null,
                            serde_json::Value::Bool(v) => Value::Integer(i64::from(*v)),
                            serde_json::Value::Number(v) => {
                                Value::Integer(v.as_i64().ok_or_else(|| {
                                    anyhow::anyhow!("Invalid scalar part integer")
                                })?)
                            }
                            serde_json::Value::String(v) => Value::Text(v.clone()),
                            _ => bail!("Invalid scalar part field"),
                        },
                    },
                ))
            })
            .collect()
    }
}

pub(crate) fn write_nullable(value: Option<&JsText>, output: &mut Vec<u8>) {
    match value {
        Some(value) => value.write_json(output),
        None => output.extend_from_slice(b"null"),
    }
}

pub(crate) fn compare_json_bytes(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    std::str::from_utf8(a)
        .expect("canonical JSON")
        .encode_utf16()
        .cmp(
            std::str::from_utf8(b)
                .expect("canonical JSON")
                .encode_utf16(),
        )
}

pub(crate) fn digest_json_bytes(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

fn is_ecmascript_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn write_escape(unit: u16, output: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.extend_from_slice(br#"\u"#);
    output.push(HEX[usize::from((unit >> 12) & 0xf)]);
    output.push(HEX[usize::from((unit >> 8) & 0xf)]);
    output.push(HEX[usize::from((unit >> 4) & 0xf)]);
    output.push(HEX[usize::from(unit & 0xf)]);
}

const MAGIC: &[u8; 5] = b"PPJS\x01";
const MAX_UNITS: usize = 8 * 1024 * 1024;

impl JsText {
    pub(crate) fn sqlite_value(&self) -> Value {
        if let Some(value) = self.as_scalar() {
            return Value::Text(value);
        }
        let count = u32::try_from(self.0.len()).expect("bounded manifest text");
        let mut bytes = Vec::with_capacity(9 + self.0.len() * 2);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&count.to_be_bytes());
        for unit in &self.0 {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        Value::Blob(bytes)
    }
}

pub(crate) fn read_manifest_text(value: ValueRef<'_>) -> Result<Option<JsText>> {
    match value {
        ValueRef::Null => Ok(None),
        ValueRef::Text(bytes) => Ok(Some(JsText::scalar(std::str::from_utf8(bytes)?))),
        ValueRef::Blob(bytes) => {
            ensure!(
                bytes.len() >= 9 && bytes.starts_with(MAGIC),
                "Invalid PPJS manifest text header"
            );
            let count = u32::from_be_bytes(bytes[5..9].try_into()?);
            let count = usize::try_from(count)?;
            ensure!(count <= MAX_UNITS, "PPJS manifest text exceeds unit budget");
            ensure!(
                bytes.len() == 9 + count * 2,
                "Invalid PPJS manifest text length"
            );
            let units = bytes[9..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
                .collect();
            let value = JsText::from_units(units);
            ensure!(
                value.as_scalar().is_none(),
                "Scalar manifest text must use SQLite TEXT"
            );
            ensure!(
                value.sqlite_value() == Value::Blob(bytes.to_vec()),
                "Noncanonical PPJS manifest text"
            );
            Ok(Some(value))
        }
        _ => bail!("Manifest text must use NULL, TEXT or canonical PPJS BLOB"),
    }
}

#[cfg(test)]
mod carrier_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn typed_scalar_part_bytes_and_planning_digest_equal_legacy_value() {
        let fields = crate::required_units::model::PART_FIELDS;
        let mut legacy = serde_json::Map::new();
        legacy.insert("baseRevisionPartId".into(), json!(null));
        for field in fields {
            legacy.insert((*field).into(), serde_json::Value::Null);
        }
        legacy.insert("partKey".into(), json!("a.stl"));
        legacy.insert("included".into(), json!(true));
        for text in [
            "ordinary",
            "literal PPJS text",
            "\u{e000}uD800\u{e000}",
            "😀",
            "\\uD800",
            "a\n\t\u{0001}b",
        ] {
            legacy.insert("requirement".into(), json!(text));
            legacy.insert("optionGroupId".into(), json!(text));
            legacy.insert("manifestSource".into(), json!("repo"));
            let mut ordinary = legacy.clone();
            for key in ["requirement", "optionGroupId", "manifestSource"] {
                ordinary.remove(key);
            }
            let part = DraftPart::new(
                ordinary.into(),
                PartManifestMetadata {
                    requirement: Some(ManifestText(JsText::scalar(text))),
                    option_group_id: Some(OptionGroupId(JsText::scalar(text))),
                    manifest_source: Some("repo".into()),
                },
            );
            let all = [vec!["baseRevisionPartId"], fields.to_vec()].concat();
            assert_eq!(
                part.json_fields(&all, false),
                serde_json::to_vec(&legacy).unwrap()
            );
            let header = json!({"baseRevisionId":null,"basePlanVersion":0});
            let expected = crate::required_units::model::digest(
                &json!({"format":"plan-draft-v1","base_revision_id":null,"base_plan_version":0,"inputs":[],"parts":[legacy.clone()]}),
            );
            assert_eq!(
                crate::required_units::model::planning(&header, &[], &[part]),
                expected
            );
        }
    }
    #[test]
    fn typed_both_metadata_fields_write_distinct_lowercase_units() {
        let part = DraftPart::new(
            json!({"partKey":"custom.stl"}),
            PartManifestMetadata {
                requirement: Some(ManifestText(JsText::from_units(vec![0xd801]))),
                option_group_id: Some(OptionGroupId(JsText::from_units(vec![0xd800]))),
                manifest_source: Some("repo".into()),
            },
        );
        assert_eq!(part.json_fields(&["requirement","optionGroupId","partKey","manifestSource"],false),br#"{"requirement":"\ud801","optionGroupId":"\ud800","partKey":"custom.stl","manifestSource":"repo"}"#);
        let bindings = part.sql_fields(&["requirement", "optionGroupId"]).unwrap();
        for (_, value) in bindings {
            let Value::Blob(bytes) = value else {
                panic!("non scalar blob")
            };
            assert!(
                read_manifest_text(ValueRef::Blob(&bytes))
                    .unwrap()
                    .unwrap()
                    .as_scalar()
                    .is_none()
            );
        }
    }
}
