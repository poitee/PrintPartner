//! Slicer profile parsing for profile sync.
//!
//! Ported from `web/apps/server/src/services/profile-sync.ts`: `scalar`,
//! `parseSlicerJson`, `parseSlicerIni`, `inferMaterialType`,
//! `parseProfileFile`, `buildResolvedFlat`, the record mapping in `upsert`,
//! `locate` and `syncRoot`. Nothing here watches files, writes storage or
//! broadcasts; [`read_profile`] returns the record Node would upsert and the
//! event it would emit.
//!
//! Node semantics this module copies on purpose:
//! - Flat configs keep JavaScript property order (array-index keys first,
//!   ascending, then insertion order), so `resolvedFlatConfig` matches
//!   `JSON.stringify` byte for byte.
//! - Numbers become strings the way `String(number)` does.
//! - `trim`/`trimStart` and regex `\s` use the JavaScript whitespace set.
//! - Number fields use `parseFloat` prefix parsing, `Math.round` and `Math.trunc`.
//! - A `__proto__` key never lands in a flat config (Node assigns it to the
//!   prototype instead).
//!
//! - Number literals that overflow f64 read as +-Infinity, as `JSON.parse` does.
//!
//! Known differences, kept because the inputs are not real slicer saves:
//! JSON nested deeper than 128 levels and lone surrogate escapes make the
//! Rust parse fail, where Node accepts the file. A parent profile whose whole
//! JSON body is a string with characters outside the BMP gets U+FFFD per
//! surrogate half where Node keeps the half.

use serde::Serialize;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// Slicer family of a watch root (TS `SlicerKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSlicer {
    Orca,
    Prusa,
    Bambu,
}

/// Profile kind (TS `ProfileKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileKind {
    Printer,
    Process,
    Filament,
}

/// One watched slicer tree (TS `SlicerWatchRoot`). `dirs` keeps Node's
/// `printer`, `process`, `filament` order; empty dirs are skipped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchRoot {
    pub kind: ProfileSlicer,
    pub base_dir: PathBuf,
    pub dirs: Vec<(ProfileKind, String)>,
}

impl WatchRoot {
    fn dir(&self, kind: ProfileKind) -> &str {
        self.dirs
            .iter()
            .find(|(k, _)| *k == kind)
            .map_or("", |(_, d)| d.as_str())
    }

    fn kind_dirs(&self) -> impl Iterator<Item = (ProfileKind, &str)> {
        self.dirs
            .iter()
            .filter(|(_, d)| !d.is_empty())
            .map(|(k, d)| (*k, d.as_str()))
    }
}

/// Flat key to string map in JavaScript property order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FlatConfig {
    entries: Vec<(String, String)>,
}

impl FlatConfig {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// `flat[key] = value`. An existing key keeps its position.
    pub fn insert(&mut self, key: String, value: String) {
        if key == "__proto__" {
            return;
        }
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    /// Entries in the order JavaScript enumerates them.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        let mut indexed: Vec<(u32, &(String, String))> = self
            .entries
            .iter()
            .filter_map(|e| array_index(&e.0).map(|i| (i, e)))
            .collect();
        indexed.sort_by_key(|(i, _)| *i);
        indexed
            .into_iter()
            .map(|(_, e)| e)
            .chain(self.entries.iter().filter(|e| array_index(&e.0).is_none()))
            .map(|(k, v)| (k.as_str(), v.as_str()))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `{ ...self, ...over }`.
    fn merged(&self, over: &FlatConfig) -> FlatConfig {
        let mut out = FlatConfig::default();
        for (k, v) in self.iter().chain(over.iter()) {
            out.insert(k.to_owned(), v.to_owned());
        }
        out
    }

    /// `JSON.stringify(flat)`.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{");
        for (i, (k, v)) in self.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_json_string(&mut out, k);
            out.push(':');
            push_json_string(&mut out, v);
        }
        out.push('}');
        out
    }
}

/// A string literal as `JSON.stringify` writes it.
fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A JavaScript array index: the canonical decimal form of 0..=2^32-2.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|i| *i != u32::MAX)
}

/// JavaScript `WhiteSpace` and `LineTerminator`, as used by `trim` and `\s`.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(js_space)
}

/// `String(number)`.
pub fn js_number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    // `{:e}` always writes `<digits>e<exponent>`.
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        let head = if k == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{head}e{e_sign}{}", e.abs())
    };
    format!("{sign}{body}")
}

/// `Number.parseFloat(text)`.
fn js_parse_float(text: &str) -> f64 {
    let s = js_trim_start(text);
    let b = s.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i = 1;
    }
    if s[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int = digits(i);
    let mut end = i + int;
    let mut frac = 0;
    if b.get(end) == Some(&b'.') {
        frac = digits(end + 1);
        if int > 0 || frac > 0 {
            end += 1 + frac;
        }
    }
    if int == 0 && frac == 0 {
        return f64::NAN;
    }
    if matches!(b.get(end), Some(b'e' | b'E')) {
        let mut j = end + 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let exp = digits(j);
        if exp > 0 {
            end = j + exp;
        }
    }
    s[..end].parse().unwrap_or(f64::NAN)
}

/// `Math.round`: nearest integer, halves toward +Infinity.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// TS `scalar`: a string from a raw slicer value (string, number, `[x]`, `{value}`).
pub fn scalar(raw: &Value) -> Option<String> {
    match raw {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => n.as_f64().map(js_number_string),
        Value::Array(items) => items.first().and_then(scalar),
        Value::Object(map) => map.get("value").and_then(scalar),
    }
}

/// Top-level JSON value with object keys in source order.
enum JsonTop {
    Object(Vec<(String, Value)>),
    Array(Vec<Value>),
    String(String),
    Null,
    Primitive,
}

impl<'de> Deserialize<'de> for JsonTop {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TopVisitor;
        impl<'de> Visitor<'de> for TopVisitor {
            type Value = JsonTop;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsonTop, A::Error> {
                let mut entries: Vec<(String, Value)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Value>()? {
                    // JSON.parse: a repeated key keeps its first position, last value.
                    match entries.iter_mut().find(|(key, _)| *key == k) {
                        Some(slot) => slot.1 = v,
                        None => entries.push((k, v)),
                    }
                }
                Ok(JsonTop::Object(entries))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JsonTop, A::Error> {
                let mut items = Vec::new();
                while let Some(v) = seq.next_element::<Value>()? {
                    items.push(v);
                }
                Ok(JsonTop::Array(items))
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<JsonTop, E> {
                Ok(JsonTop::String(s.to_owned()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<JsonTop, E> {
                Ok(JsonTop::Null)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<JsonTop, E> {
                Ok(JsonTop::Primitive)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<JsonTop, E> {
                Ok(JsonTop::Primitive)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<JsonTop, E> {
                Ok(JsonTop::Primitive)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<JsonTop, E> {
                Ok(JsonTop::Primitive)
            }
        }
        deserializer.deserialize_any(TopVisitor)
    }
}

/// Why a profile file produced no record. Node logs these and skips the file.
#[derive(Debug)]
pub enum ProfileSyncError {
    Read(std::io::Error),
    Json(serde_json::Error),
    /// `Object.entries(null)` throws.
    NullJson,
}

impl fmt::Display for ProfileSyncError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Read(e) => write!(f, "{e}"),
            Self::Json(e) => write!(f, "{e}"),
            Self::NullJson => f.write_str("Cannot convert undefined or null to object"),
        }
    }
}

impl std::error::Error for ProfileSyncError {}

/// End of the JSON number token starting at `start`. A `-` with no integer
/// digit after it is not a number, so the token stops after the `-`.
fn number_end(b: &[u8], start: usize) -> usize {
    let digits = |from: usize| from + b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut i = start + usize::from(b[start] == b'-');
    i = match b.get(i) {
        Some(b'0') => i + 1,
        Some(b'1'..=b'9') => digits(i),
        _ => return i,
    };
    if b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        i = digits(i + 1);
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(i + 1), Some(b'+' | b'-')));
        if b.get(i + 1 + sign).is_some_and(u8::is_ascii_digit) {
            i = digits(i + 1 + sign);
        }
    }
    i
}

/// serde_json refuses number literals that overflow f64, where `JSON.parse`
/// returns +-Infinity. Rewrite each one as the string `"Infinity"` or
/// `"-Infinity"`, which `scalar` turns into the text `String(Infinity)`
/// gives. A whole document that is one such number becomes `0`, since
/// `Object.entries` of any number is empty. `None` when nothing overflows.
fn overflow_as_infinity(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    let (mut out, mut last, mut i) = (String::new(), 0, 0);
    // Open containers, and the last structural byte seen. A number is a
    // value after `:`, `[`, an array's `,`, or at the start; anywhere else
    // the text is invalid JSON and is left for serde_json to refuse.
    let (mut open, mut prev) = (Vec::new(), None);
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
                prev = Some(b'"');
            }
            c @ (b'{' | b'[') => {
                open.push(c);
                prev = Some(c);
                i += 1;
            }
            c @ (b'}' | b']' | b':' | b',') => {
                if matches!(c, b'}' | b']') {
                    open.pop();
                }
                prev = Some(c);
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let end = number_end(b, i).max(i + 1);
                let value = match prev {
                    None => true,
                    Some(b':' | b'[') => true,
                    Some(b',') => open.last() == Some(&b'['),
                    _ => false,
                };
                if let Ok(x) = raw[i..end].parse::<f64>()
                    && value
                    && x.is_infinite()
                {
                    out.push_str(&raw[last..i]);
                    out.push_str(match (open.is_empty(), x > 0.0) {
                        (true, _) => "0",
                        (false, true) => "\"Infinity\"",
                        (false, false) => "\"-Infinity\"",
                    });
                    last = end;
                }
                prev = Some(b'0');
                i = end;
            }
            c if c.is_ascii_whitespace() => i += 1,
            c => {
                prev = Some(c);
                i += 1;
            }
        }
    }
    (last > 0).then(|| out + &raw[last..])
}

/// TS `parseSlicerJson`.
pub fn parse_slicer_json(raw: &str) -> Result<FlatConfig, ProfileSyncError> {
    let top: JsonTop = match serde_json::from_str(raw) {
        Ok(top) => top,
        Err(error) => match overflow_as_infinity(raw) {
            Some(rewritten) => serde_json::from_str(&rewritten).map_err(ProfileSyncError::Json)?,
            None => return Err(ProfileSyncError::Json(error)),
        },
    };
    let mut flat = FlatConfig::default();
    match top {
        JsonTop::Object(entries) => {
            for (k, v) in entries {
                if let Some(s) = scalar(&v) {
                    flat.insert(k, s);
                }
            }
        }
        JsonTop::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                if let Some(s) = scalar(v) {
                    flat.insert(i.to_string(), s);
                }
            }
        }
        // Object.entries over a string yields one entry per UTF-16 unit.
        JsonTop::String(s) => {
            for (i, unit) in s.encode_utf16().enumerate() {
                let c = char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}');
                flat.insert(i.to_string(), c.to_string());
            }
        }
        JsonTop::Primitive => {}
        JsonTop::Null => return Err(ProfileSyncError::NullJson),
    }
    // Object.entries yields array indices first; the flat map was filled in
    // that order, which FlatConfig::iter reproduces.
    Ok(flat)
}

/// TS `parseSlicerIni`: `key = value` lines, skipping blanks and `#`/`;` comments.
pub fn parse_slicer_ini(raw: &str) -> FlatConfig {
    let mut flat = FlatConfig::default();
    for line in raw.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = js_trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        if eq == 0 {
            continue;
        }
        let key = js_trim(&trimmed[..eq]);
        let value = js_trim(&trimmed[eq + 1..]);
        if !key.is_empty() {
            flat.insert(key.to_owned(), value.to_owned());
        }
    }
    flat
}

/// TS `inferMaterialType`: the first material token found as a whole word.
pub fn infer_material_type(name: &str) -> &'static str {
    const CANDIDATES: [&str; 10] = [
        "PLA", "PETG", "ABS", "ASA", "TPU", "PC", "NYLON", "PVA", "HIPS", "PCTG",
    ];
    let upper = name.to_uppercase();
    let bytes = upper.as_bytes();
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    for candidate in CANDIDATES {
        let found = upper.match_indices(candidate).any(|(at, _)| {
            let before = at.checked_sub(1).and_then(|i| bytes.get(i));
            !word(before) && !word(bytes.get(at + candidate.len()))
        });
        if found {
            return candidate;
        }
    }
    "Generic"
}

/// `/generated by\s+(?:PrusaSlicer|BambuStudio|OrcaSlicer)\s+([^\s]+)/i`, group 1.
fn header_version(raw: &str) -> Option<&str> {
    fn spaces(s: &str) -> usize {
        s.char_indices()
            .find(|(_, c)| !js_space(*c))
            .map_or(s.len(), |(i, _)| i)
    }
    fn prefix_ci(s: &str, word: &str) -> bool {
        s.len() >= word.len()
            && s.is_char_boundary(word.len())
            && s[..word.len()].eq_ignore_ascii_case(word)
    }
    for (start, _) in raw.char_indices() {
        let rest = &raw[start..];
        if !prefix_ci(rest, "generated by") {
            continue;
        }
        let rest = &rest["generated by".len()..];
        let gap = spaces(rest);
        if gap == 0 {
            continue;
        }
        let rest = &rest[gap..];
        let Some(app) = ["PrusaSlicer", "BambuStudio", "OrcaSlicer"]
            .into_iter()
            .find(|app| prefix_ci(rest, app))
        else {
            continue;
        };
        let rest = &rest[app.len()..];
        let gap = spaces(rest);
        if gap == 0 {
            continue;
        }
        let rest = &rest[gap..];
        let end = rest
            .char_indices()
            .find(|(_, c)| js_space(*c))
            .map_or(rest.len(), |(i, _)| i);
        if end > 0 {
            return Some(&rest[..end]);
        }
    }
    None
}

fn is_json(raw: &str) -> bool {
    js_trim_start(raw).starts_with('{')
}

/// TS `ParsedProfileFile`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedProfile {
    pub kind: ProfileKind,
    pub name: String,
    pub version: Option<String>,
    pub flat: FlatConfig,
}

/// TS `parseProfileFile`: JSON when the text starts with `{`, else INI. A
/// `type` field overrides `kind_hint` (the directory the file lives in).
pub fn parse_profile_file(
    raw: &str,
    kind_hint: ProfileKind,
) -> Result<ParsedProfile, ProfileSyncError> {
    let (flat, version) = if is_json(raw) {
        let flat = parse_slicer_json(raw)?;
        let version = flat.get("version").map(str::to_owned);
        (flat, version)
    } else {
        (
            parse_slicer_ini(raw),
            header_version(raw).map(str::to_owned),
        )
    };
    let kind = match flat.get("type").unwrap_or("").to_lowercase().as_str() {
        "machine" | "printer" => ProfileKind::Printer,
        "process" | "print" => ProfileKind::Process,
        "filament" => ProfileKind::Filament,
        _ => kind_hint,
    };
    let name = [flat.get("name"), flat.get("print_settings_id")]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .unwrap_or("Unnamed")
        .to_owned();
    Ok(ParsedProfile {
        kind,
        name,
        version,
        flat,
    })
}

/// Sorted directory entry names, as libuv's `scandir` returns them to Node.
fn sorted_entries(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names)
}

/// TS `findProfileFile`: case-insensitive `<name>.json` or `<name>.ini`.
fn find_profile_file(base_dir: &Path, kind_dir: &str, name: &str) -> Option<PathBuf> {
    let dir = base_dir.join(kind_dir);
    let wanted = name.to_lowercase();
    sorted_entries(&dir).ok()?.into_iter().find_map(|entry| {
        let lower = entry.to_lowercase();
        (lower == format!("{wanted}.json") || lower == format!("{wanted}.ini"))
            .then(|| dir.join(entry))
    })
}

fn read_text(path: &Path) -> std::io::Result<String> {
    fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// TS `buildResolvedFlat`: merge the single-level `inherits` parent from the
/// same kind directory under the own settings. Any failure keeps `own`.
pub fn resolve_inherited(
    raw: &str,
    own: &FlatConfig,
    base_dir: &Path,
    kind_dir: &str,
) -> FlatConfig {
    if !is_json(raw) {
        return own.clone();
    }
    let Some(parent) = own.get("inherits").filter(|p| !p.is_empty()) else {
        return own.clone();
    };
    let Some(path) = find_profile_file(base_dir, kind_dir, parent) else {
        return own.clone();
    };
    match read_text(&path)
        .map_err(ProfileSyncError::Read)
        .and_then(|t| parse_slicer_json(&t))
    {
        Ok(parent) => parent.merged(own),
        Err(_) => own.clone(),
    }
}

/// TS `firstNumber`.
fn first_number(flat: &FlatConfig, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .filter_map(|k| flat.get(k))
        .map(js_parse_float)
        .find(|n| n.is_finite())
}

/// `repo.upsertSyncedPrinterProfile` input.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncedPrinterProfile {
    pub name: String,
    pub slicer_format: ProfileSlicer,
    pub slicer_version: Option<String>,
    pub nozzle_diameter_mm: Option<String>,
    pub extruder_count: Option<f64>,
    pub raw_json: Option<String>,
    pub resolved_flat_config: String,
    pub source_path: String,
}

/// `repo.upsertSyncedProcessProfile` input.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncedProcessProfile {
    pub name: String,
    pub slicer_format: ProfileSlicer,
    pub slicer_version: Option<String>,
    pub compatible_printers: Option<String>,
    pub resolved_flat_config: String,
    pub source_path: String,
}

/// `repo.upsertSyncedFilamentProfile` input. Node passes no slicer format.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncedFilamentProfile {
    pub name: String,
    pub material_type: String,
    pub slicer_version: Option<String>,
    pub nozzle_temp_c: Option<f64>,
    pub bed_temp_c: Option<f64>,
    pub fan_pct: Option<f64>,
    pub extrusion_multiplier: Option<String>,
    pub pressure_advance: Option<String>,
    pub retraction: Option<String>,
    pub raw_json: Option<String>,
    pub raw_ini: Option<String>,
    pub resolved_flat_config: String,
    pub source_path: String,
}

/// One upsert, tagged by the table Node writes.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
#[serde(tag = "table", content = "input", rename_all = "lowercase")]
pub enum SyncedProfile {
    Printer(SyncedPrinterProfile),
    Process(SyncedProcessProfile),
    Filament(SyncedFilamentProfile),
}

/// TS `ProfileSyncResult`, the event Node broadcasts after an upsert.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileSyncEvent {
    pub kind: ProfileKind,
    pub slicer: ProfileSlicer,
    pub name: String,
    pub version: Option<String>,
}

/// TS `upsert` field mapping. Number fields read the file's own settings,
/// not the inherited ones, as Node does.
pub fn synced_profile(
    slicer: ProfileSlicer,
    parsed: &ParsedProfile,
    raw: &str,
    resolved: &FlatConfig,
    source_path: &str,
) -> SyncedProfile {
    let flat = &parsed.flat;
    let json = is_json(raw);
    let text = |keys: &[&str]| first_number(flat, keys).map(js_number_string);
    let resolved_flat_config = resolved.to_json();
    let source_path = source_path.to_owned();
    match parsed.kind {
        ProfileKind::Printer => SyncedProfile::Printer(SyncedPrinterProfile {
            name: parsed.name.clone(),
            slicer_format: slicer,
            slicer_version: parsed.version.clone(),
            nozzle_diameter_mm: text(&["nozzle_diameter", "nozzle_diameter_mm"]),
            extruder_count: first_number(flat, &["extruder_count"]).map(f64::trunc),
            raw_json: json.then(|| raw.to_owned()),
            resolved_flat_config,
            source_path,
        }),
        ProfileKind::Process => SyncedProfile::Process(SyncedProcessProfile {
            name: parsed.name.clone(),
            slicer_format: slicer,
            slicer_version: parsed.version.clone(),
            compatible_printers: flat.get("compatible_printers").map(str::to_owned),
            resolved_flat_config,
            source_path,
        }),
        ProfileKind::Filament => {
            let nozzle = first_number(
                flat,
                &[
                    "nozzle_temperature",
                    "nozzle_temperature_initial_layer",
                    "temperature",
                    "nozzle_temp_c",
                ],
            );
            let bed = first_number(
                flat,
                &[
                    "bed_temperature",
                    "bed_temperature_initial_layer",
                    "bed_temp_c",
                ],
            );
            let fan = first_number(flat, &["fan_pct", "cooling"])
                .or_else(|| (flat.get("fan_always_on") == Some("1")).then_some(100.0));
            SyncedProfile::Filament(SyncedFilamentProfile {
                name: parsed.name.clone(),
                material_type: infer_material_type(&parsed.name).to_owned(),
                slicer_version: parsed.version.clone(),
                nozzle_temp_c: nozzle.map(js_round),
                bed_temp_c: bed.map(js_round),
                fan_pct: fan.map(js_round),
                extrusion_multiplier: text(&["filament_flow_ratio", "extrusion_multiplier"]),
                pressure_advance: text(&["pressure_advance", "filament_pressure_advance"]),
                retraction: text(&["filament_retraction_length", "retraction_length_mm"]),
                raw_json: json.then(|| raw.to_owned()),
                raw_ini: (!json).then(|| raw.to_owned()),
                resolved_flat_config,
                source_path,
            })
        }
    }
}

/// TS `locate`: the first root and kind whose directory holds `path`.
pub fn locate<'a>(roots: &'a [WatchRoot], path: &Path) -> Option<(&'a WatchRoot, ProfileKind)> {
    roots.iter().find_map(|root| {
        root.kind_dirs()
            .find(|(_, dir)| path.starts_with(root.base_dir.join(dir)))
            .map(|(kind, _)| (root, kind))
    })
}

/// TS `readProfileFile` without the upsert and emit: what Node would write
/// and broadcast for `path`, or `None` when no root holds it.
pub fn read_profile(
    roots: &[WatchRoot],
    path: &Path,
) -> Option<Result<(SyncedProfile, ProfileSyncEvent), ProfileSyncError>> {
    let (root, kind) = locate(roots, path)?;
    Some(read_located(root, kind, path))
}

fn read_located(
    root: &WatchRoot,
    kind: ProfileKind,
    path: &Path,
) -> Result<(SyncedProfile, ProfileSyncEvent), ProfileSyncError> {
    let raw = read_text(path).map_err(ProfileSyncError::Read)?;
    let parsed = parse_profile_file(&raw, kind)?;
    let resolved = resolve_inherited(&raw, &parsed.flat, &root.base_dir, root.dir(kind));
    let record = synced_profile(root.kind, &parsed, &raw, &resolved, &path.to_string_lossy());
    let event = ProfileSyncEvent {
        kind: parsed.kind,
        slicer: root.kind,
        name: parsed.name,
        version: parsed.version,
    };
    Ok((record, event))
}

/// One file handled by [`scan_root`].
#[derive(Debug)]
pub struct ScannedProfile {
    pub path: PathBuf,
    pub result: Result<(SyncedProfile, ProfileSyncEvent), ProfileSyncError>,
}

/// TS `syncRoot`: every `.json`/`.ini` entry in each kind directory of
/// `roots[index]`, in Node's order. Missing directories are skipped.
pub fn scan_root(roots: &[WatchRoot], index: usize) -> Vec<ScannedProfile> {
    let root = &roots[index];
    let mut out = Vec::new();
    for (_, dir) in root.kind_dirs() {
        let dir_path = root.base_dir.join(dir);
        let Ok(entries) = sorted_entries(&dir_path) else {
            continue;
        };
        for entry in entries
            .iter()
            .filter(|e| e.ends_with(".json") || e.ends_with(".ini"))
        {
            let path = dir_path.join(entry);
            if let Some(result) = read_profile(roots, &path) {
                out.push(ScannedProfile { path, result });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_strings_follow_javascript() {
        for (x, s) in [
            (0.1, "0.1"),
            (5.0, "5"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123.456, "123.456"),
            (-2.5, "-2.5"),
            (12345678901234567890.0, "12345678901234567000"),
        ] {
            assert_eq!(js_number_string(x), s, "{x}");
        }
    }

    #[test]
    fn parse_float_takes_the_numeric_prefix() {
        assert_eq!(js_parse_float("0.4,0.4"), 0.4);
        assert_eq!(js_parse_float("  60abc"), 60.0);
        assert_eq!(js_parse_float("1."), 1.0);
        assert_eq!(js_parse_float(".95"), 0.95);
        assert_eq!(js_parse_float("1e"), 1.0);
        assert_eq!(js_parse_float("0x40"), 0.0);
        assert_eq!(js_parse_float("-Infinity"), f64::NEG_INFINITY);
        assert!(js_parse_float(".").is_nan());
        assert!(js_parse_float("abc").is_nan());
    }

    #[test]
    fn rounding_matches_math_round() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }

    #[test]
    fn json_strings_escape_like_json_stringify() {
        let all: String = (0u32..0x80)
            .filter_map(char::from_u32)
            .chain(['\u{2028}', '\u{fffd}', '😀'])
            .collect();
        let mut out = String::new();
        push_json_string(&mut out, &all);
        assert_eq!(out, serde_json::to_string(&all).unwrap());
    }

    #[test]
    fn overflowing_numbers_become_infinity_only_as_values() {
        let flat = parse_slicer_json(
            r#"{"a":1e999,"b":[2,-1e999],"c":{"value":1E400},"d":"1e999","e":1e-999}"#,
        )
        .unwrap();
        assert_eq!(
            flat.to_json(),
            r#"{"a":"Infinity","b":"2","c":"Infinity","d":"1e999","e":"0"}"#
        );
        assert!(parse_slicer_json("1e999").unwrap().is_empty());
        assert!(parse_slicer_json(r#"{1e999:1}"#).is_err());
        assert!(parse_slicer_json(r#"{"a":1,1e999:2}"#).is_err());
    }

    #[test]
    fn overflow_rewrite_keeps_invalid_numbers_refused() {
        // JSON.parse throws on each of these; f64::from_str accepts some.
        for raw in [
            "[-.5e999]",
            "[.5e999]",
            r#"{"v":-.5e999}"#,
            "[1.e999]",
            "[01e999]",
            "[-01e999]",
            "[+1e999]",
        ] {
            assert!(parse_slicer_json(raw).is_err(), "{raw} parsed");
        }
    }

    #[test]
    fn flat_config_orders_index_keys_first() {
        let flat =
            parse_slicer_json(r#"{"b":"1","10":"x","a":"2","2":"y","b":"3","__proto__":"p"}"#)
                .unwrap();
        assert_eq!(flat.to_json(), r#"{"2":"y","10":"x","b":"3","a":"2"}"#);
    }
}
