use anyhow::{Result, ensure};
use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

const APP_ID: &str = "com.poitee.printpartner";

#[derive(Debug, Clone, Copy)]
pub enum Platform {
    MacOs,
    Linux,
}

#[derive(Debug, Default)]
pub struct LayoutEnvironment {
    pub portable_root: Option<PathBuf>,
    pub xdg_data_home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    pub xdg_state_home: Option<PathBuf>,
    pub xdg_cache_home: Option<PathBuf>,
}

impl LayoutEnvironment {
    /// Snapshot supported variables without changing process environment.
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var_os(name))
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Self {
        Self {
            portable_root: lookup("PP_PORTABLE_DIR").map(PathBuf::from),
            xdg_data_home: lookup("XDG_DATA_HOME").map(PathBuf::from),
            xdg_config_home: lookup("XDG_CONFIG_HOME").map(PathBuf::from),
            xdg_state_home: lookup("XDG_STATE_HOME").map(PathBuf::from),
            xdg_cache_home: lookup("XDG_CACHE_HOME").map(PathBuf::from),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct DirectoryLayout {
    pub store: PathBuf,
    pub app_data: PathBuf,
    pub config: PathBuf,
    pub logs: PathBuf,
    pub cache: PathBuf,
}

impl DirectoryLayout {
    /// Resolve paths without filesystem access. Outside portable mode, `store`
    /// retains ~/.print-partner and `app_data` holds auxiliary state.
    /// Portable mode places both `store` and `app_data` in <root>/data.
    /// The existing desktop.toml remains in `store`, not `config`.
    /// Portable mode ignores home and XDG values. Empty XDG values use defaults;
    /// other selected roots must be absolute and contain no parent traversal.
    pub fn resolve(
        platform: Platform,
        home: &Path,
        environment: &LayoutEnvironment,
    ) -> Result<Self> {
        if let Some(root) = &environment.portable_root {
            validate_root(root, "PP_PORTABLE_DIR")?;
            return Ok(Self {
                store: root.join("data"),
                app_data: root.join("data"),
                config: root.join("config"),
                logs: root.join("logs"),
                cache: root.join("cache"),
            });
        }
        validate_root(home, "home")?;
        match platform {
            Platform::MacOs => {
                let library = home.join("Library");
                let support = library.join("Application Support").join(APP_ID);
                Ok(Self {
                    store: home.join(".print-partner"),
                    app_data: support.clone(),
                    config: support,
                    logs: library.join("Logs").join(APP_ID),
                    cache: library.join("Caches").join(APP_ID),
                })
            }
            Platform::Linux => Ok(Self {
                store: home.join(".print-partner"),
                app_data: xdg_root(
                    &environment.xdg_data_home,
                    home,
                    ".local/share",
                    "XDG_DATA_HOME",
                )?
                .join(APP_ID),
                config: xdg_root(
                    &environment.xdg_config_home,
                    home,
                    ".config",
                    "XDG_CONFIG_HOME",
                )?
                .join(APP_ID),
                logs: xdg_root(
                    &environment.xdg_state_home,
                    home,
                    ".local/state",
                    "XDG_STATE_HOME",
                )?
                .join(APP_ID)
                .join("logs"),
                cache: xdg_root(
                    &environment.xdg_cache_home,
                    home,
                    ".cache",
                    "XDG_CACHE_HOME",
                )?
                .join(APP_ID),
            }),
        }
    }
}

fn validate_root(path: &Path, name: &str) -> Result<()> {
    ensure!(
        path.is_absolute() && !path.components().any(|part| part == Component::ParentDir),
        "Invalid {name} directory"
    );
    Ok(())
}

fn xdg_root(value: &Option<PathBuf>, home: &Path, default: &str, name: &str) -> Result<PathBuf> {
    match value {
        Some(path) if !path.as_os_str().is_empty() => {
            validate_root(path, name)?;
            Ok(path.clone())
        }
        _ => Ok(home.join(default)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_t_12_macos_layout_uses_bundle_identity() {
        let layout = DirectoryLayout::resolve(
            Platform::MacOs,
            Path::new("/Users/owner"),
            &LayoutEnvironment::default(),
        )
        .unwrap();
        assert_eq!(
            layout,
            DirectoryLayout {
                store: "/Users/owner/.print-partner".into(),
                app_data: "/Users/owner/Library/Application Support/com.poitee.printpartner".into(),
                config: "/Users/owner/Library/Application Support/com.poitee.printpartner".into(),
                logs: "/Users/owner/Library/Logs/com.poitee.printpartner".into(),
                cache: "/Users/owner/Library/Caches/com.poitee.printpartner".into(),
            }
        );
    }

    #[test]
    fn ticket_t_12_linux_layout_uses_xdg_defaults() {
        let layout = DirectoryLayout::resolve(
            Platform::Linux,
            Path::new("/home/owner"),
            &LayoutEnvironment::default(),
        )
        .unwrap();
        assert_eq!(
            layout,
            DirectoryLayout {
                store: "/home/owner/.print-partner".into(),
                app_data: "/home/owner/.local/share/com.poitee.printpartner".into(),
                config: "/home/owner/.config/com.poitee.printpartner".into(),
                logs: "/home/owner/.local/state/com.poitee.printpartner/logs".into(),
                cache: "/home/owner/.cache/com.poitee.printpartner".into(),
            }
        );
    }

    #[test]
    fn ticket_t_12_linux_layout_honors_each_xdg_override() {
        let environment = LayoutEnvironment {
            xdg_data_home: Some("/data".into()),
            xdg_config_home: Some("/config".into()),
            xdg_state_home: Some("/state".into()),
            xdg_cache_home: Some("/cache".into()),
            ..Default::default()
        };
        let layout =
            DirectoryLayout::resolve(Platform::Linux, Path::new("/home/owner"), &environment)
                .unwrap();
        assert_eq!(
            layout,
            DirectoryLayout {
                store: "/home/owner/.print-partner".into(),
                app_data: "/data/com.poitee.printpartner".into(),
                config: "/config/com.poitee.printpartner".into(),
                logs: "/state/com.poitee.printpartner/logs".into(),
                cache: "/cache/com.poitee.printpartner".into(),
            }
        );
    }

    #[test]
    fn ticket_t_12_portable_layout_overrides_home_and_xdg_without_io() {
        let environment = LayoutEnvironment {
            portable_root: Some("/portable/Print Partner".into()),
            xdg_data_home: Some("ignored-relative".into()),
            ..Default::default()
        };
        for platform in [Platform::MacOs, Platform::Linux] {
            let layout = DirectoryLayout::resolve(platform, Path::new(""), &environment).unwrap();
            assert_eq!(
                layout,
                DirectoryLayout {
                    store: "/portable/Print Partner/data".into(),
                    app_data: "/portable/Print Partner/data".into(),
                    config: "/portable/Print Partner/config".into(),
                    logs: "/portable/Print Partner/logs".into(),
                    cache: "/portable/Print Partner/cache".into(),
                }
            );
        }
    }

    #[test]
    fn ticket_t_12_layout_rejects_relative_and_empty_roots() {
        for root in ["", "relative", "/safe/../other"] {
            let environment = LayoutEnvironment {
                portable_root: Some(root.into()),
                ..Default::default()
            };
            assert_eq!(
                DirectoryLayout::resolve(Platform::Linux, Path::new("/home/owner"), &environment)
                    .unwrap_err()
                    .to_string(),
                "Invalid PP_PORTABLE_DIR directory",
                "{root}"
            );
        }
        for home in ["", "relative", "/home/../other"] {
            assert_eq!(
                DirectoryLayout::resolve(
                    Platform::MacOs,
                    Path::new(home),
                    &LayoutEnvironment::default()
                )
                .unwrap_err()
                .to_string(),
                "Invalid home directory",
                "{home}"
            );
        }
    }

    #[test]
    fn ticket_t_12_layout_rejects_each_invalid_xdg_override() {
        for (index, expected) in [
            "Invalid XDG_DATA_HOME directory",
            "Invalid XDG_CONFIG_HOME directory",
            "Invalid XDG_STATE_HOME directory",
            "Invalid XDG_CACHE_HOME directory",
        ]
        .into_iter()
        .enumerate()
        {
            let mut environment = LayoutEnvironment::default();
            let field = match index {
                0 => &mut environment.xdg_data_home,
                1 => &mut environment.xdg_config_home,
                2 => &mut environment.xdg_state_home,
                _ => &mut environment.xdg_cache_home,
            };
            *field = Some("relative".into());
            assert_eq!(
                DirectoryLayout::resolve(Platform::Linux, Path::new("/home/owner"), &environment)
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
    }

    #[test]
    fn ticket_t_12_empty_xdg_values_use_defaults() {
        let environment = LayoutEnvironment::from_lookup(|_| Some(OsString::new()));
        let environment = LayoutEnvironment {
            portable_root: None,
            ..environment
        };
        let layout =
            DirectoryLayout::resolve(Platform::Linux, Path::new("/home/owner"), &environment)
                .unwrap();
        assert_eq!(
            layout.app_data,
            Path::new("/home/owner/.local/share/com.poitee.printpartner")
        );
        assert_eq!(
            layout.config,
            Path::new("/home/owner/.config/com.poitee.printpartner")
        );
        assert_eq!(
            layout.logs,
            Path::new("/home/owner/.local/state/com.poitee.printpartner/logs")
        );
        assert_eq!(
            layout.cache,
            Path::new("/home/owner/.cache/com.poitee.printpartner")
        );
    }

    #[test]
    fn ticket_t_12_environment_snapshot_uses_named_variables() {
        let environment =
            LayoutEnvironment::from_lookup(|name| Some(OsString::from(format!("/{name}"))));
        assert_eq!(
            environment.portable_root.as_deref(),
            Some(Path::new("/PP_PORTABLE_DIR"))
        );
        assert_eq!(
            environment.xdg_data_home.as_deref(),
            Some(Path::new("/XDG_DATA_HOME"))
        );
        assert_eq!(
            environment.xdg_config_home.as_deref(),
            Some(Path::new("/XDG_CONFIG_HOME"))
        );
        assert_eq!(
            environment.xdg_state_home.as_deref(),
            Some(Path::new("/XDG_STATE_HOME"))
        );
        assert_eq!(
            environment.xdg_cache_home.as_deref(),
            Some(Path::new("/XDG_CACHE_HOME"))
        );
    }

    #[test]
    fn ticket_t_12_macos_ignores_xdg_environment() {
        let environment = LayoutEnvironment::from_lookup(|name| {
            (name != "PP_PORTABLE_DIR").then(|| OsString::from("relative"))
        });
        let layout =
            DirectoryLayout::resolve(Platform::MacOs, Path::new("/Users/owner"), &environment)
                .unwrap();
        assert_eq!(
            layout.app_data,
            Path::new("/Users/owner/Library/Application Support/com.poitee.printpartner")
        );
        assert_eq!(
            layout.logs,
            Path::new("/Users/owner/Library/Logs/com.poitee.printpartner")
        );
    }

    #[cfg(unix)]
    #[test]
    fn ticket_t_12_layout_preserves_non_unicode_roots() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let environment = LayoutEnvironment::from_lookup(|name| {
            (name == "XDG_DATA_HOME").then(|| OsString::from_vec(b"/data/\xff".to_vec()))
        });
        let layout =
            DirectoryLayout::resolve(Platform::Linux, Path::new("/home/owner"), &environment)
                .unwrap();
        assert_eq!(
            layout.app_data.as_os_str().as_bytes(),
            b"/data/\xff/com.poitee.printpartner"
        );
    }
}
