use serde::Serialize;
use serde_json::value::RawValue;
use std::fmt::Write;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileKind {
    Printer,
    Process,
    Filament,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SlicerKind {
    Orca,
    Prusa,
    Bambu,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsText {
    utf16: Vec<u16>,
}

impl JsText {
    pub fn from_utf16(utf16: Vec<u16>) -> Self {
        Self { utf16 }
    }

    pub fn from_string(value: impl AsRef<str>) -> Self {
        Self {
            utf16: value.as_ref().encode_utf16().collect(),
        }
    }

    pub fn as_utf16(&self) -> &[u16] {
        &self.utf16
    }

    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.utf16)
    }

    pub fn to_node_json_string(&self) -> String {
        let mut output = String::from("\"");
        let mut index = 0;
        while index < self.utf16.len() {
            let unit = self.utf16[index];
            match unit {
                0x0008 => output.push_str("\\b"),
                0x0009 => output.push_str("\\t"),
                0x000a => output.push_str("\\n"),
                0x000c => output.push_str("\\f"),
                0x000d => output.push_str("\\r"),
                0x0022 => output.push_str("\\\""),
                0x005c => output.push_str("\\\\"),
                0x0000..=0x001f => write!(output, "\\u{unit:04x}").expect("write to string"),
                0xd800..=0xdbff
                    if self
                        .utf16
                        .get(index + 1)
                        .is_some_and(|next| matches!(next, 0xdc00..=0xdfff)) =>
                {
                    let low = self.utf16[index + 1];
                    let scalar =
                        0x1_0000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                    output.push(char::from_u32(scalar).expect("valid surrogate pair"));
                    index += 1;
                }
                0xd800..=0xdfff => {
                    write!(output, "\\u{unit:04x}").expect("write to string");
                }
                _ => output.push(char::from_u32(u32::from(unit)).expect("valid BMP scalar")),
            }
            index += 1;
        }
        output.push('"');
        output
    }

    pub fn is_empty(&self) -> bool {
        self.utf16.is_empty()
    }
}

impl Serialize for JsText {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        RawValue::from_string(self.to_node_json_string())
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JsInteger(f64);

impl JsInteger {
    pub fn new(value: f64) -> Result<Self, ImportShapeError> {
        if !value.is_finite() || value.fract() != 0.0 {
            return Err(ImportShapeError::NonIntegralNumber);
        }
        Ok(Self(if value == 0.0 { 0.0 } else { value }))
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

impl Serialize for JsInteger {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_f64(self.0)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportProvenance {
    pub name: JsText,
    pub slicer_version: Option<JsText>,
    pub resolved_flat_config: JsText,
    pub source_path: JsText,
}

#[derive(Clone, Debug, Serialize)]
pub struct PrinterImportInput {
    pub provenance: ImportProvenance,
    pub slicer_format: SlicerKind,
    pub nozzle_diameter_mm: Option<JsText>,
    pub extruder_count: Option<JsInteger>,
    pub raw_json: Option<JsText>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProcessImportInput {
    pub provenance: ImportProvenance,
    pub slicer_format: SlicerKind,
    pub compatible_printers: Option<JsText>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FilamentImportInput {
    pub provenance: ImportProvenance,
    pub material_type: JsText,
    pub nozzle_temp_c: Option<JsInteger>,
    pub bed_temp_c: Option<JsInteger>,
    pub fan_pct: Option<JsInteger>,
    pub extrusion_multiplier: Option<JsText>,
    pub pressure_advance: Option<JsText>,
    pub retraction: Option<JsText>,
    pub raw: RawFilamentSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "format", content = "value", rename_all = "lowercase")]
pub enum RawFilamentSource {
    Json(JsText),
    Ini(JsText),
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ProfileImportInner {
    Printer(PrinterImportInput),
    Process(ProcessImportInput),
    Filament(FilamentImportInput),
}

#[derive(Clone, Debug, Serialize)]
pub struct ProfileImport(ProfileImportInner);

impl ProfileImport {
    pub fn printer(input: PrinterImportInput) -> Result<Self, ImportShapeError> {
        validate_provenance(&input.provenance)?;
        Ok(Self(ProfileImportInner::Printer(input)))
    }

    pub fn process(input: ProcessImportInput) -> Result<Self, ImportShapeError> {
        validate_provenance(&input.provenance)?;
        Ok(Self(ProfileImportInner::Process(input)))
    }

    pub fn filament(input: FilamentImportInput) -> Result<Self, ImportShapeError> {
        validate_provenance(&input.provenance)?;
        Ok(Self(ProfileImportInner::Filament(input)))
    }

    pub fn kind(&self) -> ProfileKind {
        match self.0 {
            ProfileImportInner::Printer(_) => ProfileKind::Printer,
            ProfileImportInner::Process(_) => ProfileKind::Process,
            ProfileImportInner::Filament(_) => ProfileKind::Filament,
        }
    }
}

fn validate_provenance(provenance: &ImportProvenance) -> Result<(), ImportShapeError> {
    if provenance.name.is_empty() {
        return Err(ImportShapeError::EmptyName);
    }
    if provenance.source_path.is_empty() {
        return Err(ImportShapeError::EmptySourcePath);
    }
    let resolved = String::from_utf16(provenance.resolved_flat_config.as_utf16())
        .map_err(|_| ImportShapeError::InvalidResolvedJson)?;
    RawValue::from_string(resolved).map_err(|_| ImportShapeError::InvalidResolvedJson)?;
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportShapeError {
    EmptyName,
    EmptySourcePath,
    InvalidResolvedJson,
    NonIntegralNumber,
}
