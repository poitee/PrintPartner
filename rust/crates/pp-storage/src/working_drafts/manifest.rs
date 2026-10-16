use super::{
    observation::{PreparationBudget, ReadFailure, ReadResult},
    yaml::{Document, Node},
};
use crate::manifest_text::{JsText, ManifestText, OptionGroupId, VariantId};

#[cfg(test)]
#[path = "manifest_glob_tests.rs"]
mod glob_tests;

#[derive(Clone, Default)]
pub(crate) struct Manifest {
    pub project: Option<ManifestText>,
    pub rules: Vec<PartRule>,
    pub groups: Groups,
    pub selections: Selections,
    pub selection_shapes: Vec<(OptionGroupId, bool)>,
}
#[derive(Clone)]
pub(crate) struct PartRule {
    pub pattern: ManifestText,
    pub requirement: Option<ManifestText>,
    pub group: Option<OptionGroupId>,
}
#[derive(Clone)]
pub(crate) struct Variant {
    pub id: VariantId,
    pub label: Option<ManifestText>,
    pub parts: Vec<ManifestText>,
    pub excludes: Vec<ManifestText>,
}
#[derive(Clone)]
pub(crate) struct Group {
    pub rule: String,
    pub label: Option<ManifestText>,
    pub parts: Vec<ManifestText>,
    pub variants: Vec<Variant>,
    pub min: Option<u64>,
    pub max: Option<u64>,
}
pub(crate) type Groups = Vec<(OptionGroupId, Group)>;
pub(crate) type Selections = Vec<(OptionGroupId, Vec<VariantId>)>;
fn invalid<T>() -> ReadResult<T> {
    Err(ReadFailure::InvalidDocument)
}
fn mapping(
    d: &Document,
    id: usize,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Vec<(JsText, usize)>> {
    match d.node(id, b)? {
        Node::Mapping(v) => {
            b.expansion(v.iter().map(|(key, _)| key.units().len() * 2).sum())?;
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
) -> ReadResult<Vec<ManifestText>> {
    let Some(id) = id else { return Ok(Vec::new()) };
    let Node::Sequence(v) = d.node(id, b)? else {
        return Ok(Vec::new());
    };
    v.iter().map(|i| d.text(*i, b).map(ManifestText)).collect()
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
fn selections(
    d: &Document,
    id: usize,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<(Selections, Vec<(OptionGroupId, bool)>)> {
    let mut out = Vec::new();
    let mut shapes = Vec::new();
    for (key, id) in mapping(d, id, b)? {
        if key.is_ecmascript_blank() {
            return invalid();
        }
        let (ids, scalar) = match d.node(id, b)? {
            Node::Sequence(v) => (v.clone(), false),
            _ => (vec![id], true),
        };
        let mut values = Vec::new();
        for id in ids {
            let Node::String(s) = d.node(id, b)? else {
                return invalid();
            };
            b.expansion(s.units().len() * 2)?;
            let s = s.clone().trim_ecmascript();
            if s.is_empty() || values.iter().any(|v: &VariantId| v.0 == s) {
                return invalid();
            }
            values.push(VariantId(s));
        }
        b.expansion(key.units().len() * 2)?;
        shapes.push((OptionGroupId(key.clone()), scalar));
        out.push((OptionGroupId(key), values));
    }
    Ok((out, shapes))
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
                Node::String(s) => s
                    .as_scalar()
                    .filter(|rule| matches!(rule.as_str(), "pick_one" | "pick_any" | "pick_n"))
                    .ok_or(ReadFailure::InvalidDocument)?,
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
                    .optional_text(*id, "id", b)?
                    .unwrap_or_else(|| JsText::scalar(""))
                    .trim_ecmascript();
                if name.is_empty() {
                    continue;
                }
                b.rule()?;
                variants.push(Variant {
                    id: VariantId(name),
                    label: d.optional_text(*id, "label", b)?.map(ManifestText),
                    parts: strings(d, d.get(*id, "parts", b)?, b)?,
                    excludes: strings(d, d.get(*id, "excludes", b)?, b)?,
                });
            }
        }
        out.push((
            OptionGroupId(key),
            Group {
                rule,
                label: d.optional_text(row, "label", b)?.map(ManifestText),
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
            Node::String(_) => {
                b.rule()?;
                out.push(PartRule {
                    pattern: ManifestText(d.text(*id, b)?),
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
                        pattern: ManifestText(d.text(m, b)?),
                        requirement: d.optional_text(*id, "requirement", b)?.map(ManifestText),
                        group: d.optional_text(*id, "option_group", b)?.map(OptionGroupId),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(out)
}
pub(crate) fn parse(bytes: &[u8], b: &mut PreparationBudget<'_>) -> ReadResult<Manifest> {
    b.document(bytes.len(), 0)?;
    if JsText::scalar(&String::from_utf8_lossy(bytes)).is_ecmascript_blank() {
        return Ok(Manifest::default());
    }
    let d = Document::parse(bytes, b)?;
    mapping(&d, d.root, b)?;
    let (selections, selection_shapes) = if let Some(id) = d.get(d.root, "selections", b)? {
        selections(&d, id, b)?
    } else {
        (Vec::new(), Vec::new())
    };
    let mut out = Manifest {
        project: d.optional_text(d.root, "project", b)?.map(ManifestText),
        rules: rules(&d, d.get(d.root, "parts", b)?, b)?,
        groups: if let Some(id) = d.get(d.root, "option_groups", b)? {
            groups(&d, id, b)?
        } else {
            Vec::new()
        },
        selections,
        selection_shapes,
    };
    if let Some(id) = d.get(d.root, "addons", b)?
        && let Node::Sequence(v) = d.node(id, b)?
    {
        for a in v {
            if matches!(d.node(*a, b)?, Node::Null) {
                return invalid();
            }
            d.optional_text(*a, "project", b)?;
            d.optional_text(*a, "source_id", b)?;
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
fn union(left: &mut Vec<ManifestText>, right: &[ManifestText]) {
    for s in std::mem::take(left)
        .into_iter()
        .chain(right.iter().cloned())
    {
        if !left.contains(&s) {
            left.push(s);
        }
    }
}
pub(crate) fn merge(target: &mut Groups, incoming: Groups) {
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
                    if p.label.as_ref().is_none_or(|s| s.is_empty())
                        && v.label.as_ref().is_some_and(|s| !s.is_empty())
                    {
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
    target.sort_by(
        |(a, _), (b, _)| match (a.0.array_index(), b.0.array_index()) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        },
    )
}
fn normalize_glob(text: &JsText) -> JsText {
    let mut units = Vec::with_capacity(text.units().len());
    let mut scalar = String::new();
    for decoded in char::decode_utf16(text.units().iter().copied()) {
        match decoded {
            Ok(c) => scalar.push(if c == '\\' { '/' } else { c }),
            Err(error) => {
                units.extend(scalar.to_lowercase().encode_utf16());
                scalar.clear();
                units.push(error.unpaired_surrogate());
            }
        }
    }
    units.extend(scalar.to_lowercase().encode_utf16());
    JsText::from_units(units).trim_ecmascript()
}

fn canonicalize_regex_unit(unit: u16) -> u16 {
    let Some(c) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut uppercase = c.to_uppercase();
    let Some(upper) = uppercase.next() else {
        return unit;
    };
    if uppercase.next().is_some() || upper.len_utf16() != 1 {
        return unit;
    }
    let upper = upper as u16;
    if unit >= 0x80 && upper < 0x80 {
        unit
    } else {
        upper
    }
}

fn dot_matches(unit: u16) -> bool {
    !matches!(unit, 0x000a | 0x000d | 0x2028 | 0x2029)
}

fn wildcard_matches(pattern: &[u16], key: &[u16]) -> bool {
    let (mut pat, mut path) = (0, 0);
    let mut star = None;
    while path < key.len() {
        match pattern.get(pat).copied() {
            Some(0x2a) => {
                pat += 1;
                star = Some((pat, path));
            }
            Some(unit)
                if (unit == 0x3f && dot_matches(key[path]))
                    || (unit != 0x3f && unit == key[path]) =>
            {
                pat += 1;
                path += 1;
            }
            _ => {
                let Some((after_star, consumed)) = star else {
                    return false;
                };
                if !key.get(consumed).copied().is_some_and(dot_matches) {
                    return false;
                }
                path = consumed + 1;
                pat = after_star;
                star = Some((after_star, path));
            }
        }
    }
    pattern[pat..].iter().all(|unit| *unit == 0x2a)
}

pub(crate) fn matches(pattern: &ManifestText, key: &str) -> bool {
    let pattern = normalize_glob(pattern);
    let key = normalize_glob(&JsText::scalar(key));
    if pattern == key {
        return true;
    }
    let pattern: Vec<_> = pattern
        .units()
        .iter()
        .copied()
        .map(canonicalize_regex_unit)
        .collect();
    let key: Vec<_> = key
        .units()
        .iter()
        .copied()
        .map(canonicalize_regex_unit)
        .collect();
    wildcard_matches(&pattern, &key)
        || (!pattern.contains(&0x2f)
            && key.contains(&0x2f)
            && key
                .rsplit(|unit| *unit == 0x2f)
                .next()
                .is_some_and(|basename| wildcard_matches(&pattern, basename)))
}
pub(crate) fn hints(bytes: &[u8], b: &mut PreparationBudget<'_>) -> ReadResult<Vec<HintRule>> {
    b.document(bytes.len(), 0)?;
    let d = Document::parse(bytes, b)?;
    let root = mapping(&d, d.root, b)?;
    if root
        .iter()
        .any(|(k, _)| !matches!(k.as_scalar().as_deref(), Some("version" | "rules")))
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
        if map.iter().any(|(k, _)| {
            !matches!(
                k.as_scalar().as_deref(),
                Some("path" | "option_group" | "variant_id" | "label")
            )
        }) {
            return invalid();
        }
        out.push((
            ManifestText(hint_field(&d, id, "path", b)?.ok_or(ReadFailure::InvalidDocument)?),
            OptionGroupId(
                hint_field(&d, id, "option_group", b)?.ok_or(ReadFailure::InvalidDocument)?,
            ),
            VariantId(hint_field(&d, id, "variant_id", b)?.ok_or(ReadFailure::InvalidDocument)?),
            hint_field(&d, id, "label", b)?.map(ManifestText),
        ));
    }
    Ok(out)
}

fn hint_field(
    d: &Document,
    row: usize,
    key: &str,
    b: &mut PreparationBudget<'_>,
) -> ReadResult<Option<JsText>> {
    let Some(id) = d.get(row, key, b)? else {
        return Ok(None);
    };
    match d.node(id, b)? {
        Node::String(s) if !s.is_ecmascript_blank() => {
            b.expansion(s.units().len() * 2)?;
            Ok(Some(s.clone().trim_ecmascript()))
        }
        _ => invalid(),
    }
}

pub(crate) type HintRule = (ManifestText, OptionGroupId, VariantId, Option<ManifestText>);

pub(crate) fn infer_siblings(
    paths: &[String],
    budget: &mut PreparationBudget<'_>,
) -> ReadResult<Groups> {
    super::siblings::infer(paths, budget)
}
