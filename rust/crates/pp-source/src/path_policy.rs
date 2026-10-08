use crate::{Error, MAX_ENTRIES, Result, SourcePath};
use caseless::Caseless;
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

fn collision_key(path: &str) -> String {
    path.split('/')
        .map(|part| part.nfc().default_case_fold().nfc().collect::<String>())
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Default)]
pub(crate) struct PathCollisions {
    prefixes: BTreeMap<String, (String, bool)>,
    explicit: BTreeSet<String>,
}

impl PathCollisions {
    pub(crate) fn insert(&mut self, path: &SourcePath, directory: bool) -> Result<()> {
        if !self.explicit.insert(collision_key(path.as_str())) {
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
            let key = collision_key(&prefix);
            if let Some((original, was_dir)) = self.prefixes.get(&key) {
                if original != &prefix || !was_dir || !is_dir {
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
    use super::collision_key;

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
}
