use pp_source::{
    Error, SourcePath,
    retained_capture::{
        CaptureCandidate, FreezeResult, FrozenCapture, RetainedCaptureId, RetainedCaptureVault,
        RetainedInputTransfer,
    },
};
use std::{fs, sync::atomic::AtomicBool};

struct FailingReader {
    chunk: Option<&'static [u8]>,
}

impl std::io::Read for FailingReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if let Some(chunk) = self.chunk.take() {
            buffer[..chunk.len()].copy_from_slice(chunk);
            Ok(chunk.len())
        } else {
            Err(std::io::Error::other("owned reader failure"))
        }
    }
}

fn temporary_root(name: &str) -> std::path::PathBuf {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).unwrap();
    let path = std::env::temp_dir().join(format!(
        "pp-retained-integration-{name}-{}-{}",
        std::process::id(),
        hex::encode(random)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn freeze(candidate: CaptureCandidate, manifest: &[u8]) -> FrozenCapture {
    match candidate.freeze_owned(manifest) {
        FreezeResult::Frozen(frozen) => frozen,
        FreezeResult::FrozenWithError { error, .. }
        | FreezeResult::CandidateError { error, .. } => panic!("freeze failed: {error}"),
    }
}

#[test]
fn retained_capture_generated_id_and_freeze_layout() {
    let root = temporary_root("layout");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    assert_eq!(id.len(), 64);
    assert!(
        id.bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    let input = candidate
        .write_file(
            SourcePath::try_from("nested/part.stl".to_owned()).unwrap(),
            b"mesh",
            4,
        )
        .unwrap();
    assert_eq!(candidate.inventory(4).unwrap(), vec![input]);
    let frozen = freeze(candidate, br#"{"manifest_version":1}"#);
    let entries = vault.scan().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].capture_id().as_str(), id);
    assert_eq!(
        entries[0].phase(),
        pp_source::retained_capture::RetainedCapturePhase::Frozen
    );
    assert_eq!(frozen.manifest().unwrap(), br#"{"manifest_version":1}"#);
    assert!(
        root.join("source-captures")
            .join(id)
            .join("frozen/input/nested/part.stl")
            .is_file()
    );
    frozen
        .remove(&[SourcePath::try_from("nested/part.stl".to_owned()).unwrap()])
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_capture_exclusive_no_follow_and_bounds() {
    let root = temporary_root("exclusive");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let path = SourcePath::try_from("part.stl".to_owned()).unwrap();
    candidate.write_file(path.clone(), b"1234", 4).unwrap();
    assert!(matches!(
        candidate.write_file(path, b"x", 5),
        Err(Error::DuplicatePath)
    ));

    let mut candidate = vault.allocate().unwrap();
    let outside = root.join("outside");
    fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(
        &outside,
        root.join("source-captures")
            .join(candidate.capture_id().as_str())
            .join("candidate/input/link.stl"),
    )
    .unwrap();
    assert!(matches!(
        candidate.write_file(
            SourcePath::try_from("link.stl".to_owned()).unwrap(),
            b"x",
            5,
        ),
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists
    ));
    assert_eq!(fs::read(outside).unwrap(), b"outside");

    let mut candidate = vault.allocate().unwrap();
    candidate
        .write_file(
            SourcePath::try_from("part.stl".to_owned()).unwrap(),
            b"1234",
            4,
        )
        .unwrap();
    assert!(matches!(
        candidate.write_file(
            SourcePath::try_from("other.stl".to_owned()).unwrap(),
            b"x",
            4,
        ),
        Err(Error::Limit)
    ));
    assert!(SourcePath::try_from("../escape.stl".to_owned()).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_capture_freeze_sync_order() {
    let root = temporary_root("sync-order");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    candidate
        .write_file(
            SourcePath::try_from("a/b/part.stl".to_owned()).unwrap(),
            b"bytes",
            5,
        )
        .unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    freeze(candidate, b"manifest");
    let slot = root.join("source-captures").join(id);
    assert!(!slot.join("candidate").exists());
    assert_eq!(
        fs::read(slot.join("frozen/capture-manifest.json")).unwrap(),
        b"manifest"
    );
    assert_eq!(
        fs::read(slot.join("frozen/input/a/b/part.stl")).unwrap(),
        b"bytes"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_capture_freeze_refuses_inventory_change() {
    let root = temporary_root("inventory-change");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    candidate
        .write_file(
            SourcePath::try_from("part.stl".to_owned()).unwrap(),
            b"mesh",
            8,
        )
        .unwrap();
    fs::write(
        root.join("source-captures")
            .join(id)
            .join("candidate/input/part.stl"),
        b"mash",
    )
    .unwrap();
    assert!(matches!(
        candidate.freeze_owned(b"manifest"),
        FreezeResult::CandidateError {
            error: Error::CorruptSnapshot,
            ..
        }
    ));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_capture_reader_failure_closes_candidate() {
    let root = temporary_root("reader-failure");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    let error = candidate
        .write_file_from(
            SourcePath::try_from("partial.stl".to_owned()).unwrap(),
            FailingReader {
                chunk: Some(b"partial"),
            },
            1024,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        Error::Io(error) if error.to_string() == "owned reader failure"
    ));
    assert_eq!(
        fs::read(
            root.join("source-captures")
                .join(&id)
                .join("candidate/input/partial.stl")
        )
        .unwrap(),
        b"partial"
    );
    assert!(matches!(
        candidate.write_file(
            SourcePath::try_from("other.stl".to_owned()).unwrap(),
            b"other",
            1024,
        ),
        Err(Error::CorruptSnapshot)
    ));
    candidate.abort().unwrap();
    assert!(vault.scan().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_candidate_abort_preserves_unknown_slot_sibling_as_repair_evidence() {
    let root = temporary_root("candidate-sibling");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    std::fs::write(
        root.join("source-captures").join(&id).join("late-evidence"),
        b"preserve",
    )
    .unwrap();
    let error = candidate.abort().unwrap_err();
    assert_eq!(
        error.receipt().phase(),
        pp_source::retained_capture::RetainedCapturePhase::Candidate
    );
    assert_eq!(
        std::fs::read(root.join("source-captures").join(&id).join("late-evidence")).unwrap(),
        b"preserve"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_candidate_abort_preserves_unknown_file_inside_input() {
    let root = temporary_root("candidate-input-unknown-file");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    candidate
        .write_file(
            SourcePath::try_from("owned.stl".to_owned()).unwrap(),
            b"owned",
            5,
        )
        .unwrap();
    let input = root
        .join("source-captures")
        .join(&id)
        .join("candidate/input");
    fs::write(input.join("foreign.bin"), b"foreign").unwrap();

    let error = candidate.abort().unwrap_err();
    assert_eq!(
        error.receipt().phase(),
        pp_source::retained_capture::RetainedCapturePhase::Deleting
    );
    let deleting = root
        .join("source-captures")
        .join(&id)
        .join("deleting/input");
    assert_eq!(fs::read(deleting.join("foreign.bin")).unwrap(), b"foreign");
    assert!(!deleting.join("owned.stl").exists());

    let reopened = RetainedCaptureVault::open(&root).unwrap();
    assert!(matches!(
        reopened.finish_deleting(),
        Err(Error::CorruptSnapshot)
    ));
    let entries = reopened.scan().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].phase(),
        pp_source::retained_capture::RetainedCapturePhase::Deleting
    );
    assert_eq!(fs::read(deleting.join("foreign.bin")).unwrap(), b"foreign");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_candidate_abort_preserves_symlink_inside_input() {
    let root = temporary_root("candidate-input-symlink");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    candidate
        .write_file(
            SourcePath::try_from("owned.stl".to_owned()).unwrap(),
            b"owned",
            5,
        )
        .unwrap();
    let input = root
        .join("source-captures")
        .join(&id)
        .join("candidate/input");
    let outside = root.join("outside-evidence");
    fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, input.join("foreign-link")).unwrap();

    let error = candidate.abort().unwrap_err();
    assert_eq!(
        error.receipt().phase(),
        pp_source::retained_capture::RetainedCapturePhase::Deleting
    );
    let deleting = root
        .join("source-captures")
        .join(&id)
        .join("deleting/input");
    assert!(fs::symlink_metadata(deleting.join("foreign-link")).is_ok());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    assert!(!deleting.join("owned.stl").exists());

    let reopened = RetainedCaptureVault::open(&root).unwrap();
    assert!(matches!(
        reopened.finish_deleting(),
        Err(Error::CorruptSnapshot)
    ));
    assert!(fs::symlink_metadata(deleting.join("foreign-link")).is_ok());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_candidate_abort_preserves_replaced_leaf_identity() {
    let root = temporary_root("candidate-replaced-leaf");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    let path = root
        .join("source-captures")
        .join(&id)
        .join("candidate/input/part.stl");
    candidate
        .write_file(
            SourcePath::try_from("part.stl".to_owned()).unwrap(),
            b"owned",
            5,
        )
        .unwrap();
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"foreign").unwrap();

    assert!(candidate.abort().is_err());
    assert_eq!(
        fs::read(
            root.join("source-captures")
                .join(&id)
                .join("deleting/input/part.stl")
        )
        .unwrap(),
        b"foreign"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_candidate_abort_preserves_replaced_nested_directory_identity() {
    let root = temporary_root("candidate-replaced-directory");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    let input = root
        .join("source-captures")
        .join(&id)
        .join("candidate/input");
    candidate
        .write_file(
            SourcePath::try_from("nested/part.stl".to_owned()).unwrap(),
            b"owned",
            5,
        )
        .unwrap();
    fs::rename(input.join("nested"), input.join("owned-renamed")).unwrap();
    fs::create_dir(input.join("nested")).unwrap();
    fs::write(input.join("nested/foreign.stl"), b"foreign").unwrap();

    assert!(candidate.abort().is_err());
    assert_eq!(
        fs::read(
            root.join("source-captures")
                .join(&id)
                .join("deleting/input/nested/foreign.stl")
        )
        .unwrap(),
        b"foreign"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_frozen_remove_preserves_nested_unknown_and_symlink_evidence() {
    let root = temporary_root("frozen-nested-evidence");
    let (_id, frozen) = frozen_with_mesh(&root);
    let slot = fs::read_dir(root.join("source-captures"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(slot.join("frozen/input/nested/foreign.bin"), b"foreign").unwrap();
    std::os::unix::fs::symlink(
        root.join("outside"),
        slot.join("frozen/input/nested/foreign-link"),
    )
    .unwrap();
    let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];

    assert!(matches!(frozen.remove(&paths), Err(Error::CorruptSnapshot)));
    assert_eq!(
        fs::read(slot.join("frozen/input/nested/foreign.bin")).unwrap(),
        b"foreign"
    );
    assert!(fs::symlink_metadata(slot.join("frozen/input/nested/foreign-link")).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_frozen_remove_preserves_replaced_leaf_identity() {
    let root = temporary_root("frozen-replaced-leaf");
    let (id, frozen) = frozen_with_mesh(&root);
    let slot = root.join("source-captures").join(&id);
    let path = slot.join("frozen/input/nested/part.stl");
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"foreign").unwrap();
    let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];

    assert!(matches!(frozen.remove(&paths), Err(Error::CorruptSnapshot)));
    assert_eq!(
        fs::read(slot.join("deleting/input/nested/part.stl")).unwrap(),
        b"foreign"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_cleanup_deleting_restart_idempotence() {
    let root = temporary_root("cleanup");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    candidate
        .write_file(
            SourcePath::try_from("part.stl".to_owned()).unwrap(),
            b"mesh",
            4,
        )
        .unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    freeze(candidate, b"manifest");
    let slot = root.join("source-captures").join(&id);
    fs::rename(slot.join("frozen"), slot.join("deleting")).unwrap();
    fs::remove_file(slot.join("deleting/capture-manifest.json")).unwrap();
    fs::remove_file(slot.join("deleting/input/part.stl")).unwrap();
    fs::remove_dir(slot.join("deleting/input")).unwrap();

    let reopened = RetainedCaptureVault::open(&root).unwrap();
    assert_eq!(reopened.finish_deleting().unwrap(), 1);
    assert_eq!(reopened.finish_deleting().unwrap(), 0);
    assert!(!root.join("source-captures").join(id).exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_cleanup_refuses_malformed_slot_and_preserves_siblings() {
    let root = temporary_root("malformed-cleanup");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let id = "cd".repeat(32);
    let slot = root.join("source-captures").join(&id);
    fs::create_dir_all(slot.join("deleting/input")).unwrap();
    fs::write(slot.join("deleting/input/partial.stl"), b"deleting").unwrap();
    fs::create_dir_all(slot.join("frozen/input")).unwrap();
    fs::write(slot.join("frozen/input/evidence.stl"), b"frozen").unwrap();
    fs::write(slot.join("unknown-evidence"), b"unknown").unwrap();

    assert!(matches!(
        vault.finish_deleting(),
        Err(Error::CorruptSnapshot)
    ));
    assert_eq!(
        fs::read(slot.join("deleting/input/partial.stl")).unwrap(),
        b"deleting"
    );
    assert_eq!(
        fs::read(slot.join("frozen/input/evidence.stl")).unwrap(),
        b"frozen"
    );
    assert_eq!(fs::read(slot.join("unknown-evidence")).unwrap(), b"unknown");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_frozen_cleanup_refuses_new_slot_sibling() {
    let root = temporary_root("frozen-malformed");
    let vault = RetainedCaptureVault::open(&root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    candidate
        .write_file(
            SourcePath::try_from("part.stl".to_owned()).unwrap(),
            b"mesh",
            4,
        )
        .unwrap();
    let frozen = freeze(candidate, b"manifest");
    let slot = root.join("source-captures").join(id);
    fs::write(slot.join("unknown-evidence"), b"preserve").unwrap();

    assert!(matches!(
        frozen.remove(&[SourcePath::try_from("part.stl".to_owned()).unwrap()]),
        Err(Error::CorruptSnapshot)
    ));
    assert_eq!(
        fs::read(slot.join("unknown-evidence")).unwrap(),
        b"preserve"
    );
    assert_eq!(
        fs::read(slot.join("frozen/input/part.stl")).unwrap(),
        b"mesh"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_capture_id_parser_is_stricter_than_storage_syntax() {
    assert!(RetainedCaptureId::parse("ab".repeat(32)).is_ok());
    assert!(RetainedCaptureId::parse("AB".repeat(32)).is_err());
    assert!(RetainedCaptureId::parse("capture-policy-proof").is_err());
}

fn frozen_with_mesh(
    root: &std::path::Path,
) -> (String, pp_source::retained_capture::FrozenCapture) {
    let vault = RetainedCaptureVault::open(root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    candidate
        .write_file(
            SourcePath::try_from("nested/part.stl".to_owned()).unwrap(),
            b"mesh",
            4,
        )
        .unwrap();
    (id, freeze(candidate, b"manifest"))
}

#[test]
fn frozen_capture_transfers_to_owned_import_without_exposing_locator() {
    let root = temporary_root("transfer");
    let (id, frozen) = frozen_with_mesh(&root);
    let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];
    let cancelled = AtomicBool::new(false);
    let owned = frozen
        .transfer_owned_input(RetainedInputTransfer {
            paths: &paths,
            owned_root: &root,
            operation: "owned-operation",
            max_bytes: 4,
            cancelled: &cancelled,
        })
        .unwrap();

    assert_eq!(owned.inventory().len(), 1);
    assert_eq!(owned.inventory()[0].path, paths[0]);
    assert_eq!(
        fs::read(root.join(".pp-imports/owned-operation/nested/part.stl")).unwrap(),
        b"mesh"
    );
    assert!(
        root.join("source-captures")
            .join(id)
            .join("frozen")
            .is_dir()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn frozen_capture_transfer_is_bounded_and_cancelable() {
    for (name, max_bytes, cancelled) in [("bounded", 3, false), ("cancelled", 4, true)] {
        let root = temporary_root(name);
        let (id, frozen) = frozen_with_mesh(&root);
        let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];
        let cancelled = AtomicBool::new(cancelled);
        assert!(matches!(
            frozen.transfer_owned_input(RetainedInputTransfer {
                paths: &paths,
                owned_root: &root,
                operation: "owned-operation",
                max_bytes,
                cancelled: &cancelled,
            }),
            Err(Error::Limit)
        ));
        assert!(
            root.join("source-captures")
                .join(id)
                .join("frozen")
                .is_dir()
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn frozen_capture_transfer_rejects_existing_owned_operation() {
    let root = temporary_root("existing-owned");
    let (id, frozen) = frozen_with_mesh(&root);
    fs::create_dir_all(root.join(".pp-imports/owned-operation")).unwrap();
    let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];
    assert!(matches!(
        frozen.transfer_owned_input(RetainedInputTransfer {
            paths: &paths,
            owned_root: &root,
            operation: "owned-operation",
            max_bytes: 4,
            cancelled: &AtomicBool::new(false),
        }),
        Err(Error::InvalidIdentity)
    ));
    assert!(
        root.join("source-captures")
            .join(id)
            .join("frozen")
            .is_dir()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn frozen_capture_remove_after_transfer_ack_deletes_only_capture_slot() {
    let root = temporary_root("transfer-remove");
    let (id, frozen) = frozen_with_mesh(&root);
    let paths = [SourcePath::try_from("nested/part.stl".to_owned()).unwrap()];
    frozen
        .transfer_owned_input(RetainedInputTransfer {
            paths: &paths,
            owned_root: &root,
            operation: "owned-operation",
            max_bytes: 4,
            cancelled: &AtomicBool::new(false),
        })
        .unwrap();

    frozen.remove(&paths).unwrap();
    assert!(!root.join("source-captures").join(id).exists());
    assert_eq!(
        fs::read(root.join(".pp-imports/owned-operation/nested/part.stl")).unwrap(),
        b"mesh"
    );
    fs::remove_dir_all(root).unwrap();
}
