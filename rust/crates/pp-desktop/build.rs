fn main() -> tauri_build::Result<()> {
    let attributes = tauri_build::Attributes::new();
    #[cfg(feature = "desktop_rebuild")]
    let attributes = attributes.app_manifest(
        tauri_build::AppManifest::new().commands(&["open_sponsor", "sync_portable_settings"]),
    );
    tauri_build::try_build(attributes)
}
