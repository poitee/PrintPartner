use serde::{Deserialize, Deserializer, Serialize, de};
use std::{collections::HashSet, fmt};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct WireInteger<const MIN: u64, const MAX: u64>(u64);

impl<'de, const MIN: u64, const MAX: u64> Deserialize<'de> for WireInteger<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct IntegerVisitor<const MIN: u64, const MAX: u64>;
        impl<'de, const MIN: u64, const MAX: u64> de::Visitor<'de> for IntegerVisitor<MIN, MAX> {
            type Value = WireInteger<MIN, MAX>;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                write!(formatter, "a JSON integer in {MIN}..={MAX}")
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                WireInteger::new(value).map_err(E::custom)
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                let value = u64::try_from(value).map_err(|_| E::custom("integer_bounds"))?;
                self.visit_u64(value)
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                if !value.is_finite() || value.fract() != 0.0 {
                    return Err(E::custom("integer_type"));
                }
                if value < MIN as f64 || value > MAX as f64 {
                    return Err(E::custom("integer_bounds"));
                }
                self.visit_u64(value as u64)
            }
        }
        deserializer.deserialize_any(IntegerVisitor::<MIN, MAX>)
    }
}

pub type PositiveId = WireInteger<1, MAX_SAFE_INTEGER>;
pub type Version = WireInteger<0, MAX_SAFE_INTEGER>;
pub type Quantity = WireInteger<1, 10_000>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct WireText<const MIN: usize, const MAX: usize>(String);

impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for WireText<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Digest(String);

impl<'de> Deserialize<'de> for Digest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

pub(crate) fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "PlanDraftBasisWire")]
pub struct PlanDraftBasis {
    revision_id: Option<PositiveId>,
    plan_version: Version,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanDraftBasisWire {
    #[serde(deserialize_with = "required_nullable")]
    revision_id: Option<PositiveId>,
    plan_version: Version,
}

impl TryFrom<PlanDraftBasisWire> for PlanDraftBasis {
    type Error = &'static str;
    fn try_from(value: PlanDraftBasisWire) -> Result<Self, Self::Error> {
        if value.revision_id.is_none() != (value.plan_version.0 == 0) {
            return Err("basis_inconsistent");
        }
        Ok(Self {
            revision_id: value.revision_id,
            plan_version: value.plan_version,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftState {
    Open,
    Abandoned,
    Consumed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanDraftIdentity {
    draft_id: PositiveId,
    state: DraftState,
    lifecycle_version: Version,
    snapshot_digest: Digest,
    base: PlanDraftBasis,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileTarget {
    part_key: WireText<1, 4096>,
    relative_path: WireText<1, 4096>,
    #[serde(deserialize_with = "required_nullable")]
    source_layer: Option<WireText<0, 1000>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlanChoice {
    SetIncluded {
        target: FileTarget,
        value: bool,
    },
    SetQuantityOverride {
        target: FileTarget,
        #[serde(deserialize_with = "required_nullable")]
        value: Option<Quantity>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "SavePlanChoicesRequestWire")]
pub struct SavePlanChoicesRequest {
    expected_base: PlanDraftBasis,
    expected_draft: Option<PlanDraftIdentity>,
    remap_checkoff_links: bool,
    decisions: Vec<PlanChoice>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavePlanChoicesRequestWire {
    expected_base: PlanDraftBasis,
    #[serde(deserialize_with = "required_nullable")]
    expected_draft: Option<PlanDraftIdentity>,
    remap_checkoff_links: bool,
    decisions: Vec<PlanChoice>,
}

impl TryFrom<SavePlanChoicesRequestWire> for SavePlanChoicesRequest {
    type Error = &'static str;
    fn try_from(value: SavePlanChoicesRequestWire) -> Result<Self, Self::Error> {
        if !(1..=10_000).contains(&value.decisions.len()) {
            return Err("decision_count;field=decisions");
        }
        if let Some(draft) = &value.expected_draft
            && (draft.state != DraftState::Open || draft.base != value.expected_base)
        {
            return Err("observed_draft_mismatch;field=expected_draft");
        }
        let mut fields = HashSet::new();
        for decision in &value.decisions {
            let (kind, target) = match decision {
                PlanChoice::SetIncluded { target, .. } => ("set_included", target),
                PlanChoice::SetQuantityOverride { target, .. } => ("set_quantity_override", target),
            };
            if !fields.insert((kind, target)) {
                return Err("duplicate_target_field;field=decisions");
            }
        }
        Ok(Self {
            expected_base: value.expected_base,
            expected_draft: value.expected_draft,
            remap_checkoff_links: value.remap_checkoff_links,
            decisions: value.decisions,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyPlanDraftReceipt {
    profile_id: PositiveId,
    draft_id: PositiveId,
    revision_id: PositiveId,
    plan_version: PositiveId,
    draft_lifecycle_version: PositiveId,
    revision_digest: Digest,
    required_unit_mapping_digest: Digest,
    applied_at: WireText<1, 100>,
}

#[derive(Debug, Serialize)]
pub struct BoundaryError {
    pub category: String,
    pub field: String,
    pub detail: String,
}

fn parse<T: de::DeserializeOwned>(text: &str) -> Result<T, BoundaryError> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = serde_path_to_error::deserialize(&mut deserializer).map_err(|error| {
        let detail = error.inner().to_string();
        let mut field = error.path().to_string();
        let categories = [
            "basis_inconsistent",
            "observed_draft_mismatch",
            "duplicate_target_field",
            "decision_count",
            "integer_bounds",
            "integer_type",
            "text_codepoint_bounds",
            "digest_pattern",
        ];
        let category = categories
            .into_iter()
            .find(|category| detail.starts_with(category))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if detail.contains("surrogate") || detail.contains("hex escape") {
                    "invalid_unicode_scalar_text".into()
                } else if detail.starts_with("missing field") {
                    "missing_field".into()
                } else if detail.starts_with("unknown field") {
                    "unknown_field".into()
                } else if detail.starts_with("unknown variant") {
                    "invalid_variant".into()
                } else {
                    "invalid_shape".into()
                }
            });
        if let Some((_, suffix)) = detail.split_once(";field=") {
            field = suffix
                .split_whitespace()
                .next()
                .unwrap_or(suffix)
                .to_owned();
        } else if let Some(quoted) = detail.split('`').nth(1)
            && (field == "." || field.is_empty())
        {
            field = quoted.into();
        }
        BoundaryError {
            category,
            field,
            detail,
        }
    })?;
    deserializer.end().map_err(|error| BoundaryError {
        category: "invalid_json".into(),
        field: "$".into(),
        detail: error.to_string(),
    })?;
    Ok(value)
}

pub fn parse_request(text: &str) -> Result<SavePlanChoicesRequest, BoundaryError> {
    parse(text)
}
pub fn parse_receipt(text: &str) -> Result<ApplyPlanDraftReceipt, BoundaryError> {
    parse(text)
}
pub fn parse_identity(text: &str) -> Result<PlanDraftIdentity, BoundaryError> {
    parse(text)
}

impl<const MIN: u64, const MAX: u64> WireInteger<MIN, MAX> {
    pub fn new(value: u64) -> Result<Self, &'static str> {
        if (MIN..=MAX).contains(&value) {
            Ok(Self(value))
        } else {
            Err("integer_bounds")
        }
    }
    pub fn get(self) -> u64 {
        self.0
    }
}
impl<const MIN: usize, const MAX: usize> WireText<MIN, MAX> {
    pub fn new(value: String) -> Result<Self, &'static str> {
        if (MIN..=MAX).contains(&value.chars().count()) {
            Ok(Self(value))
        } else {
            Err("text_codepoint_bounds")
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl Digest {
    pub fn new(value: String) -> Result<Self, &'static str> {
        if value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err("digest_pattern")
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl PlanDraftBasis {
    pub fn new(
        revision_id: Option<PositiveId>,
        plan_version: Version,
    ) -> Result<Self, &'static str> {
        PlanDraftBasisWire {
            revision_id,
            plan_version,
        }
        .try_into()
    }
    pub fn revision_id(&self) -> Option<PositiveId> {
        self.revision_id
    }
    pub fn plan_version(&self) -> Version {
        self.plan_version
    }
}
impl PlanDraftIdentity {
    pub fn new(
        draft_id: PositiveId,
        state: DraftState,
        lifecycle_version: Version,
        snapshot_digest: Digest,
        base: PlanDraftBasis,
    ) -> Self {
        Self {
            draft_id,
            state,
            lifecycle_version,
            snapshot_digest,
            base,
        }
    }
    pub fn draft_id(&self) -> PositiveId {
        self.draft_id
    }
    pub fn state(&self) -> &DraftState {
        &self.state
    }
    pub fn lifecycle_version(&self) -> Version {
        self.lifecycle_version
    }
    pub fn snapshot_digest(&self) -> &Digest {
        &self.snapshot_digest
    }
    pub fn base(&self) -> &PlanDraftBasis {
        &self.base
    }
}
impl FileTarget {
    pub fn new(
        part_key: WireText<1, 4096>,
        relative_path: WireText<1, 4096>,
        source_layer: Option<WireText<0, 1000>>,
    ) -> Self {
        Self {
            part_key,
            relative_path,
            source_layer,
        }
    }
    pub fn part_key(&self) -> &str {
        self.part_key.as_str()
    }
    pub fn relative_path(&self) -> &str {
        self.relative_path.as_str()
    }
    pub fn source_layer(&self) -> Option<&str> {
        self.source_layer.as_ref().map(WireText::as_str)
    }
}
impl PlanChoice {
    pub fn target(&self) -> &FileTarget {
        match self {
            Self::SetIncluded { target, .. } | Self::SetQuantityOverride { target, .. } => target,
        }
    }
}
impl SavePlanChoicesRequest {
    pub fn new(
        expected_base: PlanDraftBasis,
        expected_draft: Option<PlanDraftIdentity>,
        remap_checkoff_links: bool,
        decisions: Vec<PlanChoice>,
    ) -> Result<Self, &'static str> {
        SavePlanChoicesRequestWire {
            expected_base,
            expected_draft,
            remap_checkoff_links,
            decisions,
        }
        .try_into()
    }
    pub fn expected_base(&self) -> &PlanDraftBasis {
        &self.expected_base
    }
    pub fn expected_draft(&self) -> Option<&PlanDraftIdentity> {
        self.expected_draft.as_ref()
    }
    pub fn remap_checkoff_links(&self) -> bool {
        self.remap_checkoff_links
    }
    pub fn decisions(&self) -> &[PlanChoice] {
        &self.decisions
    }
}

pub struct ReceiptFields {
    pub profile_id: PositiveId,
    pub draft_id: PositiveId,
    pub revision_id: PositiveId,
    pub plan_version: PositiveId,
    pub draft_lifecycle_version: PositiveId,
    pub revision_digest: Digest,
    pub required_unit_mapping_digest: Digest,
    pub applied_at: WireText<1, 100>,
}
impl ApplyPlanDraftReceipt {
    pub fn new(fields: ReceiptFields) -> Self {
        Self {
            profile_id: fields.profile_id,
            draft_id: fields.draft_id,
            revision_id: fields.revision_id,
            plan_version: fields.plan_version,
            draft_lifecycle_version: fields.draft_lifecycle_version,
            revision_digest: fields.revision_digest,
            required_unit_mapping_digest: fields.required_unit_mapping_digest,
            applied_at: fields.applied_at,
        }
    }
    pub fn profile_id(&self) -> PositiveId {
        self.profile_id
    }
    pub fn draft_id(&self) -> PositiveId {
        self.draft_id
    }
    pub fn revision_id(&self) -> PositiveId {
        self.revision_id
    }
    pub fn plan_version(&self) -> PositiveId {
        self.plan_version
    }
    pub fn draft_lifecycle_version(&self) -> PositiveId {
        self.draft_lifecycle_version
    }
    pub fn revision_digest(&self) -> &Digest {
        &self.revision_digest
    }
    pub fn required_unit_mapping_digest(&self) -> &Digest {
        &self.required_unit_mapping_digest
    }
    pub fn applied_at(&self) -> &str {
        self.applied_at.as_str()
    }
}
impl fmt::Display for BoundaryError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} at {}: {}", self.category, self.field, self.detail)
    }
}
impl std::error::Error for BoundaryError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture(name: &str) -> Value {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../web/packages/contracts/test-fixtures/desktop/autosave-v1.json"
        ))
        .unwrap();
        corpus["normalized"]["schema_cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap()["input"]
            .clone()
    }
    fn reject(request: &Value, category: &str) -> BoundaryError {
        let error = parse_request(&request.to_string()).unwrap_err();
        assert_eq!(error.category, category);
        assert!(!error.field.is_empty());
        error
    }

    #[test]
    fn required_nullable_fields_cannot_become_optional() {
        for (pointer, field) in [
            ("", "expected_draft"),
            ("/expected_base", "revision_id"),
            ("/decisions/0", "value"),
            ("/decisions/0/target", "source_layer"),
        ] {
            let mut request = fixture("quantity-null-reset");
            assert!(parse_request(&request.to_string()).is_ok());
            request
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            let error = reject(&request, "missing_field");
            assert!(error.detail.contains(field));
        }
    }
    #[test]
    fn integer_bounds_and_no_coercion_cannot_relax() {
        for value in [json!(0), json!(10_001), json!(1.5), json!("1"), json!(true)] {
            let mut request = fixture("quantity-null-reset");
            request["decisions"][0]["value"] = value;
            assert!(parse_request(&request.to_string()).is_err());
        }
        let mut request = fixture("quantity-null-reset");
        request["decisions"][0]["value"] = json!(10_000);
        assert!(parse_request(&request.to_string()).is_ok());
        let integral = request.to_string().replace("10000", "1.0");
        let parsed = parse_request(&integral).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["decisions"][0]["value"],
            1
        );
    }
    #[test]
    fn basis_consistency_cannot_relax() {
        let mut request = fixture("quantity-null-reset");
        request["expected_base"] = json!({ "revision_id": null, "plan_version": 1 });
        reject(&request, "basis_inconsistent");
        request["expected_base"] = json!({ "revision_id": 1, "plan_version": 0 });
        reject(&request, "basis_inconsistent");
    }
    #[test]
    fn observed_draft_state_and_base_linkage_cannot_relax() {
        for (pointer, value) in [
            ("/expected_draft/state", json!("consumed")),
            ("/expected_draft/base/revision_id", json!(999)),
        ] {
            let mut request = fixture("observed-open-draft");
            *request.pointer_mut(pointer).unwrap() = value;
            let error = reject(&request, "observed_draft_mismatch");
            assert_eq!(error.field, "expected_draft");
        }
    }
    #[test]
    fn duplicate_target_field_rejects_but_distinct_fields_remain_valid() {
        let mut request = fixture("different-fields-same-target");
        assert!(parse_request(&request.to_string()).is_ok());
        let duplicate = request["decisions"][0].clone();
        request["decisions"].as_array_mut().unwrap().push(duplicate);
        assert_eq!(
            reject(&request, "duplicate_target_field").field,
            "decisions"
        );
    }
    #[test]
    fn strict_fields_and_discriminator_cannot_relax() {
        for pointer in ["", "/expected_base", "/decisions/0", "/decisions/0/target"] {
            let mut request = fixture("quantity-null-reset");
            request
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("extra".into(), json!(true));
            reject(&request, "unknown_field");
        }
        let mut request = fixture("quantity-null-reset");
        request["decisions"][0]["kind"] = json!("set_filament");
        reject(&request, "invalid_variant");
    }
    #[test]
    fn codepoint_length_does_not_apply_legacy_utf16_bounds() {
        let mut request = fixture("quantity-null-reset");
        request["decisions"][0]["target"]["source_layer"] = json!("🙂".repeat(1000));
        assert!(parse_request(&request.to_string()).is_ok());
        request["decisions"][0]["target"]["source_layer"] = json!("🙂".repeat(1001));
        reject(&request, "text_codepoint_bounds");
    }
    #[test]
    fn receipt_identity_and_digest_preserve_exact_values() {
        let receipt = fixture("receipt-valid");
        assert_eq!(
            serde_json::to_value(parse_receipt(&receipt.to_string()).unwrap()).unwrap(),
            receipt
        );
        let mut invalid = receipt.clone();
        invalid["revision_digest"] = json!("B".repeat(64));
        assert_eq!(
            parse_receipt(&invalid.to_string()).unwrap_err().category,
            "digest_pattern"
        );
        invalid = receipt.clone();
        invalid["profile_id"] = json!(MAX_SAFE_INTEGER + 1);
        assert_eq!(
            parse_receipt(&invalid.to_string()).unwrap_err().category,
            "integer_bounds"
        );
        invalid = receipt;
        invalid["profile_id"] = json!(MAX_SAFE_INTEGER);
        assert!(parse_receipt(&invalid.to_string()).is_ok());
    }
    #[test]
    fn decision_count_bounds_cannot_relax() {
        let mut request = fixture("quantity-null-reset");
        request["decisions"] = json!([]);
        reject(&request, "decision_count");
        let decision = fixture("included-false")["decisions"][0].clone();
        request["decisions"] = Value::Array(vec![decision; 10_001]);
        reject(&request, "decision_count");
    }
}
