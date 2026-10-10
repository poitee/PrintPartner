use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilenameExport {
    pub definition: FilenameGrouping,
    pub arrangement: Arrangement,
    pub group: Option<String>,
    pub role: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Arrangement {
    Group,
    ColorGroup,
    GroupColor,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilenameGrouping {
    pub name: String,
    pub rules: Vec<FilenameRule>,
    #[serde(default)]
    pub overrides: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilenameRule {
    pub suffix: String,
    pub group: String,
}
fn label(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty()
            && value.encode_utf16().count() <= 80
            && value
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-')),
        "Invalid filename group label"
    );
    Ok(())
}
fn folder(value: &str) -> String {
    let mut name = String::new();
    let mut separator = false;
    for c in value.chars() {
        if c.is_alphanumeric() || matches!(c, '_' | '-') {
            name.push(c);
            separator = false;
        } else if !separator {
            name.push('_');
            separator = true;
        }
    }
    name.to_lowercase()
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(
            c,
            '\u{0009}'..='\u{000d}'
                | ' '
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    })
}

impl FilenameExport {
    pub(super) fn normalize(&mut self) {
        self.definition.name = trim(&self.definition.name).to_owned();
        for rule in &mut self.definition.rules {
            rule.suffix = trim(&rule.suffix).to_owned();
            rule.group = trim(&rule.group).to_owned();
        }
        for value in self.definition.overrides.values_mut() {
            *value = trim(value).to_owned();
        }
        for value in [&mut self.group, &mut self.role].into_iter().flatten() {
            *value = trim(value).to_owned();
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
        label(&self.definition.name)?;
        ensure!(self.definition.rules.len() <= 50, "Too many filename rules");
        let mut names = BTreeMap::from([("unassigned".to_owned(), "Unassigned")]);
        for rule in &self.definition.rules {
            let suffix = rule.suffix.trim();
            ensure!(
                !suffix.is_empty()
                    && suffix.encode_utf16().count() <= 120
                    && !suffix.contains(['/', '\\'])
                    && !suffix.eq_ignore_ascii_case(".stl"),
                "Invalid filename suffix"
            );
            ensure!(
                !["unassigned", "conflict"].contains(&rule.group.to_lowercase().as_str()),
                "Reserved filename group"
            );
        }
        for (key, value) in &self.definition.overrides {
            ensure!(
                key.encode_utf16().count() <= 2048 && !value.eq_ignore_ascii_case("conflict"),
                "Invalid filename override"
            );
        }
        for name in self
            .definition
            .rules
            .iter()
            .map(|r| r.group.as_str())
            .chain(self.definition.overrides.values().map(String::as_str))
        {
            label(name)?;
            let key = folder(name);
            ensure!(
                names.get(&key).is_none_or(|old| *old == name),
                "Filename folder collision"
            );
            names.insert(key, name);
        }
        for value in [&self.group, &self.role].into_iter().flatten() {
            ensure!(
                value.encode_utf16().count() <= 80,
                "Filename filter too long"
            );
        }
        Ok(())
    }
}
