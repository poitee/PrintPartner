use super::manifest::{Group as DomainGroup, Groups as DomainGroups, Variant as DomainVariant};
use super::observation::{PreparationBudget, ReadResult};
use crate::manifest_text::{ManifestText, OptionGroupId, VariantId};
#[derive(Clone)]
struct Variant {
    id: String,
    label: Option<String>,
    parts: Vec<String>,
    excludes: Vec<String>,
}
struct Group {
    rule: String,
    label: Option<String>,
    parts: Vec<String>,
    variants: Vec<Variant>,
    min: Option<u64>,
    max: Option<u64>,
}
type Groups = Vec<(String, Group)>;
use std::collections::{HashMap, HashSet};
#[derive(Default)]
struct Directory {
    parent: usize,
    path: String,
    name: String,
    direct: usize,
    total: usize,
    children: Vec<usize>,
}
const MAX_CANDIDATES: usize = 12;
const MAX_OPTIONS: usize = 16;
const OPTIONS_CONTAINER: &str =
    r"(^|[^a-z0-9])(options?|recommended|variants?|alternatives?|choose)($|[^a-z0-9])";
const VERSION: &str = r"(^|[^a-z0-9])version($|[^a-z0-9])";
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Claim {
    Files,
    Tree,
}
struct Candidate {
    base_id: String,
    dir: usize,
    optional: bool,
    options: Vec<(usize, Claim)>,
}
fn test(re: &str, s: &str) -> bool {
    match regress::Regex::with_flags(re, "i") {
        Ok(regex) => regex.find(s).is_some(),
        Err(error) => panic!("Invalid sibling inference regex {re}: {error}"),
    }
}
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c)
        } else if !out.ends_with('_') {
            out.push('_')
        }
    }
    out.trim_matches('_').chars().take(64).collect()
}
fn scope(path: &str) -> &str {
    if path.is_empty() { "root" } else { path }
}
fn unique(base: String, used: &mut HashSet<String>) -> String {
    let base = if base.is_empty() {
        "inferred".into()
    } else {
        base
    };
    let mut id = base.clone();
    let mut n = 1;
    while !used.insert(id.clone()) {
        n += 1;
        id = format!("{base}_{n}");
    }
    id
}
fn archived(dir: &Directory) -> bool {
    test("archive", &dir.path)
}
fn within_claimed_tree(dirs: &[Directory], consumed: &HashMap<usize, Claim>, mut i: usize) -> bool {
    loop {
        if consumed.get(&i) == Some(&Claim::Tree) {
            return true;
        }
        if i == 0 {
            return false;
        }
        i = dirs[i].parent;
    }
}
fn children(dirs: &[Directory], i: usize) -> Vec<usize> {
    let mut out:Vec<_>=dirs[i].children.iter().copied().filter(|i|!test(r"^(cad|step|stp|3mf|stl|stls|images?|img|pics?|pictures|assets?|gerbers?|3d|archives?|docs?|manuals?|pdf|src|source|step files)$",&dirs[*i].name)&&dirs[*i].total>0).collect();
    out.sort_by(|a, b| {
        crate::read_model::views::folder_compare(&dirs[*a].path, &dirs[*b].path)
            .then_with(|| dirs[*a].path.cmp(&dirs[*b].path))
    });
    out
}
fn tokens(s: &str) -> HashSet<String> {
    let mut expanded = String::new();
    let mut previous = None;
    for c in s.to_lowercase().chars() {
        if previous.is_some_and(|p: char| {
            p.is_ascii_digit() != c.is_ascii_digit()
                && p.is_ascii_alphanumeric()
                && c.is_ascii_alphanumeric()
        }) {
            expanded.push(' ')
        }
        expanded.push(c);
        previous = Some(c)
    }
    expanded
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| {
            !s.is_empty()
                && !s.bytes().all(|c| c.is_ascii_digit())
                && !matches!(
                    *s,
                    "cm" | "inch"
                        | "inches"
                        | "kit"
                        | "mm"
                        | "option"
                        | "options"
                        | "variant"
                        | "variants"
                        | "version"
                )
        })
        .map(|s| {
            if s.len() > 3 && s.ends_with('s') {
                s[..s.len() - 1].into()
            } else {
                s.into()
            }
        })
        .collect()
}
fn claim(consumed: &mut HashMap<usize, Claim>, i: usize, claim: Claim) {
    let current = consumed.entry(i).or_insert(claim);
    *current = (*current).max(claim);
}
fn push(candidates: &mut Vec<Candidate>, consumed: &mut HashMap<usize, Claim>, mut c: Candidate) {
    if candidates.len() >= MAX_CANDIDATES || c.options.is_empty() {
        return;
    }
    c.options.truncate(MAX_OPTIONS);
    if candidates
        .iter()
        .any(|p| p.dir == c.dir && p.optional == c.optional && p.options == c.options)
    {
        return;
    }
    for (i, kind) in &c.options {
        claim(consumed, *i, *kind);
    }
    candidates.push(c)
}
fn infer_scalar(paths: &[String], budget: &mut PreparationBudget<'_>) -> ReadResult<Groups> {
    let paths: Vec<_> = paths
        .iter()
        .map(|p| {
            let path = p.replace('\\', "/");
            path.strip_prefix("./")
                .unwrap_or(&path)
                .trim_start_matches('/')
                .to_owned()
        })
        .collect();
    let mut dirs = vec![Directory::default()];
    let mut index = HashMap::from([(String::new(), 0)]);
    for path in &paths {
        let mut parent = 0;
        dirs[0].total += 1;
        let segments: Vec<_> = path.split('/').collect();
        for end in 1..segments.len() {
            let path = segments[..end].join("/");
            let child = if let Some(i) = index.get(&path) {
                *i
            } else {
                budget.node(end)?;
                let i = dirs.len();
                dirs.push(Directory {
                    parent,
                    path: path.clone(),
                    name: segments[end - 1].into(),
                    ..Directory::default()
                });
                index.insert(path, i);
                i
            };
            if !dirs[parent].children.contains(&child) {
                dirs[parent].children.push(child)
            }
            dirs[child].total += 1;
            parent = child;
        }
        dirs[parent].direct += 1;
    }
    let mut order: Vec<_> = (1..dirs.len()).collect();
    order.sort_by(|a, b| {
        crate::read_model::views::folder_compare(&dirs[*a].path, &dirs[*b].path)
            .then_with(|| dirs[*a].path.cmp(&dirs[*b].path))
    });
    let mut candidates = Vec::new();
    let mut consumed = HashMap::new();
    for &i in &order {
        budget.check()?;
        let info = &dirs[i];
        let deprecated = test("deprecated|obsolete|legacy", &info.name);
        if (test("deprecated|obsolete|legacy", &info.path) && !deprecated)
            || archived(info)
            || consumed.contains_key(&i)
        {
            continue;
        }
        let optional = test(r"^\(?optional\)?$|\(options?\)|^optional[_\s-]", &info.name);
        let parent = info.parent;
        if test(r"^(user[_\s-]?)?mods?$", &info.name) {
            push(
                &mut candidates,
                &mut consumed,
                Candidate {
                    base_id: slug(&info.path),
                    dir: i,
                    optional: true,
                    options: children(&dirs, i)
                        .into_iter()
                        .map(|i| (i, Claim::Tree))
                        .collect(),
                },
            );
            continue;
        }
        if test(OPTIONS_CONTAINER, &info.name) && !optional {
            let c = children(&dirs, i);
            if c.len() >= 2 {
                let mut options = Vec::new();
                if deprecated && dirs[parent].direct > 0 {
                    options.push((parent, Claim::Files))
                }
                options.extend(c.into_iter().map(|i| (i, Claim::Tree)));
                push(
                    &mut candidates,
                    &mut consumed,
                    Candidate {
                        base_id: slug(&info.path),
                        dir: i,
                        optional: false,
                        options,
                    },
                );
                continue;
            }
            if info.direct > 0 {
                push(
                    &mut candidates,
                    &mut consumed,
                    Candidate {
                        base_id: slug(&info.path),
                        dir: i,
                        optional: true,
                        options: vec![(i, Claim::Tree)],
                    },
                );
                continue;
            }
        }
        if optional && info.total > 0 {
            push(
                &mut candidates,
                &mut consumed,
                Candidate {
                    base_id: slug(&info.path),
                    dir: i,
                    optional: true,
                    options: vec![(i, Claim::Tree)],
                },
            );
            continue;
        }
        if test(VERSION, &info.name) && info.total > 0 && dirs[parent].direct > 0 {
            if let Some(versions) = candidates
                .iter_mut()
                .find(|c| c.dir == parent && c.options[0] == (parent, Claim::Files))
            {
                if versions.options.len() < MAX_OPTIONS {
                    versions.options.push((i, Claim::Tree));
                    claim(&mut consumed, i, Claim::Tree);
                }
            } else {
                push(
                    &mut candidates,
                    &mut consumed,
                    Candidate {
                        base_id: slug(scope(&dirs[parent].path)),
                        dir: parent,
                        optional: false,
                        options: vec![(parent, Claim::Files), (i, Claim::Tree)],
                    },
                );
            }
        }
    }
    for i in std::iter::once(0).chain(order) {
        if candidates.len() >= MAX_CANDIDATES {
            break;
        }
        budget.check()?;
        if within_claimed_tree(&dirs, &consumed, i) {
            continue;
        }
        let c: Vec<_> = children(&dirs, i)
            .into_iter()
            .filter(|i| !consumed.contains_key(i) && !archived(&dirs[*i]))
            .collect();
        let mut skeletons: Vec<(String, Vec<usize>)> = Vec::new();
        for child in &c {
            if !dirs[*child].name.chars().any(|c| c.is_ascii_digit()) {
                continue;
            }
            let mut skeleton = String::new();
            let mut numeric = false;
            for ch in dirs[*child].name.to_lowercase().chars() {
                if ch.is_ascii_digit() {
                    if !numeric {
                        skeleton.push('#')
                    }
                    numeric = true
                } else {
                    skeleton.push(ch);
                    numeric = false
                }
            }
            let skeleton = skeleton.trim().to_owned();
            if let Some((_, v)) = skeletons.iter_mut().find(|(s, _)| *s == skeleton) {
                v.push(*child)
            } else {
                skeletons.push((skeleton, vec![*child]));
            }
        }
        for (skeleton, mut options) in skeletons {
            options.retain(|i| !consumed.contains_key(i));
            let id = slug(&format!(
                "{} {}",
                scope(&dirs[i].path),
                skeleton.replace('#', "n")
            ));
            if options.len() < 2 {
                continue;
            }
            if candidates.len() >= MAX_CANDIDATES {
                break;
            }
            let mut shared = tokens(&dirs[options[0]].name);
            for child in &options[1..] {
                let t = tokens(&dirs[*child].name);
                shared.retain(|s| t.contains(s));
            }
            if shared.len() >= 2 {
                options = c
                    .iter()
                    .copied()
                    .filter(|i| {
                        let t = tokens(&dirs[*i].name);
                        !consumed.contains_key(i) && shared.iter().all(|s| t.contains(s))
                    })
                    .collect();
            }
            push(
                &mut candidates,
                &mut consumed,
                Candidate {
                    base_id: id,
                    dir: i,
                    optional: false,
                    options: options.into_iter().map(|i| (i, Claim::Tree)).collect(),
                },
            );
        }
    }
    let mut groups = Vec::new();
    let mut group_ids = HashSet::new();
    for c in candidates {
        if c.optional && c.options.len() > 1 {
            for (i, _) in c.options {
                if dirs[i].total == 0 {
                    continue;
                }
                let id = unique(slug(&dirs[i].path), &mut group_ids);
                groups.push((id, optional_group(&dirs[i].name, &dirs[i].path, true)));
            }
            continue;
        }
        let mut variants = Vec::new();
        let mut used = HashSet::new();
        for (i, kind) in c.options {
            let d = &dirs[i];
            if kind == Claim::Files {
                variants.push(Variant {
                    id: unique("default".into(), &mut used),
                    label: Some(format!("Default ({})", d.name)),
                    parts: paths
                        .iter()
                        .filter(|p| {
                            let file = if d.path.is_empty() {
                                Some(p.as_str())
                            } else {
                                p.strip_prefix(&d.path).and_then(|p| p.strip_prefix('/'))
                            };
                            file.is_some_and(|f| !f.is_empty() && !f.contains('/'))
                        })
                        .cloned()
                        .collect(),
                    excludes: Vec::new(),
                });
            } else if d.total > 0 {
                variants.push(Variant {
                    id: unique(
                        if slug(&d.name).is_empty() {
                            slug(&d.path)
                        } else {
                            slug(&d.name)
                        },
                        &mut used,
                    ),
                    label: Some(d.name.clone()),
                    parts: vec![format!("{}/*", d.path)],
                    excludes: Vec::new(),
                });
            }
        }
        if c.optional {
            if let Some(v) = variants.first() {
                groups.push((
                    unique(c.base_id, &mut group_ids),
                    Group {
                        rule: "pick_one".into(),
                        label: Some(format!("{} (optional)", dirs[c.dir].name)),
                        parts: Vec::new(),
                        variants: vec![
                            Variant {
                                id: "skip".into(),
                                label: Some("Skip".into()),
                                parts: Vec::new(),
                                excludes: Vec::new(),
                            },
                            Variant {
                                id: "include".into(),
                                label: Some(format!(
                                    "Include {}",
                                    v.label.as_ref().unwrap_or(&v.id)
                                )),
                                parts: v.parts.clone(),
                                excludes: Vec::new(),
                            },
                        ],
                        min: None,
                        max: None,
                    },
                ));
            }
        } else if variants.len() >= 2 {
            groups.push((
                unique(c.base_id, &mut group_ids),
                Group {
                    rule: "pick_one".into(),
                    label: Some(dirs[c.dir].name.clone()),
                    parts: Vec::new(),
                    variants,
                    min: None,
                    max: None,
                },
            ));
        }
    }
    groups.sort_by_key(|(key, _)| {
        crate::manifest_text::JsText::scalar(key)
            .array_index()
            .map(|index| (0, index))
            .unwrap_or((1, 0))
    });
    Ok(groups)
}
fn optional_group(name: &str, path: &str, modification: bool) -> Group {
    Group {
        rule: "pick_one".into(),
        label: Some(format!(
            "{name} ({})",
            if modification {
                "optional mod"
            } else {
                "optional"
            }
        )),
        parts: Vec::new(),
        variants: vec![
            Variant {
                id: "skip".into(),
                label: Some("Skip".into()),
                parts: Vec::new(),
                excludes: Vec::new(),
            },
            Variant {
                id: "include".into(),
                label: Some(format!("Include {name}")),
                parts: vec![format!("{path}/*")],
                excludes: Vec::new(),
            },
        ],
        min: None,
        max: None,
    }
}

pub(super) fn infer(
    paths: &[String],
    budget: &mut PreparationBudget<'_>,
) -> ReadResult<DomainGroups> {
    Ok(infer_scalar(paths, budget)?
        .into_iter()
        .map(|(id, g)| {
            (
                OptionGroupId::from(id),
                DomainGroup {
                    rule: g.rule,
                    label: g.label.map(ManifestText::from),
                    parts: g.parts.into_iter().map(ManifestText::from).collect(),
                    min: g.min,
                    max: g.max,
                    variants: g
                        .variants
                        .into_iter()
                        .map(|v| DomainVariant {
                            id: VariantId::from(v.id),
                            label: v.label.map(ManifestText::from),
                            parts: v.parts.into_iter().map(ManifestText::from).collect(),
                            excludes: v.excludes.into_iter().map(ManifestText::from).collect(),
                        })
                        .collect(),
                },
            )
        })
        .collect())
}
