use super::model::{
    KitManifest, ManifestBuilder, ManifestDocument, ManifestOptionGroup, ManifestPart,
    ManifestSource, ManifestVariant, ManifestVariantSource,
};
use crate::working_drafts::observation::{
    self as draft_observation, BuilderGroup as Group, BuilderGroups as Groups, CatalogPurpose,
    CheckoutManifestUse, DocumentRead, DraftReads, OwnedCatalogReadRequest,
    OwnedCheckoutReadRequest, OwnedStlReadRequest, PreparationBudget, PreparationLimits,
    ReadFailure, StlPurpose,
};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CapturedManifestGraph {
    pub tenant: String,
    pub build: i64,
    pub config_modified_at: String,
    pub stored_kit: Option<String>,
    pub sources: Vec<CapturedSource>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CapturedSource {
    layer_id: i64,
    layer_order: i64,
    layer_type: String,
    source_id: i64,
    name: String,
    role: String,
    url: String,
    local_path: Option<String>,
    imported_paths: Option<String>,
    current_revision_id: Option<i64>,
    source_configuration_version: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceObservationStamp([u8; 32]);

pub(crate) struct ObservedBuilder {
    pub builder: ManifestBuilder,
    pub stamps: Vec<(i64, SourceObservationStamp)>,
}

pub(super) fn capture(
    tx: &Transaction<'_>,
    tenant: &str,
    build: i64,
) -> Result<Option<CapturedManifestGraph>> {
    let config_modified_at = tx
        .query_row(
            "SELECT config_modified_at FROM build_profiles WHERE tenant_id=?1 AND id=?2",
            params![tenant, build],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(config_modified_at) = config_modified_at else {
        return Ok(None);
    };
    let stored_kit = tx
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id=?1 AND key=?2",
            params![tenant, format!("kit_manifest_{build}")],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let mut statement = tx.prepare(
        "SELECT layer.id,layer.layer_order,layer.layer_type,source.id,source.name,coalesce(source.role,'unassigned'),coalesce(source.url,''),source.local_path,source.imported_paths,source.current_source_revision_id,source.source_configuration_version FROM profile_layers layer JOIN projects source ON source.tenant_id=layer.tenant_id AND source.id=layer.project_id WHERE layer.tenant_id=?1 AND layer.profile_id=?2 ORDER BY layer.layer_order,layer.id",
    )?;
    let sources = statement
        .query_map(params![tenant, build], |row| {
            Ok(CapturedSource {
                layer_id: row.get(0)?,
                layer_order: row.get(1)?,
                layer_type: row.get(2)?,
                source_id: row.get(3)?,
                name: row.get(4)?,
                role: row.get(5)?,
                url: row.get(6)?,
                local_path: row.get(7)?,
                imported_paths: row.get(8)?,
                current_revision_id: row.get(9)?,
                source_configuration_version: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(CapturedManifestGraph {
        tenant: tenant.into(),
        build,
        config_modified_at,
        stored_kit,
        sources,
    }))
}

pub(super) fn basis_matches(
    tx: &Transaction<'_>,
    captured: &CapturedManifestGraph,
) -> Result<bool> {
    Ok(capture(tx, &captured.tenant, captured.build)?.as_ref() == Some(captured))
}

pub(super) fn observe(
    captured: &CapturedManifestGraph,
    reads: Option<&dyn DraftReads>,
    limits: PreparationLimits,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::result::Result<ObservedBuilder, ReadFailure> {
    let kit = captured
        .stored_kit
        .as_deref()
        .and_then(|raw| super::model::KitManifestPatch::from_stored(raw).ok())
        .unwrap_or_default();
    let available = captured
        .sources
        .iter()
        .filter(|source| {
            source
                .local_path
                .as_deref()
                .is_some_and(|path| !path.is_empty())
        })
        .count();
    if available > 0 && reads.is_none() {
        return Err(ReadFailure::Unavailable);
    }
    let mut budget = PreparationBudget::new(cancelled, limits);
    let mut rows = Vec::new();
    let mut merged = Groups::new();
    let mut defaults = Vec::new();
    let mut annotations: BTreeMap<
        (
            crate::manifest_text::OptionGroupId,
            crate::manifest_text::VariantId,
        ),
        Vec<ManifestVariantSource>,
    > = BTreeMap::new();
    let mut stamps = Vec::new();
    for source in &captured.sources {
        let Some(path) = source.local_path.as_deref().filter(|path| !path.is_empty()) else {
            continue;
        };
        let Some(observed) = observe_source(
            captured,
            source,
            path,
            reads.expect("available source requires reader"),
            &mut budget,
        )?
        else {
            continue;
        };
        for (group, value) in &observed.groups {
            for variant in &value.variants {
                if variant.parts.iter().any(|pattern| {
                    observed
                        .paths
                        .iter()
                        .any(|part| draft_observation::builder_path_matches(pattern, part))
                }) {
                    let sources = annotations
                        .entry((group.clone(), variant.id.clone()))
                        .or_default();
                    if !sources
                        .iter()
                        .any(|item| item.source_id == source.source_id)
                    {
                        sources.push(ManifestVariantSource {
                            source_id: source.source_id,
                            source_name: source.name.clone(),
                        });
                    }
                }
            }
        }
        for (group, selection, scalar) in observed.defaults {
            if !defaults.iter().any(|(existing, _, _)| existing == &group) {
                defaults.push((group, selection, scalar));
            }
        }
        draft_observation::merge_builder_groups(&mut merged, observed.groups);
        rows.push(observed.row);
        stamps.push((source.source_id, observed.stamp));
    }
    let mut resolved = kit.clone();
    for (group, selection, scalar) in defaults {
        resolved.insert_default_selection(group, selection, scalar);
    }
    let merged_option_groups = groups_to_model(merged, &annotations);
    Ok(ObservedBuilder {
        builder: ManifestBuilder {
            profile_id: captured.build,
            sources: rows,
            resolved_selections: resolved,
            merged_option_groups,
        },
        stamps,
    })
}

struct SourceObservation {
    row: ManifestSource,
    groups: Groups,
    defaults: Vec<(
        crate::manifest_text::OptionGroupId,
        Vec<crate::manifest_text::VariantId>,
        bool,
    )>,
    paths: Vec<String>,
    stamp: SourceObservationStamp,
}

fn observe_source(
    captured: &CapturedManifestGraph,
    source: &CapturedSource,
    path: &str,
    reads: &dyn DraftReads,
    budget: &mut PreparationBudget<'_>,
) -> std::result::Result<Option<SourceObservation>, ReadFailure> {
    budget.check()?;
    let mut hasher = Sha256::new();
    stamp_text(&mut hasher, &source.source_id.to_string());
    stamp_text(&mut hasher, path);
    let request = OwnedCheckoutReadRequest {
        tenant: captured.tenant.clone(),
        source_id: source.source_id,
        path: path.into(),
    };
    let manifest_read =
        reads.read_checkout_manifest(&request, CheckoutManifestUse::OptionGroups, budget)?;
    stamp_document(&mut hasher, &manifest_read);
    let parsed = match &manifest_read {
        DocumentRead::Bytes(bytes) => {
            match draft_observation::parse_builder_manifest(bytes, budget) {
                Ok(parsed) => Some(parsed),
                Err(ReadFailure::InvalidDocument) => None,
                Err(error) => return Err(error),
            }
        }
        DocumentRead::Missing => None,
        DocumentRead::Skipped(error) => return Err(ReadFailure::Io(*error)),
    };
    let mut root = reads.resolve_stl_root(
        &OwnedStlReadRequest {
            tenant: captured.tenant.clone(),
            source_id: source.source_id,
            path: Some(path.into()),
            purpose: StlPurpose::CheckoutOptions,
        },
        budget,
    )?;
    if root.logical_resolved_path().is_none() {
        return Ok(None);
    }
    let inventory = root.scan_stls(budget)?;
    let rules = import_rules(source.imported_paths.as_deref());
    let mut paths: Vec<_> = inventory
        .entries()
        .iter()
        .map(|entry| entry.physical_relative_path.replace('\\', "/"))
        .filter(|path| imported(path, &rules))
        .collect();
    paths.sort_by(|left, right| {
        crate::read_model::views::folder_compare(&left.to_lowercase(), &right.to_lowercase())
    });
    for path in &paths {
        stamp_text(&mut hasher, path);
    }
    let (exists, yaml, declared, defaults) = if let Some(parsed) = parsed {
        let yaml = match manifest_read {
            DocumentRead::Bytes(bytes) => String::from_utf8(bytes).ok(),
            DocumentRead::Missing => None,
            DocumentRead::Skipped(error) => return Err(ReadFailure::Io(error)),
        };
        if let Some(yaml) = yaml {
            let defaults = parsed
                .selections
                .into_iter()
                .map(|(group, values)| {
                    let scalar = parsed
                        .selection_shapes
                        .iter()
                        .find(|(candidate, _)| candidate == &group)
                        .is_some_and(|(_, scalar)| *scalar);
                    (group, values, scalar)
                })
                .collect();
            (true, yaml, parsed.groups, defaults)
        } else {
            (false, fallback_yaml(&source.name), Vec::new(), Vec::new())
        }
    } else {
        (false, fallback_yaml(&source.name), Vec::new(), Vec::new())
    };
    let groups = if declared.is_empty() {
        inferred_groups(&paths, reads, budget, &mut hasher)?
    } else {
        declared.clone()
    };
    let row = ManifestSource {
        source_id: source.source_id,
        layer_type: source.layer_type.clone(),
        name: source.name.clone(),
        role: source.role.clone(),
        url: source.url.clone(),
        exists,
        path: "print-partner.manifest.yaml",
        yaml,
        document: ManifestDocument {
            format: "print-partner-manifest-v2",
            version: 2,
            project: source.name.clone(),
            option_groups: groups_to_model(declared, &BTreeMap::new()),
        },
        scanned_parts: paths
            .iter()
            .map(|path| ManifestPart {
                match_key: path.clone(),
                relative_path: path.clone(),
            })
            .collect(),
    };
    Ok(Some(SourceObservation {
        row,
        groups,
        defaults,
        paths,
        stamp: SourceObservationStamp(hasher.finalize().into()),
    }))
}

fn inferred_groups(
    paths: &[String],
    reads: &dyn DraftReads,
    budget: &mut PreparationBudget<'_>,
    hasher: &mut Sha256,
) -> std::result::Result<Groups, ReadFailure> {
    let mut hint_rules = Vec::new();
    for purpose in [
        CatalogPurpose::ShippedHintsFirst,
        CatalogPurpose::ShippedHintsSecond,
    ] {
        let read = reads.read_catalog_document(&OwnedCatalogReadRequest { purpose }, budget)?;
        stamp_document(hasher, &read);
        if let DocumentRead::Bytes(bytes) = read {
            match draft_observation::parse_builder_hints(&bytes, budget) {
                Ok(rules) => {
                    hint_rules = rules;
                    break;
                }
                Err(ReadFailure::InvalidDocument) => {}
                Err(error) => return Err(error),
            }
        }
    }
    let custom = reads.read_catalog_document(
        &OwnedCatalogReadRequest {
            purpose: CatalogPurpose::CustomHints,
        },
        budget,
    )?;
    stamp_document(hasher, &custom);
    match custom {
        DocumentRead::Missing => {}
        DocumentRead::Skipped(error) => return Err(ReadFailure::Io(error)),
        DocumentRead::Bytes(bytes) => {
            hint_rules.extend(draft_observation::parse_builder_hints(&bytes, budget)?)
        }
    }
    let mut groups = Groups::new();
    for (path, group, id, label) in hint_rules {
        if paths
            .iter()
            .any(|candidate| draft_observation::builder_path_matches(&path, candidate))
        {
            draft_observation::merge_builder_groups(
                &mut groups,
                vec![(
                    group.clone(),
                    Group {
                        rule: "pick_one".into(),
                        label: Some(label.clone().unwrap_or_else(|| group.0.identifier_label())),
                        parts: Vec::new(),
                        variants: vec![draft_observation::BuilderVariant {
                            id: id.clone(),
                            label: Some(label.unwrap_or_else(|| id.0.identifier_label())),
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
    draft_observation::merge_builder_groups(
        &mut groups,
        draft_observation::infer_builder_siblings(paths),
    );
    Ok(groups)
}

fn groups_to_model(
    groups: Groups,
    annotations: &BTreeMap<
        (
            crate::manifest_text::OptionGroupId,
            crate::manifest_text::VariantId,
        ),
        Vec<ManifestVariantSource>,
    >,
) -> BTreeMap<crate::manifest_text::OptionGroupId, ManifestOptionGroup> {
    groups
        .into_iter()
        .map(|(id, group)| {
            let variants = group
                .variants
                .into_iter()
                .map(|variant| {
                    let sources = annotations
                        .get(&(id.clone(), variant.id.clone()))
                        .cloned()
                        .unwrap_or_default();
                    ManifestVariant {
                        id: variant.id,
                        label: variant.label,
                        parts: variant.parts,
                        excludes: variant.excludes,
                        source_id: sources.first().map(|source| source.source_id),
                        source_name: sources.first().map(|source| source.source_name.clone()),
                        sources: (sources.len() > 1).then_some(sources),
                    }
                })
                .collect();
            (
                id,
                ManifestOptionGroup {
                    rule: group.rule,
                    label: group.label,
                    parts: group.parts,
                    min: group.min,
                    max: group.max,
                    variants,
                },
            )
        })
        .collect()
}

pub(super) fn validate_known_selections(
    kit: &KitManifest,
    builder: &ManifestBuilder,
) -> std::result::Result<(), super::ManifestInputDetail> {
    for (group_id, selection_count) in kit.selection_entries() {
        let Some(group) = builder
            .merged_option_groups
            .get(&crate::manifest_text::OptionGroupId(group_id.clone()))
        else {
            continue;
        };
        if group.rule == "pick_one" && selection_count == 0 {
            return Err(super::ManifestInputDetail::group(
                group_id,
                " must contain at least one variant id",
            ));
        }
        let maximum = if group.rule == "pick_one" {
            Some(group.max.unwrap_or(1).min(1))
        } else {
            group.max
        };
        if let Some(maximum) = maximum
            && selection_count as u64 > maximum
        {
            let unit = if maximum == 1 {
                "variant id"
            } else {
                "variant ids"
            };
            return Err(super::ManifestInputDetail::group(
                group_id,
                &format!(" must contain no more than {maximum} {unit}"),
            ));
        }
    }
    Ok(())
}

fn import_rules(raw: Option<&str>) -> Option<Vec<String>> {
    let raw = raw?;
    let parsed: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    Some(
        parsed
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter(|rule| !rule.trim().is_empty())
            .map(|rule| {
                let mut normalized = rule
                    .replace('\\', "/")
                    .trim()
                    .trim_start_matches('/')
                    .to_owned();
                if !normalized.is_empty()
                    && !normalized.ends_with('/')
                    && !normalized.to_lowercase().ends_with(".stl")
                {
                    normalized.push('/');
                }
                normalized
            })
            .collect(),
    )
}

fn imported(path: &str, rules: &Option<Vec<String>>) -> bool {
    let Some(rules) = rules else { return true };
    let normalized = path
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_owned();
    rules.iter().any(|rule| {
        if rule.ends_with('/') {
            let rule = rule.trim_end_matches('/');
            normalized == rule || normalized.starts_with(&format!("{rule}/"))
        } else {
            normalized == *rule
        }
    })
}

fn stamp_document(hasher: &mut Sha256, document: &DocumentRead) {
    match document {
        DocumentRead::Missing => hasher.update([0]),
        DocumentRead::Skipped(error) => {
            hasher.update([1]);
            stamp_text(hasher, &format!("{error:?}"));
        }
        DocumentRead::Bytes(bytes) => {
            hasher.update([2]);
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
    }
}

fn stamp_text(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn fallback_yaml(project: &str) -> String {
    format!("format: print-partner-manifest-v2\nversion: 2\nproject: {project}\n")
}
