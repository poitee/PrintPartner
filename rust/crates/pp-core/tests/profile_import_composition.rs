use pp_core::profile_interpreter::{ProfileDocument, ProfileInterpretation, interpret_profile};
use pp_storage::{
    Limits, WriterOwner,
    profiles::{ProfileKind, ProfileLibraryRequest, SlicerKind},
};
use std::{sync::atomic::AtomicBool, time::Duration};

#[test]
fn interpreted_ready_parent_resolution_and_fallback_import_through_the_local_owner() {
    let root =
        std::env::temp_dir().join(format!("pp-profile-composition-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&root).unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let ready = interpret_profile(
        ProfileDocument::new(
            include_bytes!("fixtures/profile-import-writer/ready.json"),
            ProfileKind::Printer,
            SlicerKind::Orca,
            "fixtures/ready.json",
        )
        .unwrap(),
    )
    .unwrap();
    let pending_with_parent = interpret_profile(
        ProfileDocument::new(
            include_bytes!("fixtures/profile-import-writer/needs-parent.json"),
            ProfileKind::Process,
            SlicerKind::Prusa,
            "fixtures/needs-parent.json",
        )
        .unwrap(),
    )
    .unwrap();
    let pending_without_parent = interpret_profile(
        ProfileDocument::new(
            include_bytes!("fixtures/profile-import-writer/needs-parent.json"),
            ProfileKind::Process,
            SlicerKind::Prusa,
            "fixtures/needs-parent-fallback.json",
        )
        .unwrap(),
    )
    .unwrap();
    let ready = match ready {
        ProfileInterpretation::Ready(value) => value,
        ProfileInterpretation::NeedsParent(_) => panic!("ready fixture needs a parent"),
    };
    let resolved = match pending_with_parent {
        ProfileInterpretation::NeedsParent(value) => value
            .finish_with_parent(br#"{"name":"Resolved Parent","parent_setting":"yes"}"#)
            .unwrap(),
        ProfileInterpretation::Ready(_) => panic!("parent fixture was ready"),
    };
    let fallback = match pending_without_parent {
        ProfileInterpretation::NeedsParent(value) => value.finish_without_parent().unwrap(),
        ProfileInterpretation::Ready(_) => panic!("parent fixture was ready"),
    };
    let cancelled = AtomicBool::new(false);
    let importer = owner.local_profile_importer();
    importer
        .import(ready, &cancelled, Duration::from_secs(1))
        .unwrap();
    let resolved_receipt = importer
        .import(resolved, &cancelled, Duration::from_secs(1))
        .unwrap();
    let fallback_receipt = importer
        .import(fallback, &cancelled, Duration::from_secs(1))
        .unwrap();
    assert_eq!(resolved_receipt.identity(), fallback_receipt.identity());
    assert_eq!(resolved_receipt.identity().kind(), ProfileKind::Process);
    assert!(
        owner
            .local_profile_library()
            .read(ProfileLibraryRequest, &cancelled, Duration::from_secs(1))
            .unwrap()
            .profiles()
            .len()
            >= 2
    );
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
