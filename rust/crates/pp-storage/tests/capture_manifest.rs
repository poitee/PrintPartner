use pp_storage::uploads::inspect_capture_manifest;

#[test]
fn capture_manifest_public_inspection_rejects_malformed_bytes() {
    assert!(inspect_capture_manifest(br#"{}"#).is_err());
}
