use super::observation::{PreparationBudget, ReadFailure, ReadResult};
use crate::manifest_text::JsText;
use saphyr_parser::{Event, Parser, ScalarStyle, Tag};
use std::collections::HashMap;

#[derive(Clone)]
pub(super) enum Node {
    Null,
    Bool(bool),
    Number(f64),
    String(JsText),
    Sequence(Vec<usize>),
    Mapping(Vec<(JsText, usize)>),
    Alias(usize),
}
pub(super) struct Document {
    nodes: Vec<Node>,
    pub root: usize,
}
struct Frame {
    id: usize,
    key: Option<usize>,
}
fn invalid<T>() -> ReadResult<T> {
    Err(ReadFailure::InvalidDocument)
}
fn tag_name(tag: Option<&Tag>) -> ReadResult<Option<&str>> {
    match tag {
        None => Ok(None),
        Some(t) if t.handle == "!" && t.suffix.is_empty() => Ok(Some("!")),
        Some(t) if t.is_yaml_core_schema() => Ok(Some(t.suffix.as_str())),
        _ => invalid(),
    }
}
fn number(s: &str, explicit: bool) -> Option<f64> {
    let (sign, raw) = if let Some(s) = s.strip_prefix('-') {
        (-1.0, s)
    } else if let Some(s) = s.strip_prefix('+') {
        (1.0, s)
    } else {
        (1.0, s)
    };
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = raw.strip_prefix(prefix) {
            if (!explicit && (radix == 2 || raw != s)) || digits.is_empty() {
                return None;
            }
            let mut value = 0.0;
            for c in digits.chars() {
                value = value * f64::from(radix) + f64::from(c.to_digit(radix)?);
            }
            let value = sign * value;
            return value.is_finite().then_some(value);
        }
    }
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn float(s: &str) -> Option<f64> {
    match s {
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => return Some(f64::INFINITY),
        "-.inf" | "-.Inf" | "-.INF" => return Some(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => return Some(f64::NAN),
        _ => {}
    }
    let re =
        regress::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").ok()?;
    if re.find(s).is_some() {
        s.parse::<f64>().ok().filter(|n| n.is_finite())
    } else {
        None
    }
}
fn scalar(text: JsText, style: ScalarStyle, tag: Option<&Tag>) -> ReadResult<Node> {
    let tag = tag_name(tag)?;
    let Some(scalar) = text.as_scalar() else {
        return if style == ScalarStyle::DoubleQuoted
            && matches!(tag, None | Some("str") | Some("!"))
        {
            Ok(Node::String(text))
        } else {
            invalid()
        };
    };
    let s = scalar.as_str();
    if tag == Some("str") || tag == Some("!") || (tag.is_none() && style != ScalarStyle::Plain) {
        return Ok(Node::String(JsText::scalar(s)));
    }
    let null = matches!(s, "" | "~" | "null" | "Null" | "NULL");
    let boolean = match s {
        "true" | "True" | "TRUE" => Some(true),
        "false" | "False" | "FALSE" => Some(false),
        _ => None,
    };
    match tag {
        Some("null") => {
            if null {
                Ok(Node::Null)
            } else {
                invalid()
            }
        }
        Some("bool") => boolean.map(Node::Bool).ok_or(ReadFailure::InvalidDocument),
        Some("int") => number(s, true)
            .map(Node::Number)
            .ok_or(ReadFailure::InvalidDocument),
        Some("float") => float(s)
            .map(Node::Number)
            .ok_or(ReadFailure::InvalidDocument),
        Some("seq") if s.is_empty() => Ok(Node::Sequence(Vec::new())),
        Some("map") if s.is_empty() => Ok(Node::Mapping(Vec::new())),
        Some(_) => invalid(),
        None => Ok(if null {
            Node::Null
        } else if let Some(b) = boolean {
            Node::Bool(b)
        } else if let Some(n) = number(s, false).or_else(|| float(s)) {
            Node::Number(n)
        } else {
            Node::String(JsText::scalar(s))
        }),
    }
}
fn number_text(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n == f64::INFINITY {
        "Infinity".into()
    } else if n == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        ryu_js::Buffer::new().format(n).into()
    }
}
pub(super) fn js_keys<T>(entries: &mut [(JsText, T)]) {
    entries.sort_by(|(a, _), (b, _)| match (a.array_index(), b.array_index()) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
}

fn yaml_blank_break(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n' | '\0')
}

fn scalar_chars(source: &str, budget: &PreparationBudget<'_>) -> ReadResult<Vec<char>> {
    let mut chars = Vec::new();
    let mut checkpoint = 0;
    for (offset, value) in source.char_indices() {
        if offset >= checkpoint {
            budget.check()?;
            checkpoint = offset + 4096;
        }
        chars.push(value);
    }
    Ok(chars)
}
fn line_end(chars: &[char], start: usize, budget: &PreparationBudget<'_>) -> ReadResult<usize> {
    let mut end = start;
    while end < chars.len() && !matches!(chars[end], '\r' | '\n') {
        if (end - start).is_multiple_of(1024) {
            budget.check()?;
        }
        end += 1;
    }
    Ok(end)
}

fn shield(source: &str, budget: &mut PreparationBudget<'_>) -> ReadResult<String> {
    budget.check()?;
    let chars = scalar_chars(source, budget)?;
    let mut output = String::with_capacity(source.len());
    let mut i = 0;
    let mut flow = 0usize;
    let mut quote = None;
    let mut plain = false;
    let mut plain_indent = 0usize;
    let mut node = true;
    let mut line_start = true;
    let mut line_indent = 0usize;
    let mut quoted_end = false;
    let mut block: Option<(usize, Option<usize>)> = None;
    let mut consumed = 0usize;
    let mut next_check = 4096usize;
    while i < chars.len() {
        if consumed >= next_check {
            budget.check()?;
            next_check = consumed + 4096;
        }
        if line_start && quote.is_none() {
            let start = i;
            while i < chars.len() && chars[i] == ' ' {
                if (i - start) % 1024 == 0 {
                    budget.check()?;
                }
                i += 1;
            }
            line_indent = i - start;
            let blank = i == chars.len() || matches!(chars[i], '\r' | '\n');
            if let Some((base, required)) = block {
                let required = required.or_else(|| (!blank).then_some(line_indent));
                if blank || required.is_some_and(|n| line_indent >= n && line_indent > base) {
                    block = Some((base, required));
                    let end = line_end(&chars, i, budget)?;
                    for c in &chars[start..end] {
                        output.push(*c);
                        if *c == '\u{e000}' {
                            output.push(*c);
                        }
                        consumed += c.len_utf8();
                        if consumed >= next_check {
                            budget.check()?;
                            next_check = consumed + 4096;
                        }
                    }
                    i = end;
                    line_start = false;
                    continue;
                }
                block = None;
            }
            for c in &chars[start..i] {
                output.push(*c);
                consumed += c.len_utf8();
                if consumed >= next_check {
                    budget.check()?;
                    next_check = consumed + 4096;
                }
            }
            if i == chars.len() {
                break;
            }
            if flow == 0 && (!plain || line_indent <= plain_indent) {
                plain = false;
                node = true;
                quoted_end = false;
            }
            line_start = false;
            if line_indent == 0
                && flow == 0
                && chars.get(i..i + 3) == Some(&['-', '-', '-'])
                && chars.get(i + 3).copied().is_none_or(yaml_blank_break)
            {
                output.push_str("---");
                consumed += 3;
                i += 3;
                plain = false;
                node = true;
                quoted_end = false;
                continue;
            }
            if (chars[i] == '%' && line_indent == 0 && !plain) || chars[i] == '#' {
                let end = line_end(&chars, i, budget)?;
                for c in &chars[i..end] {
                    output.push(*c);
                    consumed += c.len_utf8();
                    if consumed >= next_check {
                        budget.check()?;
                        next_check = consumed + 4096;
                    }
                }
                i = end;
                continue;
            }
        }
        let c = chars[i];
        if let Some(q) = quote {
            if q == '"' && c == '\\' {
                let width = match chars.get(i + 1) {
                    Some('u') => Some(4),
                    Some('U') => Some(8),
                    _ => None,
                };
                if let Some(width) = width
                    && i + 2 + width <= chars.len()
                {
                    let digits = chars[i + 2..i + 2 + width].iter().collect::<String>();
                    if let Ok(value) = u32::from_str_radix(&digits, 16) {
                        if value == 0xe000 {
                            output.push('\u{e000}');
                            output.push('\u{e000}');
                            consumed += 2 + width;
                            i += 2 + width;
                            continue;
                        }
                        if (0xd800..=0xdfff).contains(&value) {
                            output.push('\u{e000}');
                            output.push('u');
                            output.push_str(&format!("{value:04x}"));
                            output.push('\u{e000}');
                            consumed += 2 + width;
                            i += 2 + width;
                            continue;
                        }
                    }
                }
                output.push(c);
                consumed += 1;
                i += 1;
                if let Some(c) = chars.get(i) {
                    output.push(*c);
                    consumed += c.len_utf8();
                    i += 1;
                    if *c == '\n' {
                        line_start = true;
                    }
                }
                continue;
            }
            if c == q {
                output.push(c);
                consumed += 1;
                i += 1;
                if q == '\'' && chars.get(i) == Some(&'\'') {
                    output.push('\'');
                    consumed += 1;
                    i += 1;
                    continue;
                }
                quote = None;
                node = false;
                quoted_end = true;
                continue;
            }
            output.push(c);
            if c == '\u{e000}' {
                output.push(c);
            }
            consumed += c.len_utf8();
            i += 1;
            if c == '\n' || c == '\r' {
                line_start = true;
            }
            continue;
        }
        if matches!(c, '\r' | '\n') {
            output.push(c);
            consumed += 1;
            i += 1;
            line_start = true;
            continue;
        }
        let next = chars.get(i + 1).copied();
        if c == '#' && (i == 0 || yaml_blank_break(chars[i - 1])) {
            let end = line_end(&chars, i, budget)?;
            for c in &chars[i..end] {
                output.push(*c);
                consumed += c.len_utf8();
                if consumed >= next_check {
                    budget.check()?;
                    next_check = consumed + 4096;
                }
            }
            i = end;
            continue;
        }
        if node && matches!(c, '!' | '&' | '*') {
            let mut end = i + 1;
            if c == '!' && next == Some('<') {
                while end < chars.len() && chars[end] != '>' {
                    if (end - i) % 1024 == 0 {
                        budget.check()?;
                    }
                    end += 1;
                }
                if end < chars.len() {
                    end += 1;
                }
            } else {
                while end < chars.len()
                    && !yaml_blank_break(chars[end])
                    && !matches!(chars[end], ',' | '[' | ']' | '{' | '}')
                {
                    if (end - i) % 1024 == 0 {
                        budget.check()?;
                    }
                    end += 1;
                }
            }
            for c in &chars[i..end] {
                output.push(*c);
                consumed += c.len_utf8();
                if consumed >= next_check {
                    budget.check()?;
                    next_check = consumed + 4096;
                }
            }
            i = end;
            if c == '*' {
                node = false;
            }
            continue;
        }
        if node && matches!(c, '"' | '\'') {
            quote = Some(c);
            plain = false;
            output.push(c);
            consumed += 1;
            i += 1;
            continue;
        }
        if node && matches!(c, '|' | '>') && flow == 0 {
            let end = line_end(&chars, i, budget)?;
            let mut explicit = None;
            for c in &chars[i + 1..end] {
                if let Some(n) = c.to_digit(10)
                    && n > 0
                {
                    explicit = Some(line_indent + n as usize);
                    break;
                }
                if *c == '#' {
                    break;
                }
            }
            block = Some((line_indent, explicit));
            for c in &chars[i..end] {
                output.push(*c);
                consumed += c.len_utf8();
                if consumed >= next_check {
                    budget.check()?;
                    next_check = consumed + 4096;
                }
            }
            i = end;
            plain = false;
            node = false;
            continue;
        }
        let colon = c == ':'
            && (next.is_none_or(yaml_blank_break)
                || quoted_end
                || (flow > 0 && next.is_some_and(|n| matches!(n, ',' | '[' | ']' | '{' | '}'))));
        let structural = colon
            || (flow > 0 && matches!(c, ',' | ']' | '}'))
            || (node && matches!(c, '[' | '{'))
            || (node && matches!(c, '-' | '?') && next.is_none_or(yaml_blank_break));
        if structural {
            if matches!(c, '[' | '{') {
                flow += 1;
            } else if matches!(c, ']' | '}') {
                flow = flow.saturating_sub(1);
            }
            node = !matches!(c, ']' | '}');
            plain = false;
            quoted_end = false;
        } else if !yaml_blank_break(c) {
            if node {
                plain_indent = line_indent;
            }
            node = false;
            plain = true;
            quoted_end = false;
        }
        output.push(c);
        if plain && c == '\u{e000}' {
            output.push(c);
        }
        consumed += c.len_utf8();
        i += 1;
    }
    budget.check()?;
    if output.len() > source.len().saturating_mul(2) {
        return invalid();
    }
    budget.expansion(output.len().saturating_sub(source.len()))?;
    Ok(output)
}

fn restore_scalar(source: &str, budget: &mut PreparationBudget<'_>) -> ReadResult<JsText> {
    budget.check()?;
    let chars = scalar_chars(source, budget)?;
    let mut units = Vec::new();
    let mut i = 0;
    let mut checked = 0;
    while i < chars.len() {
        if i >= checked {
            budget.check()?;
            checked = i + 1024;
        }
        if chars[i] != '\u{e000}' {
            let mut buffer = [0; 2];
            units.extend_from_slice(chars[i].encode_utf16(&mut buffer));
            i += 1;
            continue;
        }
        if chars.get(i + 1) == Some(&'\u{e000}') {
            units.push(0xe000);
            i += 2;
            continue;
        }
        if chars.get(i + 1) == Some(&'u') && chars.get(i + 6) == Some(&'\u{e000}') {
            let digits = chars[i + 2..i + 6].iter().collect::<String>();
            if let Ok(value) = u16::from_str_radix(&digits, 16)
                && (0xd800..=0xdfff).contains(&value)
            {
                units.push(value);
                i += 7;
                continue;
            }
        }
        return invalid();
    }
    budget.expansion(units.len() * 2)?;
    Ok(JsText::from_units(units))
}
impl Document {
    pub fn parse(bytes: &[u8], budget: &mut PreparationBudget<'_>) -> ReadResult<Self> {
        let text = shield(&String::from_utf8_lossy(bytes), budget)?;
        let mut doc = Self {
            nodes: Vec::new(),
            root: 0,
        };
        let mut stack: Vec<Frame> = Vec::new();
        let mut anchors = HashMap::new();
        let mut documents = 0;
        let mut root = None;
        for event in Parser::new_from_str(&text) {
            let (event, _) = event.map_err(|_| ReadFailure::InvalidDocument)?;
            if matches!(
                &event,
                Event::Scalar(..)
                    | Event::Alias(..)
                    | Event::SequenceStart(..)
                    | Event::MappingStart(..)
            ) {
                budget.node(stack.len())?;
            }
            let (node, anchor, start) = match event {
                Event::StreamStart | Event::Nothing => continue,
                Event::StreamEnd => break,
                Event::DocumentStart(_) => {
                    documents += 1;
                    if documents > 1 {
                        return invalid();
                    }
                    continue;
                }
                Event::DocumentEnd => continue,
                Event::SequenceEnd | Event::MappingEnd => {
                    let frame = stack.pop().ok_or(ReadFailure::InvalidDocument)?;
                    if frame.key.is_some() {
                        return invalid();
                    }
                    continue;
                }
                Event::Scalar(s, style, anchor, tag) => (
                    scalar(restore_scalar(&s, budget)?, style, tag.as_deref())?,
                    anchor,
                    false,
                ),
                Event::Alias(anchor) => (
                    Node::Alias(*anchors.get(&anchor).ok_or(ReadFailure::InvalidDocument)?),
                    0,
                    false,
                ),
                Event::SequenceStart(anchor, tag) => {
                    if !matches!(tag_name(tag.as_deref())?, None | Some("seq") | Some("!")) {
                        return invalid();
                    }
                    (Node::Sequence(Vec::new()), anchor, true)
                }
                Event::MappingStart(anchor, tag) => {
                    if !matches!(tag_name(tag.as_deref())?, None | Some("map") | Some("!")) {
                        return invalid();
                    }
                    (Node::Mapping(Vec::new()), anchor, true)
                }
            };
            let id = doc.nodes.len();
            doc.nodes.push(node);
            if anchor > 0 {
                anchors.insert(anchor, id);
            }
            let depth = stack.len();
            if let Some(frame) = stack.last_mut() {
                budget.node(depth)?;
                let frame_id = frame.id;
                if matches!(doc.nodes[frame_id], Node::Sequence(_)) {
                    if let Node::Sequence(v) = &mut doc.nodes[frame_id] {
                        v.push(id)
                    }
                } else if let Some(key_id) = frame.key.take() {
                    let key = match doc.node(key_id, budget)? {
                        Node::Null => JsText::scalar("null"),
                        Node::Bool(b) => JsText::scalar(&b.to_string()),
                        Node::Number(n) => JsText::scalar(&number_text(*n)),
                        Node::String(s) => s.clone(),
                        _ => return invalid(),
                    };
                    if let Node::Mapping(v) = &mut doc.nodes[frame_id] {
                        if v.iter().any(|(k, _)| *k == key) {
                            return invalid();
                        }
                        v.push((key, id));
                    }
                } else {
                    frame.key = Some(id);
                }
            } else if root.replace(id).is_some() {
                return invalid();
            }
            if start {
                stack.push(Frame { id, key: None });
            }
        }
        if !stack.is_empty() {
            return invalid();
        }
        doc.root = root.ok_or(ReadFailure::InvalidDocument)?;
        for node in &mut doc.nodes {
            if let Node::Mapping(v) = node {
                js_keys(v)
            }
        }
        Ok(doc)
    }
    pub fn node<'a>(
        &'a self,
        mut id: usize,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<&'a Node> {
        loop {
            budget.visit(0)?;
            match self.nodes.get(id).ok_or(ReadFailure::InvalidDocument)? {
                Node::Alias(next) => id = *next,
                node => return Ok(node),
            }
        }
    }
    pub fn get(
        &self,
        id: usize,
        key: &str,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Option<usize>> {
        Ok(match self.node(id, budget)? {
            Node::Mapping(v) => v
                .iter()
                .find(|(k, _)| *k == JsText::scalar(key))
                .map(|(_, v)| *v),
            _ => None,
        })
    }
    pub fn text(&self, id: usize, budget: &mut PreparationBudget<'_>) -> ReadResult<JsText> {
        self.stringify(id, budget, 0, false)
    }
    fn stringify(
        &self,
        id: usize,
        budget: &mut PreparationBudget<'_>,
        depth: usize,
        array: bool,
    ) -> ReadResult<JsText> {
        budget.visit(depth)?;
        match self.node(id, budget)? {
            Node::Null => Ok(JsText::scalar(if array { "" } else { "null" })),
            Node::Bool(b) => Ok(JsText::scalar(&b.to_string())),
            Node::Number(n) => Ok(JsText::scalar(&number_text(*n))),
            Node::String(s) => {
                budget.visit(depth)?;
                budget.expansion(s.units().len() * 2)?;
                Ok(s.clone())
            }
            Node::Mapping(_) => Ok(JsText::scalar("[object Object]")),
            Node::Sequence(v) => {
                let mut out = Vec::new();
                for (i, n) in v.iter().enumerate() {
                    if i > 0 {
                        budget.expansion(1)?;
                        out.push(u16::from(b','))
                    }
                    let s = self.stringify(*n, budget, depth + 1, true)?;
                    if (out.len() + s.units().len()) * 2 > 1024 * 1024 {
                        return Err(ReadFailure::LimitExceeded(
                            super::observation::Resource::DocumentBytes,
                        ));
                    }
                    budget.expansion(s.units().len() * 2)?;
                    out.extend_from_slice(s.units());
                }
                Ok(JsText::from_units(out))
            }
            Node::Alias(_) => unreachable!(),
        }
    }
    pub fn truthy(&self, id: usize, budget: &mut PreparationBudget<'_>) -> ReadResult<bool> {
        Ok(match self.node(id, budget)? {
            Node::Null => false,
            Node::Bool(b) => *b,
            Node::Number(n) => *n != 0.0 && !n.is_nan(),
            Node::String(s) => !s.is_empty(),
            _ => true,
        })
    }
    pub fn optional_text(
        &self,
        id: usize,
        key: &str,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Option<JsText>> {
        let Some(value) = self.get(id, key, budget)? else {
            return Ok(None);
        };
        if matches!(self.node(value, budget)?, Node::Null) {
            Ok(None)
        } else {
            self.text(value, budget).map(Some)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::observation::PreparationLimits;
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn units(document: &Document, key: &str, budget: &mut PreparationBudget<'_>) -> Vec<u16> {
        let id = document.get(document.root, key, budget).unwrap().unwrap();
        document.text(id, budget).unwrap().units().to_vec()
    }

    #[test]
    fn r7_yaml_percent_plain_continuation_preserves_literal_sentinel() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
        let source = "format: print-partner-manifest-v2\nversion: 2\nproject: Diagnostic\noption_groups:\n  toolhead:\n    rule: pick_one\n    label: ordinary\n      %\u{e000}uD800\u{e000}\n    variants:\n      - id: stock\n        parts: [\"toolhead/**\"]\n";
        let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
        let groups = doc
            .get(doc.root, "option_groups", &mut budget)
            .unwrap()
            .unwrap();
        let group = doc.get(groups, "toolhead", &mut budget).unwrap().unwrap();
        let label = doc.get(group, "label", &mut budget).unwrap().unwrap();
        assert_eq!(
            doc.text(label, &mut budget).unwrap().units(),
            "ordinary %\u{e000}uD800\u{e000}"
                .encode_utf16()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn r7_yaml_inline_document_start_preserves_first_surrogate_key_and_groups() {
        let cancel = AtomicBool::new(false);
        for separator in [" ", "\t", "\n"] {
            let source = format!(
                r#"---{separator}{{"\uD800": 0, option_groups: {{toolhead: {{rule: pick_one, variants: [{{id: custom, parts: [custom.stl]}}]}}}}}}"#
            );
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
            let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
            let Node::Mapping(entries) = doc.node(doc.root, &mut budget).unwrap() else {
                panic!("mapping")
            };
            assert!(entries.iter().any(|(key, _)| key.units() == [0xd800]));
            let groups = doc
                .get(doc.root, "option_groups", &mut budget)
                .unwrap()
                .unwrap();
            let group = doc.get(groups, "toolhead", &mut budget).unwrap().unwrap();
            let rule = doc.get(group, "rule", &mut budget).unwrap().unwrap();
            assert_eq!(
                doc.text(rule, &mut budget).unwrap().as_scalar().as_deref(),
                Some("pick_one")
            );
        }
        for scalar in ["---x", "----", "...x"] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
            let doc = Document::parse(scalar.as_bytes(), &mut budget).unwrap();
            assert_eq!(
                doc.text(doc.root, &mut budget)
                    .unwrap()
                    .as_scalar()
                    .as_deref(),
                Some(scalar)
            );
        }
    }

    #[test]
    fn utf16_yaml_active_escapes_alias_and_explicit_string() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
        let doc = Document::parse(
            br#"a: &value "\uD800"
b: *value
c: !!str "\uDC00"
d: "\\uD800"
e: "\uD800\uDC00"
"#,
            &mut budget,
        )
        .unwrap();
        assert_eq!(units(&doc, "a", &mut budget), [0xd800]);
        assert_eq!(units(&doc, "b", &mut budget), [0xd800]);
        assert_eq!(units(&doc, "c", &mut budget), [0xdc00]);
        assert_eq!(
            units(&doc, "d", &mut budget),
            r"\uD800".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(units(&doc, "e", &mut budget), [0xd800, 0xdc00]);
    }

    #[test]
    fn utf16_yaml_sentinel_all_scalar_styles_and_collision() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
        let source = format!(
            "plain: {0}uD800{0}\nsingle: '{0}uD800{0}'\ndouble: \"{0}uD800{0}\"\nliteral: |-\n  {0}uD800{0}\nfolded: >-\n  {0}uD800{0}\n",
            '\u{e000}'
        );
        let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
        for key in ["plain", "single", "double", "literal", "folded"] {
            assert_eq!(
                units(&doc, key, &mut budget),
                [0xe000, 0x75, 0x44, 0x38, 0x30, 0x30, 0xe000]
            );
        }
    }

    #[test]
    fn utf16_yaml_flow_multiline_plain_quotes_comments_and_anchors() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
        let source = "# \u{e000}uD800\u{e000}\nanchor: &\u{e000} value\nalias: *\u{e000}\nflow: {\"\\uD800\": \"\\uDC00\"}\nplain: a\"\u{e000}\"b\nmultiline: \"a\n  \\uD800\"\n";
        let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
        assert_eq!(
            units(&doc, "anchor", &mut budget),
            "value".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(
            units(&doc, "alias", &mut budget),
            "value".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(
            units(&doc, "plain", &mut budget),
            "a\"\u{e000}\"b".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(units(&doc, "multiline", &mut budget), [0x61, 0x20, 0xd800]);
        let flow = doc.get(doc.root, "flow", &mut budget).unwrap().unwrap();
        let Node::Mapping(entries) = doc.node(flow, &mut budget).unwrap() else {
            panic!("mapping")
        };
        assert_eq!(entries[0].0.units(), [0xd800]);
        assert_eq!(
            doc.text(entries[0].1, &mut budget).unwrap().units(),
            [0xdc00]
        );
    }

    #[test]
    fn utf16_yaml_rejects_other_tags_duplicates_and_invalid_escapes() {
        let cancel = AtomicBool::new(false);
        for text in [
            r#"a: !!int "\uD800""#,
            r#"a: !!bool "\uD800""#,
            r#""\uD800": a
"\uD800": b"#,
            r#"a: "\uD80X""#,
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
            assert!(matches!(
                Document::parse(text.as_bytes(), &mut budget),
                Err(ReadFailure::InvalidDocument)
            ));
        }
    }

    #[test]
    fn utf16_yaml_ordinary_cancellation_and_expansion_refusal() {
        let cancel = AtomicBool::new(true);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default());
        assert!(matches!(
            Document::parse(b"a: b", &mut budget),
            Err(ReadFailure::Cancelled)
        ));
        let cancel = AtomicBool::new(false);
        let limits = PreparationLimits {
            total_document_bytes: 2,
            ..PreparationLimits::default()
        };
        let mut budget = PreparationBudget::new(&cancel, limits);
        assert!(matches!(
            Document::parse(br#"a: "\uD800""#, &mut budget),
            Err(ReadFailure::LimitExceeded(_))
        ));
    }
}
