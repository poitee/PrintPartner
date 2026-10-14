use pp_storage::profiles::{
    FilamentImportInput, ImportProvenance, JsInteger, JsText, PrinterImportInput,
    ProcessImportInput, ProfileImport, ProfileKind, RawFilamentSource, SlicerKind,
};

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESOLVED_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;
const MAX_KEY_UNITS: usize = 64 * 1024;
const MAX_SCALAR_UNITS: usize = 1024 * 1024;
const MAX_SCALAR_DEPTH: usize = 64;
const MAX_JSON_DEPTH: usize = 128;

pub struct ProfileDocument<'a> {
    bytes: &'a [u8],
    kind_hint: ProfileKind,
    slicer: SlicerKind,
    source_label: &'a str,
}

impl<'a> ProfileDocument<'a> {
    pub fn new(
        bytes: &'a [u8],
        kind_hint: ProfileKind,
        slicer: SlicerKind,
        source_label: &'a str,
    ) -> Result<Self, ProfileInterpretError> {
        if source_label.is_empty() {
            return Err(ProfileInterpretError::EmptySourceLabel);
        }
        Ok(Self {
            bytes,
            kind_hint,
            slicer,
            source_label,
        })
    }
}

#[derive(Debug)]
pub enum ProfileInterpretation {
    Ready(ProfileImport),
    NeedsParent(PendingProfile),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParentFileRequest {
    file_stem: JsText,
}

impl ParentFileRequest {
    pub fn file_stem(&self) -> &JsText {
        &self.file_stem
    }
}

#[derive(Debug)]
pub struct PendingProfile {
    request: ParentFileRequest,
    child: CheckedChild,
}

impl PendingProfile {
    pub fn request(&self) -> &ParentFileRequest {
        &self.request
    }

    pub fn finish_without_parent(self) -> Result<ProfileImport, ProfileInterpretError> {
        let resolved = self.child.own.clone();
        self.child.into_import(resolved)
    }

    pub fn finish_with_parent(
        self,
        parent_bytes: &[u8],
    ) -> Result<ProfileImport, ProfileInterpretError> {
        let resolved = match parse_parent(parent_bytes) {
            Some(parent) => merge(parent, &self.child.own)?,
            None => self.child.own.clone(),
        };
        self.child.into_import(resolved)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileInterpretError {
    EmptySourceLabel,
    DocumentTooLarge,
    InvalidJson,
    JsonNestingLimit,
    TooManyEntries,
    KeyTooLarge,
    ScalarTooLarge,
    ScalarDepthLimit,
    ResolvedDocumentTooLarge,
    InvalidStorageShape,
}

pub fn interpret_profile(
    document: ProfileDocument<'_>,
) -> Result<ProfileInterpretation, ProfileInterpretError> {
    if document.bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(ProfileInterpretError::DocumentTooLarge);
    }
    let raw = String::from_utf8_lossy(document.bytes).into_owned();
    let format = if ecma_trim_start(&raw).starts_with('{') {
        SourceFormat::Json
    } else {
        SourceFormat::Ini
    };
    let own = match format {
        SourceFormat::Json => parse_json_flat(&raw)?,
        SourceFormat::Ini => parse_ini_flat(&raw)?,
    };
    let kind = profile_kind(own.get_ascii("type"), document.kind_hint);
    let name = own
        .get_ascii("name")
        .filter(|name| !name.is_empty())
        .or_else(|| {
            own.get_ascii("print_settings_id")
                .filter(|name| !name.is_empty())
        })
        .cloned()
        .unwrap_or_else(|| JsText::from_string("Unnamed"));
    let version = match format {
        SourceFormat::Json => own.get_ascii("version").cloned(),
        SourceFormat::Ini => ini_version(&raw).map(JsText::from_string),
    };
    let child = CheckedChild {
        format,
        kind,
        slicer: document.slicer,
        name,
        version,
        raw,
        source_label: document.source_label.to_owned(),
        own,
    };
    if format == SourceFormat::Json
        && child
            .own
            .get_ascii("inherits")
            .is_some_and(|value| !value.is_empty())
    {
        return Ok(ProfileInterpretation::NeedsParent(PendingProfile {
            request: ParentFileRequest {
                file_stem: child.own.get_ascii("inherits").expect("checked").clone(),
            },
            child,
        }));
    }
    let resolved = child.own.clone();
    Ok(ProfileInterpretation::Ready(child.into_import(resolved)?))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceFormat {
    Json,
    Ini,
}

#[derive(Clone, Debug)]
struct CheckedChild {
    format: SourceFormat,
    kind: ProfileKind,
    slicer: SlicerKind,
    name: JsText,
    version: Option<JsText>,
    raw: String,
    source_label: String,
    own: NodeFlatObject,
}

impl CheckedChild {
    fn into_import(self, resolved: NodeFlatObject) -> Result<ProfileImport, ProfileInterpretError> {
        let resolved_flat_config = serialize_flat(&resolved)?;
        let provenance = ImportProvenance {
            name: self.name.clone(),
            slicer_version: self.version,
            resolved_flat_config: JsText::from_string(resolved_flat_config),
            source_path: JsText::from_string(self.source_label),
        };
        let raw = JsText::from_string(self.raw);
        match self.kind {
            ProfileKind::Printer => ProfileImport::printer(PrinterImportInput {
                provenance,
                slicer_format: self.slicer,
                nozzle_diameter_mm: first_number(
                    &self.own,
                    &["nozzle_diameter", "nozzle_diameter_mm"],
                )
                .map(js_number)
                .map(JsText::from_string),
                extruder_count: first_number(&self.own, &["extruder_count"])
                    .map(|value| js_integer(value.trunc()))
                    .transpose()?,
                raw_json: (self.format == SourceFormat::Json).then_some(raw),
            })
            .map_err(|_| ProfileInterpretError::InvalidStorageShape),
            ProfileKind::Process => ProfileImport::process(ProcessImportInput {
                provenance,
                slicer_format: self.slicer,
                compatible_printers: self.own.get_ascii("compatible_printers").cloned(),
            })
            .map_err(|_| ProfileInterpretError::InvalidStorageShape),
            ProfileKind::Filament => {
                let fan = first_number(&self.own, &["fan_pct", "cooling"]).or_else(|| {
                    self.own
                        .get_ascii("fan_always_on")
                        .is_some_and(|value| ascii_eq(value, "1"))
                        .then_some(100.0)
                });
                ProfileImport::filament(FilamentImportInput {
                    provenance,
                    material_type: JsText::from_string(infer_material(
                        &self.name.to_string_lossy(),
                    )),
                    nozzle_temp_c: rounded_number(first_number(
                        &self.own,
                        &[
                            "nozzle_temperature",
                            "nozzle_temperature_initial_layer",
                            "temperature",
                            "nozzle_temp_c",
                        ],
                    ))?,
                    bed_temp_c: rounded_number(first_number(
                        &self.own,
                        &[
                            "bed_temperature",
                            "bed_temperature_initial_layer",
                            "bed_temp_c",
                        ],
                    ))?,
                    fan_pct: rounded_number(fan)?,
                    extrusion_multiplier: first_number(
                        &self.own,
                        &["filament_flow_ratio", "extrusion_multiplier"],
                    )
                    .map(js_number)
                    .map(JsText::from_string),
                    pressure_advance: first_number(
                        &self.own,
                        &["pressure_advance", "filament_pressure_advance"],
                    )
                    .map(js_number)
                    .map(JsText::from_string),
                    retraction: first_number(
                        &self.own,
                        &["filament_retraction_length", "retraction_length_mm"],
                    )
                    .map(js_number)
                    .map(JsText::from_string),
                    raw: match self.format {
                        SourceFormat::Json => RawFilamentSource::Json(raw),
                        SourceFormat::Ini => RawFilamentSource::Ini(raw),
                    },
                })
                .map_err(|_| ProfileInterpretError::InvalidStorageShape)
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
struct NodeFlatObject {
    entries: Vec<(JsText, JsText)>,
}

impl NodeFlatObject {
    fn assign(&mut self, key: JsText, value: JsText) -> Result<(), ProfileInterpretError> {
        if ascii_eq(&key, "__proto__") {
            return Ok(());
        }
        if key.as_utf16().len() > MAX_KEY_UNITS {
            return Err(ProfileInterpretError::KeyTooLarge);
        }
        if value.as_utf16().len() > MAX_SCALAR_UNITS {
            return Err(ProfileInterpretError::ScalarTooLarge);
        }
        if let Some((_, current)) = self.entries.iter_mut().find(|(current, _)| current == &key) {
            *current = value;
            return Ok(());
        }
        if self.entries.len() == MAX_ENTRIES {
            return Err(ProfileInterpretError::TooManyEntries);
        }
        self.entries.push((key, value));
        Ok(())
    }
    fn get_ascii(&self, key: &str) -> Option<&JsText> {
        let key: Vec<_> = key.encode_utf16().collect();
        self.entries
            .iter()
            .find_map(|(candidate, value)| (candidate.as_utf16() == key).then_some(value))
    }
    fn ordered(&self) -> Vec<(&JsText, &JsText)> {
        let mut indexes: Vec<_> = self
            .entries
            .iter()
            .filter(|(key, _)| array_index(key).is_some())
            .collect();
        indexes.sort_by_key(|(key, _)| array_index(key).expect("filtered"));
        indexes
            .into_iter()
            .chain(
                self.entries
                    .iter()
                    .filter(|(key, _)| array_index(key).is_none()),
            )
            .map(|(key, value)| (key, value))
            .collect()
    }
}

fn parse_json_flat(raw: &str) -> Result<NodeFlatObject, ProfileInterpretError> {
    let value = JsonParser::new(raw).parse()?;
    flatten_top(&value)
}

fn parse_parent(bytes: &[u8]) -> Option<NodeFlatObject> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return None;
    }
    parse_json_flat(&String::from_utf8_lossy(bytes)).ok()
}

#[derive(Clone, Debug)]
enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(JsText),
    Array(Vec<JsValue>),
    Object(Vec<(JsText, JsValue)>),
}

struct JsonParser<'a> {
    raw: &'a str,
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(raw: &'a str) -> Self {
        Self { raw, position: 0 }
    }

    fn parse(mut self) -> Result<JsValue, ProfileInterpretError> {
        self.skip_whitespace();
        let value = self.parse_value(0)?;
        self.skip_whitespace();
        if self.position != self.raw.len() {
            return Err(ProfileInterpretError::InvalidJson);
        }
        Ok(value)
    }

    fn parse_value(&mut self, depth: usize) -> Result<JsValue, ProfileInterpretError> {
        if depth > MAX_JSON_DEPTH {
            return Err(ProfileInterpretError::JsonNestingLimit);
        }
        self.skip_whitespace();
        match self.peek() {
            Some(b'"') => self.parse_string().map(JsValue::String),
            Some(b'{') => self.parse_object(depth + 1),
            Some(b'[') => self.parse_array(depth + 1),
            Some(b't') => {
                self.literal("true")?;
                Ok(JsValue::Bool(true))
            }
            Some(b'f') => {
                self.literal("false")?;
                Ok(JsValue::Bool(false))
            }
            Some(b'n') => {
                self.literal("null")?;
                Ok(JsValue::Null)
            }
            Some(b'-' | b'0'..=b'9') => self.parse_number().map(JsValue::Number),
            _ => Err(ProfileInterpretError::InvalidJson),
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<JsValue, ProfileInterpretError> {
        self.position += 1;
        self.skip_whitespace();
        let mut entries = Vec::new();
        if self.consume(b'}') {
            return Ok(JsValue::Object(entries));
        }
        loop {
            if self.peek() != Some(b'"') {
                return Err(ProfileInterpretError::InvalidJson);
            }
            let key = self.parse_string()?;
            self.skip_whitespace();
            if !self.consume(b':') {
                return Err(ProfileInterpretError::InvalidJson);
            }
            let value = self.parse_value(depth)?;
            if let Some((_, current)) = entries.iter_mut().find(|(current, _)| current == &key) {
                *current = value;
            } else {
                entries.push((key, value));
            }
            self.skip_whitespace();
            if self.consume(b'}') {
                return Ok(JsValue::Object(entries));
            }
            if !self.consume(b',') {
                return Err(ProfileInterpretError::InvalidJson);
            }
            self.skip_whitespace();
        }
    }

    fn parse_array(&mut self, depth: usize) -> Result<JsValue, ProfileInterpretError> {
        self.position += 1;
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.consume(b']') {
            return Ok(JsValue::Array(values));
        }
        loop {
            values.push(self.parse_value(depth)?);
            self.skip_whitespace();
            if self.consume(b']') {
                return Ok(JsValue::Array(values));
            }
            if !self.consume(b',') {
                return Err(ProfileInterpretError::InvalidJson);
            }
            self.skip_whitespace();
        }
    }

    fn parse_string(&mut self) -> Result<JsText, ProfileInterpretError> {
        self.position += 1;
        let mut units = Vec::new();
        loop {
            let byte = self.peek().ok_or(ProfileInterpretError::InvalidJson)?;
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(JsText::from_utf16(units));
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self.peek().ok_or(ProfileInterpretError::InvalidJson)?;
                    self.position += 1;
                    match escaped {
                        b'"' | b'\\' | b'/' => units.push(u16::from(escaped)),
                        b'b' => units.push(0x0008),
                        b'f' => units.push(0x000c),
                        b'n' => units.push(0x000a),
                        b'r' => units.push(0x000d),
                        b't' => units.push(0x0009),
                        b'u' => units.push(self.parse_hex_unit()?),
                        _ => return Err(ProfileInterpretError::InvalidJson),
                    }
                }
                0x00..=0x1f => return Err(ProfileInterpretError::InvalidJson),
                _ => {
                    let character = self.raw[self.position..]
                        .chars()
                        .next()
                        .ok_or(ProfileInterpretError::InvalidJson)?;
                    units.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
                    self.position += character.len_utf8();
                }
            }
        }
    }

    fn parse_hex_unit(&mut self) -> Result<u16, ProfileInterpretError> {
        let end = self
            .position
            .checked_add(4)
            .filter(|end| *end <= self.raw.len())
            .ok_or(ProfileInterpretError::InvalidJson)?;
        let digits = &self.raw.as_bytes()[self.position..end];
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return Err(ProfileInterpretError::InvalidJson);
        }
        self.position = end;
        let digits = std::str::from_utf8(digits).expect("ASCII hex digits");
        u16::from_str_radix(digits, 16).map_err(|_| ProfileInterpretError::InvalidJson)
    }

    fn parse_number(&mut self) -> Result<f64, ProfileInterpretError> {
        let start = self.position;
        self.consume(b'-');
        match self.peek() {
            Some(b'0') => {
                self.position += 1;
                if self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    return Err(ProfileInterpretError::InvalidJson);
                }
            }
            Some(b'1'..=b'9') => {
                self.position += 1;
                while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    self.position += 1;
                }
            }
            _ => return Err(ProfileInterpretError::InvalidJson),
        }
        if self.consume(b'.') {
            let fraction = self.position;
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.position += 1;
            }
            if self.position == fraction {
                return Err(ProfileInterpretError::InvalidJson);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            let exponent = self.position;
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.position += 1;
            }
            if self.position == exponent {
                return Err(ProfileInterpretError::InvalidJson);
            }
        }
        self.raw[start..self.position]
            .parse()
            .map_err(|_| ProfileInterpretError::InvalidJson)
    }

    fn literal(&mut self, literal: &str) -> Result<(), ProfileInterpretError> {
        if self.raw[self.position..].starts_with(literal) {
            self.position += literal.len();
            Ok(())
        } else {
            Err(ProfileInterpretError::InvalidJson)
        }
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.raw.as_bytes().get(self.position).copied()
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }
}

fn flatten_top(value: &JsValue) -> Result<NodeFlatObject, ProfileInterpretError> {
    let mut result = NodeFlatObject::default();
    match value {
        JsValue::Object(object) => {
            for (key, value) in object {
                if let Some(value) = scalar(value, 0)? {
                    result.assign(key.clone(), value)?;
                }
            }
        }
        JsValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                if let Some(value) = scalar(value, 0)? {
                    result.assign(JsText::from_string(index.to_string()), value)?;
                }
            }
        }
        JsValue::String(value) => {
            for (index, unit) in value.as_utf16().iter().copied().enumerate() {
                result.assign(
                    JsText::from_string(index.to_string()),
                    JsText::from_utf16(vec![unit]),
                )?;
            }
        }
        JsValue::Null => return Err(ProfileInterpretError::InvalidJson),
        JsValue::Bool(_) | JsValue::Number(_) => {}
    }
    Ok(result)
}

fn scalar(value: &JsValue, depth: usize) -> Result<Option<JsText>, ProfileInterpretError> {
    if depth > MAX_SCALAR_DEPTH {
        return Err(ProfileInterpretError::ScalarDepthLimit);
    }
    let scalar = match value {
        JsValue::Null => None,
        JsValue::String(value) => Some(value.clone()),
        JsValue::Bool(value) => Some(JsText::from_string(value.to_string())),
        JsValue::Number(number) => Some(JsText::from_string(js_number(*number))),
        JsValue::Array(values) => values
            .first()
            .map(|value| scalar(value, depth + 1))
            .transpose()?
            .flatten(),
        JsValue::Object(object) => object
            .iter()
            .rev()
            .find(|(key, _)| ascii_eq(key, "value"))
            .map(|(_, value)| value)
            .filter(|value| !matches!(value, JsValue::Null))
            .map(|value| scalar(value, depth + 1))
            .transpose()?
            .flatten(),
    };
    if scalar
        .as_ref()
        .is_some_and(|value| value.as_utf16().len() > MAX_SCALAR_UNITS)
    {
        return Err(ProfileInterpretError::ScalarTooLarge);
    }
    Ok(scalar)
}

fn parse_ini_flat(raw: &str) -> Result<NodeFlatObject, ProfileInterpretError> {
    let mut flat = NodeFlatObject::default();
    for line in raw.split('\n') {
        let line = ecma_trim(line);
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some(index) = line.find('=') else {
            continue;
        };
        if index == 0 {
            continue;
        }
        let key = ecma_trim(&line[..index]);
        if key.is_empty() {
            continue;
        }
        flat.assign(
            JsText::from_string(key),
            JsText::from_string(ecma_trim(&line[index + 1..])),
        )?;
    }
    Ok(flat)
}

fn merge(
    parent: NodeFlatObject,
    child: &NodeFlatObject,
) -> Result<NodeFlatObject, ProfileInterpretError> {
    let mut resolved = NodeFlatObject::default();
    for (key, value) in parent.ordered().into_iter().chain(child.ordered()) {
        resolved.assign(key.clone(), value.clone())?;
    }
    Ok(resolved)
}

fn serialize_flat(flat: &NodeFlatObject) -> Result<String, ProfileInterpretError> {
    let mut output = String::from("{");
    for (index, (key, value)) in flat.ordered().into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&key.to_node_json_string());
        output.push(':');
        output.push_str(&value.to_node_json_string());
    }
    output.push('}');
    if output.len() > MAX_RESOLVED_BYTES {
        return Err(ProfileInterpretError::ResolvedDocumentTooLarge);
    }
    Ok(output)
}

fn profile_kind(raw: Option<&JsText>, fallback: ProfileKind) -> ProfileKind {
    match raw
        .map(JsText::to_string_lossy)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "machine" | "printer" => ProfileKind::Printer,
        "process" | "print" => ProfileKind::Process,
        "filament" => ProfileKind::Filament,
        _ => fallback,
    }
}

fn ini_version(raw: &str) -> Option<String> {
    static EXPRESSION: std::sync::OnceLock<regress::Regex> = std::sync::OnceLock::new();
    let expression = EXPRESSION.get_or_init(|| {
        regress::Regex::with_flags(
            r"generated by\s+(?:PrusaSlicer|BambuStudio|OrcaSlicer)\s+([^\s]+)",
            "i",
        )
        .expect("static generated-by expression")
    });
    expression
        .find(raw)
        .and_then(|matched| matched.captures.first().cloned().flatten())
        .map(|version| raw[version].to_owned())
}

fn first_number(flat: &NodeFlatObject, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| flat.get_ascii(key).and_then(parse_float_prefix))
}

fn parse_float_prefix(raw: &JsText) -> Option<f64> {
    let raw = raw.to_string_lossy();
    let value = ecma_trim_start(&raw);
    let bytes = value.as_bytes();
    let mut position = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        position += 1;
    }
    if value[position..].starts_with("Infinity") {
        return None;
    }
    let start_digits = position;
    while bytes.get(position).is_some_and(u8::is_ascii_digit) {
        position += 1;
    }
    let before = position > start_digits;
    if bytes.get(position) == Some(&b'.') {
        position += 1;
        while bytes.get(position).is_some_and(u8::is_ascii_digit) {
            position += 1;
        }
    }
    if !before && !(position > start_digits + 1 && bytes.get(start_digits) == Some(&b'.')) {
        return None;
    }
    let mantissa_end = position;
    if matches!(bytes.get(position), Some(b'e' | b'E')) {
        let exponent_start = position;
        position += 1;
        if matches!(bytes.get(position), Some(b'+' | b'-')) {
            position += 1;
        }
        let digits = position;
        while bytes.get(position).is_some_and(u8::is_ascii_digit) {
            position += 1;
        }
        if digits == position {
            position = exponent_start;
        }
    }
    let end = position.max(mantissa_end);
    value[..end]
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value == f64::INFINITY {
        "Infinity".to_owned()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_owned()
    } else if value == 0.0 {
        "0".to_owned()
    } else {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    }
}
fn js_integer(value: f64) -> Result<JsInteger, ProfileInterpretError> {
    JsInteger::new(if value == 0.0 { 0.0 } else { value })
        .map_err(|_| ProfileInterpretError::InvalidStorageShape)
}
fn rounded_number(value: Option<f64>) -> Result<Option<JsInteger>, ProfileInterpretError> {
    value
        .map(|value| {
            let lower = value.floor();
            js_integer(if value - lower < 0.5 {
                lower
            } else {
                value.ceil()
            })
        })
        .transpose()
}

fn infer_material(name: &str) -> &'static str {
    let upper = name.to_uppercase();
    [
        "PLA", "PETG", "ABS", "ASA", "TPU", "PC", "NYLON", "PVA", "HIPS", "PCTG",
    ]
    .into_iter()
    .find(|candidate| ascii_word_match(&upper, candidate))
    .unwrap_or("Generic")
}

fn ascii_word_match(text: &str, needle: &str) -> bool {
    text.match_indices(needle).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + needle.len()..].chars().next();
        !before.is_some_and(ascii_word) && !after.is_some_and(ascii_word)
    })
}
fn ascii_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}
fn array_index(key: &JsText) -> Option<u32> {
    let key = ascii_text(key)?;
    if key == "0" {
        return Some(0);
    }
    if key.starts_with('0') || key.is_empty() {
        return None;
    }
    key.parse::<u32>()
        .ok()
        .filter(|value| *value < u32::MAX)
        .filter(|value| value.to_string() == key)
}
fn ascii_text(value: &JsText) -> Option<String> {
    value
        .as_utf16()
        .iter()
        .copied()
        .map(|unit| u8::try_from(unit).ok().filter(u8::is_ascii).map(char::from))
        .collect()
}
fn ascii_eq(value: &JsText, expected: &str) -> bool {
    value.as_utf16().iter().copied().eq(expected.encode_utf16())
}
fn is_ecma_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}
fn ecma_trim_start(value: &str) -> &str {
    value.trim_start_matches(is_ecma_whitespace)
}
fn ecma_trim(value: &str) -> &str {
    value.trim_matches(is_ecma_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(raw: &str, kind: ProfileKind) -> ProfileDocument<'_> {
        ProfileDocument::new(raw.as_bytes(), kind, SlicerKind::Orca, "owned/profile").unwrap()
    }
    #[test]
    fn negative_half_rounding_matches_javascript() {
        assert_eq!(rounded_number(Some(-0.5)).unwrap().unwrap().value(), 0.0);
        assert_eq!(rounded_number(Some(-1.5)).unwrap().unwrap().value(), -1.0);
    }

    #[test]
    fn rounding_matches_javascript_at_binary_representation_edges() {
        for (input, expected) in [
            (0.499_999_999_999_999_94, 0.0),
            (0.5, 1.0),
            (-0.5, 0.0),
            (-1.5, -1.0),
            (4_503_599_627_370_497.0, 4_503_599_627_370_497.0),
        ] {
            assert_eq!(
                rounded_number(Some(input)).unwrap().unwrap().value(),
                expected,
                "input {input}"
            );
        }
        assert!(
            rounded_number(Some(-0.5))
                .unwrap()
                .unwrap()
                .value()
                .is_sign_positive()
        );
    }

    #[test]
    fn ini_version_matches_javascript_generated_by_expression() {
        for (raw, expected) in [
            ("generated by PrusaSlicer 2.8.0", Some("2.8.0")),
            ("generated by\tPrusaSlicer\t2.8.1", Some("2.8.1")),
            ("generated by\nOrcaSlicer\n2.3.2", Some("2.3.2")),
            ("generated by\u{00a0}BambuStudio\u{2028}1.9", Some("1.9")),
            ("generated by PrusaSlicer2.8.0", None),
            ("generated byPrusaSlicer 2.8.0", None),
            (
                "generated by Unknown 1.0\ngenerated by OrcaSlicer 2.4.0",
                Some("2.4.0"),
            ),
        ] {
            assert_eq!(ini_version(raw).as_deref(), expected, "input {raw:?}");
        }
    }
    #[test]
    fn child_overwrites_one_parent_and_keeps_node_key_order() {
        let pending = match interpret_profile(document(
            r#"{"name":"Child","inherits":"Parent","shared":"child","child":true}"#,
            ProfileKind::Process,
        ))
        .unwrap()
        {
            ProfileInterpretation::NeedsParent(value) => value,
            ProfileInterpretation::Ready(_) => panic!("expected parent"),
        };
        let value = serde_json::to_value(
            pending
                .finish_with_parent(br#"{"9":"nine","2":"two","shared":"parent","parent":true}"#)
                .unwrap(),
        )
        .unwrap();
        let text = value.to_string();
        assert!(text.contains("\\\"2\\\":\\\"two\\\",\\\"9\\\":\\\"nine\\\""));
        assert!(text.contains("\\\"shared\\\":\\\"child\\\""));
    }

    #[test]
    fn profile_interpreter_limits_fail_with_named_errors() {
        let oversized = vec![b' '; MAX_DOCUMENT_BYTES + 1];
        assert_eq!(
            interpret_profile(
                ProfileDocument::new(
                    &oversized,
                    ProfileKind::Process,
                    SlicerKind::Orca,
                    "owned/profile",
                )
                .unwrap()
            )
            .unwrap_err(),
            ProfileInterpretError::DocumentTooLarge
        );

        let scalar = format!(
            "{{\"name\":\"large\",\"value\":\"{}\"}}",
            "a".repeat(MAX_SCALAR_UNITS + 1)
        );
        assert_eq!(
            interpret_profile(document(&scalar, ProfileKind::Process)).unwrap_err(),
            ProfileInterpretError::ScalarTooLarge
        );

        let nested = format!(
            "{{\"name\":\"deep\",\"value\":{}{}}}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        assert_eq!(
            interpret_profile(document(&nested, ProfileKind::Process)).unwrap_err(),
            ProfileInterpretError::JsonNestingLimit
        );

        let mut resolved = NodeFlatObject::default();
        let value = JsText::from_string("a".repeat(MAX_SCALAR_UNITS));
        for index in 0..17 {
            resolved
                .assign(JsText::from_string(index.to_string()), value.clone())
                .unwrap();
        }
        assert_eq!(
            serialize_flat(&resolved).unwrap_err(),
            ProfileInterpretError::ResolvedDocumentTooLarge
        );
    }
}
