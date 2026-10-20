//! UTF-16 manifest text carriers and their JSON and SQLite encodings.
//!
//! Available only with `desktop_rebuild`. Runtime consumers must also check
//! `PP_DESKTOP_REBUILD` before exposing desktop rebuild behavior.

use anyhow::{Result, bail, ensure};
use rusqlite::types::{Value, ValueRef};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct JsText(Vec<u16>);

impl JsText {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }

    pub fn scalar(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }

    pub fn units(&self) -> &[u16] {
        &self.0
    }

    pub fn identifier_label(&self) -> ManifestText {
        ManifestText(Self(
            self.0
                .iter()
                .map(|unit| if *unit == 0x5f { 0x20 } else { *unit })
                .collect(),
        ))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn as_scalar(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }

    pub fn trim_ecmascript(mut self) -> Self {
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

    pub fn is_ecmascript_blank(&self) -> bool {
        self.0.iter().all(|unit| is_ecmascript_whitespace(*unit))
    }

    pub fn write_json(&self, output: &mut Vec<u8>) {
        output.push(b'"');
        for decoded in char::decode_utf16(self.0.iter().copied()) {
            match decoded {
                Ok('"') => output.extend_from_slice(br#"\""#),
                Ok('\\') => output.extend_from_slice(br#"\\"#),
                Ok('\u{0008}') => output.extend_from_slice(br#"\b"#),
                Ok('\t') => output.extend_from_slice(br#"\t"#),
                Ok('\n') => output.extend_from_slice(br#"\n"#),
                Ok('\u{000c}') => output.extend_from_slice(br#"\f"#),
                Ok('\r') => output.extend_from_slice(br#"\r"#),
                Ok(control @ '\u{0000}'..='\u{001f}') => write_escape(control as u16, output),
                Ok(value) => {
                    let mut bytes = [0; 4];
                    output.extend_from_slice(value.encode_utf8(&mut bytes).as_bytes());
                }
                Err(error) => write_escape(error.unpaired_surrogate(), output),
            }
        }
        output.push(b'"');
    }

    pub fn array_index(&self) -> Option<u32> {
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
pub struct OptionGroupId(pub JsText);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct VariantId(pub JsText);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestText(pub JsText);

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
pub struct PartManifestMetadata {
    pub requirement: Option<ManifestText>,
    pub option_group_id: Option<OptionGroupId>,
    pub manifest_source: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DraftPart {
    pub scalar: serde_json::Value,
    pub manifest: PartManifestMetadata,
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
    /// Keeps manifest metadata separate from ordinary JSON fields.
    ///
    /// # Panics
    /// Panics if `scalar` contains a manifest metadata field or its snake-case alias.
    pub fn new(scalar: serde_json::Value, manifest: PartManifestMetadata) -> Self {
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

    pub fn same_field(&self, other: &Self, field: &str) -> bool {
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

    pub fn projected(&self, fields: &[&str]) -> Self {
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

    pub fn json_fields(&self, fields: &[&str], snake: bool) -> Vec<u8> {
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
                    serde_json::Value::from(self.manifest.manifest_source.clone())
                        .to_string()
                        .as_bytes(),
                ),
                "quantityInferred" | "quantityOverride" | "quantityEffective"
                | "quantity_inferred" | "quantity_override" | "quantity_effective" => {
                    match self.scalar[*field].as_f64() {
                        Some(quantity) => output
                            .extend_from_slice(ryu_js::Buffer::new().format(quantity).as_bytes()),
                        None => {
                            output.extend_from_slice(self.scalar[*field].to_string().as_bytes())
                        }
                    }
                }
                _ => output.extend_from_slice(self.scalar[*field].to_string().as_bytes()),
            }
        }
        output.push(b'}');
        output
    }

    pub fn sql_fields(&self, fields: &[&str]) -> anyhow::Result<Vec<(String, Value)>> {
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
                            .map(|v| v.0.sqlite_value())
                            .transpose()?
                            .unwrap_or(Value::Null),
                        "optionGroupId" | "option_group_id" => self
                            .manifest
                            .option_group_id
                            .as_ref()
                            .map(|v| v.0.sqlite_value())
                            .transpose()?
                            .unwrap_or(Value::Null),
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

fn write_nullable(value: Option<&JsText>, output: &mut Vec<u8>) {
    match value {
        Some(value) => value.write_json(output),
        None => output.extend_from_slice(b"null"),
    }
}

/// Compares UTF-8 JSON bytes in UTF-16 code-unit order without parsing the JSON.
/// Returns an error if either byte slice is invalid UTF-8.
pub fn compare_json_bytes(a: &[u8], b: &[u8]) -> Result<std::cmp::Ordering> {
    Ok(std::str::from_utf8(a)?
        .encode_utf16()
        .cmp(std::str::from_utf8(b)?.encode_utf16()))
}

pub fn digest_json_bytes(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

pub(crate) fn is_ecmascript_whitespace(unit: u16) -> bool {
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
    /// Encodes scalar text as TEXT and non-scalar text as a versioned PPJS BLOB.
    /// Returns an error if non-scalar text exceeds the 8,388,608-unit budget.
    pub fn sqlite_value(&self) -> Result<Value> {
        if let Some(value) = self.as_scalar() {
            return Ok(Value::Text(value));
        }
        ensure!(
            self.0.len() <= MAX_UNITS,
            "PPJS manifest text exceeds unit budget"
        );
        let count = u32::try_from(self.0.len())?;
        let mut bytes = Vec::with_capacity(9 + self.0.len() * 2);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&count.to_be_bytes());
        for unit in &self.0 {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        Ok(Value::Blob(bytes))
    }
}

pub fn read_manifest_text(value: ValueRef<'_>) -> Result<Option<JsText>> {
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
                value.sqlite_value()? == Value::Blob(bytes.to_vec()),
                "Noncanonical PPJS manifest text"
            );
            Ok(Some(value))
        }
        _ => bail!("Manifest text must use NULL, TEXT or canonical PPJS BLOB"),
    }
}

#[cfg(test)]
mod tests;
