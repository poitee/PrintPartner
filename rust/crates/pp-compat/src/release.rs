use crate::Bundle;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

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
    Ok(())
}
