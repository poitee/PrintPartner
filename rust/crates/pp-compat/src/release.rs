use crate::Bundle;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

#[derive(Deserialize)]
struct DependencyInventory {
    web_path: String,
    roots: Vec<String>,
    files: BTreeMap<String, String>,
    links: BTreeMap<String, String>,
}

#[derive(Deserialize)]
pub(crate) struct ReleaseManifest {
    schema: u8,
    runtime_version: String,
    pub(crate) commit: String,
    node_sha256: String,
    frontend: BTreeMap<String, String>,
    backend: BTreeMap<String, String>,
    contracts: BTreeMap<String, String>,
    domain: BTreeMap<String, String>,
    metadata: BTreeMap<String, String>,
    dependencies: DependencyInventory,
}

fn measure(path: &Path) -> Result<String> {
    let mut file = File::open(path).context("Release artifact missing")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn verify_files(root: &Path, expected: &BTreeMap<String, String>, exact: bool) -> Result<()> {
    let root = root.canonicalize().context("Release root missing")?;
    ensure!(!expected.is_empty(), "Release inventory empty");
    if exact {
        let mut actual = std::collections::BTreeSet::new();
        let mut pending = vec![root.clone()];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                ensure!(
                    !entry.file_type()?.is_symlink(),
                    "Release inventory contains a symlink"
                );
                if entry.file_type()?.is_dir() {
                    pending.push(entry.path());
                } else {
                    actual.insert(
                        entry
                            .path()
                            .strip_prefix(&root)?
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }
        ensure!(
            actual == expected.keys().cloned().collect(),
            "Release file inventory mismatch"
        );
    }

    for (relative, digest) in expected {
        let path = root
            .join(relative)
            .canonicalize()
            .context("Release artifact missing")?;
        ensure!(path.starts_with(&root), "Release artifact escaped root");
        ensure!(
            measure(&path)? == *digest,
            "Release artifact content mismatch"
        );
    }
    Ok(())
}

pub(crate) fn manifest() -> Result<ReleaseManifest> {
    let release: ReleaseManifest = serde_json::from_slice(include_bytes!(concat!(
        env!("OUT_DIR"),
        "/bundle-manifest.json"
    )))?;
    ensure!(release.schema == 1, "Unsupported release inventory");
    Ok(release)
}

pub fn verify_bundle(bundle: &Bundle, assets: &Path) -> Result<()> {
    let release = manifest()?;
    verify_files(assets, &release.frontend, true)?;
    verify_backend(bundle)
}

pub(crate) fn verify_backend(bundle: &Bundle) -> Result<()> {
    let release = manifest()?;
    ensure!(
        release.runtime_version == bundle.runtime_version && release.commit == bundle.commit,
        "Requested release differs from embedded identity"
    );
    ensure!(
        measure(&bundle.node)? == release.node_sha256,
        "Node executable content mismatch"
    );
    ensure!(
        bundle.entry.file_name().and_then(|name| name.to_str()) == Some("desktop.js"),
        "Unexpected compatibility entry"
    );
    ensure!(
        release.backend.contains_key("desktop-resolution.js"),
        "Desktop preload is not measured"
    );
    let preload = bundle
        .entry
        .parent()
        .context("Missing backend root")?
        .join("desktop-resolution.js")
        .canonicalize()?;
    ensure!(
        preload.starts_with(package_root(bundle)?),
        "Desktop preload escaped package"
    );
    verify_files(
        bundle.entry.parent().context("Missing backend root")?,
        &release.backend,
        true,
    )?;
    verify_files(
        &bundle.web_root.join("packages/contracts/dist/current"),
        &release.contracts,
        true,
    )?;
    verify_files(
        &bundle.web_root.join("packages/domain/dist/current"),
        &release.domain,
        true,
    )?;
    verify_files(&bundle.web_root, &release.metadata, false)?;
    verify_dependencies(&bundle.web_root, &release.dependencies)?;
    Ok(())
}

fn relative(path: &str) -> Result<&Path> {
    let path = Path::new(path);
    ensure!(
        !path.is_absolute()
            && path.components().all(|part| matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )),
        "Invalid dependency inventory path"
    );
    Ok(path)
}

fn inventory_root(web: &Path, inventory: &DependencyInventory) -> Result<std::path::PathBuf> {
    let web = web.canonicalize()?;
    let suffix = relative(&inventory.web_path)?;
    let mut root = web.clone();
    for component in suffix.components().rev() {
        if let std::path::Component::Normal(name) = component {
            ensure!(root.file_name() == Some(name), "Package layout mismatch");
            ensure!(root.pop(), "Package root unavailable");
        }
    }
    ensure!(
        root.join(suffix).canonicalize()? == web,
        "Package layout mismatch"
    );
    Ok(root)
}

pub(crate) fn package_root(bundle: &Bundle) -> Result<std::path::PathBuf> {
    inventory_root(&bundle.web_root, &manifest()?.dependencies)
}

fn verify_dependencies(web: &Path, inventory: &DependencyInventory) -> Result<()> {
    let root = inventory_root(web, inventory)?;
    ensure!(
        !inventory.files.is_empty() && !inventory.roots.is_empty(),
        "Dependency inventory empty"
    );
    let mut actual_files = std::collections::BTreeSet::new();
    let mut actual_links = std::collections::BTreeSet::new();
    let mut visited = std::collections::BTreeSet::new();
    for directory in &inventory.roots {
        let directory = root.join(relative(directory)?);
        if !directory.try_exists()? {
            continue;
        }
        ensure!(
            directory.canonicalize()?.starts_with(&root),
            "Dependency root escaped package"
        );
        let mut pending = vec![directory];
        while let Some(directory) = pending.pop() {
            let directory = directory.canonicalize()?;
            if !visited.insert(directory.clone()) {
                continue;
            }
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                let path = entry.path();
                let key = path.strip_prefix(&root)?.to_string_lossy().into_owned();
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    actual_links.insert(key.clone());
                    let target = path.canonicalize()?;
                    ensure!(target.starts_with(&root), "Dependency link escaped package");
                    if target.is_file() {
                        actual_files
                            .insert(target.strip_prefix(&root)?.to_string_lossy().into_owned());
                    } else if target.is_dir() {
                        pending.push(target);
                    } else {
                        anyhow::bail!("Unexpected dependency link target");
                    }
                } else if kind.is_dir() {
                    pending.push(path);
                } else {
                    ensure!(kind.is_file(), "Unexpected dependency file type");
                    actual_files.insert(key);
                }
            }
        }
    }
    ensure!(
        actual_files == inventory.files.keys().cloned().collect(),
        "Dependency file inventory mismatch"
    );
    ensure!(
        actual_links == inventory.links.keys().cloned().collect(),
        "Dependency link inventory mismatch"
    );
    for (path, target) in &inventory.links {
        ensure!(
            std::fs::read_link(root.join(relative(path)?))? == Path::new(target),
            "Dependency link changed"
        );
    }
    verify_files(&root, &inventory.files, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn dependency_aliases_are_measured_and_cannot_escape() {
        let root = std::env::temp_dir().join(format!(
            "pp-dependencies-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        let web = root.join("Resources/desktop-runtime/web");
        let modules = web.join("node_modules");
        let framework = root.join("Frameworks/addon.node");
        std::fs::create_dir_all(&modules).unwrap();
        std::fs::create_dir_all(framework.parent().unwrap()).unwrap();
        std::fs::write(&framework, b"measured native addon").unwrap();
        let alias = modules.join("addon.node");
        let target = Path::new("../../../../Frameworks/addon.node");
        symlink(target, &alias).unwrap();
        let inventory = DependencyInventory {
            web_path: "Resources/desktop-runtime/web".into(),
            roots: vec![
                "Resources/desktop-runtime/web/node_modules".into(),
                "Resources/desktop-runtime/web/apps/node_modules".into(),
            ],
            files: BTreeMap::from([("Frameworks/addon.node".into(), measure(&framework).unwrap())]),
            links: BTreeMap::from([(
                "Resources/desktop-runtime/web/node_modules/addon.node".into(),
                target.to_string_lossy().into_owned(),
            )]),
        };
        verify_dependencies(&web, &inventory).unwrap();
        let moved = root.with_extension("relocated");
        std::fs::rename(&root, &moved).unwrap();
        verify_dependencies(&moved.join("Resources/desktop-runtime/web"), &inventory).unwrap();
        std::fs::rename(&moved, &root).unwrap();
        std::fs::write(&framework, b"changed signed bytes").unwrap();
        assert!(verify_dependencies(&web, &inventory).is_err());
        std::fs::write(&framework, b"measured native addon").unwrap();
        std::fs::write(modules.join("unmeasured.js"), b"extra code").unwrap();
        assert!(verify_dependencies(&web, &inventory).is_err());
        std::fs::remove_file(modules.join("unmeasured.js")).unwrap();
        let nearer = web.join("apps/node_modules");
        std::fs::create_dir_all(&nearer).unwrap();
        std::fs::write(nearer.join("shadow.js"), b"new search root").unwrap();
        assert!(verify_dependencies(&web, &inventory).is_err());
        std::fs::remove_dir_all(&nearer).unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink("/usr/bin/node", &alias).unwrap();
        assert!(verify_dependencies(&web, &inventory).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
