//! The JavaScript conversions the TypeScript kit code applies to parsed JSON:
//! `String(x)`, `Number(x)`, `String.prototype.trim` and
//! `JSON.stringify`. Kit bundles are user files, so a bundle with an odd
//! value (a numeric `name`, a `version` of `"3"`) must read the same way Node
//! read it.

use serde_json::{Map, Value};

/// `String.prototype.trim`: ECMAScript WhiteSpace and LineTerminator. Unlike
/// `str::trim`, this strips U+FEFF and keeps U+0085.
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn is_js_space(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}')
        || matches!(
            c,
            '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
}

/// `Number.prototype.toString()` for a JSON number. JSON numbers are f64 in
/// JavaScript, so an integer above 2^53 prints rounded.
pub(crate) fn number_string(n: &serde_json::Number) -> String {
    let f = n.as_f64().unwrap_or(f64::NAN);
    ryu_js::Buffer::new().format(f).to_owned()
}

/// `String(x)` for a JSON value.
pub(crate) fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_string(n),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `Number(x)` for a JSON value.
pub(crate) fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(_) => string_to_number(&to_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// ECMAScript StringToNumber.
fn string_to_number(s: &str) -> f64 {
    let s = trim(s);
    if s.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if unsigned == "Infinity" {
        return if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust also accepts "inf" and "nan"; JavaScript accepts only digits here.
    let mantissa = unsigned.split(['e', 'E']).next().unwrap_or("");
    if !unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b))
        || !mantissa.bytes().any(|b| b.is_ascii_digit())
    {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}

/// `JSON.stringify(value)`, or `JSON.stringify(value, null, 2)` when `pretty`.
/// Objects list array-index keys first in ascending order, as JavaScript
/// objects do, then the other keys in insertion order.
pub fn stringify(value: &Value, pretty: bool) -> String {
    let mut out = String::new();
    write_value(&mut out, value, pretty, 0);
    out
}

fn write_value(out: &mut String, value: &Value, pretty: bool, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            // JSON.stringify writes non-finite numbers as null.
            if f.is_finite() {
                out.push_str(&number_string(n))
            } else {
                out.push_str("null")
            }
        }
        Value::String(s) => write_string(out, s),
        Value::Array(items) => write_container(
            out,
            '[',
            ']',
            items.iter().map(|item| (None, item)),
            pretty,
            depth,
        ),
        Value::Object(map) => {
            let keys = ordered_keys(map);
            let entries = keys.into_iter().map(|key| (Some(key), &map[key]));
            write_container(out, '{', '}', entries, pretty, depth)
        }
    }
}

fn write_container<'a>(
    out: &mut String,
    open: char,
    close: char,
    entries: impl ExactSizeIterator<Item = (Option<&'a str>, &'a Value)>,
    pretty: bool,
    depth: usize,
) {
    out.push(open);
    let empty = entries.len() == 0;
    for (index, (key, item)) in entries.enumerate() {
        if index > 0 {
            out.push(',');
        }
        if pretty {
            out.push('\n');
            out.push_str(&"  ".repeat(depth + 1));
        }
        if let Some(key) = key {
            write_string(out, key);
            out.push_str(if pretty { ": " } else { ":" });
        }
        write_value(out, item, pretty, depth + 1);
    }
    if pretty && !empty {
        out.push('\n');
        out.push_str(&"  ".repeat(depth));
    }
    out.push(close);
}

fn write_string(out: &mut String, s: &str) {
    // serde_json escapes exactly the characters JSON.stringify does for a
    // well-formed string: `"`, `\` and C0 controls, with lowercase hex.
    out.push_str(&serde_json::to_string(s).unwrap_or_default());
}

fn ordered_keys(map: &Map<String, Value>) -> Vec<&str> {
    let mut indexed: Vec<(u32, &str)> = Vec::new();
    let mut named: Vec<&str> = Vec::new();
    for key in map.keys() {
        match array_index(key) {
            Some(index) => indexed.push((index, key)),
            None => named.push(key),
        }
    }
    indexed.sort_unstable_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key)| key)
        .chain(named)
        .collect()
}

/// A canonical array index: "0" or a decimal without leading zeros, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index < u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversions_follow_ecmascript() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
        assert_eq!(
            to_string(&json!([1, null, [2, 3], {"a": 1}, true])),
            "1,,2,3,[object Object],true"
        );
        assert_eq!(to_string(&json!(1e21)), "1e+21");
        assert_eq!(to_number(&json!(" 0x3 ")), 3.0);
        assert_eq!(to_number(&json!("3e0")), 3.0);
        assert!(to_number(&json!("inf")).is_nan());
        assert!(to_number(&json!(".")).is_nan());
        assert_eq!(to_number(&json!(["2"])), 2.0);
        assert_eq!(to_number(&json!([])), 0.0);
        assert_eq!(
            stringify(&json!({"b": 1, "10": [], "2": {}, "a": [1.0, 0.5]}), false),
            r#"{"2":{},"10":[],"b":1,"a":[1,0.5]}"#
        );
        assert_eq!(
            stringify(&json!({"a": [1, {"b": []}]}), true),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": []\n    }\n  ]\n}"
        );
    }
}
