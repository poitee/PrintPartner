#![cfg(feature = "desktop_rebuild")]

use pp_source::{
    Error, LocalFiles, SourcePath,
    retained_capture::{
        FreezeResult, RetainedCapturePhase, RetainedCaptureVault, RetainedInputTransfer,
    },
};
use std::{fs, sync::atomic::AtomicBool};

#[test]
fn retained_lifecycle_reopens_transfers_and_preserves_existing_operations() {
    let root = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(root.path()).unwrap();
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate_owned().unwrap();
    let id = candidate.capture_id().clone();
    let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];
    let input = candidate.write_file(paths[0].clone(), b"mesh", 4).unwrap();
    assert_eq!(input.size, 4);
    assert_eq!(
        input.sha256,
        "d30ca7a7a32bf5772dc5eb2a2e7bd35737eff795ad74f2479b359716b59abdfa"
    );
    assert_eq!(
        candidate.inventory(4).unwrap().as_slice(),
        std::slice::from_ref(&input)
    );
    let frozen = match candidate.freeze_owned(b"opaque manifest") {
        FreezeResult::Frozen(frozen) => frozen,
        _ => panic!("freeze failed"),
    };
    assert_eq!(frozen.receipt().phase(), RetainedCapturePhase::Frozen);
    drop(frozen);
    let frozen = vault.open_frozen(&id).unwrap();
    assert_eq!(frozen.manifest().unwrap(), b"opaque manifest");
    assert_eq!(
        frozen.inventory(&paths, 4).unwrap().as_slice(),
        std::slice::from_ref(&input)
    );
    let cancelled = AtomicBool::new(false);
    let transferred = frozen
        .transfer_owned_input(RetainedInputTransfer {
            paths: &paths,
            owned_root: &root,
            operation: "operation",
            max_bytes: 4,
            cancelled: &cancelled,
        })
        .unwrap();
    assert_eq!(transferred.into_inventory(), [input]);
    let staging = root.join(".pp-imports/operation");
    let sentinel = staging.join("sentinel");
    fs::write(&sentinel, b"preserve").unwrap();
    let local = LocalFiles::open(&staging).unwrap();
    for selected in [&paths[..], &[][..]] {
        assert!(matches!(
            local.capture(selected, &root, "operation", 4, &cancelled),
            Err(Error::InvalidIdentity)
        ));
        assert_eq!(fs::read(&sentinel).unwrap(), b"preserve");
        assert_eq!(fs::read(staging.join("nested/part.stl")).unwrap(), b"mesh");
    }
    frozen.remove(&paths).unwrap();
    assert!(vault.scan().unwrap().is_empty());
    assert_eq!(vault.finish_deleting().unwrap(), 0);
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve");
    assert_eq!(fs::read(staging.join("nested/part.stl")).unwrap(), b"mesh");
}
