use super::manifest::{Group, Groups, Variant};
use std::collections::{HashMap, HashSet};
#[derive(Default)]
struct Directory {
    path: String,
    name: String,
    direct: usize,
    total: usize,
    children: Vec<usize>,
}
struct Candidate {
    id: String,
    dir: usize,
    optional: bool,
    options: Vec<(usize, bool)>,
}
fn test(re: &str, s: &str) -> bool {
    regress::Regex::with_flags(re, "i")
        .unwrap()
        .find(s)
        .is_some()
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
fn children(dirs: &[Directory], i: usize) -> Vec<usize> {
    let mut out:Vec<_>=dirs[i].children.iter().copied().filter(|i|!test(r"^(cad|step|stp|3mf|stl|stls|images?|img|pics?|pictures|assets?|gerbers?|3d|archives?|docs?|manuals?|pdf|src|source|step files)$",&dirs[*i].name)&&dirs[*i].total>0).collect();
    out.sort_by(|a, b| crate::read_model::views::folder_compare(&dirs[*a].path, &dirs[*b].path));
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
fn push(candidates: &mut Vec<Candidate>, consumed: &mut HashSet<usize>, mut c: Candidate) {
    if candidates.len() >= 12 || c.options.is_empty() || candidates.iter().any(|p| p.id == c.id) {
        return;
    }
    c.options.truncate(16);
    for (i, _) in &c.options {
        consumed.insert(*i);
    }
    candidates.push(c)
}
pub(super) fn infer(paths: &[String]) -> Groups {
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
                let i = dirs.len();
                dirs.push(Directory {
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
    order.sort_by(|a, b| crate::read_model::views::folder_compare(&dirs[*a].path, &dirs[*b].path));
    let mut candidates = Vec::new();
    let mut consumed = HashSet::new();
    for i in order {
        let info = &dirs[i];
        let deprecated = test("deprecated|obsolete|legacy", &info.name);
        if (test("deprecated|obsolete|legacy", &info.path) && !deprecated)
            || test("archive", &info.path)
            || consumed.contains(&i)
        {
            continue;
        }
        let optional = test(r"^\(?optional\)?$|\(options?\)|^optional[_\s-]", &info.name);
        let parent = *index
            .get(info.path.rsplit_once('/').map(|p| p.0).unwrap_or(""))
            .unwrap();
        if test(r"^(user[_\s-]?)?mods?$", &info.name) {
            push(
                &mut candidates,
                &mut consumed,
                Candidate {
                    id: slug(&info.path),
                    dir: i,
                    optional: true,
                    options: children(&dirs, i).into_iter().map(|i| (i, false)).collect(),
                },
            );
            continue;
        }
        if test(
            r"\b(options?|recommended|variants?|alternatives?|choose)\b",
            &info.name,
        ) && !optional
        {
            let c = children(&dirs, i);
            if c.len() >= 2 {
                let mut options = Vec::new();
                if deprecated && dirs[parent].direct > 0 {
                    options.push((parent, true))
                }
                options.extend(c.into_iter().map(|i| (i, false)));
                push(
                    &mut candidates,
                    &mut consumed,
                    Candidate {
                        id: slug(&info.path),
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
                        id: slug(&info.path),
                        dir: i,
                        optional: true,
                        options: vec![(i, false)],
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
                    id: slug(&info.path),
                    dir: i,
                    optional: true,
                    options: vec![(i, false)],
                },
            );
            continue;
        }
        if test(r"\bversion\b", &info.name) && info.total > 0 && dirs[parent].direct > 0 {
            push(
                &mut candidates,
                &mut consumed,
                Candidate {
                    id: slug(&dirs[parent].path),
                    dir: parent,
                    optional: false,
                    options: vec![(parent, true), (i, false)],
                },
            );
        }
    }
    for i in 0..dirs.len() {
        if candidates.len() >= 12 {
            break;
        }
        let c: Vec<_> = children(&dirs, i)
            .into_iter()
            .filter(|i| !consumed.contains(i) && dirs[*i].total > 0)
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
            if options.len() < 2 {
                continue;
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
                        shared.iter().all(|s| t.contains(s))
                    })
                    .collect();
            }
            let root = if dirs[i].path.is_empty() {
                "root"
            } else {
                &dirs[i].path
            };
            push(
                &mut candidates,
                &mut consumed,
                Candidate {
                    id: slug(&format!("{root} {}", skeleton.replace('#', "n"))),
                    dir: i,
                    optional: false,
                    options: options.into_iter().map(|i| (i, false)).collect(),
                },
            );
        }
    }
    let mut groups = Vec::new();
    for c in candidates {
        if c.optional && c.options.len() > 1 {
            for (i, _) in c.options {
                if dirs[i].total == 0 {
                    continue;
                }
                let id = slug(&dirs[i].path);
                if groups.iter().any(|(k, _)| *k == id) {
                    continue;
                }
                groups.push((id, optional_group(&dirs[i].name, &dirs[i].path, true)));
            }
            continue;
        }
        let mut variants = Vec::new();
        for (i, default) in c.options {
            let d = &dirs[i];
            if default {
                variants.push(Variant {
                    id: "default".into(),
                    label: Some(format!("Default ({})", d.name)),
                    parts: paths
                        .iter()
                        .filter(|p| {
                            p.starts_with(&format!("{}/", d.path))
                                && !p[d.path.len() + 1..].contains('/')
                        })
                        .cloned()
                        .collect(),
                    excludes: Vec::new(),
                });
            } else if d.total > 0 {
                variants.push(Variant {
                    id: if slug(&d.name).is_empty() {
                        slug(&d.path)
                    } else {
                        slug(&d.name)
                    },
                    label: Some(d.name.clone()),
                    parts: vec![format!("{}/*", d.path)],
                    excludes: Vec::new(),
                });
            }
        }
        if c.optional {
            if let Some(v) = variants.first() {
                groups.push((
                    c.id,
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
                c.id,
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
    super::yaml::js_keys(&mut groups);
    groups
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
