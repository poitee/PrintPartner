use super::observation::{PreparationBudget, ReadFailure, ReadResult};
use saphyr_parser::{Event, Parser, ScalarStyle, Tag};
use std::collections::HashMap;

#[derive(Clone)]
pub(super) enum Node {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Sequence(Vec<usize>),
    Mapping(Vec<(String, usize)>),
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
fn scalar(s: &str, style: ScalarStyle, tag: Option<&Tag>) -> ReadResult<Node> {
    let tag = tag_name(tag)?;
    if tag == Some("str") || tag == Some("!") || (tag.is_none() && style != ScalarStyle::Plain) {
        return Ok(Node::String(s.into()));
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
            Node::String(s.into())
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
pub(super) fn js_keys<T>(entries: &mut [(String, T)]) {
    entries.sort_by(|(a, _), (b, _)| {
        fn index(s: &str) -> Option<u32> {
            let n = s.parse::<u32>().ok()?;
            if n != u32::MAX && n.to_string() == s {
                Some(n)
            } else {
                None
            }
        }
        match (index(a), index(b)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        }
    })
}
impl Document {
    pub fn parse(bytes: &[u8], budget: &mut PreparationBudget<'_>) -> ReadResult<Self> {
        let text = String::from_utf8_lossy(bytes);
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
                Event::Scalar(s, style, anchor, tag) => {
                    (scalar(&s, style, tag.as_deref())?, anchor, false)
                }
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
                        Node::Null => "null".into(),
                        Node::Bool(b) => b.to_string(),
                        Node::Number(n) => number_text(*n),
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
            Node::Mapping(v) => v.iter().find(|(k, _)| k == key).map(|(_, v)| *v),
            _ => None,
        })
    }
    pub fn string(&self, id: usize, budget: &mut PreparationBudget<'_>) -> ReadResult<String> {
        self.stringify(id, budget, 0, false)
    }
    fn stringify(
        &self,
        id: usize,
        budget: &mut PreparationBudget<'_>,
        depth: usize,
        array: bool,
    ) -> ReadResult<String> {
        budget.visit(depth)?;
        match self.node(id, budget)? {
            Node::Null => Ok(if array { String::new() } else { "null".into() }),
            Node::Bool(b) => Ok(b.to_string()),
            Node::Number(n) => Ok(number_text(*n)),
            Node::String(s) => {
                budget.visit(depth)?;
                budget.expansion(s.len())?;
                Ok(s.clone())
            }
            Node::Mapping(_) => Ok("[object Object]".into()),
            Node::Sequence(v) => {
                let mut out = String::new();
                for (i, n) in v.iter().enumerate() {
                    if i > 0 {
                        budget.expansion(1)?;
                        out.push(',')
                    }
                    let s = self.stringify(*n, budget, depth + 1, true)?;
                    if out.len() + s.len() > 1024 * 1024 {
                        return Err(ReadFailure::LimitExceeded(
                            super::observation::Resource::DocumentBytes,
                        ));
                    }
                    budget.expansion(s.len())?;
                    out.push_str(&s);
                }
                Ok(out)
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
    pub fn optional_string(
        &self,
        id: usize,
        key: &str,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Option<String>> {
        let Some(v) = self.get(id, key, budget)? else {
            return Ok(None);
        };
        if matches!(self.node(v, budget)?, Node::Null) {
            Ok(None)
        } else {
            self.string(v, budget).map(Some)
        }
    }
}
