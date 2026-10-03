use super::*;
const DEFAULTS: [&str; 6] = [
    "Printer kits",
    "Toolheads",
    "Probes & sensors",
    "Mods",
    "Hardware",
    "Other",
];
pub(super) fn normalize(s: &str) -> String {
    s.split('/')
        .map(trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}
pub(super) fn resolve(m: &Map<String, Value>, role: &str) -> Option<String> {
    if let Some(v) = m.get("category") {
        v.as_str()
            .map(trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    } else {
        match trim(role).to_lowercase().as_str() {
            "base" => Some("Printer kits".into()),
            "addon" => Some("Mods".into()),
            _ => None,
        }
    }
}
fn paths(input: &[String], strict: bool) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for raw in input {
        let path = normalize(raw);
        let segments: Vec<_> = path.split('/').collect();
        let valid = !path.is_empty() && segments.len() <= 9;
        if strict {
            ensure!(valid, CatalogFailure::Input("Invalid category path".into()))
        }
        if !valid {
            continue;
        }
        for i in 1..=segments.len() {
            let p = segments[..i].join("/");
            if !out
                .iter()
                .any(|s: &String| s.to_lowercase() == p.to_lowercase())
            {
                out.push(p);
            }
        }
    }
    if strict {
        ensure!(
            !out.is_empty(),
            CatalogFailure::Input("At least one category is required".into())
        )
    }
    Ok(out)
}
pub(super) fn load(tx: &Transaction<'_>, tenant: &str) -> Result<Vec<String>> {
    let input = get_setting(tx, tenant, "source_categories")?
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .map(|v| {
            v.into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let p = paths(&input, false)?;
    Ok(if p.is_empty() {
        DEFAULTS.iter().map(|s| s.to_string()).collect()
    } else {
        p
    })
}
pub(super) fn nodes(paths: &[String], parent: Option<&str>) -> Vec<CategoryNode> {
    paths
        .iter()
        .filter(|p| {
            p.rsplit_once('/').map(|(p, _)| p.to_lowercase()) == parent.map(str::to_lowercase)
        })
        .map(|p| CategoryNode {
            path: p.clone(),
            name: p.rsplit('/').next().unwrap_or(p).into(),
            depth: p.matches('/').count(),
            parent: p.rsplit_once('/').map(|(p, _)| p.into()),
            children: nodes(paths, Some(p)),
        })
        .collect()
}
pub(super) fn tree(paths: &[String]) -> Value {
    json!(nodes(paths, None))
}
pub(super) fn save(
    tx: &Transaction<'_>,
    tenant: &str,
    input: Vec<String>,
    replacements: HashMap<String, Option<String>>,
) -> Result<Vec<String>> {
    let next = paths(&input, true)?;
    let previous = load(tx, tenant)?;
    let next_map: HashMap<_, _> = next.iter().map(|p| (p.to_lowercase(), p.clone())).collect();
    let mut replacements_map = HashMap::new();
    for (from, to) in replacements {
        let from = normalize(&from).to_lowercase();
        ensure!(
            previous.iter().any(|p| p.to_lowercase() == from),
            CatalogFailure::Input("Unknown source category".into())
        );
        let to = to
            .map(|t| {
                next_map
                    .get(&normalize(&t).to_lowercase())
                    .cloned()
                    .ok_or_else(|| {
                        anyhow!(CatalogFailure::Input(
                            "Replacement category must be in the saved category list".into()
                        ))
                    })
            })
            .transpose()?;
        if let Some(t) = &to {
            let t = t.to_lowercase();
            ensure!(
                t != from && !t.starts_with(&format!("{from}/")),
                CatalogFailure::Input("Cannot move category inside itself".into())
            );
        }
        replacements_map.insert(from, to);
    }
    for source in list(tx, tenant)? {
        let current = normalize(source.category.as_deref().unwrap_or(""));
        let parts: Vec<_> = current.split('/').collect();
        let key = current.to_lowercase();
        let target = if let Some(to) = replacements_map.get(&key) {
            to.clone().unwrap_or_default()
        } else {
            let mut moved = None;
            for i in (1..parts.len()).rev() {
                if let Some(to) = replacements_map.get(&parts[..i].join("/").to_lowercase()) {
                    moved = Some(match to {
                        None => String::new(),
                        Some(to) => next_map
                            .get(&format!("{to}/{}", parts[i..].join("/")).to_lowercase())
                            .cloned()
                            .unwrap_or_else(|| to.clone()),
                    });
                    break;
                }
            }
            moved
                .or_else(|| next_map.get(&key).cloned())
                .or_else(|| {
                    (1..parts.len())
                        .rev()
                        .find_map(|i| next_map.get(&parts[..i].join("/").to_lowercase()).cloned())
                })
                .unwrap_or_default()
        };
        let mut m = source.metadata.unwrap_or_default();
        let explicit = m
            .get("category")
            .and_then(Value::as_str)
            .map(trim)
            .unwrap_or("");
        if m.contains_key("category") && explicit == target {
            continue;
        }
        m.insert("category".into(), json!(target));
        save_metadata(tx, tenant, source.id, m)?;
    }
    set_setting(
        tx,
        tenant,
        "source_categories",
        serde_json::to_string(&next)?,
    )?;
    Ok(next)
}
