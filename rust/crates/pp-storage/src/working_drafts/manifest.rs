use super::{
    observation::*,
    yaml::{Document, Node, js_keys},
};
use serde_json::Value;

#[derive(Clone, Default)]
pub(super) struct Manifest {
    pub project: Option<String>,
    pub rules: Vec<PartRule>,
    pub groups: Groups,
    pub selections: Selections,
}
#[derive(Clone)]
pub(super) struct PartRule {
    pub pattern: String,
    pub requirement: Option<String>,
    pub group: Option<String>,
}
#[derive(Clone)]
pub(super) struct Variant {
    pub id: String,
    pub label: Option<String>,
    pub parts: Vec<String>,
    pub excludes: Vec<String>,
}
#[derive(Clone)]
pub(super) struct Group {
    pub rule: String,
    pub label: Option<String>,
    pub parts: Vec<String>,
    pub variants: Vec<Variant>,
    pub min: Option<u64>,
    pub max: Option<u64>,
}
pub(super) type Groups = Vec<(String, Group)>;
pub(super) type Selections = Vec<(String, Vec<String>)>;
fn invalid<T>() -> ReadResult<T> {
    Err(ReadFailure::InvalidDocument)
}
fn mapping(
    d: &Document,
    id: usize,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Vec<(String, usize)>> {
    match d.node(id, b)? {
        Node::Mapping(v) => {
            b.expansion(v.iter().map(|(key, _)| key.len()).sum())?;
            Ok(v.clone())
        }
        _ => invalid(),
    }
}
fn sequence(d: &Document, id: usize, b: &mut PreparationBudget<'_>) -> ReadResult<Vec<usize>> {
    match d.node(id, b)? {
        Node::Sequence(v) => Ok(v.clone()),
        _ => invalid(),
    }
}
fn strings(
    d: &Document,
    id: Option<usize>,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Vec<String>> {
    let Some(id) = id else { return Ok(Vec::new()) };
    let Node::Sequence(v) = d.node(id, b)? else {
        return Ok(Vec::new());
    };
    v.iter().map(|i| d.string(*i, b)).collect()
}
fn bound(
    d: &Document,
    id: Option<usize>,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Option<u64>> {
    let Some(id) = id else { return Ok(None) };
    match d.node(id, b)? {
        Node::Null => Ok(None),
        Node::Number(n)
            if n.is_finite() && *n >= 0.0 && *n <= 9007199254740991.0 && n.fract() == 0.0 =>
        {
            Ok(Some(*n as u64))
        }
        _ => invalid(),
    }
}
fn selections(d: &Document, id: usize, b: &mut PreparationBudget<'_>) -> ReadResult<Selections> {
    let mut out = Vec::new();
    for (key, id) in mapping(d, id, b)? {
        if key.trim().is_empty() {
            return invalid();
        }
        let ids = match d.node(id, b)? {
            Node::Sequence(v) => v.clone(),
            _ => vec![id],
        };
        let mut values = Vec::new();
        for id in ids {
            let Node::String(s) = d.node(id, b)? else {
                return invalid();
            };
            let s = s.trim();
            if s.is_empty() || values.iter().any(|v| v == s) {
                return invalid();
            }
            values.push(s.into());
        }
        out.push((key, values));
    }
    Ok(out)
}
fn groups(d: &Document, id: usize, b: &mut PreparationBudget<'_>) -> ReadResult<Groups> {
    let mut out = Vec::new();
    for (key, row) in mapping(d, id, b)? {
        b.rule()?;
        mapping(d, row, b)?;
        let min = bound(d, d.get(row, "min", b)?, b)?;
        let max = bound(d, d.get(row, "max", b)?, b)?;
        let rule = if let Some(id) = d.get(row, "rule", b)? {
            match d.node(id, b)? {
                Node::Null => "pick_one".into(),
                Node::String(s) if matches!(s.as_str(), "pick_one" | "pick_any" | "pick_n") => {
                    s.clone()
                }
                _ => return invalid(),
            }
        } else {
            "pick_one".into()
        };
        if min.zip(max).is_some_and(|(a, z)| a > z)
            || (rule == "pick_one" && (min.unwrap_or(0) > 1 || max.unwrap_or(1) > 1))
        {
            return invalid();
        }
        let mut variants = Vec::new();
        if let Some(id) = d.get(row, "variants", b)?
            && let Node::Sequence(v) = d.node(id, b)?
        {
            for id in v {
                if !matches!(d.node(*id, b)?, Node::Mapping(_) | Node::Sequence(_)) {
                    continue;
                }
                let name = d
                    .optional_string(*id, "id", b)?
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if name.is_empty() {
                    continue;
                }
                b.rule()?;
                variants.push(Variant {
                    id: name,
                    label: d.optional_string(*id, "label", b)?,
                    parts: strings(d, d.get(*id, "parts", b)?, b)?,
                    excludes: strings(d, d.get(*id, "excludes", b)?, b)?,
                });
            }
        }
        out.push((
            key,
            Group {
                rule,
                label: d.optional_string(row, "label", b)?,
                parts: strings(d, d.get(row, "parts", b)?, b)?,
                variants,
                min,
                max,
            },
        ));
    }
    Ok(out)
}
fn rules(
    d: &Document,
    id: Option<usize>,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Vec<PartRule>> {
    let Some(id) = id else { return Ok(Vec::new()) };
    let Node::Sequence(v) = d.node(id, b)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for id in v {
        match d.node(*id, b)? {
            Node::String(s) => {
                b.rule()?;
                out.push(PartRule {
                    pattern: s.clone(),
                    requirement: None,
                    group: None,
                });
            }
            Node::Mapping(_) => {
                if let Some(m) = d.get(*id, "match", b)? {
                    b.rule()?;
                    if let Some(v) = d.get(*id, "default_included", b)? {
                        d.truthy(v, b)?;
                    }
                    out.push(PartRule {
                        pattern: d.string(m, b)?,
                        requirement: d.optional_string(*id, "requirement", b)?,
                        group: d.optional_string(*id, "option_group", b)?,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(out)
}
pub(super) fn parse(bytes: &[u8], b: &mut PreparationBudget<'_>) -> ReadResult<Manifest> {
    if String::from_utf8_lossy(bytes).trim().is_empty() {
        return Ok(Manifest::default());
    }
    let d = Document::parse(bytes, b)?;
    mapping(&d, d.root, b)?;
    let mut out = Manifest {
        project: d.optional_string(d.root, "project", b)?,
        rules: rules(&d, d.get(d.root, "parts", b)?, b)?,
        groups: if let Some(id) = d.get(d.root, "option_groups", b)? {
            groups(&d, id, b)?
        } else {
            Vec::new()
        },
        selections: if let Some(id) = d.get(d.root, "selections", b)? {
            selections(&d, id, b)?
        } else {
            Vec::new()
        },
    };
    if let Some(id) = d.get(d.root, "addons", b)?
        && let Node::Sequence(v) = d.node(id, b)?
    {
        for a in v {
            if matches!(d.node(*a, b)?, Node::Null) {
                return invalid();
            }
            d.optional_string(*a, "project", b)?;
            d.optional_string(*a, "source_id", b)?;
            out.rules.extend(rules(&d, d.get(*a, "parts", b)?, b)?);
        }
    }
    for (key, ids) in &out.selections {
        if ids.is_empty() {
            return invalid();
        }
        if let Some((_, g)) = out.groups.iter().find(|(k, _)| k == key) {
            let max = if g.rule == "pick_one" {
                Some(g.max.unwrap_or(1).min(1))
            } else {
                g.max
            };
            if max.is_some_and(|n| ids.len() as u64 > n) {
                return invalid();
            }
        }
    }
    Ok(out)
}
pub(super) fn optional_document(
    read: &DocumentRead,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Option<Manifest>> {
    match read {
        DocumentRead::Bytes(bytes) => match parse(bytes, b) {
            Ok(d) => Ok(Some(d)),
            Err(ReadFailure::InvalidDocument) => Ok(None),
            Err(e) => Err(e),
        },
        _ => Ok(None),
    }
}
fn union(left: &mut Vec<String>, right: &[String]) {
    for s in right {
        if !left.contains(s) {
            left.push(s.clone());
        }
    }
}
pub(super) fn merge(target: &mut Groups, incoming: Groups) {
    for (key, g) in incoming {
        if let Some((_, prior)) = target.iter_mut().find(|(k, _)| *k == key) {
            let mut variants: Vec<Variant> = Vec::new();
            for variant in std::mem::take(&mut prior.variants) {
                if let Some(existing) = variants
                    .iter_mut()
                    .find(|existing| existing.id == variant.id)
                {
                    *existing = variant;
                } else {
                    variants.push(variant);
                }
            }
            prior.variants = variants;
            union(&mut prior.parts, &g.parts);
            for v in g.variants {
                if let Some(p) = prior.variants.iter_mut().find(|p| p.id == v.id) {
                    union(&mut p.parts, &v.parts);
                    union(&mut p.excludes, &v.excludes);
                    if p.label.as_ref().is_none_or(|s| s.is_empty()) {
                        p.label = v.label
                    }
                } else {
                    prior.variants.push(v)
                }
            }
            if prior.label.as_ref().is_none_or(|s| s.is_empty()) {
                prior.label = g.label
            }
            prior.min = prior.min.or(g.min);
            prior.max = prior.max.or(g.max);
        } else {
            target.push((key, g));
        }
    }
    js_keys(target)
}
pub(super) fn matches(pattern: &str, key: &str) -> bool {
    let pat = pattern.replace('\\', "/").to_lowercase().trim().to_owned();
    let key = key.replace('\\', "/").to_lowercase().trim().to_owned();
    if pat == key {
        return true;
    }
    let mut expression = "^".to_owned();
    for c in pat.chars() {
        match c {
            '*' => expression.push_str(".*"),
            '?' => expression.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                expression.push('\\');
                expression.push(c)
            }
            c => expression.push(c),
        }
    }
    expression.push('$');
    regress::Regex::with_flags(&expression, "i").is_ok_and(|r| {
        r.find(&key).is_some()
            || (!pat.contains('/') && key.rsplit('/').next().is_some_and(|s| r.find(s).is_some()))
    })
}
pub(super) fn apply(
    parts: &mut [Value],
    docs: &[(String, String, Manifest)],
    mut groups: Groups,
    mut selections: Selections,
) {
    for (_, _, d) in docs {
        for (key, s) in &d.selections {
            if !selections.iter().any(|(k, _)| k == key) {
                selections.push((key.clone(), s.clone()));
            }
        }
    }
    let inferred = std::mem::take(&mut groups);
    for (_, _, d) in docs {
        merge(&mut groups, d.groups.clone())
    }
    merge(&mut groups, inferred);
    for part in parts {
        let key = part["partKey"].as_str().unwrap_or_default().to_owned();
        let label = part["sourceLayer"]
            .as_str()
            .unwrap_or_default()
            .split(':')
            .nth(1);
        for (name, source, d) in docs {
            if d.project.as_ref().is_some_and(|p| {
                !p.is_empty() && label.is_some_and(|l| !l.is_empty() && p != l && name != l)
            }) {
                continue;
            }
            if let Some(rule) = d.rules.iter().find(|r| matches(&r.pattern, &key)) {
                if let Some(v) = &rule.requirement {
                    part["requirement"] = v.clone().into()
                }
                if let Some(v) = &rule.group {
                    part["optionGroupId"] = v.clone().into()
                }
                part["manifestSource"] = source.clone().into();
                break;
            }
        }
        let explicit = part["optionGroupId"].as_str();
        let mut member = false;
        let mut included = false;
        let mut excluded = false;
        for (id, g) in &groups {
            let ids: Vec<&String> = selections
                .iter()
                .find(|(k, _)| k == id)
                .map(|(_, v)| {
                    v.iter()
                        .filter(|id| {
                            g.variants.is_empty() || g.variants.iter().any(|v| v.id == ***id)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let max = if g.rule == "pick_one" {
                g.max.unwrap_or(1).min(1)
            } else {
                g.max.unwrap_or(u64::MAX)
            };
            let complete = (ids.len() as u64) >= g.min.unwrap_or(0) && (ids.len() as u64) <= max;
            let membership = explicit.map_or_else(
                || {
                    g.parts
                        .iter()
                        .chain(g.variants.iter().flat_map(|v| v.parts.iter()))
                        .any(|p| matches(p, &key))
                },
                |v| v == id,
            );
            if membership {
                member = true;
                if complete {
                    included |= ids.iter().any(|id| {
                        g.variants.iter().find(|v| v.id == ***id).map_or_else(
                            || matches(id, &key),
                            |v| v.parts.iter().any(|p| matches(p, &key)),
                        )
                    });
                }
            }
            if complete && explicit.is_none_or(|v| v == id) {
                excluded |= ids.iter().any(|id| {
                    g.variants
                        .iter()
                        .find(|v| v.id == ***id)
                        .is_some_and(|v| v.excludes.iter().any(|p| matches(p, &key)))
                });
            }
        }
        if member {
            part["included"] = included.into()
        }
        if excluded {
            part["included"] = false.into()
        }
    }
}
pub(super) fn kit(raw: Option<String>) -> Selections {
    let parse = || -> Option<Selections> {
        let data: Value = serde_json::from_str(raw.as_deref()?).ok()?;
        let map = data.as_object()?;
        for key in ["name", "base_source_id"] {
            if let Some(v) = map.get(key)
                && !v.is_null()
                && !v.is_string()
            {
                return None;
            }
        }
        for key in ["layers", "addon_source_ids", "include", "exclude"] {
            if let Some(v) = map.get(key)
                && !v.as_array()?.iter().all(Value::is_string)
            {
                return None;
            }
        }
        if let Some(v) = map.get("replacements")
            && !v.as_object()?.values().all(Value::is_string)
        {
            return None;
        }
        for key in ["choice_tree", "category_links"] {
            if let Some(v) = map.get(key) {
                v.as_array()?;
            }
        }
        let Some(v) = map.get("selections") else {
            return Some(Vec::new());
        };
        let mut out = Vec::new();
        for (key, v) in v.as_object()? {
            if key.trim().is_empty() {
                return None;
            }
            let values = if let Some(a) = v.as_array() {
                a.iter().collect()
            } else {
                vec![v]
            };
            let mut ids = Vec::new();
            for v in values {
                let s = v.as_str()?.trim();
                if s.is_empty() || ids.iter().any(|v| v == s) {
                    return None;
                }
                ids.push(s.into());
            }
            out.push((key.clone(), ids));
        }
        Some(out)
    };
    parse().unwrap_or_default()
}
pub(super) fn hints(bytes: &[u8], b: &mut PreparationBudget<'_>) -> ReadResult<Vec<HintRule>> {
    let d = Document::parse(bytes, b)?;
    let root = mapping(&d, d.root, b)?;
    if root
        .iter()
        .any(|(k, _)| !matches!(k.as_str(), "version" | "rules"))
    {
        return invalid();
    }
    let version = d
        .get(d.root, "version", b)?
        .ok_or(ReadFailure::InvalidDocument)?;
    if !matches!(d.node(version,b)?,Node::Number(n) if *n==1.0) {
        return invalid();
    }
    let rules = d
        .get(d.root, "rules", b)?
        .ok_or(ReadFailure::InvalidDocument)?;
    let mut out = Vec::new();
    for id in sequence(&d, rules, b)? {
        b.rule()?;
        let map = mapping(&d, id, b)?;
        if map
            .iter()
            .any(|(k, _)| !matches!(k.as_str(), "path" | "option_group" | "variant_id" | "label"))
        {
            return invalid();
        }
        let mut values = Vec::new();
        for key in ["path", "option_group", "variant_id", "label"] {
            let val = if let Some(id) = d.get(id, key, b)? {
                match d.node(id, b)? {
                    Node::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
                    _ => return invalid(),
                }
            } else if key == "label" {
                None
            } else {
                return invalid();
            };
            values.push(val);
        }
        out.push((
            values[0].take().unwrap(),
            values[1].take().unwrap(),
            values[2].take().unwrap(),
            values[3].take(),
        ));
    }
    Ok(out)
}

type HintRule = (String, String, String, Option<String>);
