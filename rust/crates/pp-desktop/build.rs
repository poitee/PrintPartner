fn main() {
    let attributes = tauri_build::Attributes::new();
    #[cfg(feature = "desktop_rebuild")]
    let attributes =
        attributes.app_manifest(tauri_build::AppManifest::new().commands(&["open_sponsor"]));
    tauri_build::try_build(attributes).expect("desktop build configuration failed");
}
