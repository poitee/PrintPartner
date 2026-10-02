use anyhow::{Context, Result, ensure};
use pp_core::{DesktopLaunch, VerifiedBundle};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::Url;

#[derive(Clone)]
pub struct AllowedOrigin(Url);

impl AllowedOrigin {
    pub fn parse(value: &str) -> Result<Self> {
        let url = Url::parse(value)?;
        ensure!(
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "Invalid desktop origin"
        );
        Ok(Self(url))
    }
    pub fn admits(&self, url: &Url) -> bool {
        url.origin() == self.0.origin() && url.username().is_empty() && url.password().is_none()
    }
}

#[derive(Deserialize)]
struct ReleaseIdentity {
    runtime_version: String,
    commit: String,
    node: PathBuf,
    web: PathBuf,
    os: String,
    arch: String,
    node_version: String,
    node_abi: String,
}

pub struct ResourceLayout {
    root: PathBuf,
    release: ReleaseIdentity,
}

impl ResourceLayout {
    pub fn read(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .context("Desktop resources unavailable")?;
        let identity = if root.join("release.json").is_file() {
            root.join("release.json")
        } else {
            root.join("Resources/desktop-runtime/release.json")
        };
        let release: ReleaseIdentity = serde_json::from_slice(&std::fs::read(identity)?)?;
        ensure!(
            release.os == std::env::consts::OS && release.arch == std::env::consts::ARCH,
            "Desktop architecture mismatch"
        );
        ensure!(
            release.node_version == "v24.21.0" && release.node_abi == "137",
            "Desktop Node identity mismatch"
        );
        ensure!(
            release.commit.len() == 40
                && release
                    .commit
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "Desktop commit identity missing"
        );
        contained(&root, &release.node)?;
        contained(&root, &release.web)?;
        Ok(Self { root, release })
    }
    pub fn into_launch(self, data_dir: PathBuf) -> Result<DesktopLaunch> {
        let web = contained(&self.root, &self.release.web)?;
        let node = contained(&self.root, &self.release.node)?;
        Ok(DesktopLaunch {
            data_dir,
            assets: web.join("apps/web/dist"),
            bundle: VerifiedBundle {
                node,
                entry: web.join("apps/server/dist/current/desktop.js"),
                web_root: web,
                runtime_version: self.release.runtime_version,
                commit: self.release.commit,
            },
        })
    }
}

fn contained(root: &Path, relative: &Path) -> Result<PathBuf> {
    ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
        "Invalid desktop resource path"
    );
    let path = root.join(relative).canonicalize()?;
    ensure!(path.starts_with(root), "Desktop resource escaped package");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_authority_denies_native_commands_for_every_origin() {
        let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let build_config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            build_config.bundle.macos.minimum_system_version.as_deref(),
            Some("13.5")
        );
        let authority = context.runtime_authority_mut();
        for origin in [
            tauri::ipc::Origin::Local,
            tauri::ipc::Origin::Remote {
                url: Url::parse("http://127.0.0.1:46687/").unwrap(),
            },
            tauri::ipc::Origin::Remote {
                url: Url::parse("https://example.com/").unwrap(),
            },
        ] {
            for command in [
                "plugin:app|exit",
                "plugin:window|close",
                "plugin:webview|create_webview_window",
                "plugin:fs|read_file",
                "plugin:shell|execute",
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &origin)
                        .is_none(),
                    "{command}"
                );
            }
        }
    }

    #[test]
    fn resource_paths_must_remain_inside_the_package() {
        let root = std::env::temp_dir().join(format!(
            "pp-layout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin/node"), b"node").unwrap();
        let root = root.canonicalize().unwrap();
        assert_eq!(
            contained(&root, Path::new("bin/node")).unwrap(),
            root.join("bin/node")
        );
        for path in ["../outside", "/usr/bin/node", "bin/missing"] {
            assert!(contained(&root, Path::new(path)).is_err());
        }
        std::os::unix::fs::symlink("/usr/bin/node", root.join("escape")).unwrap();
        assert!(contained(&root, Path::new("escape")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn admits_only_the_exact_loopback_origin() {
        let policy = AllowedOrigin::parse("http://127.0.0.1:46687").unwrap();
        for url in [
            "http://127.0.0.1:46687/",
            "http://127.0.0.1:46687/plans?x=1#part",
        ] {
            assert!(policy.admits(&Url::parse(url).unwrap()));
        }
        for url in [
            "http://127.0.0.1:46688/",
            "http://localhost:46687/",
            "https://127.0.0.1:46687/",
            "http://owner@127.0.0.1:46687/",
            "http://127.0.0.1.evil:46687/",
            "file:///tmp/index.html",
            "data:text/html,hello",
        ] {
            assert!(!policy.admits(&Url::parse(url).unwrap()), "{url}");
        }
        assert!(AllowedOrigin::parse("http://localhost:46687").is_err());
        assert!(AllowedOrigin::parse("http://127.0.0.1:46687/path").is_err());
    }
}
