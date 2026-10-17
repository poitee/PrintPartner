use super::{
    manifest::{self, Group, Variant},
    observation::*,
};
use crate::manifest_text::{DraftPart, PartManifestMetadata};
use crate::required_units::storage::{normalize_parts, num, one, part_rows, rows, text};
use crate::{catalog::naming::NamingProfile, required_units};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, Transaction};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

#[cfg(test)]
thread_local! {
    pub(super) static GLOBAL_NAMING_PROJECTIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static SOURCE_LAYER_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) struct Capture {
    pub fingerprint: String,
    pub inputs: Vec<Value>,
    layers: Vec<Layer>,
    source_layers: HashMap<String, SourceLayer>,
}
struct SourceLayer {
    source_id: i64,
    tracked: bool,
}
impl Capture {
    fn source_layer(
        &self,
        layer: &str,
        budget: &mut PreparationBudget<'_>,
    ) -> Result<Option<&SourceLayer>> {
        budget.comparison(layer.len())?;
        Ok(self.source_layers.get(layer))
    }
}
struct Layer {
    source_id: i64,
    source_layer: String,
    naming: Arc<NamingProfile>,
    rules: Option<Vec<String>>,
    root: Box<dyn StlRootRead>,
}
pub(super) struct PreparedDraftSnapshot {
    pub base: Value,
    pub capture: Capture,
    pub parts: Vec<DraftPart>,
    pub digest: String,
}
#[derive(Clone)]
struct Scanned {
    key: String,
    path: String,
    filename: String,
    slug: String,
    role: String,
    quantity: f64,
    inventory: usize,
    index: usize,
    layer: String,
    status: String,
}
pub(super) fn setting(tx: &Transaction<'_>, tenant: &str, key: &str) -> Result<Option<String>> {
    Ok(one(
        tx,
        "SELECT value FROM app_settings WHERE tenant_id=? AND key=?",
        &[&tenant, &key],
    )?
    .and_then(|v| v["value"].as_str().map(str::to_owned)))
}
fn spoolman_enabled(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    b: &mut PreparationBudget<'_>,
) -> Result<bool> {
    use pp_domain::features::{Feature, Toggles, resolve};
    b.check()?;
    if one(
        tx,
        "SELECT id FROM build_profiles WHERE tenant_id=? AND id=?",
        &[&tenant, &profile],
    )?
    .is_none()
    {
        return Ok(false);
    }
    let mut layer = |key: &str| -> Result<Option<Toggles>> {
        b.visit(0)?;
        Ok(match setting(tx, tenant, key)? {
            None => Some(Toggles::default()),
            Some(raw) => {
                b.document(raw.len(), raw.len())?;
                serde_json::from_str(&raw).ok()
            }
        })
    };
    let user = layer("feature_toggles")?;
    let plan = layer(&format!("feature_toggles:plan:{profile}"))?;
    Ok(match (user, plan) {
        (Some(user), Some(plan)) => resolve(&user, Some(&plan)).enabled(Feature::Spoolman),
        _ => false,
    })
}
fn import_rules(value: &Value, b: &mut PreparationBudget<'_>) -> Result<Option<Vec<String>>> {
    b.check()?;
    if value.is_null() {
        return Ok(None);
    }
    let raw = value.as_str().unwrap_or_default();
    b.document(raw.len(), raw.len())?;
    let parsed: Value =
        serde_json::from_str(value.as_str().unwrap_or_default()).unwrap_or(Value::Null);
    let mut rules = Vec::new();
    for value in parsed.as_array().into_iter().flatten() {
        b.visit(0)?;
        let Some(raw) = value.as_str() else { continue };
        b.comparison(raw.len())?;
        if raw.trim().is_empty() {
            continue;
        }
        let mut rule = raw
            .replace('\\', "/")
            .trim()
            .trim_start_matches('/')
            .to_owned();
        if !rule.is_empty() && !rule.ends_with('/') && !rule.to_lowercase().ends_with(".stl") {
            rule.push('/');
        }
        b.rule()?;
        b.expansion(rule.len())?;
        rules.push(rule);
    }
    Ok(Some(rules))
}
fn imported(
    path: &str,
    rules: &Option<Vec<String>>,
    b: &mut PreparationBudget<'_>,
) -> Result<bool> {
    b.check()?;
    let Some(rules) = rules else { return Ok(true) };
    let normalized = path
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_owned();
    for r in rules {
        b.comparison(path.len().saturating_add(r.len()))?;
        let matched = if r.ends_with('/') {
            let r = &r[..r.len() - 1];
            normalized == r || normalized.starts_with(&format!("{r}/"))
        } else {
            normalized == *r
        };
        if matched {
            return Ok(true);
        }
    }
    Ok(false)
}
#[derive(Clone)]
struct NamingSnapshot {
    profile: Arc<NamingProfile>,
    digest: Value,
    bytes: usize,
}
fn project_naming(
    metadata: Map<String, Value>,
    global: NamingProfile,
    budget: &mut PreparationBudget<'_>,
) -> Result<NamingSnapshot> {
    #[cfg(test)]
    if crate::catalog::naming::uses_defaults(&metadata) {
        GLOBAL_NAMING_PROJECTIONS.with(|count| count.set(count.get() + 1));
    }
    let mut projected = if crate::catalog::naming::uses_defaults(&metadata) {
        crate::catalog::naming::project(metadata, global)
    } else {
        let override_value = metadata["naming"]
            .get("override")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}));
        crate::catalog::naming::merge_override(override_value, global)
    }
    .map_err(|error| error.context(crate::catalog::CatalogFailure::InvalidStoredNaming))?;
    let bytes = serde_json::to_vec(&projected["effective"])?;
    budget.expansion(bytes.len())?;
    Ok(NamingSnapshot {
        profile: Arc::new(serde_json::from_slice(&bytes)?),
        digest: projected["effective_digest"].take(),
        bytes: bytes.len(),
    })
}
fn global_naming(
    tx: &Transaction<'_>,
    tenant: &str,
    budget: &mut PreparationBudget<'_>,
) -> Result<NamingSnapshot> {
    let raw = setting(tx, tenant, "stl_naming_defaults")?;
    if let Some(raw) = &raw {
        budget.document(raw.len(), raw.len())?;
    }
    project_naming(
        Map::new(),
        crate::catalog::naming::parse_global(raw),
        budget,
    )
}
pub(super) fn capture(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    reads: &dyn DraftReads,
    budget: &mut PreparationBudget<'_>,
) -> Result<Capture> {
    budget.check()?;
    let attachments = rows(
        tx,
        "SELECT * FROM profile_layers WHERE tenant_id=? AND profile_id=? ORDER BY layer_order",
        &[&tenant, &profile],
    )?;
    let defaults = global_naming(tx, tenant, budget)?;
    let mut seen = HashSet::new();
    let mut layers = Vec::new();
    let mut inputs = Vec::new();
    let mut source_layers = HashMap::new();
    let mut fingerprint = Vec::new();
    for attachment in attachments {
        budget.visit(0)?;
        let Some(id) = attachment["projectId"].as_i64().filter(|n| *n != 0) else {
            continue;
        };
        ensure!(
            seen.insert(id),
            "A Source can only be attached to a Plan once"
        );
        let source = one(
            tx,
            "SELECT * FROM projects WHERE tenant_id=? AND id=?",
            &[&tenant, &id],
        )?
        .ok_or_else(|| anyhow!("Plan Source not found"))?;
        let raw_metadata = source["metadataJson"].as_str();
        if let Some(raw) = raw_metadata {
            budget.document(raw.len(), raw.len())?;
        }
        let metadata = raw_metadata
            .and_then(|raw| serde_json::from_str::<Map<String, Value>>(raw).ok())
            .unwrap_or_default();
        let naming = if crate::catalog::naming::uses_defaults(&metadata) {
            defaults.clone()
        } else {
            budget.comparison(
                defaults
                    .bytes
                    .saturating_add(raw_metadata.map(str::len).unwrap_or_default())
                    .saturating_mul(8),
            )?;
            project_naming(metadata, (*defaults.profile).clone(), budget)?
        };
        let effective = naming.profile;
        for rule in &effective.folder_rules {
            budget.rule()?;
            budget.comparison(rule.path_contains.len())?;
        }
        for role in &effective.roles {
            for marker in &role.markers {
                budget.rule()?;
                budget.comparison(marker.len())?;
            }
        }
        let revision = if let Some(id) = source["currentSourceRevisionId"].as_i64() {
            let r = one(
                tx,
                "SELECT * FROM source_revisions WHERE tenant_id=? AND id=?",
                &[&tenant, &id],
            )?
            .ok_or_else(|| anyhow!("Active Source revision not found"))?;
            ensure!(
                r["projectId"] == source["id"],
                "Active Source revision not found"
            );
            Some(r)
        } else {
            None
        };
        let layer = format!(
            "{}:{}",
            text(&attachment, "layerType")?,
            text(&source, "name")?
        );
        budget.comparison(layer.len())?;
        budget.expansion(layer.len())?;
        #[cfg(test)]
        SOURCE_LAYER_VISITS.with(|count| count.set(count.get() + 1));
        source_layers.insert(
            layer.clone(),
            SourceLayer {
                source_id: id,
                tracked: revision.is_some(),
            },
        );
        let path = revision
            .as_ref()
            .map(|r| r["snapshotLocator"].as_str().map(str::to_owned))
            .unwrap_or_else(|| source["localPath"].as_str().map(str::to_owned));
        let root = reads.resolve_stl_root(
            &OwnedStlReadRequest {
                tenant: tenant.into(),
                source_id: id,
                path,
                purpose: if revision.is_some() {
                    StlPurpose::Revision
                } else {
                    StlPurpose::Untracked
                },
            },
            budget,
        )?;
        let rules = import_rules(&source["importedPaths"], budget)?;
        let input = json!({"sourceId":id,"sourceLayer":layer,"layerOrder":attachment["layerOrder"],"trackingKind":if revision.is_some(){"revision"}else{"untracked"},"sourceRevisionId":revision.as_ref().map(|r|r["id"].clone()),"manifestDigest":revision.as_ref().map(|r|r["manifestDigest"].clone()),"effectiveNamingDigest":naming.digest});
        let wire = json!({"source_id":id,"source_name":source["name"],"source_layer":layer,"layer_order":attachment["layerOrder"],"tracking_kind":input["trackingKind"],"source_revision_id":input["sourceRevisionId"],"manifest_digest":input["manifestDigest"],"effective_naming_digest":input["effectiveNamingDigest"]});
        fingerprint.push(json!({"layer_id":attachment["id"],"layer_order":attachment["layerOrder"],"layer_type":attachment["layerType"],"project_id":id,"source_name":source["name"],"local_path":root.logical_resolved_path(),"import_rules":rules,"input":wire}));
        inputs.push(input);
        layers.push(Layer {
            source_id: id,
            source_layer: layer,
            naming: effective,
            rules,
            root,
        });
    }
    Ok(Capture {
        fingerprint: required_units::model::digest(&json!(fingerprint)),
        inputs,
        layers,
        source_layers,
    })
}
fn role_name(role: crate::catalog::naming::RoleId) -> String {
    use crate::catalog::naming::RoleId;
    match role {
        RoleId::Primary => "primary",
        RoleId::Accent => "accent",
        RoleId::Clear => "clear",
        RoleId::Opaque => "opaque",
    }
    .into()
}
fn replace_first(input: &str, pattern: &str, replacement: &str) -> String {
    if let Ok(re) = regress::Regex::with_flags(pattern, "i")
        && let Some(m) = re.find(input)
    {
        return format!(
            "{}{}{}",
            &input[..m.range.start],
            replacement,
            &input[m.range.end..]
        );
    }
    input.into()
}
pub(super) fn parse(
    path: &str,
    profile: &NamingProfile,
    b: &mut PreparationBudget<'_>,
) -> Result<(String, String, String, f64)> {
    let filename = path.rsplit('/').next().unwrap_or(path).to_owned();
    b.comparison(path.len())?;
    let lower = path.to_lowercase();
    let mut role = None;
    for rule in &profile.folder_rules {
        b.visit(0)?;
        b.comparison(lower.len().saturating_add(rule.path_contains.len()))?;
        if lower.contains(&rule.path_contains.to_lowercase()) {
            role = Some(role_name(rule.role_id));
            break;
        }
    }
    if role.is_none() {
        let mut markers = Vec::new();
        for role in &profile.roles {
            b.visit(0)?;
            for marker in &role.markers {
                b.visit(0)?;
                b.comparison(marker.len())?;
                if !marker.trim().is_empty() {
                    markers.push((marker, role.id, marker.encode_utf16().count()));
                }
            }
        }
        b.comparison(
            markers
                .len()
                .saturating_mul(markers.len().max(1).ilog2() as usize + 1),
        )?;
        markers.sort_by_key(|(_, _, len)| std::cmp::Reverse(*len));
        'segments: for segment in path.split('/') {
            let lower = segment.to_lowercase();
            for (marker, id, _) in &markers {
                b.visit(0)?;
                b.comparison(segment.len().saturating_add(marker.len()))?;
                if lower.contains(&marker.to_lowercase()) {
                    role = Some(role_name(*id));
                    break 'segments;
                }
            }
        }
    }
    b.comparison(filename.len().saturating_add(profile.quantity.regex.len()))?;
    let quantity = regress::Regex::with_flags(&profile.quantity.regex, "i")?
        .find(&filename)
        .and_then(|m| m.captures.first().cloned().flatten())
        .map(|r| filename[r].to_owned())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = s.trim_start();
            let mut end = 0;
            for (i, c) in s.char_indices() {
                if c.is_ascii_digit() || (i == 0 && (c == '+' || c == '-')) {
                    end = i + c.len_utf8()
                } else {
                    break;
                }
            }
            let number = s[..end].parse::<f64>().unwrap_or(f64::NAN);
            if number.is_nan() {
                number
            } else {
                number.max(1.0)
            }
        })
        .unwrap_or(profile.quantity.default as f64);
    let name = if filename.to_lowercase().ends_with(".stl") {
        filename[..filename.len() - 4].to_owned()
    } else {
        filename.clone()
    };
    let mut slug = name.clone();
    if profile.slug.strip_markers {
        for r in &profile.roles {
            b.visit(0)?;
            for marker in &r.markers {
                b.visit(0)?;
                b.comparison(slug.len().saturating_add(marker.len().saturating_mul(2)))?;
                if marker.trim().is_empty() {
                    continue;
                }
                let mut escaped = String::new();
                for c in marker.chars() {
                    if ".*+?^${}()|[]\\".contains(c) {
                        escaped.push('\\')
                    }
                    escaped.push(c)
                }
                slug = replace_first(&slug, &format!("^{escaped}"), "");
            }
        }
    }
    if profile.slug.strip_quantity {
        b.comparison(
            slug.len()
                .saturating_add(profile.quantity.regex.len().saturating_mul(8)),
        )?;
        let mut strip = pp_domain::build_identity::trim_js(&profile.quantity.regex).to_owned();
        strip = regress::Regex::new(r"\(\?P<\w+>")?.replace_all(&strip, "(");
        strip = regress::Regex::new(r"\(\?:")?.replace_all(&strip, "(");
        strip = regress::Regex::new(r"\([^?][^)]*\)")?.replace(&strip, "[0-9]+");
        strip = regress::Regex::new(r"\\\.stl\$")?.replace(&strip, "$");
        strip = regress::Regex::with_flags(r"\.stl$", "i")?.replace(&strip, "$");
        slug = replace_first(&slug, &strip, "");
    }
    if slug.is_empty() {
        slug = name
    }
    Ok((
        filename,
        slug,
        role.unwrap_or_else(|| "primary".into()),
        quantity,
    ))
}
fn merge(
    scans: &[Vec<Scanned>],
    prior: &HashMap<String, DraftPart>,
    b: &mut PreparationBudget<'_>,
) -> Result<Vec<Scanned>> {
    let mut parts: Vec<Scanned> = Vec::new();
    let mut index = HashMap::new();
    let mut slugs: HashMap<String, String> = HashMap::new();
    for (layer, scan) in scans.iter().enumerate() {
        for p in scan {
            b.visit(0)?;
            let mut p = p.clone();
            p.status = if index.contains_key(&p.key) {
                "replaced"
            } else if layer == 0 {
                "base"
            } else {
                "added"
            }
            .into();
            if prior.get(&p.key).is_some_and(|p| p["included"] == false) {
                p.status = "excluded".into()
            }
            let idx = if let Some(i) = index.get(&p.key) {
                *i
            } else {
                let i = parts.len();
                index.insert(p.key.clone(), i);
                parts.push(p.clone());
                i
            };
            parts[idx] = p.clone();
            if let Some(other) = slugs.get(&p.slug).filter(|other| **other != p.key) {
                parts[idx].status = "conflict".into();
                if let Some(i) = index.get(other) {
                    parts[*i].status = "conflict".into()
                }
            } else {
                slugs.insert(p.slug, p.key);
            }
        }
    }
    Ok(parts)
}
fn source_rows(tx: &Transaction<'_>, tenant: &str, profile: i64) -> Result<Vec<Value>> {
    rows(
        tx,
        "SELECT p.* FROM profile_layers l JOIN projects p ON p.id=l.project_id AND p.tenant_id=l.tenant_id WHERE l.tenant_id=? AND l.profile_id=? ORDER BY l.layer_order",
        &[&tenant, &profile],
    )
}
fn checkout(source: &Value, tenant: &str) -> Option<OwnedCheckoutReadRequest> {
    Some(OwnedCheckoutReadRequest {
        tenant: tenant.into(),
        source_id: source["id"].as_i64()?,
        path: source["localPath"]
            .as_str()
            .filter(|s| !s.is_empty())?
            .into(),
    })
}
fn inferred(
    paths: &[String],
    reads: &dyn DraftReads,
    b: &mut PreparationBudget<'_>,
) -> Result<manifest::Groups> {
    let mut rules = Vec::new();
    for purpose in [
        CatalogPurpose::ShippedHintsFirst,
        CatalogPurpose::ShippedHintsSecond,
    ] {
        if let DocumentRead::Bytes(bytes) =
            reads.read_catalog_document(&OwnedCatalogReadRequest { purpose }, b)?
        {
            match manifest::hints(&bytes, b) {
                Ok(v) => {
                    rules = v;
                    break;
                }
                Err(ReadFailure::InvalidDocument) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    match reads.read_catalog_document(
        &OwnedCatalogReadRequest {
            purpose: CatalogPurpose::CustomHints,
        },
        b,
    )? {
        DocumentRead::Missing => {}
        DocumentRead::Skipped(e) => return Err(ReadFailure::Io(e).into()),
        DocumentRead::Bytes(bytes) => rules.extend(manifest::hints(&bytes, b)?),
    }
    let mut groups = Vec::new();
    for (path, group, id, label) in rules {
        if paths.iter().try_fold(false, |found, p| -> Result<bool> {
            Ok(found || manifest::path_matches(&path, p, b)?)
        })? {
            manifest::merge(
                &mut groups,
                vec![(
                    group.clone(),
                    Group {
                        rule: "pick_one".into(),
                        label: Some(label.clone().unwrap_or_else(|| group.0.identifier_label())),
                        parts: Vec::new(),
                        variants: vec![Variant {
                            id: id.clone(),
                            label: Some(label.unwrap_or_else(|| id.0.identifier_label())),
                            parts: vec![path],
                            excludes: Vec::new(),
                        }],
                        min: None,
                        max: None,
                    },
                )],
                b,
            )?;
        }
    }
    let siblings = manifest::infer_siblings(paths, b)?;
    manifest::merge(&mut groups, siblings, b)?;
    Ok(groups)
}
pub(super) fn prepare(
    connection: &mut impl PreparationSql,
    tenant: &str,
    profile: i64,
    base: Value,
    context: PreparationContext<'_>,
    reads: &dyn DraftReads,
    b: &mut PreparationBudget<'_>,
) -> Result<PreparedDraftSnapshot> {
    b.check()?;
    let PreparationContext { options, repos } = context;
    let (previous, captured, reuse) = connection.read(|tx| {
        let mut previous = if let Some(id) = base["baseRevisionId"].as_i64() {
            ensure!(
                one(
                    tx,
                    "SELECT id FROM plan_revisions WHERE tenant_id=? AND profile_id=? AND id=?",
                    &[&tenant, &profile, &id]
                )?
                .is_some(),
                "Missing accepted base"
            );
            part_rows(
                tx,
                "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
                &[&tenant, &id],
            )?
        } else {
            Vec::new()
        };
        normalize_parts(&mut previous)?;
        let captured = capture(tx, tenant, profile, reads, b)?;
        let reuse = options.prefer_accepted
            && !options.apply_manifest
            && !base["baseRevisionId"].is_null()
            && options.excluded_paths_by_source_id.is_none()
            && options.included_paths_by_source_id.is_none()
            && options.part_choices_by_source_id.is_none()
            && !captured.inputs.is_empty()
            && captured
                .inputs
                .iter()
                .all(|i| i["trackingKind"] == "revision")
            && crate::read_model::reusable_draft_base(tx, tenant, profile, repos, b)?;
        Ok((previous, captured, reuse))
    })?;
    let mut captured = captured;
    if reuse {
        let parts: Vec<_> = previous
            .into_iter()
            .map(|p| {
                let row = json!({"baseRevisionPartId":p["id"]});
                let mut part = p.projected(required_units::model::PART_FIELDS);
                part["baseRevisionPartId"] = row["baseRevisionPartId"].clone();
                part
            })
            .collect();
        b.check()?;
        let digest = required_units::model::planning(&base, &captured.inputs, &parts)?;
        return Ok(PreparedDraftSnapshot {
            base,
            capture: captured,
            parts,
            digest,
        });
    }
    let mut prior = HashMap::new();
    for p in previous {
        b.visit(0)?;
        prior.entry(text(&p, "partKey")?.to_owned()).or_insert(p);
    }
    let mut inventories = Vec::new();
    let mut scans = Vec::new();
    let mut available = Vec::new();
    for layer in &mut captured.layers {
        b.check()?;
        if layer.root.logical_resolved_path().is_none() {
            continue;
        }
        let inventory = layer.root.scan_stls(b)?;
        let n = inventories.len();
        let mut scan = Vec::new();
        for (index, entry) in inventory.entries().iter().enumerate() {
            b.visit(0)?;
            b.comparison(entry.physical_relative_path.len())?;
            let path = entry.physical_relative_path.replace('\\', "/");
            if let Some(paths) = options
                .excluded_paths_by_source_id
                .as_ref()
                .and_then(|m| m.get(&layer.source_id))
            {
                let mut excluded = false;
                for p in paths {
                    b.comparison(p.len().saturating_add(path.len()))?;
                    excluded |= p == &path;
                }
                if excluded {
                    continue;
                }
            }
            if let Some(paths) = options
                .included_paths_by_source_id
                .as_ref()
                .and_then(|m| m.get(&layer.source_id))
            {
                let mut included = false;
                for p in paths {
                    b.comparison(p.len().saturating_add(path.len()))?;
                    included |= p == &path
                        || p.strip_suffix("/**")
                            .is_some_and(|p| path.starts_with(&format!("{p}/")));
                }
                if !included {
                    continue;
                }
            }
            let (filename, slug, role, quantity) = parse(&path, &layer.naming, b)?;
            scan.push(Scanned {
                key: path.to_lowercase().trim_matches('/').into(),
                path,
                filename,
                slug,
                role,
                quantity,
                inventory: n,
                index,
                layer: layer.source_layer.clone(),
                status: String::new(),
            });
        }
        scan.sort_by(|a, z| crate::read_model::views::folder_compare(&a.key, &z.key));
        let mut imported_scan = Vec::new();
        for p in &scan {
            if imported(&p.path, &layer.rules, b)? {
                imported_scan.push(p.clone());
            }
        }
        scans.push(imported_scan);
        available.push(scan);
        inventories.push(inventory);
    }
    ensure!(!scans.is_empty(), Failure::NoLayers);
    ensure!(available.iter().any(|v| !v.is_empty()), Failure::NoStls);
    let mut merged = merge(&scans, &prior, b)?;
    let selected: HashSet<_> = merged.iter().map(|p| p.key.clone()).collect();
    merged.extend(
        merge(&available, &prior, b)?
            .into_iter()
            .filter(|p| !selected.contains(&p.key)),
    );
    let defaults =
        connection.read(|tx| setting(tx, tenant, &format!("role_filaments_{profile}")))?;
    if let Some(raw) = &defaults {
        b.document(raw.len(), raw.len())?;
    }
    let role_defaults = defaults
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let spoolman = connection.read(|tx| spoolman_enabled(tx, tenant, profile, b))?;
    let mut parts = Vec::new();
    for p in merged {
        b.visit(0)?;
        let old = prior.get(&p.key);
        let default = &role_defaults[p.role.trim().to_lowercase()];
        if old.is_none() && !spoolman {
            b.comparison(default["filament_color_id"].as_str().map_or(0, str::len))?;
        }
        let nullable = |key: &str, default_key: &str| {
            old.map(|v| v[key].clone()).unwrap_or_else(|| {
                default[default_key]
                    .as_str()
                    .filter(|value| {
                        spoolman
                            || match default_key {
                                "spoolman_spool_id" => false,
                                "filament_color_id" => !value.trim().starts_with("spoolman:"),
                                _ => true,
                            }
                    })
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null)
            })
        };
        let quantity_override = old
            .map(|v| v["quantityOverride"].clone())
            .unwrap_or(Value::Null);
        let tracked = captured
            .source_layer(&p.layer, b)?
            .is_some_and(|source| source.tracked);
        let artifact = if tracked {
            Some(
                inventories[p.inventory]
                    .hash_tracked_winner(p.index, b)?
                    .byte_sha256,
            )
        } else {
            None
        };
        parts.push(DraftPart::new(json!({"baseRevisionPartId":old.map(|v|v["id"].clone()),"partKey":p.key,"relativePath":p.path,"filename":p.filename,"sourceLayer":p.layer,"status":p.status,"roleInferred":p.role,"roleOverride":old.map(|v|v["roleOverride"].clone()),"filamentColorId":nullable("filamentColorId","filament_color_id"),"filamentCustomHex":nullable("filamentCustomHex","filament_custom_hex"),"spoolmanSpoolId":nullable("spoolmanSpoolId","spoolman_spool_id"),"quantityInferred":quantity_value(p.quantity),"quantityOverride":quantity_override,"quantityEffective":if quantity_override.is_null(){quantity_value(p.quantity)}else{quantity_override},"included":old.map(|v|v["included"].clone()).unwrap_or(json!(selected.contains(&p.key))),"notes":old.map(|v|v["notes"].clone()).unwrap_or(json!("")),"githubBlobUrl":old.map(|v|v["githubBlobUrl"].clone()),"geometrySame":old.map(|v|v["geometrySame"].clone()),"artifactDigest":artifact}),old.map(|part| part.manifest.clone()).unwrap_or_else(PartManifestMetadata::default)));
    }
    let option_sources = connection.read(|tx| source_rows(tx, tenant, profile))?;
    let mut groups = Vec::new();
    for source in &option_sources {
        b.check()?;
        let Some(request) = checkout(source, tenant) else {
            continue;
        };
        let observed =
            reads.read_checkout_manifest(&request, CheckoutManifestUse::OptionGroups, b)?;
        let doc = manifest::optional_document(&observed, b)?.unwrap_or_default();
        let mut root = reads.resolve_stl_root(
            &OwnedStlReadRequest {
                tenant: tenant.into(),
                source_id: num(source, "id")?,
                path: Some(request.path.clone()),
                purpose: StlPurpose::CheckoutOptions,
            },
            b,
        )?;
        if root.logical_resolved_path().is_none() {
            continue;
        }
        let inventory = root.scan_stls(b)?;
        let rules = import_rules(&source["importedPaths"], b)?;
        let mut paths = Vec::new();
        for entry in inventory.entries() {
            b.visit(0)?;
            let path = entry.physical_relative_path.replace('\\', "/");
            if imported(&path, &rules, b)? {
                paths.push(path);
            }
        }
        paths.sort_by(|a, z| {
            crate::read_model::views::folder_compare(&a.to_lowercase(), &z.to_lowercase())
        });
        let declared = doc.groups;
        let resolved = if declared.is_empty() {
            inferred(&paths, reads, b)?
        } else {
            declared
        };
        manifest::merge(&mut groups, resolved, b)?;
    }
    let manifest_sources = connection.read(|tx| source_rows(tx, tenant, profile))?;
    let mut docs = Vec::new();
    for source in &manifest_sources {
        b.check()?;
        let Some(request) = checkout(source, tenant) else {
            continue;
        };
        let name = text(source, "name")?.to_owned();
        let observed =
            reads.read_checkout_manifest(&request, CheckoutManifestUse::PartRulesAndDefaults, b)?;
        if let Some(doc) = manifest::optional_document(&observed, b)? {
            docs.push((name.clone(), "repo".into(), doc));
        }
        if let Some(stored) = source["manifestCommunitySlug"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            // Node's loadCommunityManifest warns and skips an invalid stored slug.
            let Some(slug) = CommunitySlug::parse(stored) else {
                eprintln!(
                    "Ignoring invalid stored community manifest slug source_id={}",
                    source["id"]
                );
                continue;
            };
            let observed = reads.read_catalog_document(
                &OwnedCatalogReadRequest {
                    purpose: CatalogPurpose::Community(slug),
                },
                b,
            )?;
            if let Some(doc) = manifest::optional_document(&observed, b)? {
                docs.push((name, "community".into(), doc));
            }
        }
    }
    let kit = connection.read(|tx| setting(tx, tenant, &format!("kit_manifest_{profile}")))?;
    let selections = manifest::kit(kit, b)?;
    manifest::apply(&mut parts, &docs, groups, selections, b)?;
    if !options.apply_manifest {
        for part in &mut parts {
            b.visit(0)?;
            part["included"] = prior
                .get(text(part, "partKey")?)
                .map(|v| v["included"].clone())
                .unwrap_or(json!(
                    selected.contains(text(part, "partKey")?) && part["included"] == true
                ));
        }
    }
    if let Some(choices) = &options.part_choices_by_source_id {
        let mut matched = HashSet::new();
        for part in &mut parts {
            b.visit(0)?;
            let source = captured
                .source_layer(text(part, "sourceLayer")?, b)?
                .map(|source| source.source_id);
            let Some(source) = source else { continue };
            let path = text(part, "relativePath")?.to_owned();
            let Some(choice) = choices.get(&source).and_then(|choices| choices.get(&path)) else {
                continue;
            };
            ensure!(
                matched.insert((source, path)),
                "Reference part maps to more than one Plan Part"
            );
            part["roleOverride"] = json!(choice.role);
            part["filamentColorId"] = Value::Null;
            part["filamentCustomHex"] = json!(choice.color);
            part["spoolmanSpoolId"] = Value::Null;
            part["quantityOverride"] = serde_json::to_value(choice.quantity)?;
            part["quantityEffective"] = part["quantityOverride"].clone();
            part["included"] = json!(true);
        }
        ensure!(
            matched.len() == choices.values().map(|choices| choices.len()).sum::<usize>(),
            "Reference part is missing from the Plan draft"
        );
    }
    b.check()?;
    let digest = required_units::model::planning(&base, &captured.inputs, &parts)?;
    Ok(PreparedDraftSnapshot {
        base,
        capture: captured,
        parts,
        digest,
    })
}

fn quantity_value(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && (0.0..=9007199254740991.0).contains(&n) {
        json!(n as u64)
    } else {
        json!(n)
    }
}

pub(super) struct PreparationContext<'a> {
    pub options: &'a PreparationOptions,
    pub repos: &'a std::path::Path,
}
pub(super) trait PreparationSql {
    fn read<T>(&mut self, read: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T>;
}
impl PreparationSql for Connection {
    fn read<T>(&mut self, read: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let tx = self.transaction()?;
        let result = read(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}
impl PreparationSql for Transaction<'_> {
    fn read<T>(&mut self, read: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        read(self)
    }
}

#[cfg_attr(test, derive(serde::Deserialize))]
pub(super) struct PartChoice {
    pub quantity: pp_domain::Quantity,
    pub role: String,
    pub color: Option<String>,
}

pub(super) struct PreparationOptions {
    pub part_choices_by_source_id: Option<BTreeMap<i64, BTreeMap<String, PartChoice>>>,
    pub apply_manifest: bool,
    pub prefer_accepted: bool,
    pub excluded_paths_by_source_id: Option<BTreeMap<i64, Vec<String>>>,
    pub included_paths_by_source_id: Option<BTreeMap<i64, Vec<String>>>,
}
impl Default for PreparationOptions {
    fn default() -> Self {
        Self {
            part_choices_by_source_id: None,
            apply_manifest: true,
            prefer_accepted: false,
            excluded_paths_by_source_id: None,
            included_paths_by_source_id: None,
        }
    }
}

#[derive(Debug)]
pub(super) enum Failure {
    NoLayers,
    NoStls,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Failure {}
