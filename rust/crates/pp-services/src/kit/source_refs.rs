//! Source references in a kit bundle, ported from
//! `web/apps/server/src/services/kit-bundle-share.ts`. A reference names a
//! source by URL and name only: bundles never carry model files.

use std::collections::HashMap;
use std::fmt;

use serde_json::{Map, Value, json};

use super::js;

/// A `projects` row as the kit export reads it (`KitBundleProjectRow`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KitSourceProject {
    pub name: String,
    pub url: String,
    pub branch: Option<String>,
    pub tag: Option<String>,
    pub source_kind: Option<String>,
    pub source_type: Option<String>,
    pub role: Option<String>,
    pub imported_paths: Option<String>,
    pub metadata_json: Option<String>,
    pub manifest_community_slug: Option<String>,
}

/// `KitBundleSourceRef`. `tag` may be `Some("")` when it came from a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KitSourceRef {
    pub name: String,
    pub url: String,
    pub branch: String,
    pub tag: Option<String>,
    pub source_kind: String,
    pub source_type: String,
    pub role: String,
    pub category: String,
    pub import_rules: Vec<String>,
    pub manifest_community_slug: Option<String>,
    /// The layer slot (`base` or `addon`) the source filled, when known.
    pub layer_type: Option<String>,
}

/// Why a bundle's source references could not be read. Node threw these from
/// `collectKitBundleSourceRefs`, and the import route returned the message
/// as a 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceRefError {
    /// `INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL`.
    InvalidCommunityManifestSlug,
    /// `sources` or `layers` is a number, boolean or object, or a layer is
    /// `null`. Node threw a V8 `TypeError` whose text names its own source
    /// expression; this names the field instead.
    Malformed(&'static str),
}

pub const INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL: &str = "manifest_community_slug must be 1 to 64 lowercase letters, digits, dots, hyphens or underscores, starting with a letter or digit, and not kit-catalog or registry-index";

impl fmt::Display for SourceRefError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCommunityManifestSlug => {
                f.write_str(INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL)
            }
            Self::Malformed(field) => write!(f, "kit bundle {field} is malformed"),
        }
    }
}

impl std::error::Error for SourceRefError {}

/// `isCommunityManifestSlug`.
pub fn is_community_manifest_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    let body = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(b);
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(body)
        && value != "kit-catalog"
        && value != "registry-index"
}

/// `parseCommunityManifestSlug`: trimmed slug, or `None` when absent or blank.
fn parse_community_manifest_slug(value: Option<&Value>) -> Result<Option<String>, SourceRefError> {
    let slug = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => js::trim(s),
        Some(_) => return Err(SourceRefError::InvalidCommunityManifestSlug),
    };
    if slug.is_empty() {
        return Ok(None);
    }
    if !is_community_manifest_slug(slug) {
        return Err(SourceRefError::InvalidCommunityManifestSlug);
    }
    Ok(Some(slug.to_owned()))
}

/// `normalizeRule` from `@print-partner/domain` import rules.
fn normalize_rule(rule: &str) -> String {
    let replaced = rule.replace('\\', "/");
    let r = js::trim(&replaced).trim_start_matches('/');
    if r.is_empty() || r.ends_with('/') || r.to_lowercase().ends_with(".stl") {
        r.to_owned()
    } else {
        format!("{r}/")
    }
}

/// `importRulesForProject` (`parseImportRulesJson`).
fn import_rules_for_project(raw: Option<&str>) -> Option<Vec<String>> {
    let trimmed = js::trim(raw?);
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(trimmed) else {
        return Some(Vec::new());
    };
    Some(
        items
            .iter()
            .filter_map(Value::as_str)
            .filter(|item| !js::trim(item).is_empty())
            .map(normalize_rule)
            .collect(),
    )
}

/// `resolveSourceCategory`. `metadata.category` wins when the key is present,
/// even as null; otherwise the legacy role maps to a category.
fn resolve_source_category(metadata_json: Option<&str>, role: Option<&str>) -> Option<String> {
    let metadata = metadata_json.filter(|raw| !raw.is_empty()).and_then(|raw| {
        match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        }
    });
    if let Some(category) = metadata.as_ref().and_then(|map| map.get("category")) {
        return category
            .as_str()
            .map(js::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
    }
    match js::trim(role.unwrap_or("unassigned"))
        .to_lowercase()
        .as_str()
    {
        "base" => Some("Printer kits".to_owned()),
        "addon" => Some("Mods".to_owned()),
        _ => None,
    }
}

impl KitSourceRef {
    /// `kitSourceRefFromProject`.
    pub fn from_project(project: &KitSourceProject) -> Self {
        Self {
            name: project.name.clone(),
            url: project.url.clone(),
            branch: project.branch.clone().unwrap_or_else(|| "main".to_owned()),
            tag: project.tag.clone(),
            source_kind: project
                .source_kind
                .clone()
                .unwrap_or_else(|| "github".to_owned()),
            source_type: project
                .source_type
                .clone()
                .unwrap_or_else(|| "git".to_owned()),
            role: project
                .role
                .clone()
                .unwrap_or_else(|| "unassigned".to_owned()),
            category: resolve_source_category(
                project.metadata_json.as_deref(),
                project.role.as_deref(),
            )
            .unwrap_or_else(|| "unassigned".to_owned()),
            import_rules: import_rules_for_project(project.imported_paths.as_deref())
                .unwrap_or_default(),
            manifest_community_slug: project.manifest_community_slug.clone(),
            layer_type: None,
        }
    }

    /// `kitSourceRefFromRecord`: `None` when the record has neither a name
    /// nor a URL.
    pub fn from_record(raw: &Map<String, Value>) -> Result<Option<Self>, SourceRefError> {
        let text = |key: &str, default: &str| match raw.get(key) {
            None | Some(Value::Null) => default.to_owned(),
            Some(value) => js::trim(&js::to_string(value)).to_owned(),
        };
        let or = |value: String, default: &str| {
            if value.is_empty() {
                default.to_owned()
            } else {
                value
            }
        };
        let name = text("name", "");
        let url = text("url", "");
        if name.is_empty() && url.is_empty() {
            return Ok(None);
        }
        let raw_role = or(text("role", "unassigned"), "unassigned");
        let role_key = raw_role.to_lowercase();
        let role = if ["base", "addon", "unassigned"].contains(&role_key.as_str()) {
            role_key
        } else {
            "unassigned".to_owned()
        };
        let category_default = if role == "unassigned" {
            raw_role.as_str()
        } else {
            "unassigned"
        };
        let category = or(text("category", category_default), "unassigned");
        let manifest_community_slug =
            parse_community_manifest_slug(raw.get("manifest_community_slug"))?;
        let tag = match raw.get("tag") {
            Some(Value::String(tag)) if !js::trim(tag).is_empty() => Some(js::trim(tag).to_owned()),
            _ => None,
        };
        let import_rules = match raw.get("import_rules") {
            Some(Value::Array(rules)) => rules
                .iter()
                .map(js::to_string)
                .filter(|rule| !rule.is_empty())
                .collect(),
            _ => Vec::new(),
        };
        Ok(Some(Self {
            name,
            url,
            branch: or(text("branch", "main"), "main"),
            tag,
            source_kind: or(text("source_kind", "github"), "github"),
            source_type: or(text("source_type", "git"), "git"),
            role,
            category,
            import_rules,
            manifest_community_slug,
            layer_type: None,
        }))
    }

    /// `kitSourceRefToExportRecord` (also `kitLayerProjectExportRecord`).
    /// `layer_type` is left out.
    pub fn to_export_record(&self) -> Value {
        let mut out = json!({
            "name": self.name,
            "url": self.url,
            "branch": self.branch,
            "source_kind": self.source_kind,
            "source_type": self.source_type,
            "role": self.role,
            "category": self.category,
            "import_rules": self.import_rules,
        });
        if let Some(tag) = self.tag.as_deref().filter(|tag| !tag.is_empty()) {
            out["tag"] = json!(tag);
        }
        let slug = self
            .manifest_community_slug
            .as_deref()
            .map(js::trim)
            .unwrap_or("");
        if is_community_manifest_slug(slug) {
            out["manifest_community_slug"] = json!(slug);
        }
        out
    }

    /// `kitUnmatchedSourceFromRef`: a source the importer found no project for.
    pub fn to_unmatched(&self) -> Value {
        let mut out = json!({
            "name": self.name,
            "url": self.url,
            "branch": self.branch,
            "tag": self.tag,
            "source_kind": self.source_kind,
            "role": self.role,
            "category": self.category,
            "import_rules": self.import_rules,
            "layer_type": self.layer_type.as_deref().unwrap_or("addon"),
        });
        if let Some(slug) = self
            .manifest_community_slug
            .as_deref()
            .filter(|slug| !slug.is_empty())
        {
            out["manifest_community_slug"] = json!(slug);
        }
        out
    }

    /// `kitMatchedSourcePatch`: the fields the importer writes onto a project
    /// it matched. Empty and `unassigned` values are left out.
    pub fn matched_patch(&self) -> Value {
        let mut out = Map::new();
        if !self.branch.is_empty() {
            out.insert("branch".into(), json!(self.branch));
        }
        if let Some(tag) = self.tag.as_deref().filter(|tag| !tag.is_empty()) {
            out.insert("tag".into(), json!(tag));
        }
        if !self.source_kind.is_empty() {
            out.insert("source_kind".into(), json!(self.source_kind));
        }
        if !self.role.is_empty() && self.role != "unassigned" {
            out.insert("role".into(), json!(self.role));
        }
        if !self.category.is_empty() && self.category != "unassigned" {
            out.insert("metadata".into(), json!({ "category": self.category }));
        }
        if let Some(slug) = self
            .manifest_community_slug
            .as_deref()
            .filter(|slug| !slug.is_empty())
        {
            out.insert("manifest_community_slug".into(), json!(slug));
        }
        Value::Object(out)
    }

    fn key(&self) -> String {
        let url = js::trim(&self.url).to_lowercase();
        if !url.is_empty() {
            return format!("url:{url}");
        }
        let name = js::trim(&self.name).to_lowercase();
        if name.is_empty() {
            String::new()
        } else {
            format!("name:{name}")
        }
    }

    /// `mergeSourceRefs`: the first reference wins field by field, empty
    /// fields fall back to the second, and import rules are unioned.
    fn merge(self, incoming: Self) -> Self {
        let pick = |a: String, b: String| if a.is_empty() { b } else { a };
        let mut import_rules = self.import_rules;
        for rule in incoming.import_rules {
            if !import_rules.contains(&rule) {
                import_rules.push(rule);
            }
        }
        let base = |layer: &Option<String>| layer.as_deref() == Some("base");
        let layer_type = if base(&self.layer_type) || base(&incoming.layer_type) {
            Some("base".to_owned())
        } else {
            self.layer_type.or(incoming.layer_type)
        };
        Self {
            name: pick(self.name, incoming.name),
            url: pick(self.url, incoming.url),
            branch: pick(self.branch, incoming.branch),
            tag: self.tag.filter(|tag| !tag.is_empty()).or(incoming.tag),
            source_kind: pick(self.source_kind, incoming.source_kind),
            source_type: pick(self.source_type, incoming.source_type),
            role: if self.role != "unassigned" {
                self.role
            } else {
                incoming.role
            },
            category: if self.category != "unassigned" {
                self.category
            } else {
                incoming.category
            },
            import_rules,
            manifest_community_slug: self
                .manifest_community_slug
                .or(incoming.manifest_community_slug),
            layer_type,
        }
    }
}

/// `collectKitBundleSourceRefs`: the bundle's `sources`, then each layer's
/// `project`, merged by URL (or name when there is no URL) in first-seen order.
pub fn collect_kit_bundle_source_refs(
    data: &Map<String, Value>,
) -> Result<Vec<KitSourceRef>, SourceRefError> {
    let mut refs: Vec<KitSourceRef> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut add =
        |raw: &Map<String, Value>, layer_type: Option<String>| -> Result<(), SourceRefError> {
            let Some(mut source) = KitSourceRef::from_record(raw)? else {
                return Ok(());
            };
            if layer_type.as_deref().is_some_and(|layer| !layer.is_empty()) {
                source.layer_type = layer_type;
            }
            let key = source.key();
            if key.is_empty() {
                return Ok(());
            }
            match by_key.get(&key) {
                Some(&index) => {
                    let existing = refs[index].clone();
                    refs[index] = existing.merge(source);
                }
                None => {
                    by_key.insert(key, refs.len());
                    refs.push(source);
                }
            }
            Ok(())
        };

    for entry in iterate(data.get("sources"), "sources")? {
        if let Value::Object(raw) = entry {
            add(raw, None)?;
        }
    }
    for layer in iterate(data.get("layers"), "layers")? {
        let layer = match layer {
            Value::Null => return Err(SourceRefError::Malformed("layer")),
            Value::Object(layer) => layer,
            _ => continue,
        };
        if let Some(Value::Object(project)) = layer.get("project") {
            let layer_type = match layer.get("layer_type") {
                None | Some(Value::Null) => "addon".to_owned(),
                Some(value) => js::to_string(value),
            };
            add(project, Some(layer_type))?;
        }
    }
    Ok(refs)
}

/// `for (const x of value ?? [])`. A string iterates its characters, which
/// the callers skip, so it reads as empty.
fn iterate<'a>(
    value: Option<&'a Value>,
    field: &'static str,
) -> Result<&'a [Value], SourceRefError> {
    match value {
        None | Some(Value::Null) | Some(Value::String(_)) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(SourceRefError::Malformed(field)),
    }
}
