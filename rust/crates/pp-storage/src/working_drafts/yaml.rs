use super::observation::{PreparationBudget, ReadFailure, ReadResult};
use crate::manifest_text::JsText;
use saphyr_parser::{Event, Parser, ScalarStyle, Tag};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

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
    keys: HashSet<JsText>,
}
fn invalid<T>() -> ReadResult<T> {
    Err(ReadFailure::InvalidDocument)
}
fn tag_name(tag: Option<&Tag>) -> ReadResult<Option<&str>> {
    let Some(t) = tag else {
        return Ok(None);
    };
    if t.handle.is_empty() && t.suffix == "!" {
        return Ok(Some("!"));
    }
    // A verbatim tag has an empty handle and its whole URI as the suffix.
    let name = if t.handle.is_empty() {
        t.suffix.strip_prefix("tag:yaml.org,2002:")
    } else if t.is_yaml_core_schema() {
        Some(t.suffix.as_str())
    } else {
        None
    };
    match name {
        Some(name @ ("str" | "int" | "float" | "bool" | "null" | "seq" | "map")) => Ok(Some(name)),
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
    static FLOAT: LazyLock<Option<regress::Regex>> = LazyLock::new(|| {
        regress::Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").ok()
    });
    if FLOAT.as_ref()?.find(s).is_some() {
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

struct FlowProperty {
    line: usize,
    // A `:` after the empty node would separate it as a mapping key.
    key: bool,
}

fn shield(source: &str, budget: &mut PreparationBudget<'_>) -> ReadResult<String> {
    budget.check()?;
    let chars = scalar_chars(source, budget)?;
    let mut output = String::with_capacity(source.len());
    let mut i = 0;
    // Opening bracket of each open flow collection.
    let mut flow: Vec<char> = Vec::new();
    let mut quote = None;
    let mut plain = false;
    // Column of the last block `-` or `?`, or of the key before the last block
    // `:`; None at the document root. A plain scalar continues on any deeper line.
    let mut parent: Option<usize> = None;
    let mut plain_parent: Option<usize> = None;
    let mut node_column: Option<usize> = None;
    let mut node = true;
    let mut line_start = true;
    let mut line_begin = 0usize;
    let mut line_indent = 0usize;
    // The line began inside a quoted scalar, so its indent is unknown here.
    let mut quoted_line = false;
    let mut quoted_end = false;
    let mut block: Option<(usize, Option<usize>)> = None;
    // js-yaml's indent for the outermost flow collection: one past its block
    // parent, or the indent of the line the root node starts on.
    let mut flow_indent = 0usize;
    let mut document_indent: Option<usize> = None;
    // js-yaml rejects a separating tab followed on the same line by a flow
    // token when the line is indented less than the collection, which is the
    // line a block value's flow opens on.
    let mut shallow_flow = false;
    let mut separation_tab = false;
    // A tab after a flow node's properties counts once the node ends.
    let mut node_tab = false;
    let mut flow_key = false;
    let mut flow_property: Option<FlowProperty> = None;
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
            line_begin = start;
            line_indent = i - start;
            quoted_line = start > 0 && !matches!(chars[start - 1], '\r' | '\n');
            node_column = None;
            shallow_flow = false;
            separation_tab = false;
            node_tab = false;
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
            let mut content = i;
            while chars.get(content).is_some_and(|c| matches!(c, ' ' | '\t')) {
                if (content - i).is_multiple_of(1024) {
                    budget.check()?;
                }
                content += 1;
            }
            let plain_blank = chars.get(content).is_none_or(|c| matches!(c, '\r' | '\n'));
            if !plain_blank
                && flow.is_empty()
                && (!plain || plain_parent.is_some_and(|n| line_indent <= n))
            {
                plain = false;
                node = true;
                quoted_end = false;
            }
            line_start = false;
            if line_indent == 0
                && flow.is_empty()
                && matches!(chars.get(i..i + 3), Some(['-', '-', '-'] | ['.', '.', '.']))
                && chars.get(i + 3).copied().is_none_or(yaml_blank_break)
            {
                output.extend(&chars[i..i + 3]);
                consumed += 3;
                i += 3;
                parent = None;
                document_indent = None;
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
            // js-yaml checks quoted continuation lines before reading flow keys.
            if !flow.is_empty() && i > 0 && matches!(chars[i - 1], '\r' | '\n') {
                let mut end = i;
                while chars.get(end) == Some(&' ') {
                    if (end - i).is_multiple_of(1024) {
                        budget.check()?;
                    }
                    end += 1;
                }
                let indent = end - i;
                while chars.get(end).is_some_and(|c| matches!(c, ' ' | '\t')) {
                    if (end - i).is_multiple_of(1024) {
                        budget.check()?;
                    }
                    end += 1;
                }
                if indent < flow_indent && chars.get(end).is_some_and(|c| !matches!(c, '\r' | '\n'))
                {
                    return invalid();
                }
            }
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
                    if matches!(*c, '\r' | '\n') {
                        line_start = true;
                        if *c == '\r' && chars.get(i) == Some(&'\n') {
                            output.push('\n');
                            consumed += 1;
                            i += 1;
                        }
                        // js-yaml folds the blank lines after an escaped line
                        // break away; saphyr keeps each as a newline.
                        loop {
                            let mut end = i;
                            while chars.get(end).is_some_and(|c| matches!(c, ' ' | '\t')) {
                                if (end - i).is_multiple_of(1024) {
                                    budget.check()?;
                                }
                                end += 1;
                            }
                            let width = match chars.get(end..end + 2) {
                                Some(['\r', '\n']) => 2,
                                _ if chars.get(end).is_some_and(|c| matches!(c, '\r' | '\n')) => 1,
                                _ => break,
                            };
                            consumed += end + width - i;
                            i = end + width;
                        }
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
            if c == '\r' && chars.get(i) == Some(&'\n') {
                output.push('\n');
                consumed += 1;
                i += 1;
            }
            line_start = true;
            continue;
        }
        let next = chars.get(i + 1).copied();
        let column = i - line_begin;
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
        let mut separator = false;
        if !yaml_blank_break(c) {
            // js-yaml ends a flow node at its properties when a line break
            // follows and the next line is not indented past the collection.
            // That line may sit below the collection's indent.
            if let Some(property) = flow_property.take()
                && property.line != line_begin
                && line_indent <= flow_indent
            {
                separator = c == ':' && property.key;
                if !separator && !matches!(c, ',' | ']' | '}') {
                    return invalid();
                }
                shallow_flow = line_indent < flow_indent;
            }
            // js-yaml indents every other flow line at least to the collection.
            if !flow.is_empty() && !shallow_flow && !quoted_line && line_indent < flow_indent {
                return invalid();
            }
            if separation_tab && shallow_flow && !flow.is_empty() {
                return invalid();
            }
            // js-yaml counts no indent on the first line.
            document_indent.get_or_insert(if line_begin == 0 { 0 } else { line_indent });
        }
        if node && !yaml_blank_break(c) && node_column.is_none() {
            node_column = Some(column);
        }
        if node && matches!(c, '!' | '&' | '*') {
            let verbatim = c == '!' && next == Some('<');
            let mut end = i + 1;
            while end < chars.len()
                && !yaml_blank_break(chars[end])
                && if verbatim {
                    chars[end] != '>'
                } else {
                    !matches!(chars[end], ',' | '[' | ']' | '{' | '}')
                }
            {
                if (end - i) % 1024 == 0 {
                    budget.check()?;
                }
                end += 1;
            }
            if verbatim {
                // saphyr decodes verbatim tags and gives them an empty handle, so
                // `!<!>` and `!<%21>` would pass as a bare `!`, which js-yaml rejects.
                if matches!(&chars[i + 2..end], ['!'] | ['%', '2', '1']) {
                    return invalid();
                }
                if chars.get(end) == Some(&'>') {
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
            } else if !flow.is_empty() {
                flow_property = Some(FlowProperty {
                    line: line_begin,
                    key: flow_key,
                });
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
        if node && matches!(c, '|' | '>') {
            // js-yaml reads no block scalar inside a flow collection.
            if !flow.is_empty() {
                return invalid();
            }
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
            && (separator
                || next.is_none_or(yaml_blank_break)
                || quoted_end
                || (!flow.is_empty()
                    && next.is_some_and(|n| matches!(n, ',' | '[' | ']' | '{' | '}'))));
        let structural = colon
            || (!flow.is_empty() && matches!(c, ',' | ']' | '}'))
            || (node && matches!(c, '[' | '{'))
            || (node && matches!(c, '-' | '?') && next.is_none_or(yaml_blank_break));
        if structural {
            if flow.is_empty() && c == ':' {
                parent = Some(node_column.unwrap_or(column));
            } else if flow.is_empty() && matches!(c, '-' | '?') {
                parent = Some(column);
            }
            node_column = None;
            if node_tab && shallow_flow && !flow.is_empty() {
                if !matches!(c, '[' | '{') {
                    return invalid();
                }
                separation_tab = true;
            }
            node_tab = false;
            if matches!(c, '[' | '{') {
                if flow.is_empty() {
                    flow_indent = parent.map_or(document_indent.unwrap_or(0), |p| p + 1);
                    shallow_flow = line_indent < flow_indent;
                }
                flow.push(c);
            } else if matches!(c, ']' | '}') {
                flow.pop();
            }
            flow_key = match c {
                '{' | '?' => true,
                ',' => flow.last() == Some(&'{'),
                _ => false,
            };
            node = !matches!(c, ']' | '}');
            plain = false;
            quoted_end = false;
        } else if !yaml_blank_break(c) {
            if node {
                plain_parent = parent;
            }
            node = false;
            plain = true;
            quoted_end = false;
        } else if c == '\t' && !plain && (node || !flow.is_empty()) {
            if flow_property.is_some() {
                node_tab = true;
            } else {
                separation_tab = true;
            }
        }
        output.push(c);
        if separator {
            output.push(' ');
        }
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
            if let Some(frame) = stack.last_mut() {
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
                    // The entry and the seen-key set each store a UTF-16 copy.
                    budget.expansion(key.units().len() * 4)?;
                    if let Node::Mapping(v) = &mut doc.nodes[frame_id] {
                        if !frame.keys.insert(key.clone()) {
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
                stack.push(Frame {
                    id,
                    key: None,
                    keys: HashSet::new(),
                });
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
        self.stringify(id, budget, &mut Vec::new())
    }
    /// `active` holds the sequences being joined on the current path. Like
    /// JavaScript's `Array.prototype.join`, a sequence already in it contributes
    /// an empty string instead of recursing.
    fn stringify<'a>(
        &'a self,
        id: usize,
        budget: &mut PreparationBudget<'_>,
        active: &mut Vec<&'a Node>,
    ) -> ReadResult<JsText> {
        let depth = active.len();
        budget.visit(depth)?;
        let node = self.node(id, budget)?;
        let text = match node {
            Node::Null => JsText::scalar(if depth > 0 { "" } else { "null" }),
            Node::Bool(b) => JsText::scalar(&b.to_string()),
            Node::Number(n) => JsText::scalar(&number_text(*n)),
            Node::String(s) => {
                budget.visit(depth)?;
                budget.expansion(s.units().len() * 2)?;
                return Ok(s.clone());
            }
            Node::Mapping(_) => JsText::scalar("[object Object]"),
            Node::Sequence(_) if active.iter().any(|n| std::ptr::eq(*n, node)) => {
                JsText::scalar("")
            }
            Node::Sequence(v) => {
                active.push(node);
                let mut out = Vec::new();
                for (i, n) in v.iter().enumerate() {
                    if i > 0 {
                        budget.expansion(2)?;
                        out.push(u16::from(b','))
                    }
                    let s = self.stringify(*n, budget, active)?;
                    if (out.len() + s.units().len()) * 2 > 1024 * 1024 {
                        return Err(ReadFailure::LimitExceeded(
                            super::observation::Resource::DocumentBytes,
                        ));
                    }
                    budget.expansion(s.units().len() * 2)?;
                    out.extend_from_slice(s.units());
                }
                active.pop();
                return Ok(JsText::from_units(out));
            }
            Node::Alias(_) => unreachable!(),
        };
        budget.expansion(text.units().len() * 2)?;
        Ok(text)
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
    fn yaml_direct_coercion_charges_all_output_bytes() {
        let cancel = AtomicBool::new(false);
        for (source, expected) in [
            ("null", "null"),
            ("true", "true"),
            ("1e21", "1e+21"),
            ("{}", "[object Object]"),
        ] {
            let mut parse_budget =
                PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let doc = Document::parse(source.as_bytes(), &mut parse_budget).unwrap();
            let bytes = expected.encode_utf16().count() * 2;
            for limit in [bytes - 1, bytes] {
                let mut budget = PreparationBudget::new(
                    &cancel,
                    PreparationLimits {
                        total_document_bytes: limit,
                        ..PreparationLimits::default()
                    },
                )
                .unwrap();
                let result = doc.text(doc.root, &mut budget);
                if limit == bytes {
                    assert_eq!(result.unwrap().as_scalar().as_deref(), Some(expected));
                    assert!(matches!(
                        doc.text(doc.root, &mut budget),
                        Err(ReadFailure::LimitExceeded(
                            super::super::observation::Resource::DocumentBytes
                        ))
                    ));
                } else {
                    assert!(
                        matches!(
                            result,
                            Err(ReadFailure::LimitExceeded(
                                super::super::observation::Resource::DocumentBytes
                            ))
                        ),
                        "{source}"
                    );
                }
            }
        }
        let source = b"x: {}";
        let mut budget = PreparationBudget::new(
            &cancel,
            PreparationLimits {
                total_document_bytes: 8,
                ..PreparationLimits::default()
            },
        )
        .unwrap();
        budget.document(source.len(), source.len()).unwrap();
        let doc = Document::parse(source, &mut budget).unwrap();
        assert!(matches!(
            doc.optional_text(doc.root, "x", &mut budget),
            Err(ReadFailure::LimitExceeded(
                super::super::observation::Resource::DocumentBytes
            ))
        ));
    }

    #[test]
    fn yaml_counts_each_parsed_node_once() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(
            &cancel,
            PreparationLimits {
                nodes: 3,
                ..PreparationLimits::default()
            },
        )
        .unwrap();
        let doc = Document::parse(b"[a, b]", &mut budget).unwrap();
        assert_eq!(
            doc.text(doc.root, &mut budget)
                .unwrap()
                .as_scalar()
                .as_deref(),
            Some("a,b")
        );
        let mut budget = PreparationBudget::new(
            &cancel,
            PreparationLimits {
                nodes: 2,
                ..PreparationLimits::default()
            },
        )
        .unwrap();
        assert!(matches!(
            Document::parse(b"[a, b]", &mut budget),
            Err(ReadFailure::LimitExceeded(
                super::super::observation::Resource::Nodes
            ))
        ));
    }

    #[test]
    fn yaml_array_separator_expansion_counts_utf16_bytes() {
        let cancel = AtomicBool::new(false);
        let mut parse_budget =
            PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(b"[null, null, null, null]", &mut parse_budget).unwrap();
        for (limit, succeeds) in [(6, true), (5, false)] {
            let mut budget = PreparationBudget::new(
                &cancel,
                PreparationLimits {
                    total_document_bytes: limit,
                    ..PreparationLimits::default()
                },
            )
            .unwrap();
            let result = doc.text(doc.root, &mut budget);
            if succeeds {
                assert_eq!(result.unwrap().as_scalar().as_deref(), Some(",,,"));
            } else {
                assert!(matches!(
                    result,
                    Err(ReadFailure::LimitExceeded(
                        super::super::observation::Resource::DocumentBytes
                    ))
                ));
            }
        }
    }

    #[test]
    fn yaml_large_mapping_keeps_keys_and_rejects_coerced_duplicates() {
        let cancel = AtomicBool::new(false);
        let source = (0..4096)
            .map(|i| format!("key{i}: {i}\n"))
            .collect::<String>();
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
        let Node::Mapping(entries) = doc.node(doc.root, &mut budget).unwrap() else {
            panic!("mapping");
        };
        assert_eq!(entries.len(), 4096);
        assert_eq!(units(&doc, "key4095", &mut budget), [52, 48, 57, 53]);
        for source in [
            format!("{source}key0: duplicate\n"),
            "true: one\n'true': two\n".into(),
            "1: one\n'1': two\n".into(),
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            assert!(matches!(
                Document::parse(source.as_bytes(), &mut budget),
                Err(ReadFailure::InvalidDocument)
            ));
        }
    }

    #[test]
    fn yaml_signed_prefixes_and_empty_collection_tags_match_js_yaml() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(
            b"hex: -0x10\noctal: +0o10\nmap: !!map \"\"\nseq: !!seq \"\"\n",
            &mut budget,
        )
        .unwrap();
        assert_eq!(
            units(&doc, "hex", &mut budget),
            "-0x10".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(
            units(&doc, "octal", &mut budget),
            "+0o10".encode_utf16().collect::<Vec<_>>()
        );
        let map = doc.get(doc.root, "map", &mut budget).unwrap().unwrap();
        assert!(matches!(doc.node(map, &mut budget).unwrap(), Node::Mapping(v) if v.is_empty()));
        let seq = doc.get(doc.root, "seq", &mut budget).unwrap().unwrap();
        assert!(matches!(doc.node(seq, &mut budget).unwrap(), Node::Sequence(v) if v.is_empty()));
    }

    #[test]
    fn yaml_mapping_key_copies_charge_expansion() {
        let cancel = AtomicBool::new(false);
        let long = "k".repeat(1000);
        for (source, key, bytes) in [
            (format!("{long}: v"), long.as_str(), 6002),
            ("1e21: v".into(), "1e+21", 30),
        ] {
            for limit in [bytes - 1, bytes] {
                let mut budget = PreparationBudget::new(
                    &cancel,
                    PreparationLimits {
                        total_document_bytes: limit,
                        ..PreparationLimits::default()
                    },
                )
                .unwrap();
                let result = Document::parse(source.as_bytes(), &mut budget);
                if limit == bytes {
                    let doc = result.unwrap();
                    let Node::Mapping(entries) = doc.node(doc.root, &mut budget).unwrap() else {
                        panic!("mapping");
                    };
                    assert_eq!(entries.len(), 1);
                    assert_eq!(entries[0].0.as_scalar().as_deref(), Some(key));
                } else {
                    assert!(
                        matches!(
                            result,
                            Err(ReadFailure::LimitExceeded(
                                super::super::observation::Resource::DocumentBytes
                            ))
                        ),
                        "{}-unit key under {limit} bytes",
                        key.len()
                    );
                }
            }
        }
    }

    #[test]
    fn yaml_cyclic_array_aliases_coerce_like_js_join() {
        let cancel = AtomicBool::new(false);
        for (source, expected) in [
            ("project: &a [*a]", ""),
            ("project: &a [x, *a, y]", "x,,y"),
            ("project: &a [x, &b [y, *a, *b], *b]", "x,y,,,y,,"),
            ("project: &a [&b [*a]]", ""),
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
            let text = doc.optional_text(doc.root, "project", &mut budget);
            assert_eq!(
                text.unwrap().and_then(|t| t.as_scalar()).as_deref(),
                Some(expected),
                "{source}"
            );
        }
    }

    #[test]
    fn yaml_bare_non_specific_tag_matches_js_yaml() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(
            b"project: ! 123\nparts: ! [a]\ngroups: ! {a: 1}\n",
            &mut budget,
        )
        .unwrap();
        let project = doc.get(doc.root, "project", &mut budget).unwrap().unwrap();
        assert!(matches!(
            doc.node(project, &mut budget).unwrap(),
            Node::String(s) if s.as_scalar().as_deref() == Some("123")
        ));
        let parts = doc.get(doc.root, "parts", &mut budget).unwrap().unwrap();
        assert!(matches!(doc.node(parts, &mut budget).unwrap(), Node::Sequence(v) if v.len() == 1));
        assert_eq!(units(&doc, "parts", &mut budget), [0x61]);
        let groups = doc.get(doc.root, "groups", &mut budget).unwrap().unwrap();
        let a = doc.get(groups, "a", &mut budget).unwrap().unwrap();
        assert!(matches!(doc.node(a, &mut budget).unwrap(), Node::Number(n) if *n == 1.0));
        for source in ["project: !<!> 123", "parts: !<%21> [a]"] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            assert!(
                matches!(
                    Document::parse(source.as_bytes(), &mut budget),
                    Err(ReadFailure::InvalidDocument)
                ),
                "{source}"
            );
        }
    }

    #[test]
    fn yaml_plain_continuation_keeps_property_lookalikes_like_js_yaml() {
        let cancel = AtomicBool::new(false);
        for (source, path, expected) in [
            (
                "project:\n  prefix\n  !<literal>",
                &["project"][..],
                "prefix !<literal>",
            ),
            ("project:\n  prefix\n  !<!>", &["project"], "prefix !<!>"),
            ("project:\n  prefix\n  &a b", &["project"], "prefix &a b"),
            ("project:\n  prefix\n  'q'", &["project"], "prefix 'q'"),
            ("project:\n  prefix\n  - x", &["project"], "prefix - x"),
            ("project:\n    prefix\n  !<l>", &["project"], "prefix !<l>"),
            (
                "x:\n  a:\n    prefix\n    !<l>\n  b: 1",
                &["x", "a"],
                "prefix !<l>",
            ),
            ("? a\n  !<l>\n: v", &["a !<l>"], "v"),
            ("- a\n  !<b>", &[], "a !<b>"),
            ("a\n!<b>", &[], "a !<b>"),
            (
                "- -\n    a\n  - \"\\uE000\\uE000\"",
                &[],
                "a,\u{e000}\u{e000}",
            ),
            ("...\n\"\\uE000\\uE000\"", &[], "\u{e000}\u{e000}"),
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
            let mut id = doc.root;
            for key in path {
                id = doc.get(id, key, &mut budget).unwrap().unwrap();
            }
            assert_eq!(
                doc.text(id, &mut budget).unwrap().units(),
                expected.encode_utf16().collect::<Vec<_>>(),
                "{source}"
            );
        }
        for source in [
            "a:\n  b # c\n  !<l> x",
            "a:\n  b\n# c\n  !<l> x",
            "- - a\n  !<l>",
            "- -\n    a\n  - !<!> x",
            "...\n!<!> x",
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            assert!(
                matches!(
                    Document::parse(source.as_bytes(), &mut budget),
                    Err(ReadFailure::InvalidDocument)
                ),
                "{source}"
            );
        }
    }

    #[test]
    fn yaml_plain_continuation_after_crlf_preserves_literal_escape() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(b"project: prefix\r\n  \"\\uE000\"", &mut budget).unwrap();
        assert_eq!(
            units(&doc, "project", &mut budget),
            "prefix \"\\uE000\"".encode_utf16().collect::<Vec<_>>()
        );
    }

    #[test]
    fn yaml_plain_continuation_after_blank_preserves_literal_escape() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(b"project: prefix\n\n  \"\\uE000\"", &mut budget).unwrap();
        assert_eq!(
            units(&doc, "project", &mut budget),
            "prefix\n\"\\uE000\"".encode_utf16().collect::<Vec<_>>()
        );
    }

    #[test]
    fn yaml_tab_blank_regressions_preserve_literal_escape() {
        let cancel = AtomicBool::new(false);
        let mut actual = Vec::new();
        for source in [
            "a: x\n\t\n  \"\\uE000\"",
            "a: x\n\t  \n  \"\\uE000\"",
            "- x\n\t\n  \"\\uE000\"",
            "a: x\n  \n\t\n    \n  \"\\uE000\"",
            "a: x\r\n\t\r\n  \"\\uE000\"",
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let doc = Document::parse(source.as_bytes(), &mut budget).unwrap();
            let id = if source.starts_with('-') {
                let Node::Sequence(items) = doc.node(doc.root, &mut budget).unwrap() else {
                    panic!("expected a sequence");
                };
                items[0]
            } else {
                doc.get(doc.root, "a", &mut budget).unwrap().unwrap()
            };
            actual.push(doc.text(id, &mut budget).unwrap().units().to_vec());
        }
        let expected = [
            "x\n\"\\uE000\"",
            "x\n\"\\uE000\"",
            "x\n\"\\uE000\"",
            "x\n\n\n\"\\uE000\"",
            "x\n\"\\uE000\"",
        ]
        .map(|value| value.encode_utf16().collect::<Vec<_>>());
        assert_eq!(actual, expected);
    }

    #[test]
    fn yaml_line_breaks_match_js_yaml() {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Expected {
            Mapping(HashMap<String, String>),
            Sequence(Vec<String>),
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            source: String,
            expected: Option<Expected>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../tests/fixtures/yaml-line-breaks-node.json"
        ))
        .unwrap();
        let cancel = AtomicBool::new(false);
        for case in cases {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let result = Document::parse(case.source.as_bytes(), &mut budget);
            let Some(expected) = case.expected else {
                assert!(
                    matches!(result, Err(ReadFailure::InvalidDocument)),
                    "{}: {:?}",
                    case.name,
                    case.source
                );
                continue;
            };
            let doc = result.unwrap_or_else(|err| panic!("{}: {err:?}", case.name));
            match (doc.node(doc.root, &mut budget).unwrap(), expected) {
                (Node::Mapping(entries), Expected::Mapping(expected)) => {
                    assert_eq!(entries.len(), expected.len(), "{}", case.name);
                    for (key, value) in expected {
                        assert_eq!(
                            units(&doc, &key, &mut budget),
                            value.encode_utf16().collect::<Vec<_>>(),
                            "{}: {key}",
                            case.name
                        );
                    }
                }
                (Node::Sequence(items), Expected::Sequence(expected)) => {
                    assert_eq!(items.len(), expected.len(), "{}", case.name);
                    for (id, value) in items.iter().zip(expected) {
                        assert_eq!(
                            doc.text(*id, &mut budget).unwrap().units(),
                            value.encode_utf16().collect::<Vec<_>>(),
                            "{}",
                            case.name
                        );
                    }
                }
                _ => panic!("{}: unexpected collection", case.name),
            }
        }
    }

    fn json(doc: &Document, id: usize, budget: &mut PreparationBudget<'_>) -> serde_json::Value {
        let text = |s: &JsText| String::from_utf16(s.units()).unwrap();
        match doc.node(id, budget).unwrap().clone() {
            Node::Null => serde_json::Value::Null,
            Node::Bool(b) => b.into(),
            Node::Number(n) if n.fract() == 0.0 && n.abs() < 9e15 => (n as i64).into(),
            Node::Number(n) => n.into(),
            Node::String(s) => text(&s).into(),
            Node::Sequence(items) => items.iter().map(|id| json(doc, *id, budget)).collect(),
            Node::Mapping(entries) => entries
                .iter()
                .map(|(key, id)| (text(key), json(doc, *id, budget)))
                .collect(),
            Node::Alias(_) => unreachable!("node resolves aliases"),
        }
    }

    #[test]
    fn yaml_flow_collections_match_js_yaml() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            source: String,
            expected: Option<serde_json::Value>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../tests/fixtures/yaml-flow-collections-node.json"
        ))
        .unwrap();
        let cancel = AtomicBool::new(false);
        let mut mismatches = Vec::new();
        for case in cases {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            let actual = match Document::parse(case.source.as_bytes(), &mut budget) {
                Ok(doc) => Some(json(&doc, doc.root, &mut budget)),
                Err(ReadFailure::InvalidDocument) => None,
                Err(err) => panic!("{}: {err:?}", case.name),
            };
            if actual != case.expected {
                mismatches.push(format!("{}: {:?} gave {actual:?}", case.name, case.source));
            }
        }
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }

    #[test]
    fn yaml_verbatim_core_schema_tags_match_js_yaml() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(
            b"str: !<tag:yaml.org,2002:str> 123\n\
              escaped: !<tag:yaml.org,2002:%73tr> 123\n\
              int: !<tag:yaml.org,2002:int> 123\n\
              null: !<tag:yaml.org,2002:null> ''\n\
              bool: !<tag:yaml.org,2002:bool> true\n\
              float: !<tag:yaml.org,2002:float> 1.5\n\
              seq: !<tag:yaml.org,2002:seq> [a]\n\
              map: !<tag:yaml.org,2002:map> {a: 1}\n\
              flow: [!<tag:yaml.org,2002:str> 1, b]\n\
              quoted: !<tag:yaml.org,2002:str> \"\\uE000\\uE000\"\n\
              surrogate: !<tag:yaml.org,2002:str> \"\\uE000uD800\\uE000\"\n",
            &mut budget,
        )
        .unwrap();
        let mut node = |key: &str| {
            let id = doc.get(doc.root, key, &mut budget).unwrap().unwrap();
            doc.node(id, &mut budget).unwrap().clone()
        };
        for key in ["str", "escaped"] {
            assert!(
                matches!(node(key), Node::String(s) if s.as_scalar().as_deref() == Some("123")),
                "{key}"
            );
        }
        assert!(matches!(node("int"), Node::Number(n) if n == 123.0));
        assert!(matches!(node("null"), Node::Null));
        assert!(matches!(node("bool"), Node::Bool(true)));
        assert!(matches!(node("float"), Node::Number(n) if n == 1.5));
        assert!(matches!(node("seq"), Node::Sequence(v) if v.len() == 1));
        assert!(matches!(node("map"), Node::Mapping(v) if v.len() == 1));
        assert_eq!(
            units(&doc, "flow", &mut budget),
            "1,b".encode_utf16().collect::<Vec<_>>()
        );
        assert_eq!(units(&doc, "quoted", &mut budget), [0xe000, 0xe000]);
        assert_eq!(
            units(&doc, "surrogate", &mut budget),
            "\u{e000}uD800\u{e000}".encode_utf16().collect::<Vec<_>>()
        );
        for source in [
            "project: !<tag:yaml.org,2002:!> 123",
            "project: !<tag:yaml.org,2002:%21> 123",
            "parts: !<tag:yaml.org,2002:!> [a]",
            "project: !<tag:yaml.org,2002:binary> 123",
            "project: !<tag:example.com,2000:x> 1",
            "project: !<> 1",
        ] {
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            assert!(
                matches!(
                    Document::parse(source.as_bytes(), &mut budget),
                    Err(ReadFailure::InvalidDocument)
                ),
                "{source}"
            );
        }
    }

    #[test]
    fn r7_yaml_percent_plain_continuation_preserves_literal_sentinel() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
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
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
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
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
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
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
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
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
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
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
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
    fn yaml_js_coercion_for_optional_text_and_truthiness() {
        let cancel = AtomicBool::new(false);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        let doc = Document::parse(
            b"none: ~\nlist: [1, null, x]\nmap: {a: 1}\nnum: 1e21\nzero: 0\nnan: .nan\nempty: ''\nyes: on\n",
            &mut budget,
        )
        .unwrap();
        let text = |key: &str, budget: &mut PreparationBudget<'_>| {
            doc.optional_text(doc.root, key, budget)
                .unwrap()
                .map(|t| t.as_scalar().unwrap())
        };
        assert_eq!(text("missing", &mut budget), None);
        assert_eq!(text("none", &mut budget), None);
        assert_eq!(text("list", &mut budget).as_deref(), Some("1,,x"));
        assert_eq!(text("map", &mut budget).as_deref(), Some("[object Object]"));
        assert_eq!(text("num", &mut budget).as_deref(), Some("1e+21"));
        assert_eq!(text("yes", &mut budget).as_deref(), Some("on"));
        let truthy = |key: &str, budget: &mut PreparationBudget<'_>| {
            let id = doc.get(doc.root, key, budget).unwrap().unwrap();
            doc.truthy(id, budget).unwrap()
        };
        for key in ["none", "zero", "nan", "empty"] {
            assert!(!truthy(key, &mut budget), "{key}");
        }
        for key in ["list", "map", "num", "yes"] {
            assert!(truthy(key, &mut budget), "{key}");
        }
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
            let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
            assert!(matches!(
                Document::parse(text.as_bytes(), &mut budget),
                Err(ReadFailure::InvalidDocument)
            ));
        }
    }

    #[test]
    fn utf16_yaml_ordinary_cancellation_and_expansion_refusal() {
        let cancel = AtomicBool::new(true);
        let mut budget = PreparationBudget::new(&cancel, PreparationLimits::default()).unwrap();
        assert!(matches!(
            Document::parse(b"a: b", &mut budget),
            Err(ReadFailure::Cancelled)
        ));
        let cancel = AtomicBool::new(false);
        let limits = PreparationLimits {
            total_document_bytes: 2,
            ..PreparationLimits::default()
        };
        let mut budget = PreparationBudget::new(&cancel, limits).unwrap();
        assert!(matches!(
            Document::parse(br#"a: "\uD800""#, &mut budget),
            Err(ReadFailure::LimitExceeded(_))
        ));
    }
}
