mod builder;
mod json;
mod model;
pub(crate) mod observation;
#[cfg(test)]
mod observation_tests;

pub use model::KitManifest;

#[derive(Debug, Clone)]
pub struct ManifestInputDetail(crate::manifest_text::JsText);
impl From<&str> for ManifestInputDetail {
    fn from(value: &str) -> Self {
        Self(crate::manifest_text::JsText::scalar(value))
    }
}
impl From<String> for ManifestInputDetail {
    fn from(value: String) -> Self {
        Self(crate::manifest_text::JsText::scalar(&value))
    }
}
impl ManifestInputDetail {
    pub(super) fn group(group: &crate::manifest_text::JsText, suffix: &str) -> Self {
        Self::keyed("kit.selections.", group, suffix)
    }
    /// `prefix`, then the key's UTF-16 units, then `suffix`, as Node's template
    /// strings join them.
    pub(super) fn keyed(prefix: &str, key: &crate::manifest_text::JsText, suffix: &str) -> Self {
        let mut units = prefix.encode_utf16().collect::<Vec<_>>();
        units.extend_from_slice(key.units());
        units.extend(suffix.encode_utf16());
        Self(crate::manifest_text::JsText::from_units(units))
    }
    pub fn into_body(self) -> ManifestJsonBody {
        let mut output = b"{\"detail\":".to_vec();
        self.0.write_json(&mut output);
        output.push(b'}');
        ManifestJsonBody(output)
    }
}

#[derive(Debug)]
pub struct ManifestJsonBody(pub(crate) Vec<u8>);

impl ManifestJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}
