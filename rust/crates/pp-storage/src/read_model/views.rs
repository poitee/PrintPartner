use super::{AcceptedRead, Part, Provenance, Snapshot};
use crate::manifest_text::{DraftPart, JsText};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Color {
    pub id: String,
    pub display_name: String,
    pub product_line: String,
    pub hex: String,
}
impl Color {
    fn label(&self) -> String {
        if self.product_line.is_empty() {
            self.display_name.clone()
        } else {
            format!("{} · {}", self.product_line, self.display_name)
        }
    }
}
pub fn catalog_color(id: &str) -> Option<&'static Color> {
    static COLORS: OnceLock<Vec<Color>> = OnceLock::new();
    #[derive(Deserialize)]
    struct Catalog {
        colors: Vec<Color>,
    }
    COLORS
        .get_or_init(|| {
            serde_json::from_str::<Catalog>(include_str!("../../data/filament-catalog.json"))
                .expect("bundled filament catalog")
                .colors
        })
        .iter()
        .find(|c| c.id == id)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpoolSummary {
    pub remaining_g: f64,
    pub spool_id: i64,
}
#[derive(Clone, Debug)]
pub struct ResolvedFilament {
    pub combo_label: String,
    pub hex: Option<String>,
    pub spools: Vec<SpoolSummary>,
}
pub trait FilamentLookup {
    fn for_part(
        &self,
        color_id: Option<&str>,
        spool_id: Option<&str>,
    ) -> Result<Option<ResolvedFilament>>;
}
pub struct CatalogOnly;
impl FilamentLookup for CatalogOnly {
    fn for_part(&self, _: Option<&str>, _: Option<&str>) -> Result<Option<ResolvedFilament>> {
        Ok(None)
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaObservation {
    pub artifact_missing: bool,
    pub thumb_empty: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewObservations {
    pub available_input_roots: HashSet<i64>,
    pub media_by_part_id: HashMap<i64, MediaObservation>,
}

fn filament(
    part: &Part,
    provider: &dyn FilamentLookup,
) -> Result<(String, Option<String>, Vec<SpoolSummary>)> {
    let resolved = provider.for_part(
        part.filament_color_id.as_deref(),
        part.spoolman_spool_id.as_deref(),
    )?;
    let catalog = part.filament_color_id.as_deref().and_then(catalog_color);
    let fallback_hex = part
        .filament_custom_hex
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| catalog.map(|c| c.hex.clone()));
    Ok(match resolved {
        Some(value) => (value.combo_label, value.hex.or(fallback_hex), value.spools),
        None => (
            catalog.map(Color::label).unwrap_or_default(),
            fallback_hex,
            vec![],
        ),
    })
}
fn badge(spools: &[SpoolSummary]) -> String {
    let total = spools.iter().map(|s| s.remaining_g).sum::<f64>();
    let rounded = (total + 0.5).floor();
    if spools.len() == 1 {
        format!("~{rounded} g on spool #{}", spools[0].spool_id)
    } else {
        format!(
            "{} spools · ~{rounded} g ({})",
            spools.len(),
            spools
                .iter()
                .map(|s| format!("#{}", s.spool_id))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}
fn add_spools(row: &mut Value, spools: Vec<SpoolSummary>) -> Result<()> {
    ensure!(
        spools
            .iter()
            .all(|s| s.remaining_g.is_finite() && s.spool_id > 0),
        "Invalid filament provider response"
    );
    if !spools.is_empty() {
        row["spool_badge"] = json!(badge(&spools));
        row["spool_summary"] = serde_json::to_value(spools)?;
    }
    Ok(())
}
fn unavailable(read: &AcceptedRead) -> Option<Value> {
    match read {
        AcceptedRead::CompatibilityDirty => {
            Some(json!({"kind":"accepted_state_unavailable","reason":"compatibility_dirty"}))
        }
        AcceptedRead::Uninitialized => {
            Some(json!({"kind":"accepted_state_unavailable","reason":"uninitialized"}))
        }
        AcceptedRead::IntegrityFailure { code, message } => {
            Some(json!({"kind":"integrity_failure","code":code,"message":message}))
        }
        AcceptedRead::Missing => Some(json!({"kind":"not_found"})),
        _ => None,
    }
}
pub fn progress(profile_id: i64, read: &AcceptedRead) -> Value {
    match read {
        AcceptedRead::Ready { snapshot } => {
            let units = snapshot
                .parts
                .iter()
                .filter(|p| p.included)
                .flat_map(|p| p.units.iter())
                .collect::<Vec<_>>();
            json!({"kind":"ready","profileId":profile_id,"totalUnits":units.len(),"remainingUnits":units.iter().filter(|u|!u.completed).count()})
        }
        AcceptedRead::Empty { .. } => json!({"kind":"empty","profileId":profile_id}),
        AcceptedRead::CompatibilityDirty => {
            json!({"kind":"unavailable","profileId":profile_id,"reason":"compatibility_dirty"})
        }
        AcceptedRead::Uninitialized => {
            json!({"kind":"unavailable","profileId":profile_id,"reason":"uninitialized"})
        }
        AcceptedRead::IntegrityFailure { code, .. } => {
            json!({"kind":"integrity_failure","profileId":profile_id,"code":code})
        }
        AcceptedRead::Missing => json!({"kind":"missing","profileId":profile_id}),
    }
}
pub fn checkoff(
    profile_id: i64,
    read: &AcceptedRead,
    provider: &dyn FilamentLookup,
) -> Result<Value> {
    if let Some(value) = unavailable(read) {
        return Ok(value);
    }
    let mut rows = Vec::new();
    let (mut done, mut printed, mut total) = (0, 0, 0);
    if let AcceptedRead::Ready { snapshot } = read {
        let mut parts = snapshot
            .parts
            .iter()
            .filter(|p| p.included)
            .collect::<Vec<_>>();
        parts.sort_by(|a, b| {
            a.filename
                .as_bytes()
                .cmp(b.filename.as_bytes())
                .then(a.projection_part_id.cmp(&b.projection_part_id))
        });
        for p in parts {
            let units = p.units.iter().map(|u| u.completed).collect::<Vec<_>>();
            let count = units.iter().filter(|&&u| u).count() as i64;
            let (display, hex, spools) = filament(p, provider)?;
            let mut row = json!({"id":p.projection_part_id,"filename":p.filename,"match_key":p.part_key,"relative_path":p.relative_path,"source_layer":p.source_layer,"role":p.effective_role,"quantity_effective":p.quantity_effective,"printed_count":count,"print_units":units,"missing":count<p.quantity_effective,"filament_display":display,"filament_hex":hex});
            add_spools(&mut row, spools)?;
            rows.push(row);
            total += p.quantity_effective;
            printed += count;
            if count == p.quantity_effective {
                done += 1;
            }
        }
    }
    Ok(
        json!({"kind":if matches!(read,AcceptedRead::Empty{..}){"empty"}else{"ready"},"body":{"profile_id":profile_id,"summary":format!("{done}/{} parts fully printed · {printed}/{total} units",rows.len()),"parts":rows}}),
    )
}
pub fn assembled(part_id: i64, read: &AcceptedRead) -> Value {
    if let Some(value) = unavailable(read) {
        return value;
    }
    if let AcceptedRead::Ready { snapshot } = read
        && let Some(p) = snapshot
            .parts
            .iter()
            .find(|p| p.projection_part_id == part_id)
    {
        let units = p.units.iter().map(|u| u.assembled).collect::<Vec<_>>();
        return json!({"kind":"ready","body":{"part_id":part_id,"assembled_count":units.iter().filter(|&&u|u).count(),"assembled_units":units}});
    }
    json!({"kind":"part_not_found"})
}
fn issue(code: &str, message: String, hint: &str) -> Value {
    json!({"severity":if code=="merge_conflict"{"warning"}else{"blocker"},"code":code,"message":message,"link_hint":hint})
}
fn no_parts() -> Value {
    issue(
        "no_included_parts",
        "No parts are included in this build.".into(),
        "build",
    )
}
pub struct ProjectReviewJsonBody {
    bytes: Vec<u8>,
    summary: Option<ProjectReviewSummaryJsonBody>,
}

#[derive(Clone)]
pub struct ProjectReviewSummaryJsonBody(Vec<u8>);

impl ProjectReviewJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub fn summary_json(&self) -> Option<ProjectReviewSummaryJsonBody> {
        self.summary.clone()
    }
}

impl ProjectReviewSummaryJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

struct ReviewProjection {
    kind: &'static str,
    ordinary: Value,
    groups: Vec<(String, (String, Vec<DraftPart>))>,
}
impl ReviewProjection {
    fn body_json(&self) -> Vec<u8> {
        let object = self.ordinary.as_object().expect("review object");
        let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        keys.push("part_groups");
        let mut bytes = vec![b'{'];
        for (index, key) in keys.iter().enumerate() {
            if index > 0 {
                bytes.push(b',');
            }
            JsText::scalar(key).write_json(&mut bytes);
            bytes.push(b':');
            if *key != "part_groups" {
                bytes.extend_from_slice(
                    &serde_json::to_vec(&object[*key]).expect("scalar review field"),
                );
                continue;
            }
            bytes.push(b'[');
            for (index, (folder, (source, parts))) in self.groups.iter().enumerate() {
                if index > 0 {
                    bytes.push(b',');
                }
                bytes.extend_from_slice(b"{\"folder\":");
                bytes.extend_from_slice(&serde_json::to_vec(folder).expect("folder"));
                bytes.extend_from_slice(b",\"source_layer\":");
                bytes.extend_from_slice(&serde_json::to_vec(source).expect("source layer"));
                bytes.extend_from_slice(b",\"parts\":[");
                for (index, part) in parts.iter().enumerate() {
                    if index > 0 {
                        bytes.push(b',');
                    }
                    let mut fields = part
                        .scalar
                        .as_object()
                        .expect("review part")
                        .keys()
                        .map(String::as_str)
                        .collect::<Vec<_>>();
                    let insertion = fields
                        .iter()
                        .position(|field| *field == "included")
                        .expect("included");
                    fields.splice(insertion..insertion, ["requirement", "option_group_id"]);
                    bytes.extend_from_slice(&part.json_fields(&fields, false));
                }
                bytes.push(b']');
                bytes.push(b'}');
            }
            bytes.push(b']');
        }
        bytes.push(b'}');
        bytes
    }
}
pub fn review_json(
    read: &AcceptedRead,
    include_excluded: bool,
    observations: &ReviewObservations,
    provider: &dyn FilamentLookup,
) -> Result<ProjectReviewJsonBody> {
    if let Some(value) = unavailable(read) {
        return Ok(ProjectReviewJsonBody {
            bytes: serde_json::to_vec(&value)?,
            summary: None,
        });
    }
    let projection = match read {
        AcceptedRead::Empty { profile } => ReviewProjection {
            kind: "empty",
            ordinary: json!({"profile_id":profile.id,"accepted_basis":null,"plan_name":profile.name,"layers":[],"totals":{"included_parts":0,"total_print_units":0,"by_role":{},"by_filament":{}},"issues":[no_parts()],"has_blockers":true}),
            groups: Vec::new(),
        },
        AcceptedRead::Ready { snapshot } => {
            project_review(snapshot, include_excluded, observations, provider)?
        }
        _ => unreachable!(),
    };
    let summary = ProjectReviewSummaryJsonBody(serde_json::to_vec(&summarize_review(
        &projection.ordinary,
    )?)?);
    let mut bytes = b"{\"kind\":".to_vec();
    bytes.extend_from_slice(&serde_json::to_vec(projection.kind)?);
    bytes.extend_from_slice(b",\"body\":");
    bytes.extend_from_slice(&projection.body_json());
    bytes.push(b'}');
    Ok(ProjectReviewJsonBody {
        bytes,
        summary: Some(summary),
    })
}
fn project_review(
    s: &Snapshot,
    include_excluded: bool,
    obs: &ReviewObservations,
    provider: &dyn FilamentLookup,
) -> Result<ReviewProjection> {
    let mut issues = Vec::new();
    let mut layers = Vec::new();
    if let Provenance::Tracked { inputs, .. } = &s.provenance {
        let mut inputs = inputs.iter().collect::<Vec<_>>();
        inputs.sort_by_key(|i| (i.layer_order, i.input_id));
        for i in inputs {
            let (t, name) = i
                .source_layer
                .split_once(':')
                .unwrap_or(("source", &i.source_layer));
            let synced =
                i.tracking_kind == "revision" && obs.available_input_roots.contains(&i.input_id);
            if !synced {
                issues.push(issue(
                    "unsynced_source",
                    format!("Source \"{name}\" is not synced to a local folder."),
                    "sources",
                ));
            }
            layers.push(json!({"id":i.input_id,"layer_type":t,"project_id":i.source_id,"project_name":name,"local_path":null,"synced":synced,"last_synced_at":i.source_synced_at}));
        }
    }
    let mut role_counts = BTreeMap::<String, i64>::new();
    let mut filament_counts = BTreeMap::<String, i64>::new();
    let mut total = 0;
    let mut count = 0;
    let mut resolved = HashMap::new();
    for p in &s.parts {
        let f = filament(p, provider)?;
        if p.included {
            count += 1;
            total += p.quantity_effective;
            let role = if p.effective_role.is_empty() {
                "primary"
            } else {
                &p.effective_role
            };
            *role_counts.entry(role.into()).or_default() += 1;
            let label = if !f.0.trim().is_empty() {
                f.0.trim()
            } else {
                p.filament_color_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Unassigned")
            };
            *filament_counts.entry(label.into()).or_default() += p.quantity_effective;
        }
        resolved.insert(p.projection_part_id, f);
    }
    if count == 0 {
        issues.push(no_parts());
    }
    let mut parts = s
        .parts
        .iter()
        .filter(|p| include_excluded || p.included)
        .collect::<Vec<_>>();
    parts.sort_by(|a, b| {
        a.filename
            .as_bytes()
            .cmp(b.filename.as_bytes())
            .then(a.projection_part_id.cmp(&b.projection_part_id))
    });
    let mut grouped = BTreeMap::<String, (String, Vec<DraftPart>)>::new();
    let mut folder_order = Vec::new();
    for p in &parts {
        let media = obs.media_by_part_id.get(&p.projection_part_id);
        ensure!(
            !p.included || media.is_some(),
            "Included Part is missing accepted media observation"
        );
        let artifact_missing = media.is_some_and(|m| m.artifact_missing);
        let thumb_empty = media.is_some_and(|m| m.thumb_empty);
        if p.included && artifact_missing {
            issues.push(issue(
                "missing_stl",
                format!("STL not found on disk: {}", p.filename),
                "sources",
            ));
        }
        let (display, hex, spools) = resolved
            .remove(&p.projection_part_id)
            .expect("resolved part");
        let printed = p.units.iter().filter(|u| u.completed).count() as i64;
        let mut row = json!({"id":p.projection_part_id,"match_key":p.part_key,"relative_path":p.relative_path,"filename":p.filename,"source_layer":p.source_layer,"status":p.status,"role":p.effective_role,"included":p.included,"filament_color_id":p.filament_color_id,"filament_custom_hex":p.filament_custom_hex,"spoolman_spool_id":p.spoolman_spool_id,"filament_display":display,"filament_hex":hex,"quantity_auto":p.quantity_inferred,"quantity_override":p.quantity_override,"quantity_effective":p.quantity_effective,"printed_count":printed,"print_units":p.units.iter().map(|u|u.completed).collect::<Vec<_>>(),"assembled_units":p.units.iter().map(|u|u.assembled).collect::<Vec<_>>(),"missing":printed<p.quantity_effective,"stl_missing":artifact_missing,"thumb_empty":thumb_empty});
        add_spools(&mut row, spools)?;
        let path = if p.relative_path.is_empty() {
            &p.filename
        } else {
            &p.relative_path
        }
        .replace('\\', "/");
        let folder = path
            .rsplit_once('/')
            .map(|p| p.0)
            .filter(|f| !f.is_empty() && *f != ".")
            .unwrap_or("(root)");
        if !grouped.contains_key(folder) {
            folder_order.push(folder.to_owned());
        }
        grouped
            .entry(folder.into())
            .or_insert_with(|| (p.source_layer.clone(), Vec::new()))
            .1
            .push(DraftPart::new(row, p.manifest.clone()));
    }
    for p in parts {
        if p.included && p.status == "conflict" {
            issues.push(issue(
                "merge_conflict",
                format!(
                    "Merge conflict for {} — exclude duplicates on the Plan source cards.",
                    p.filename
                ),
                "build",
            ));
        }
    }
    let mut groups = folder_order
        .into_iter()
        .map(|folder| {
            let value = grouped.remove(&folder).expect("known folder");
            (folder, value)
        })
        .collect::<Vec<_>>();
    groups.sort_by(|a, b| match (a.0.as_str(), b.0.as_str()) {
        ("(root)", "(root)") => std::cmp::Ordering::Equal,
        ("(root)", _) => std::cmp::Ordering::Less,
        (_, "(root)") => std::cmp::Ordering::Greater,
        _ => folder_compare(&a.0, &b.0),
    });
    Ok(ReviewProjection {
        kind: "ready",
        ordinary: json!({"profile_id":s.profile.id,"accepted_basis":{"profile_id":s.profile.id,"plan_version":s.plan_version,"plan_revision_id":s.revision_id,"plan_revision_digest":s.revision_digest,"required_unit_mapping_digest":s.required_unit_mapping_digest},"plan_name":s.profile.name,"layers":layers,"totals":{"included_parts":count,"total_print_units":total,"by_role":role_counts,"by_filament":filament_counts},"has_blockers":issues.iter().any(|i|i["severity"]=="blocker"),"issues":issues}),
        groups,
    })
}
fn summarize_review(body: &Value) -> Result<Value> {
    let issues = body["issues"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Review issues missing"))?;
    let mut codes = Vec::new();
    for i in issues {
        if !codes.contains(&i["code"]) {
            codes.push(i["code"].clone());
        }
    }
    Ok(
        json!({"plan_id":body["profile_id"],"plan_name":body["plan_name"],"has_blockers":body["has_blockers"],"blocker_count":issues.iter().filter(|i|i["severity"]=="blocker").count(),"warning_count":issues.iter().filter(|i|i["severity"]=="warning").count(),"issue_codes":codes,"sample_issues":issues.iter().take(8).map(|i|json!({"severity":i["severity"],"code":i["code"],"message":i["message"]})).collect::<Vec<_>>(),"totals":body["totals"],"layers":body["layers"].as_array().ok_or_else(||anyhow::anyhow!("Review layers missing"))?.iter().map(|l|json!({"type":l["layer_type"],"source":l["project_name"],"synced":l["synced"]})).collect::<Vec<_>>()}),
    )
}

pub fn folder_compare(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: OnceLock<icu_collator::CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            icu_collator::Collator::try_new(Default::default(), Default::default())
                .expect("compiled root collation")
        })
        .compare(left, right)
}
