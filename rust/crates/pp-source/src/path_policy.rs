use crate::unicode16::nfc16;
use crate::{Error, MAX_ENTRIES, Result, SourcePath};
use caseless::Caseless;
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

fn collision_key(path: &str) -> String {
    keyed(path, false)
}

/// Unicode 16 NFC, then the same case fold, then Unicode 16 NFC again.
/// Names that were distinct NFC under Unicode 16 stay distinct here.
fn collision_key_unicode16(path: &str) -> String {
    keyed(path, true)
}

fn keyed(path: &str, unicode16: bool) -> String {
    path.split('/')
        .map(|part| {
            if unicode16 {
                let folded: String = nfc16(part).chars().default_case_fold().collect();
                nfc16(&folded)
            } else {
                part.nfc().default_case_fold().nfc().collect::<String>()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Default)]
pub(crate) struct PathCollisions {
    prefixes: BTreeMap<String, (String, bool)>,
    explicit: BTreeSet<String>,
    merge_folder_case: bool,
    unicode16: bool,
}

impl PathCollisions {
    /// Accept folder spellings that snapshot publication merges into one
    /// canonical destination directory.
    pub(crate) fn merging_folder_case() -> Self {
        Self {
            merge_folder_case: true,
            ..Self::default()
        }
    }

    /// Load-time index. New publication keeps `merging_folder_case`, whose
    /// keys are Unicode 17 NFC.
    pub(crate) fn persisted_unicode16() -> Self {
        Self {
            merge_folder_case: true,
            unicode16: true,
            ..Self::default()
        }
    }

    fn key(&self, path: &str) -> String {
        if self.unicode16 {
            collision_key_unicode16(path)
        } else {
            collision_key(path)
        }
    }

    pub(crate) fn insert(&mut self, path: &SourcePath, directory: bool) -> Result<()> {
        if !self.explicit.insert(self.key(path.as_str())) {
            return Err(Error::DuplicatePath);
        }
        let mut prefix = String::new();
        let mut parts = path.as_str().split('/').peekable();
        while let Some(part) = parts.next() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let is_dir = parts.peek().is_some() || directory;
            let key = self.key(&prefix);
            if let Some((original, was_dir)) = self.prefixes.get(&key) {
                let same_folder = original == &prefix
                    || (self.merge_folder_case && original.to_lowercase() == prefix.to_lowercase());
                if !same_folder || !was_dir || !is_dir {
                    return Err(Error::DuplicatePath);
                }
            } else {
                self.prefixes.insert(key, (prefix.clone(), is_dir));
            }
            if self.prefixes.len() > MAX_ENTRIES {
                return Err(Error::Limit);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{collision_key, collision_key_unicode16};

    #[test]
    fn full_default_folding_is_normalized_and_locale_independent() {
        assert_eq!(caseless::UNICODE_VERSION, (16, 0, 0));
        for (left, right) in [
            ("Straße.stl", "STRASSE.stl"),
            ("Σ/σ.stl", "ς/Σ.STL"),
            ("é.stl", "e\u{301}.stl"),
            ("ﬃ.stl", "FFI.stl"),
            ("İ.stl", "i\u{307}.stl"),
            ("I.stl", "i.stl"),
        ] {
            let key = collision_key(left);
            assert_eq!(key, collision_key(right));
            assert_eq!(key, collision_key(&key));
        }
        assert_ne!(collision_key("İ"), collision_key("i"));
        assert_ne!(collision_key("ı"), collision_key("I"));
    }

    #[test]
    fn unicode16_nfc_pair_collides_only_under_unicode17() {
        let legacy = "a\u{1ADD}\u{0300}.stl";
        let composed = "\u{00E0}\u{1ADD}.stl";
        assert_eq!(collision_key(legacy), collision_key(composed));
        assert_ne!(
            collision_key_unicode16(legacy),
            collision_key_unicode16(composed)
        );
        assert_eq!(collision_key("é.stl"), collision_key_unicode16("é.stl"));
        assert_eq!(
            collision_key("e\u{301}.stl"),
            collision_key_unicode16("e\u{301}.stl")
        );
        assert_eq!(collision_key("e\u{301}.stl"), collision_key("é.stl"));
    }
}
