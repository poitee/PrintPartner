use super::*;
use sha2::{Digest, Sha256};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamingProfile {
    pub roles: Vec<Role>,
    pub quantity: Quantity,
    pub slug: Slug,
    pub folder_rules: Vec<FolderRule>,
    pub export_role_order: Vec<RoleId>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleId {
    Primary,
    Accent,
    Clear,
    Opaque,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Role {
    pub id: RoleId,
    pub label: String,
    pub markers: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Quantity {
    pub regex: String,
    pub default: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Slug {
    pub strip_markers: bool,
    pub strip_quantity: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderRule {
    pub path_contains: String,
    pub role_id: RoleId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub functional_class: Option<FunctionalClass>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FunctionalClass {
    Functional,
    Cosmetic,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NamingCommand {
    UseDefaults,
    Override { profile: NamingProfile },
}
impl Default for NamingProfile {
    fn default() -> Self {
        serde_json::from_value(json!({"roles":[{"id":"primary","label":"Primary","markers":[]},{"id":"accent","label":"Accent","markers":["[a]"]},{"id":"clear","label":"Clear","markers":["[c]"]},{"id":"opaque","label":"Opaque","markers":["[o]"]}],"quantity":{"regex":"[ _]x([0-9]+)\\.stl$","default":1},"slug":{"strip_markers":true,"strip_quantity":true},"folder_rules":[],"export_role_order":["primary","accent","clear","opaque"]})).expect("default naming")
    }
}
impl NamingProfile {
    pub(super) fn validate(mut self) -> Result<Self> {
        ensure!(
            !self.roles.is_empty() && self.roles.iter().any(|r| r.id == RoleId::Primary),
            CatalogFailure::Input("Naming requires primary role".into())
        );
        let mut seen = Vec::new();
        for r in &mut self.roles {
            ensure!(
                !seen.contains(&r.id),
                CatalogFailure::Input("Duplicate naming role".into())
            );
            seen.push(r.id);
            r.label = trim(&r.label).into();
            ensure!(
                !r.label.is_empty(),
                CatalogFailure::Input("Blank naming label".into())
            );
        }
        ensure!(
            self.export_role_order.len() == 4,
            CatalogFailure::Input("Invalid export role order".into())
        );
        let mut seen = Vec::new();
        for id in &self.export_role_order {
            ensure!(
                !seen.contains(id),
                CatalogFailure::Input("Duplicate export role".into())
            );
            seen.push(*id);
        }
        self.quantity.regex = trim(&self.quantity.regex).into();
        ensure!(
            self.quantity.default > 0 && self.quantity.default <= 9_007_199_254_740_991,
            CatalogFailure::Input("Invalid quantity default".into())
        );
        validate_regex_structure(&self.quantity.regex)?;
        regress::Regex::with_flags(&self.quantity.regex, "i")
            .map_err(|_| anyhow!(CatalogFailure::Input("Invalid quantity regex".into())))?;
        let regex = regress::Regex::new(&format!("(?:{})|", self.quantity.regex))
            .map_err(|_| anyhow!(CatalogFailure::Input("Invalid quantity regex".into())))?;
        ensure!(
            regex.find("").is_some_and(|m| m.captures.len() == 1),
            CatalogFailure::Input("Quantity regex must have one capture group".into())
        );
        for r in &mut self.folder_rules {
            r.path_contains = trim(&r.path_contains).into();
            ensure!(
                !r.path_contains.is_empty(),
                CatalogFailure::Input("Blank folder rule".into())
            );
        }
        Ok(self)
    }
}
fn validate_regex_structure(pattern: &str) -> Result<()> {
    const MAX_GROUP_DEPTH: usize = 16;
    const MAX_GROUPS: usize = 64;
    ensure!(
        pattern.len() <= 4096,
        CatalogFailure::Input("Quantity regex too long".into())
    );
    let mut escaped = false;
    let mut in_class = false;
    let mut depth = 0usize;
    let mut groups = 0usize;
    for byte in pattern.bytes() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if in_class {
            if byte == b']' {
                in_class = false;
            }
            continue;
        }
        match byte {
            b'[' => in_class = true,
            b'(' => {
                depth += 1;
                groups += 1;
                ensure!(
                    depth <= MAX_GROUP_DEPTH && groups <= MAX_GROUPS,
                    CatalogFailure::Input("Quantity regex exceeds group complexity limits".into())
                );
            }
            b')' => {
                ensure!(
                    depth > 0,
                    CatalogFailure::Input("Invalid quantity regex groups".into())
                );
                depth -= 1;
            }
            _ => {}
        }
    }
    ensure!(
        !escaped && !in_class && depth == 0,
        CatalogFailure::Input("Invalid quantity regex structure".into())
    );
    Ok(())
}

pub(super) fn uses_defaults(m: &Map<String, Value>) -> bool {
    m.get("naming")
        .and_then(Value::as_object)
        .and_then(|n| n.get("use_defaults"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}
pub(super) fn global(tx: &Transaction<'_>, tenant: &str) -> Result<NamingProfile> {
    Ok(get_setting(tx, tenant, "stl_naming_defaults")?
        .and_then(|s| serde_json::from_str::<NamingProfile>(&s).ok())
        .and_then(|p| p.validate().ok())
        .unwrap_or_default())
}
fn response(profile: NamingProfile, use_defaults: bool, override_value: Value) -> Result<Value> {
    #[derive(Serialize)]
    struct Canonical<'a> {
        version: u8,
        roles: &'a [Role],
        quantity: &'a Quantity,
        slug: &'a Slug,
        folder_rules: Vec<CanonicalFolder<'a>>,
        export_role_order: &'a [RoleId],
    }
    #[derive(Serialize)]
    struct CanonicalFolder<'a> {
        path_contains: &'a str,
        role_id: RoleId,
        functional_class: &'a Option<FunctionalClass>,
    }
    let canonical = Canonical {
        version: 1,
        roles: &profile.roles,
        quantity: &profile.quantity,
        slug: &profile.slug,
        folder_rules: profile
            .folder_rules
            .iter()
            .map(|f| CanonicalFolder {
                path_contains: &f.path_contains,
                role_id: f.role_id,
                functional_class: &f.functional_class,
            })
            .collect(),
        export_role_order: &profile.export_role_order,
    };
    let digest = hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?));
    Ok(
        json!({"use_defaults":use_defaults,"override":override_value,"effective":profile,"effective_digest":digest}),
    )
}
pub(crate) fn get(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<Value> {
    let source = require(tx, tenant, id)?;
    let m = source.metadata.unwrap_or_default();
    let global = global(tx, tenant)?;
    project(m, global).map_err(|e| e.context(CatalogFailure::InvalidStoredNaming))
}
fn project(m: Map<String, Value>, global: NamingProfile) -> Result<Value> {
    let Some(naming) = m.get("naming") else {
        return response(global, true, json!({}));
    };
    let Some(naming) = naming.as_object() else {
        return response(global, true, json!({}));
    };
    let defaults = naming
        .get("use_defaults")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if defaults {
        return response(global, true, json!({}));
    }
    let override_value = naming
        .get("override")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!({}));
    if let Some(full) = serde_json::from_value::<NamingProfile>(override_value.clone())
        .ok()
        .and_then(|p| p.validate().ok())
    {
        return response(full.clone(), false, serde_json::to_value(full)?);
    }
    let mut effective = serde_json::to_value(global)?;
    let object = override_value
        .as_object()
        .ok_or_else(|| anyhow!("Invalid naming override"))?;
    for (k, v) in object {
        ensure!(
            matches!(
                k.as_str(),
                "roles" | "quantity" | "slug" | "folder_rules" | "export_role_order"
            ),
            "Unknown naming field"
        );
        if k == "roles" {
            let roles = v.as_array().ok_or_else(|| anyhow!("Invalid roles"))?;
            let base = effective["roles"].as_array_mut().unwrap();
            let mut seen = Vec::new();
            ensure!(!roles.is_empty(), "Empty roles override");
            for r in roles {
                let id = r.get("id").ok_or_else(|| anyhow!("Missing role id"))?;
                ensure!(!seen.contains(id), "Duplicate role override");
                seen.push(id.clone());
                serde_json::from_value::<RoleId>(id.clone())?;
                if !base.iter().any(|b| b.get("id") == Some(id)) {
                    base.push(json!({"id":id,"label":id,"markers":[]}));
                }
                let target = base.iter_mut().find(|b| b.get("id") == Some(id)).unwrap();
                target.as_object_mut().unwrap().extend(
                    r.as_object()
                        .ok_or_else(|| anyhow!("Invalid role"))?
                        .clone(),
                );
            }
        } else if matches!(k.as_str(), "quantity" | "slug") {
            effective[k].as_object_mut().unwrap().extend(
                v.as_object()
                    .ok_or_else(|| anyhow!("Invalid naming fields"))?
                    .clone(),
            );
        } else {
            effective[k] = v.clone();
        }
    }
    let effective = serde_json::from_value::<NamingProfile>(effective)?.validate()?;
    let normalized = serde_json::to_value(&effective)?;
    let mut override_value = override_value;
    for (key, value) in override_value.as_object_mut().unwrap() {
        if key == "roles" {
            for r in value.as_array_mut().unwrap() {
                let id = r["id"].clone();
                let full = normalized["roles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["id"] == id)
                    .unwrap();
                for (k, v) in r.as_object_mut().unwrap() {
                    *v = full[k].clone();
                }
            }
        } else if matches!(key.as_str(), "quantity" | "slug") {
            for (k, v) in value.as_object_mut().unwrap() {
                *v = normalized[key][k].clone();
            }
        } else {
            *value = normalized[key].clone();
        }
    }
    response(effective, false, override_value)
}
pub(super) fn save(
    tx: &Transaction<'_>,
    tenant: &str,
    id: i64,
    command: NamingCommand,
) -> Result<Value> {
    let mut m = require(tx, tenant, id)?.metadata.unwrap_or_default();
    let naming = match command {
        NamingCommand::UseDefaults => json!({"use_defaults":true,"override":{}}),
        NamingCommand::Override { profile } => {
            json!({"use_defaults":false,"override":profile.validate()?})
        }
    };
    m.insert("naming".into(), naming);
    save_metadata(tx, tenant, id, m)?;
    get(tx, tenant, id)
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamingOverride {
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub roles: Option<Vec<RoleOverride>>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub quantity: Option<QuantityOverride>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub slug: Option<SlugOverride>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub folder_rules: Option<Vec<FolderRule>>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub export_role_order: Option<Vec<RoleId>>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleOverride {
    pub id: RoleId,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub markers: Option<Vec<String>>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuantityOverride {
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub regex: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub default: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlugOverride {
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub strip_markers: Option<bool>,
    #[serde(
        default,
        deserialize_with = "optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub strip_quantity: Option<bool>,
}
#[derive(Debug, Serialize)]
pub struct NamingPreview {
    pub role: RoleId,
    pub quantity: Option<serde_json::Number>,
    pub part_slug: String,
    pub filename: String,
}
fn merge(mut base: NamingProfile, overrides: NamingOverride) -> Result<NamingProfile> {
    if let Some(roles) = overrides.roles {
        ensure!(
            !roles.is_empty(),
            CatalogFailure::Input("Empty roles override".into())
        );
        let mut seen = Vec::new();
        for role in roles {
            ensure!(
                !seen.contains(&role.id),
                CatalogFailure::Input("Duplicate role override".into())
            );
            seen.push(role.id);
            let position = base.roles.iter().position(|r| r.id == role.id);
            let target = if let Some(i) = position {
                &mut base.roles[i]
            } else {
                let label = serde_json::to_value(role.id)?
                    .as_str()
                    .expect("role string")
                    .to_owned();
                base.roles.push(Role {
                    id: role.id,
                    label,
                    markers: vec![],
                });
                base.roles.last_mut().unwrap()
            };
            if let Some(label) = role.label {
                target.label = label
            }
            if let Some(markers) = role.markers {
                target.markers = markers
            }
        }
    }
    if let Some(q) = overrides.quantity {
        if let Some(r) = q.regex {
            base.quantity.regex = r
        }
        if let Some(d) = q.default {
            base.quantity.default = d
        }
    }
    if let Some(s) = overrides.slug {
        if let Some(v) = s.strip_markers {
            base.slug.strip_markers = v
        }
        if let Some(v) = s.strip_quantity {
            base.slug.strip_quantity = v
        }
    }
    if let Some(r) = overrides.folder_rules {
        base.folder_rules = r
    }
    if let Some(r) = overrides.export_role_order {
        base.export_role_order = r
    }
    base.validate()
}
fn escape_regex(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            out.push('\\')
        }
        out.push(ch)
    }
    out
}
fn replace_first(text: &str, pattern: &str, replacement: &str) -> String {
    if let Ok(regex) = regress::Regex::with_flags(pattern, "i")
        && let Some(m) = regex.find(text)
    {
        let mut result = text.to_owned();
        result.replace_range(m.range(), replacement);
        return result;
    }
    text.to_owned()
}
fn quantity_strip(pattern: &str) -> Option<regress::Regex> {
    let mut pattern = pattern.replace("(?:", "(");
    let named = regress::Regex::new(r"\(\?P<\w+>").expect("named prefix");
    while let Some(m) = named.find(&pattern) {
        pattern.replace_range(m.range(), "(");
    }
    pattern = replace_first(&pattern, r"\([^?][^)]*\)", "[0-9]+");
    pattern = pattern.replacen(r"\.stl$", "$", 1);
    pattern = replace_first(&pattern, r".stl$", "$");
    regress::Regex::with_flags(&pattern, "i").ok()
}
fn parse_integer(text: &str) -> f64 {
    let text = trim(text);
    let mut end = 0;
    for (i, b) in text.bytes().enumerate() {
        if b.is_ascii_digit() || (i == 0 && matches!(b, b'+' | b'-')) {
            end = i + 1
        } else {
            break;
        }
    }
    text[..end].parse::<f64>().unwrap_or(f64::NAN)
}
pub(super) fn preview(
    tx: &Transaction<'_>,
    tenant: &str,
    relative_path: String,
    overrides: Option<NamingOverride>,
) -> Result<NamingPreview> {
    let global = global(tx, tenant)?;
    let profile = match overrides {
        Some(p) => merge(global, p)?,
        None => global,
    };
    let path = relative_path.replace('\\', "/");
    let filename = path.rsplit('/').next().unwrap_or("").to_owned();
    let mut markers = profile
        .roles
        .iter()
        .flat_map(|r| {
            r.markers
                .iter()
                .filter(|m| !trim(m).is_empty())
                .map(move |m| (m, r.id))
        })
        .collect::<Vec<_>>();
    markers.sort_by_key(|(marker, _)| std::cmp::Reverse(marker.encode_utf16().count()));
    let role = profile
        .folder_rules
        .iter()
        .find(|r| {
            path.to_lowercase()
                .contains(&r.path_contains.to_lowercase())
        })
        .map(|r| r.role_id)
        .or_else(|| {
            path.split('/').find_map(|segment| {
                markers
                    .iter()
                    .find(|(m, _)| segment.to_lowercase().contains(&m.to_lowercase()))
                    .map(|(_, role)| *role)
            })
        })
        .unwrap_or(RoleId::Primary);
    let quantity_re =
        regress::Regex::with_flags(&profile.quantity.regex, "i").expect("validated quantity regex");
    let captured = quantity_re
        .find(&filename)
        .and_then(|m| m.captures.first().cloned().flatten())
        .map(|r| &filename[r])
        .filter(|s| !s.is_empty());
    let quantity = captured
        .map(parse_integer)
        .unwrap_or(profile.quantity.default as f64);
    let quantity = if quantity.is_nan() {
        None
    } else {
        serde_json::Number::from_f64(quantity.max(1.0))
    };
    let name = if filename.to_lowercase().ends_with(".stl") {
        &filename[..filename.len() - 4]
    } else {
        &filename
    };
    let mut slug = name.to_owned();
    if profile.slug.strip_markers {
        for marker in profile
            .roles
            .iter()
            .flat_map(|r| &r.markers)
            .filter(|m| !trim(m).is_empty())
        {
            slug = replace_first(&slug, &format!("^{}", escape_regex(marker)), "")
        }
    }
    if profile.slug.strip_quantity
        && let Some(regex) = quantity_strip(&profile.quantity.regex)
        && let Some(m) = regex.find(&slug)
    {
        slug.replace_range(m.range(), "");
    }
    if slug.is_empty() {
        slug = name.to_owned()
    }
    Ok(NamingPreview {
        role,
        quantity,
        part_slug: slug,
        filename,
    })
}

fn optional_non_null<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
