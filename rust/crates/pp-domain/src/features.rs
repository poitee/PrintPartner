use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::{collections::BTreeMap, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeatureSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    pub default_enabled: bool,
}

macro_rules! feature_registry {
    ($($variant:ident => ($key:literal, $label:literal, $summary:literal, $default_enabled:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum Feature {
            $($variant),+
        }

        impl Feature {
            pub const ALL: [Feature; [$(stringify!($variant)),+].len()] = [$(Feature::$variant),+];

            pub fn spec(self) -> FeatureSpec {
                match self {
                    $(Feature::$variant => FeatureSpec {
                        key: $key,
                        label: $label,
                        summary: $summary,
                        default_enabled: $default_enabled,
                    }),+
                }
            }
        }
    };
}

feature_registry! {
    Farm => (
        "farm",
        "Print farm",
        "Queue suggestions, printer matching and packing for several printers.",
        false
    ),
    Orders => (
        "orders",
        "Orders",
        "Order numbers and customer requests on Plans.",
        false
    ),
    Bambu => (
        "bambu",
        "Bambu printers",
        "Connect Bambu Lab printers and hand off jobs.",
        false
    ),
    Spoolman => (
        "spoolman",
        "Spoolman",
        "Filament stock from Spoolman and grams-needed checks.",
        false
    ),
}

impl Feature {
    pub fn key(self) -> &'static str {
        self.spec().key
    }

    pub fn from_key(key: &str) -> Option<Feature> {
        Feature::ALL
            .into_iter()
            .find(|feature| feature.key() == key)
    }
}

impl Serialize for Feature {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.key())
    }
}

impl<'de> Deserialize<'de> for Feature {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let key = String::deserialize(deserializer)?;
        Feature::from_key(&key).ok_or_else(|| de::Error::custom(format!("unknown feature `{key}`")))
    }
}

/// Explicit choices for one layer. An absent feature inherits from the layer below.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Toggles(BTreeMap<Feature, bool>);

impl Toggles {
    pub fn get(&self, feature: Feature) -> Option<bool> {
        self.0.get(&feature).copied()
    }

    pub fn set(&mut self, feature: Feature, choice: Option<bool>) {
        match choice {
            Some(enabled) => self.0.insert(feature, enabled),
            None => self.0.remove(&feature),
        };
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (Feature, bool)> + '_ {
        self.0.iter().map(|(&feature, &enabled)| (feature, enabled))
    }
}

impl<'de> Deserialize<'de> for Toggles {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TogglesIgnoringUnknownKeys;
        impl<'de> de::Visitor<'de> for TogglesIgnoringUnknownKeys {
            type Value = Toggles;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an object of feature keys to booleans")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Toggles, A::Error> {
                let mut toggles = Toggles::default();
                while let Some(key) = map.next_key::<String>()? {
                    match Feature::from_key(&key) {
                        Some(feature) => toggles.set(feature, Some(map.next_value()?)),
                        None => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(toggles)
            }
        }
        deserializer.deserialize_map(TogglesIgnoringUnknownKeys)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Default,
    User,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved {
    pub feature: Feature,
    pub enabled: bool,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Effective([Resolved; Feature::ALL.len()]);

impl Effective {
    pub fn enabled(&self, feature: Feature) -> bool {
        self.0
            .iter()
            .any(|resolved| resolved.feature == feature && resolved.enabled)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Resolved> {
        self.0.iter()
    }
}

pub fn resolve(user: &Toggles, plan: Option<&Toggles>) -> Effective {
    Effective(Feature::ALL.map(|feature| {
        let (enabled, source) = match (plan.and_then(|plan| plan.get(feature)), user.get(feature)) {
            (Some(enabled), _) => (enabled, Source::Plan),
            (None, Some(enabled)) => (enabled, Source::User),
            (None, None) => (feature.spec().default_enabled, Source::Default),
        };
        Resolved {
            feature,
            enabled,
            source,
        }
    }))
}

#[cfg(test)]
mod tests;
