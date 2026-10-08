use std::collections::BTreeMap;

pub(super) const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_DEPTH: usize = 64;
pub(super) const MAX_NODES: usize = 100_000;

pub(super) use crate::manifest_text::JsText;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct OrderedObject<T> {
    entries: Vec<(JsText, T)>,
    index: BTreeMap<Vec<u16>, usize>,
}

impl<T> Default for OrderedObject<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: BTreeMap::new(),
        }
    }
}

impl<T> OrderedObject<T> {
    pub(super) fn insert(&mut self, key: JsText, value: T) {
        if let Some(index) = self.index.get(key.units()).copied() {
            self.entries[index].1 = value;
            return;
        }
        let index = self.entries.len();
        self.index.insert(key.units().to_vec(), index);
        self.entries.push((key, value));
    }

    pub(super) fn get(&self, key: &str) -> Option<&T> {
        let key: Vec<_> = key.encode_utf16().collect();
        self.index.get(&key).map(|index| &self.entries[*index].1)
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = (&JsText, &T)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub(super) fn contains_key(&self, key: &JsText) -> bool {
        self.index.contains_key(key.units())
    }

    pub(super) fn write_json(
        &self,
        output: &mut Vec<u8>,
        mut write_value: impl FnMut(&T, &mut Vec<u8>),
    ) {
        let mut indices: Vec<_> = self
            .entries
            .iter()
            .enumerate()
            .filter_map(|(position, (key, _))| key.array_index().map(|key| (key, position)))
            .collect();
        indices.sort_unstable_by_key(|(key, _)| *key);
        output.push(b'{');
        let mut first = true;
        for position in indices.into_iter().map(|(_, position)| position).chain(
            self.entries
                .iter()
                .enumerate()
                .filter(|(_, (key, _))| key.array_index().is_none())
                .map(|(position, _)| position),
        ) {
            if !first {
                output.push(b',');
            }
            first = false;
            let (key, value) = &self.entries[position];
            key.write_json(output);
            output.push(b':');
            write_value(value, output);
        }
        output.push(b'}');
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(JsText),
    Array(Vec<JsonValue>),
    Object(OrderedObject<JsonValue>),
}

impl JsonValue {
    pub(super) fn write_json(&self, output: &mut Vec<u8>) {
        match self {
            Self::Null => output.extend_from_slice(b"null"),
            Self::Bool(true) => output.extend_from_slice(b"true"),
            Self::Bool(false) => output.extend_from_slice(b"false"),
            Self::Number(value) if !value.is_finite() => output.extend_from_slice(b"null"),
            Self::Number(value) if *value == 0.0 => output.push(b'0'),
            Self::Number(value) => {
                output.extend_from_slice(ryu_js::Buffer::new().format(*value).as_bytes())
            }
            Self::Text(value) => value.write_json(output),
            Self::Array(values) => {
                output.push(b'[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    value.write_json(output);
                }
                output.push(b']');
            }
            Self::Object(values) => values.write_json(output, Self::write_json),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum JsonLimit {
    Bytes,
    Depth,
    Nodes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum JsonError {
    Syntax,
    Limit(JsonLimit),
}

pub(super) fn parse(bytes: &[u8]) -> Result<JsonValue, JsonError> {
    if bytes.len() > MAX_BYTES {
        return Err(JsonError::Limit(JsonLimit::Bytes));
    }
    let mut parser = Parser {
        bytes,
        position: 0,
        nodes: 0,
    };
    parser.whitespace();
    let value = parser.value(0)?;
    parser.whitespace();
    if parser.position != bytes.len() {
        return Err(JsonError::Syntax);
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    position: usize,
    nodes: usize,
}

impl Parser<'_> {
    fn value(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        if depth > MAX_DEPTH {
            return Err(JsonError::Limit(JsonLimit::Depth));
        }
        self.node()?;
        self.whitespace();
        match self.peek() {
            Some(b'n') => self.literal(b"null", JsonValue::Null),
            Some(b't') => self.literal(b"true", JsonValue::Bool(true)),
            Some(b'f') => self.literal(b"false", JsonValue::Bool(false)),
            Some(b'"') => self.string().map(JsonValue::Text),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.object(depth),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(JsonError::Syntax),
        }
    }

    fn node(&mut self) -> Result<(), JsonError> {
        self.nodes = self
            .nodes
            .checked_add(1)
            .ok_or(JsonError::Limit(JsonLimit::Nodes))?;
        if self.nodes > MAX_NODES {
            return Err(JsonError::Limit(JsonLimit::Nodes));
        }
        Ok(())
    }

    fn literal(&mut self, expected: &[u8], value: JsonValue) -> Result<JsonValue, JsonError> {
        if self
            .bytes
            .get(self.position..self.position + expected.len())
            != Some(expected)
        {
            return Err(JsonError::Syntax);
        }
        self.position += expected.len();
        Ok(value)
    }

    fn string(&mut self) -> Result<JsText, JsonError> {
        if self.take() != Some(b'"') {
            return Err(JsonError::Syntax);
        }
        let mut units = Vec::new();
        loop {
            match self.take() {
                Some(b'"') => return Ok(JsText::from_units(units)),
                Some(b'\\') => match self.take() {
                    Some(b'"') => units.push(u16::from(b'"')),
                    Some(b'\\') => units.push(u16::from(b'\\')),
                    Some(b'/') => units.push(u16::from(b'/')),
                    Some(b'b') => units.push(0x0008),
                    Some(b'f') => units.push(0x000c),
                    Some(b'n') => units.push(0x000a),
                    Some(b'r') => units.push(0x000d),
                    Some(b't') => units.push(0x0009),
                    Some(b'u') => units.push(self.hex4()?),
                    _ => return Err(JsonError::Syntax),
                },
                Some(0x00..=0x1f) | None => return Err(JsonError::Syntax),
                Some(ascii @ 0x20..=0x7f) => units.push(u16::from(ascii)),
                Some(first) => {
                    self.position -= 1;
                    let width = match first {
                        0xc2..=0xdf => 2,
                        0xe0..=0xef => 3,
                        0xf0..=0xf4 => 4,
                        _ => return Err(JsonError::Syntax),
                    };
                    let bytes = self
                        .bytes
                        .get(self.position..self.position + width)
                        .ok_or(JsonError::Syntax)?;
                    let remaining = std::str::from_utf8(bytes).map_err(|_| JsonError::Syntax)?;
                    let value = remaining.chars().next().ok_or(JsonError::Syntax)?;
                    let mut encoded = [0; 2];
                    units.extend_from_slice(value.encode_utf16(&mut encoded));
                    self.position += value.len_utf8();
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, JsonError> {
        let mut value = 0u16;
        for _ in 0..4 {
            value = value
                .checked_mul(16)
                .and_then(|value| self.take().and_then(hex).map(|digit| value + digit))
                .ok_or(JsonError::Syntax)?;
        }
        Ok(value)
    }

    fn array(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        self.position += 1;
        self.whitespace();
        let mut values = Vec::new();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(JsonValue::Array(values));
        }
        loop {
            values.push(self.value(depth + 1)?);
            self.whitespace();
            match self.take() {
                Some(b',') => self.whitespace(),
                Some(b']') => return Ok(JsonValue::Array(values)),
                _ => return Err(JsonError::Syntax),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        self.position += 1;
        self.whitespace();
        let mut values = OrderedObject::default();
        if self.peek() == Some(b'}') {
            self.position += 1;
            return Ok(JsonValue::Object(values));
        }
        loop {
            let key = self.string()?;
            self.node()?;
            self.whitespace();
            if self.take() != Some(b':') {
                return Err(JsonError::Syntax);
            }
            let value = self.value(depth + 1)?;
            values.insert(key, value);
            self.whitespace();
            match self.take() {
                Some(b',') => self.whitespace(),
                Some(b'}') => return Ok(JsonValue::Object(values)),
                _ => return Err(JsonError::Syntax),
            }
        }
    }

    fn number(&mut self) -> Result<JsonValue, JsonError> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.take() {
            Some(b'0') if matches!(self.peek(), Some(b'0'..=b'9')) => {
                return Err(JsonError::Syntax);
            }
            Some(b'0') => {}
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(JsonError::Syntax),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            let fraction = self.position;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
            if self.position == fraction {
                return Err(JsonError::Syntax);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            let exponent = self.position;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
            if self.position == exponent {
                return Err(JsonError::Syntax);
            }
        }
        let token = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| JsonError::Syntax)?;
        let number = token.parse::<f64>().map_err(|_| JsonError::Syntax)?;
        Ok(if number.is_finite() {
            JsonValue::Number(number)
        } else {
            JsonValue::Null
        })
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn take(&mut self) -> Option<u8> {
        let value = self.peek()?;
        self.position += 1;
        Some(value)
    }
}

fn hex(value: u8) -> Option<u16> {
    match value {
        b'0'..=b'9' => Some(u16::from(value - b'0')),
        b'a'..=b'f' => Some(u16::from(value - b'a' + 10)),
        b'A'..=b'F' => Some(u16::from(value - b'A' + 10)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{JsonError, JsonLimit, parse};

    fn round_trip(input: &str) -> String {
        let mut output = Vec::new();
        parse(input.as_bytes()).unwrap().write_json(&mut output);
        String::from_utf8(output).unwrap()
    }

    #[test]
    fn numbers_match_node_24_json_stringify() {
        let input = "[100000000000000000000,-100000000000000000000,100000000000000000001,99999999999999999999,1e21,-1e21,0.000001,0.0000001,9007199254740991,9007199254740992,9007199254740993,1000000000000000128,5e-324,2.2250738585072014e-308,1.7976931348623157e308,0,-0,1e400,-1e400]";
        assert_eq!(
            round_trip(input),
            "[100000000000000000000,-100000000000000000000,100000000000000000000,100000000000000000000,1e+21,-1e+21,0.000001,1e-7,9007199254740991,9007199254740992,9007199254740992,1000000000000000100,5e-324,2.2250738585072014e-308,1.7976931348623157e+308,0,0,null,null]"
        );
    }

    #[test]
    fn object_assignment_and_property_order_match_node_24() {
        let input = r#"{"b":1,"2":"two","a":3,"1":"one","b":4,"01":"leading","4294967294":"max","4294967295":"ordinary","3":3}"#;
        assert_eq!(
            round_trip(input),
            r#"{"1":"one","2":"two","3":3,"4294967294":"max","b":4,"a":3,"01":"leading","4294967295":"ordinary"}"#
        );
    }

    #[test]
    fn parser_accepts_exact_depth_and_node_limits() {
        let at_depth = format!("{}null{}", "[".repeat(64), "]".repeat(64));
        assert_eq!(round_trip(&at_depth), at_depth);
        let over_depth = format!("{}null{}", "[".repeat(65), "]".repeat(65));
        assert_eq!(
            parse(over_depth.as_bytes()),
            Err(JsonError::Limit(JsonLimit::Depth))
        );

        let at_nodes = format!(
            "[{}]",
            std::iter::repeat_n("null", 99_999)
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(parse(at_nodes.as_bytes()).is_ok());
        let over_nodes = format!(
            "[{}]",
            std::iter::repeat_n("null", 100_000)
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(
            parse(over_nodes.as_bytes()),
            Err(JsonError::Limit(JsonLimit::Nodes))
        );
    }

    #[test]
    fn object_keys_are_charged_to_the_node_budget() {
        let object = |entries: usize| {
            let pairs = (0..entries)
                .map(|index| format!(r#""k{index}":null"#))
                .collect::<Vec<_>>()
                .join(",");
            format!("[{{{pairs}}}]")
        };
        assert!(parse(object(49_999).as_bytes()).is_ok());
        assert_eq!(
            parse(object(50_000).as_bytes()),
            Err(JsonError::Limit(JsonLimit::Nodes))
        );
    }
    #[test]
    fn utf8_codepoint_steps_preserve_long_text_and_refuse_malformed_units() {
        let input = format!("\"{}\"", "é𐀀".repeat(100_000));
        assert_eq!(round_trip(&input), input);
        for bytes in [
            &[b'"', 0xc0, 0xaf, b'"'][..],
            &[b'"', 0xed, 0xa0, 0x80, b'"'][..],
            &[b'"', 0xf4, 0x90, 0x80, 0x80, b'"'][..],
            &[b'"', 0xe2, 0x82][..],
        ] {
            assert_eq!(parse(bytes), Err(JsonError::Syntax));
        }
    }

    #[test]
    fn manifest_column_codec_is_canonical_and_preserves_scalar_text() {
        use crate::manifest_text::{JsText, read_manifest_text};
        use rusqlite::types::{Value, ValueRef};
        assert_eq!(read_manifest_text(ValueRef::Null).unwrap(), None);
        let scalar = JsText::scalar("PPJS\u{e000}é𐀀");
        assert_eq!(scalar.sqlite_value(), Value::Text("PPJS\u{e000}é𐀀".into()));
        for units in [
            vec![0xd800],
            vec![0xdc00],
            vec![0x61, 0xd800, 0xdc00, 0xdc00],
        ] {
            let text = JsText::from_units(units.clone());
            let Value::Blob(blob) = text.sqlite_value() else {
                panic!("expected non-scalar BLOB");
            };
            assert_eq!(&blob[..5], b"PPJS\x01");
            assert_eq!(
                read_manifest_text(ValueRef::Blob(&blob))
                    .unwrap()
                    .unwrap()
                    .units(),
                units
            );
            let mut trailing = blob.clone();
            trailing.push(0);
            assert!(read_manifest_text(ValueRef::Blob(&trailing)).is_err());
            let mut unknown = blob;
            unknown[4] = 2;
            assert!(read_manifest_text(ValueRef::Blob(&unknown)).is_err());
        }
        for bytes in [
            b"generic".as_slice(),
            b"PPJS\x01\0\0\0\x01\0a",
            b"PPJS\x01\0\0\0\x01\xd8",
            b"PPJS\x01\x7f\xff\xff\xff",
        ] {
            assert!(read_manifest_text(ValueRef::Blob(bytes)).is_err());
        }
        assert!(read_manifest_text(ValueRef::Integer(1)).is_err());
    }

    #[test]
    fn known_group_errors_match_node_empty_multiple_and_maximum_bodies() {
        use super::super::model::{
            KitManifest, KitManifestPatch, ManifestBuilder, ManifestOptionGroup,
        };
        use super::super::observation::validate_known_selections;
        use std::collections::BTreeMap;
        for (rule, maximum, selection, expected) in [
            (
                "pick_one",
                None,
                "[]",
                Some("kit.selections.toolhead must contain at least one variant id"),
            ),
            (
                "pick_one",
                None,
                "[\"a\",\"b\"]",
                Some("kit.selections.toolhead must contain no more than 1 variant id"),
            ),
            (
                "pick_one",
                Some(0),
                "[\"a\"]",
                Some("kit.selections.toolhead must contain no more than 0 variant ids"),
            ),
            (
                "pick_any",
                Some(2),
                "[\"a\",\"b\",\"c\"]",
                Some("kit.selections.toolhead must contain no more than 2 variant ids"),
            ),
            (
                "pick_n",
                Some(1),
                "[\"a\",\"b\"]",
                Some("kit.selections.toolhead must contain no more than 1 variant id"),
            ),
            ("pick_any", Some(2), "[]", None),
        ] {
            let group = ManifestOptionGroup {
                rule: rule.into(),
                max: maximum,
                min: None,
                label: None,
                parts: vec![],
                variants: vec![],
            };
            let builder = ManifestBuilder {
                profile_id: 1,
                sources: vec![],
                resolved_selections: KitManifest::default(),
                merged_option_groups: BTreeMap::from([(
                    crate::manifest_text::OptionGroupId::from("toolhead".to_owned()),
                    group,
                )]),
            };
            let request = format!(r#"{{"kit":{{"selections":{{"toolhead":{selection}}}}}}}"#);
            let kit = KitManifestPatch::from_request(request.as_bytes())
                .unwrap()
                .into_empty_defaults();
            let actual = validate_known_selections(&kit, &builder)
                .err()
                .and_then(|detail| detail.scalar_detail());
            assert_eq!(actual.as_deref(), expected);
            if let Some(detail) = actual {
                println!(
                    "{}",
                    serde_json::json!({"case":"known_group","rule":rule,"maximum":maximum,"selection":selection,"body":serde_json::json!({"detail":detail}).to_string()})
                );
            }
        }
    }
}
