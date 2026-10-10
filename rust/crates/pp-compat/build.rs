use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PP_DESKTOP_RELEASE_MANIFEST");
    let manifest = env::var_os("PP_DESKTOP_RELEASE_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bundle-manifest.json")
        });
    println!("cargo:rerun-if-changed={}", manifest.display());
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    fs::copy(manifest, output.join("bundle-manifest.json"))
        .expect("Generate the measured desktop manifest before building Rust");
}
