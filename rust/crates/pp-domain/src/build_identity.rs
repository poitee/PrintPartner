use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct BuildName(String);

impl BuildName {
    pub fn parse(value: String) -> Result<Self, &'static str> {
        let value = trim_js(&value).to_owned();
        if value.is_empty() {
            return Err("Profile name is required");
        }
        if value.chars().count() > 4096 {
            return Err("Profile name is too long");
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for BuildName {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

pub fn trim_js(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(character,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}
