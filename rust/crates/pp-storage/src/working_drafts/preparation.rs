use super::{
    Failure,
    manifest::{self, Group, Variant},
    observation::*,
};
use crate::{
    catalog::naming::NamingProfile,
    required_units::{self, num, one, rows, text},
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, Transaction};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub(super) struct Capture {
    pub fingerprint: String,
    pub inputs: Vec<Value>,
    layers: Vec<Layer>,
    observations: PreparationObservations,
}
#[derive(Default)]
struct PreparationObservations {
    documents: BTreeMap<String, Vec<DocumentRead>>,
    inventories: Vec<Box<dyn StlInventory>>,
    checkout_inventories: Vec<Box<dyn StlInventory>>,
    artifacts: HashMap<(usize, usize), ArtifactRead>,
    role_defaults: Value,
    kit: Option<String>,
    option_sources: Vec<Value>,
    manifest_sources: Vec<Value>,
}
fn document(
    observations: &mut BTreeMap<String, Vec<DocumentRead>>,
    purpose: String,
    read: DocumentRead,
) -> &DocumentRead {
    let occurrences = observations.entry(purpose).or_default();
    occurrences.push(read);
    occurrences.last().expect("Recorded document occurrence")
}
struct Layer {
    source_id: i64,
    source_layer: String,
    naming: NamingProfile,
    rules: Option<Vec<String>>,
    root: Box<dyn StlRootRead>,
}
pub(super) struct PreparedDraftSnapshot {
    pub base: Value,
    pub capture: Capture,
    pub parts: Vec<Value>,
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
fn import_rules(value: &Value) -> Option<Vec<String>> {
    if value.is_null() {
        return None;
    }
    let parsed: Value =
        serde_json::from_str(value.as_str().unwrap_or_default()).unwrap_or(Value::Null);
    Some(
        parsed
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| {
                        let mut s = s
                            .replace('\\', "/")
                            .trim()
                            .trim_start_matches('/')
                            .to_owned();
                        if !s.is_empty() && !s.ends_with('/') && !s.to_lowercase().ends_with(".stl")
                        {
                            s.push('/')
                        }
                        s
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}
fn imported(path: &str, rules: &Option<Vec<String>>) -> bool {
    let Some(rules) = rules else { return true };
    let normalized = path
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_owned();
    rules.iter().any(|r| {
        if r.ends_with('/') {
            let r = r.trim_end_matches('/');
            normalized == r || normalized.starts_with(&format!("{r}/"))
        } else {
            normalized == *r
        }
    })
}
pub(super) fn capture(
    tx: &Transaction<'_>,
    tenant: &str,
    profile: i64,
    reads: &dyn DraftReads,
    budget: &mut PreparationBudget<'_>,
) -> Result<Capture> {
    let attachments = rows(
        tx,
        "SELECT * FROM profile_layers WHERE tenant_id=? AND profile_id=? ORDER BY layer_order",
        &[&tenant, &profile],
    )?;
    let mut seen = HashSet::new();
    let mut layers = Vec::new();
    let mut inputs = Vec::new();
    let mut fingerprint = Vec::new();
    for attachment in attachments {
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
        let naming = crate::catalog::naming::get(tx, tenant, id)?;
        let effective: NamingProfile = serde_json::from_value(naming["effective"].clone())?;
        let revision = if let Some(id) = source["currentSourceRevisionId"].as_i64() {
            let r = one(
                tx,
                "SELECT * FROM source_revisions WHERE tenant_id=? AND id=?",
                &[&tenant, &id],
            )?
            .ok_or_else(|| anyhow!("Active Source revision not found"))?;
            ensure!(
                r["projectId"] == source["id"],
                "Active Source revision not owned"
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
        let rules = import_rules(&source["importedPaths"]);
        let input = json!({"sourceId":id,"sourceLayer":layer,"layerOrder":attachment["layerOrder"],"trackingKind":if revision.is_some(){"revision"}else{"untracked"},"sourceRevisionId":revision.as_ref().map(|r|r["id"].clone()),"manifestDigest":revision.as_ref().map(|r|r["manifestDigest"].clone()),"effectiveNamingDigest":naming["effective_digest"]});
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
        observations: PreparationObservations::default(),
    })
}
fn role_name(role: crate::catalog::naming::RoleId) -> String {
    serde_json::to_value(role).unwrap().as_str().unwrap().into()
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
fn parse(path: &str, profile: &NamingProfile) -> Result<(String, String, String, f64)> {
    let filename = path.rsplit('/').next().unwrap_or(path).to_owned();
    let lower = path.to_lowercase();
    let mut role = profile
        .folder_rules
        .iter()
        .find(|r| lower.contains(&r.path_contains.to_lowercase()))
        .map(|r| role_name(r.role_id));
    let mut markers: Vec<_> = profile
        .roles
        .iter()
        .flat_map(|r| {
            r.markers
                .iter()
                .filter(|m| !m.trim().is_empty())
                .map(move |m| (m, r.id))
        })
        .collect();
    markers.sort_by_key(|(m, _)| std::cmp::Reverse(m.encode_utf16().count()));
    if role.is_none() {
        for segment in path.split('/') {
            if let Some((_, id)) = markers
                .iter()
                .find(|(m, _)| segment.to_lowercase().contains(&m.to_lowercase()))
            {
                role = Some(role_name(*id));
                break;
            }
        }
    }
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
            for marker in &r.markers {
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
        let mut strip = profile.quantity.regex.trim().replace("(?:", "(");
        strip = replace_first(&strip, r"\(\?P<\w+>", "(");
        strip = replace_first(&strip, r"\([^?][^)]*\)", "[0-9]+");
        strip = strip.replace("\\.stl$", "$");
        if strip.to_lowercase().ends_with(".stl") {
            strip.truncate(strip.len() - 4);
            strip.push('$')
        }
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
fn merge(scans: &[Vec<Scanned>], prior: &HashMap<String, Value>) -> Vec<Scanned> {
    let mut parts: Vec<Scanned> = Vec::new();
    let mut index = HashMap::new();
    let mut slugs: HashMap<String, String> = HashMap::new();
    for (layer, scan) in scans.iter().enumerate() {
        for p in scan {
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
    parts
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
    observations: &mut BTreeMap<String, Vec<DocumentRead>>,
    b: &mut PreparationBudget<'_>,
) -> Result<manifest::Groups> {
    let mut rules = Vec::new();
    for purpose in [
        CatalogPurpose::ShippedHintsFirst,
        CatalogPurpose::ShippedHintsSecond,
    ] {
        if let DocumentRead::Bytes(bytes) = document(
            observations,
            match purpose {
                CatalogPurpose::ShippedHintsFirst => "shipped_hints_first",
                _ => "shipped_hints_second",
            }
            .into(),
            reads.read_catalog_document(&OwnedCatalogReadRequest { purpose }, b)?,
        ) {
            match manifest::hints(bytes, b) {
                Ok(v) => {
                    rules = v;
                    break;
                }
                Err(ReadFailure::InvalidDocument) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    match document(
        observations,
        "custom_hints".into(),
        reads.read_catalog_document(
            &OwnedCatalogReadRequest {
                purpose: CatalogPurpose::CustomHints,
            },
            b,
        )?,
    ) {
        DocumentRead::Missing => {}
        DocumentRead::Skipped(e) => return Err(ReadFailure::Io(*e).into()),
        DocumentRead::Bytes(bytes) => rules.extend(manifest::hints(bytes, b)?),
    }
    let mut groups = Vec::new();
    for (path, group, id, label) in rules {
        if paths.iter().any(|p| manifest::matches(&path, p)) {
            manifest::merge(
                &mut groups,
                vec![(
                    group.clone(),
                    Group {
                        rule: "pick_one".into(),
                        label: Some(label.clone().unwrap_or_else(|| group.replace('_', " "))),
                        parts: Vec::new(),
                        variants: vec![Variant {
                            id: id.clone(),
                            label: Some(label.unwrap_or_else(|| id.replace('_', " "))),
                            parts: vec![path],
                            excludes: Vec::new(),
                        }],
                        min: None,
                        max: None,
                    },
                )],
            );
        }
    }
    manifest::merge(&mut groups, super::siblings::infer(paths));
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
            rows(
                tx,
                "SELECT * FROM plan_revision_parts WHERE tenant_id=? AND revision_id=? ORDER BY id",
                &[&tenant, &id],
            )?
        } else {
            Vec::new()
        };
        required_units::normalize_parts(&mut previous)?;
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
            && crate::read_model::reusable_draft_base(tx, tenant, profile, repos)?;
        Ok((previous, captured, reuse))
    })?;
    let mut captured = captured;
    if reuse {
        let parts: Vec<_> = previous
            .into_iter()
            .map(|p| {
                let mut row = json!({"baseRevisionPartId":p["id"]});
                for f in required_units::model::PART_FIELDS {
                    row[*f] = p[*f].clone()
                }
                row
            })
            .collect();
        let digest = required_units::model::planning(&base, &captured.inputs, &parts);
        return Ok(PreparedDraftSnapshot {
            base,
            capture: captured,
            parts,
            digest,
        });
    }
    let mut prior = HashMap::new();
    for p in previous {
        prior.entry(text(&p, "partKey")?.to_owned()).or_insert(p);
    }
    let mut scans = Vec::new();
    let mut available = Vec::new();
    for layer in &mut captured.layers {
        if layer.root.logical_resolved_path().is_none() {
            continue;
        }
        let inventory = layer.root.scan_stls(b)?;
        let n = captured.observations.inventories.len();
        let mut scan = Vec::new();
        for (index, entry) in inventory.entries().iter().enumerate() {
            let path = entry.physical_relative_path.replace('\\', "/");
            if options
                .excluded_paths_by_source_id
                .as_ref()
                .and_then(|m| m.get(&layer.source_id))
                .is_some_and(|s| s.contains(&path))
            {
                continue;
            }
            if options
                .included_paths_by_source_id
                .as_ref()
                .and_then(|m| m.get(&layer.source_id))
                .is_some_and(|s| {
                    !s.iter().any(|p| {
                        p == &path
                            || p.strip_suffix("/**")
                                .is_some_and(|p| path.starts_with(&format!("{p}/")))
                    })
                })
            {
                continue;
            }
            let (filename, slug, role, quantity) = parse(&path, &layer.naming)?;
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
        scans.push(
            scan.iter()
                .filter(|p| imported(&p.path, &layer.rules))
                .cloned()
                .collect(),
        );
        available.push(scan);
        captured.observations.inventories.push(inventory);
    }
    ensure!(!scans.is_empty(), Failure::NoLayers);
    ensure!(available.iter().any(|v| !v.is_empty()), Failure::NoStls);
    let mut merged = merge(&scans, &prior);
    let selected: HashSet<_> = merged.iter().map(|p| p.key.clone()).collect();
    merged.extend(
        merge(&available, &prior)
            .into_iter()
            .filter(|p| !selected.contains(&p.key)),
    );
    captured.observations.role_defaults = connection
        .read(|tx| setting(tx, tenant, &format!("role_filaments_{profile}")))?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let mut parts = Vec::new();
    for p in merged {
        let old = prior.get(&p.key);
        let default = &captured.observations.role_defaults[p.role.trim().to_lowercase()];
        let nullable = |key: &str, default_key: &str| {
            old.map(|v| v[key].clone()).unwrap_or_else(|| {
                default[default_key]
                    .as_str()
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null)
            })
        };
        let quantity_override = old
            .map(|v| v["quantityOverride"].clone())
            .unwrap_or(Value::Null);
        let tracked = captured
            .inputs
            .iter()
            .any(|v| v["sourceLayer"] == p.layer && v["trackingKind"] == "revision");
        let artifact = if tracked {
            let observed =
                captured.observations.inventories[p.inventory].hash_tracked_winner(p.index, b)?;
            captured
                .observations
                .artifacts
                .insert((p.inventory, p.index), observed);
            Some(
                captured.observations.artifacts[&(p.inventory, p.index)]
                    .byte_sha256
                    .clone(),
            )
        } else {
            None
        };
        parts.push(json!({"baseRevisionPartId":old.map(|v|v["id"].clone()),"partKey":p.key,"relativePath":p.path,"filename":p.filename,"sourceLayer":p.layer,"status":p.status,"roleInferred":p.role,"roleOverride":old.map(|v|v["roleOverride"].clone()),"filamentColorId":nullable("filamentColorId","filament_color_id"),"filamentCustomHex":nullable("filamentCustomHex","filament_custom_hex"),"spoolmanSpoolId":nullable("spoolmanSpoolId","spoolman_spool_id"),"quantityInferred":quantity_value(p.quantity),"quantityOverride":quantity_override,"quantityEffective":if quantity_override.is_null(){quantity_value(p.quantity)}else{quantity_override},"included":old.map(|v|v["included"].clone()).unwrap_or(json!(selected.contains(&p.key))),"notes":old.map(|v|v["notes"].clone()).unwrap_or(json!("")),"githubBlobUrl":old.map(|v|v["githubBlobUrl"].clone()),"geometrySame":old.map(|v|v["geometrySame"].clone()),"requirement":old.map(|v|v["requirement"].clone()),"optionGroupId":old.map(|v|v["optionGroupId"].clone()),"manifestSource":old.map(|v|v["manifestSource"].clone()),"artifactDigest":artifact}));
    }
    captured.observations.option_sources =
        connection.read(|tx| source_rows(tx, tenant, profile))?;
    let mut groups = Vec::new();
    for source in &captured.observations.option_sources {
        let Some(request) = checkout(source, tenant) else {
            continue;
        };
        let doc = manifest::optional_document(
            document(
                &mut captured.observations.documents,
                format!("checkout_options:{}:{}", request.source_id, request.path),
                reads.read_checkout_manifest(&request, CheckoutManifestUse::OptionGroups, b)?,
            ),
            b,
        )?
        .unwrap_or_default();
        let mut root = reads.resolve_stl_root(
            &OwnedStlReadRequest {
                tenant: tenant.into(),
                source_id: num(source, "id")?,
                path: Some(request.path.clone()),
                purpose: StlPurpose::CheckoutOptions,
            },
            b,
        )?;
        captured
            .observations
            .checkout_inventories
            .push(root.scan_stls(b)?);
        let inventory = captured
            .observations
            .checkout_inventories
            .last()
            .expect("Recorded checkout inventory");
        let rules = import_rules(&source["importedPaths"]);
        let mut paths: Vec<_> = inventory
            .entries()
            .iter()
            .map(|p| p.physical_relative_path.replace('\\', "/"))
            .filter(|p| imported(p, &rules))
            .collect();
        paths.sort_by(|a, z| {
            crate::read_model::views::folder_compare(&a.to_lowercase(), &z.to_lowercase())
        });
        let declared = doc.groups;
        let resolved = if declared.is_empty() {
            inferred(&paths, reads, &mut captured.observations.documents, b)?
        } else {
            declared
        };
        manifest::merge(&mut groups, resolved);
    }
    captured.observations.manifest_sources =
        connection.read(|tx| source_rows(tx, tenant, profile))?;
    let mut docs = Vec::new();
    for source in &captured.observations.manifest_sources {
        let Some(request) = checkout(source, tenant) else {
            continue;
        };
        let name = text(source, "name")?.to_owned();
        if let Some(doc) = manifest::optional_document(
            document(
                &mut captured.observations.documents,
                format!("checkout_parts:{}:{}", request.source_id, request.path),
                reads.read_checkout_manifest(
                    &request,
                    CheckoutManifestUse::PartRulesAndDefaults,
                    b,
                )?,
            ),
            b,
        )? {
            docs.push((name.clone(), "repo".into(), doc));
        }
        if let Some(slug) = source["manifestCommunitySlug"]
            .as_str()
            .filter(|s| !s.is_empty())
            && let Some(doc) = manifest::optional_document(
                document(
                    &mut captured.observations.documents,
                    format!("community:{slug}"),
                    reads.read_catalog_document(
                        &OwnedCatalogReadRequest {
                            purpose: CatalogPurpose::Community(slug.into()),
                        },
                        b,
                    )?,
                ),
                b,
            )?
        {
            docs.push((name, "community".into(), doc));
        }
    }
    captured.observations.kit =
        connection.read(|tx| setting(tx, tenant, &format!("kit_manifest_{profile}")))?;
    let selections = manifest::kit(captured.observations.kit.clone());
    manifest::apply(&mut parts, &docs, groups, selections);
    if !options.apply_manifest {
        for part in &mut parts {
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
            let source = captured
                .inputs
                .iter()
                .find(|input| input["sourceLayer"] == part["sourceLayer"])
                .and_then(|input| input["sourceId"].as_i64());
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
    let digest = required_units::model::planning(&base, &captured.inputs, &parts);
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
    pub options: &'a pp_contracts::working_drafts::RecomputeOptions,
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
