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
    let slot = root.join("source-captures").join(id.as_str());
    for directory in [&slot, &slot.join("frozen")] {
        let sibling = directory.join("evidence");
        fs::write(&sibling, b"preserve").unwrap();
        assert!(matches!(
            vault.open_frozen(&id),
            Err(Error::CorruptSnapshot)
        ));
        assert_eq!(fs::read(&sibling).unwrap(), b"preserve");
        fs::remove_file(sibling).unwrap();
    }
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
    let empty = SourcePath::try_from("empty".to_owned()).unwrap();
    fs::write(staging.join("empty"), []).unwrap();
    let repeated = vec![empty; pp_source::MAX_ENTRIES + 1];
    let missing = vec![SourcePath::try_from("absent".to_owned()).unwrap(); 2];
    for (selected, operation, category) in [
        (&repeated[..], "overlimit", "limit"),
        (&repeated[..2], "duplicate", "duplicate-path"),
        (&missing[..], "duplicate", "duplicate-path"),
    ] {
        let inventory = local.inventory(selected, 0);
        let capture = local.capture(selected, &root, operation, 0, &cancelled);
        for result in [inventory.map(|_| ()), capture.map(|_| ())] {
            assert_eq!(result.err().unwrap().category(), category);
        }
        assert!(!root.join(".pp-imports").join(operation).exists());
    }
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
