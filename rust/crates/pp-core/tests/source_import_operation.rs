use pp_core::uploads::{SourceImports, Through};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::{self, CreateSource, SourcePatch},
    jobs::{self, Credential},
    uploads::{
        Admission, AdmissionLimits, CaptureId, CapturedInputV2, CapturedPayloadV1, File, Input,
        Phase, Postprocessing, State, Target,
    },
};
use rusqlite::{Connection, OpenFlags};
use sha2::Digest;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}
fn temp() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "source-import-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn fixture() -> (PathBuf, PathBuf, WriterOwner) {
    let root = temp();
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Ordinary Source\n").unwrap();
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.version, 37);
    (root, files, owner)
}
fn request(key: &str, target: Target) -> Admission {
    Admission {
        key: key.into(),
        target,
        input: Input::Files {
            paths: vec!["triangle.stl".into(), "README.md".into()],
        },
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 65536,
        max_prepared_bytes: 65536,
    }
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}
fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}
fn zip_bytes(name: &str, content: &[u8]) -> Vec<u8> {
    let name = name.as_bytes();
    let size = u32::try_from(content.len()).unwrap();
    let checksum = crc32(content);
    let mut output = Vec::new();
    push_u32(&mut output, 0x0403_4b50);
    push_u16(&mut output, 20);
    push_u16(&mut output, 0x0800);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, checksum);
    push_u32(&mut output, size);
    push_u32(&mut output, size);
    push_u16(&mut output, u16::try_from(name.len()).unwrap());
    push_u16(&mut output, 0);
    output.extend_from_slice(name);
    output.extend_from_slice(content);
    let central_offset = u32::try_from(output.len()).unwrap();
    push_u32(&mut output, 0x0201_4b50);
    push_u16(&mut output, 20);
    push_u16(&mut output, 20);
    push_u16(&mut output, 0x0800);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, checksum);
    push_u32(&mut output, size);
    push_u32(&mut output, size);
    push_u16(&mut output, u16::try_from(name.len()).unwrap());
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u32(&mut output, 0);
    push_u32(&mut output, 0);
    output.extend_from_slice(name);
    let central_size = u32::try_from(output.len()).unwrap() - central_offset;
    push_u32(&mut output, 0x0605_4b50);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, 1);
    push_u16(&mut output, 1);
    push_u32(&mut output, central_size);
    push_u32(&mut output, central_offset);
    push_u16(&mut output, 0);
    output
}
fn captured_zip_request(key: &str, target: Target, zip: &[u8]) -> Admission {
    let limits = AdmissionLimits {
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 65536,
        max_prepared_bytes: 65536,
    };
    let requested = vec![File {
        path: "upload.zip".into(),
        size: zip.len().try_into().unwrap(),
        sha256: hex::encode(sha2::Sha256::digest(zip)),
        kind: "input".into(),
    }];
    let input = Input::Captured(
        CapturedInputV2::bind(
            CaptureId::new(format!("capture-{key}")).unwrap(),
            CapturedPayloadV1::zip("upload.zip".into()),
            "physical-owner",
            key,
            &target,
            limits,
            &requested,
        )
        .unwrap(),
    );
    Admission {
        key: key.into(),
        target,
        input,
        reserved_bytes: limits.reserved_bytes,
        max_input_bytes: limits.max_input_bytes,
        max_prepared_bytes: limits.max_prepared_bytes,
    }
}
fn create(name: &str) -> Target {
    Target::Create {
        metadata: Box::new(CreateSource {
            name: name.into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            ..Default::default()
        }),
    }
}
fn credential(owner: &WriterOwner) -> Credential {
    Credential::PhysicalOwner(owner.job_physical_owner())
}
fn service(owner: &WriterOwner) -> SourceImports {
    SourceImports::new(owner, policy(), 128 * 1024 * 1024).unwrap()
}
fn read(root: &Path) -> Connection {
    Connection::open_with_flags(
        root.join("print-partner.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
fn count(root: &Path, table: &str) -> i64 {
    read(root)
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn cancel(owner: &WriterOwner, id: String) {
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(owner),
            jobs::UserOperation::Cancel { job_id: id },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
}
#[test]
fn create_update_exact_retry_never_repoints_and_preserves_originals() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(admitted.state, State::Admitted);
    let first = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(first.receipt.as_ref().unwrap().activated);
    assert!(first.cleanup_settled);
    assert_eq!(
        first.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert_eq!(count(&root, "source_docs"), 1);
    assert_eq!(count(&root, "source_revisions"), 1);
    let old = first.artifact.as_ref().unwrap();
    let old_bytes =
        std::fs::read(root.join("repos").join(&old.locator).join("triangle.stl")).unwrap();
    assert_eq!(
        old_bytes,
        include_bytes!("fixtures/source-import/triangle.stl")
    );
    let retry = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(retry, first);
    let unchanged_admitted = svc
        .admit(
            credential(&owner),
            request(
                "unchanged",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let unchanged = svc
        .work_operation(
            &unchanged_admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        unchanged.receipt.as_ref().unwrap().revision_id,
        first.receipt.as_ref().unwrap().revision_id
    );
    assert_eq!(count(&root, "source_revisions"), 1);
    std::fs::write(
        files.join("triangle.stl"),
        String::from_utf8(old_bytes.clone())
            .unwrap()
            .replace("vertex 1 0 0", "vertex 2 0 0"),
    )
    .unwrap();
    let second_admitted = svc
        .admit(
            credential(&owner),
            request(
                "two",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let second = svc
        .work_operation(
            &second_admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_ne!(
        second.artifact.as_ref().unwrap().upstream_key,
        old.upstream_key
    );
    assert_eq!(count(&root, "source_revisions"), 2);
    assert_eq!(svc.get(credential(&owner), "one".into()).unwrap(), first);
    let current: i64 = read(&root)
        .query_row(
            "SELECT current_source_revision_id FROM projects WHERE id=?1",
            [first.source_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, second.receipt.unwrap().revision_id);
    assert_eq!(
        std::fs::read(root.join("repos").join(&old.locator).join("triangle.stl")).unwrap(),
        old_bytes
    );
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete {
                id: first.source_id
            })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::RetainedHistory)
    ));
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn restart_each_durable_fact_and_exact_activation_acknowledgement() {
    for through in [
        None,
        Some(Through::OwnedInput),
        Some(Through::Published),
        Some(Through::Activated),
    ] {
        let (root, files, owner) = fixture();
        let svc = service(&owner);
        let admitted = svc
            .admit(
                credential(&owner),
                request("restart", create("Restart")),
                &files,
                &AtomicBool::new(false),
            )
            .unwrap();
        let before = through.map(|t| {
            svc.work_operation(&admitted.job_id, Some(&files), t, &AtomicBool::new(false))
                .unwrap()
                .unwrap()
        });
        assert!(matches!(
            owner
                .local_source_catalog()
                .execute(catalog::Request::Delete {
                    id: admitted.source_id
                })
                .unwrap(),
            catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
        ));
        drop(svc);
        owner.shutdown().unwrap();
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let svc = service(&owner);
        assert!(matches!(
            owner
                .local_source_catalog()
                .execute(catalog::Request::Delete {
                    id: admitted.source_id
                })
                .unwrap(),
            catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
        ));
        let resumed = if through.is_none() {
            svc.work_operation(
                &admitted.job_id,
                Some(&files),
                Through::Settled,
                &AtomicBool::new(false),
            )
        } else {
            svc.work_next(Through::Settled, &AtomicBool::new(false))
        }
        .unwrap()
        .unwrap();
        assert_eq!(resumed.source_id, admitted.source_id);
        assert!(resumed.cleanup_settled);
        if let Some(receipt) = before.and_then(|o| o.receipt) {
            assert_eq!(resumed.receipt.unwrap(), receipt);
        }
        assert_eq!(count(&root, "source_revisions"), 1);
        assert_eq!(
            read(&root)
                .query_row(
                    "SELECT SUM(reserved_bytes) FROM source_import_quota",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(svc);
        owner.shutdown().unwrap();
    }
}
#[test]
fn captured_zip_has_explicit_ready_only_ownership_and_nfc_replay() {
    let (root, files, owner) = fixture();
    let zip = zip_bytes(
        "cafe\u{301}.stl",
        include_bytes!("fixtures/source-import/triangle.stl"),
    );
    std::fs::write(files.join("upload.zip"), &zip).unwrap();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            captured_zip_request("captured-zip", create("Captured ZIP"), &zip),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(admitted.input_version, 2);
    let ordinary_worker = owner
        .job_worker(jobs::WorkerAdmission {
            kinds: vec![(jobs::JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    assert!(ordinary_worker.claim().unwrap().is_none());
    assert!(
        svc.work_next(Through::OwnedInput, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        svc.get(credential(&owner), admitted.key.clone())
            .unwrap()
            .state,
        State::Admitted
    );
    let settled = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(settled.cleanup_settled);
    assert!(
        settled
            .artifact
            .as_ref()
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == "caf\u{e9}.stl")
    );
    assert_eq!(
        settled.requested_digest,
        hex::encode(sha2::Sha256::digest(
            serde_json::to_vec(&settled.requested_files).unwrap()
        ))
    );
    let (quota_reserved, quota_settled): (i64, bool) = read(&root)
        .query_row(
            "SELECT reserved_bytes,settled FROM source_import_quota WHERE operation_key=?1",
            [&settled.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(quota_reserved, 0);
    assert!(quota_settled);
    assert_eq!(settled.reserved_bytes, 20 * 1024 * 1024);
    drop(svc);
    owner.shutdown().unwrap();

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    assert_eq!(
        svc.get(credential(&owner), settled.key.clone()).unwrap(),
        settled
    );
    let legacy = svc
        .admit(
            credential(&owner),
            Admission {
                key: "legacy-strict-zip".into(),
                target: create("Legacy Strict ZIP"),
                input: Input::Zip {
                    path: "upload.zip".into(),
                },
                reserved_bytes: 20 * 1024 * 1024,
                max_input_bytes: 65536,
                max_prepared_bytes: 65536,
            },
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.work_operation(
            &legacy.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    assert_eq!(
        svc.get(credential(&owner), legacy.key).unwrap().state,
        State::Failed
    );
    drop(svc);
    owner.shutdown().unwrap();
}

#[test]
fn archived_captured_job_reopens_and_rejects_future_payload_version_without_mutation() {
    let (root, files, owner) = fixture();
    let zip = zip_bytes(
        "archived.stl",
        include_bytes!("fixtures/source-import/triangle.stl"),
    );
    std::fs::write(files.join("upload.zip"), &zip).unwrap();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            captured_zip_request("captured-archive", create("Captured Archive"), &zip),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let settled = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(settled.cleanup_settled);
    drop(svc);
    owner.shutdown().unwrap();

    let database = root.join("print-partner.db");
    let connection = Connection::open(&database).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT document FROM durable_jobs WHERE id=?1",
            [&admitted.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut job: serde_json::Value = serde_json::from_str(&raw).unwrap();
    job["updated_at"] = serde_json::json!(0);
    connection
        .execute(
            "UPDATE durable_jobs SET updated=0,document=?2 WHERE id=?1",
            (&admitted.job_id, serde_json::to_string(&job).unwrap()),
        )
        .unwrap();
    drop(connection);

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    owner.shutdown().unwrap();
    let connection = Connection::open(&database).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM durable_jobs WHERE id=?1",
                [&admitted.job_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert!(
        connection
            .query_row(
                "SELECT archived_document IS NOT NULL FROM durable_job_keys WHERE job_id=?1",
                [&admitted.job_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
    );
    drop(connection);

    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(
        service(&owner)
            .get(credential(&owner), admitted.key.clone())
            .unwrap(),
        settled
    );
    owner.shutdown().unwrap();

    let connection = Connection::open(&database).unwrap();
    let archived: String = connection
        .query_row(
            "SELECT archived_document FROM durable_job_keys WHERE job_id=?1",
            [&admitted.job_id],
            |row| row.get(0),
        )
        .unwrap();
    let mut future: serde_json::Value = serde_json::from_str(&archived).unwrap();
    future["payload_version"] = serde_json::json!(2);
    connection
        .execute(
            "UPDATE durable_job_keys SET archived_document=?2 WHERE job_id=?1",
            (&admitted.job_id, serde_json::to_string(&future).unwrap()),
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&database).unwrap();
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert!(!root.join(".desktop-owner.json").exists());
}
#[test]
fn metadata_cas_conflict_keeps_inactive_revision() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("conflict", create("Conflict")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    svc.work_operation(
        &op.job_id,
        Some(&files),
        Through::Published,
        &AtomicBool::new(false),
    )
    .unwrap();
    owner
        .local_source_catalog()
        .execute(catalog::Request::Update {
            id: op.source_id,
            patch: SourcePatch {
                branch: Some("newer".into()),
                ..Default::default()
            },
        })
        .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let result = svc
        .work_next(Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(result.state, State::Conflict);
    assert!(!result.receipt.as_ref().unwrap().activated);
    assert_eq!(
        result.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::NotActivated
    );
    assert_eq!(count(&root, "source_revisions"), 1);
    let row: (String, Option<i64>) = read(&root)
        .query_row(
            "SELECT branch,current_source_revision_id FROM projects WHERE id=?1",
            [op.source_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("newer".into(), None));
    assert_eq!(count(&root, "source_docs"), 0);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn quota_atomic_admission_missing_duplicate_cancelled_and_unsupported() {
    let (root, files, owner) = fixture();
    let tiny = SourceImports::new(&owner, policy(), 1024).unwrap();
    assert!(
        tiny.admit(
            credential(&owner),
            request("tiny", create("Tiny")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "projects"), 0);
    drop(tiny);
    owner.shutdown().unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = SourceImports::new(&owner, policy(), 30 * 1024 * 1024).unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("missing", Target::Existing { source_id: 999 }),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.admit(
            credential(&owner),
            request("cancelled", create("Cancelled")),
            &files,
            &AtomicBool::new(true)
        )
        .is_err()
    );
    let one = svc
        .admit(
            credential(&owner),
            request("one", create("One")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("two", create("Two")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let other_token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "other-tenant@example.test".into(),
            display_name: "Other tenant".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token,
        _ => panic!("session"),
    };
    assert!(
        svc.admit(
            Credential::Session(other_token),
            request("other-tenant", create("Other tenant")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "projects"), 1);
    assert_eq!(count(&root, "source_import_quota"), 1);
    assert_eq!(count(&root, "durable_jobs"), 1);
    let revisions = root
        .join("repos")
        .join(one.source_id.to_string())
        .join("revisions");
    for candidate in [
        ".pp-source-archives/.candidate",
        ".pp-source-media/.candidate",
        ".pp-source-candidate",
    ] {
        let path = revisions.join(candidate);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("ordinary.txt"), "ordinary pending staging").unwrap();
    }
    cancel(&owner, one.job_id.clone());
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: one.source_id })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    let cancelled = svc
        .work_operation(&one.job_id, None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert!(cancelled.cleanup_settled);
    assert!(cancelled.receipt.is_none());
    for candidate in [
        ".pp-source-archives/.candidate",
        ".pp-source-media/.candidate",
        ".pp-source-candidate",
    ] {
        assert!(!revisions.join(candidate).exists());
    }
    assert!(
        svc.admit(
            credential(&owner),
            request("duplicate", create("One")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    std::fs::write(files.join("notes.txt"), "ordinary unsupported text").unwrap();
    let mut unsupported = request("unsupported", create("Unsupported"));
    unsupported.input = Input::Files {
        paths: vec!["notes.txt".into()],
    };
    let op = svc
        .admit(
            credential(&owner),
            unsupported,
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.work_operation(
            &op.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    let failed = svc.get(credential(&owner), op.key).unwrap();
    assert_eq!(failed.state, State::Failed);
    assert!(failed.cleanup_settled);
    assert_eq!(
        std::fs::read_to_string(files.join("notes.txt")).unwrap(),
        "ordinary unsupported text"
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn stale_attempt_cannot_write_import_phases() {
    let (_root, files, owner) = fixture();
    let svc = service(&owner);
    let op = svc
        .admit(
            credential(&owner),
            request("stale", create("Stale")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker(jobs::WorkerAdmission {
            kinds: vec![(jobs::JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let (_, lease) = worker.claim_import(&op.job_id).unwrap().unwrap();
    cancel(&owner, op.job_id.clone());
    assert!(worker.import_phase(&lease, Phase::Read).is_err());
    assert!(
        worker
            .begin_source_work(
                &lease,
                None,
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .is_err()
    );
    let done = svc
        .work_operation(&op.job_id, None, Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(done.state, State::Cancelled);
    drop(svc);
    owner.shutdown().unwrap();
}
fn auth_call(owner: &WriterOwner, p: AuthPolicy, r: auth::Request) -> auth::Outcome {
    owner
        .auth_with_policy(p)
        .unwrap()
        .submit(r, Arc::new(AtomicBool::new(false)), Duration::from_secs(5))
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
}
#[test]
fn real_session_policy_key_actor_replay_revocation_and_atomic_audit() {
    let (root, files, owner) = fixture();
    let strict = AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
        first_user: FirstUserTenant::NewUser,
    };
    let (user, token) = match auth_call(
        &owner,
        strict,
        auth::Request::Register {
            email: "source@example.test".into(),
            display_name: "Source user".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { user, token } => (user, token.expose().to_owned()),
        _ => panic!("session"),
    };
    let svc = SourceImports::new(&owner, strict, 128 * 1024 * 1024).unwrap();
    let admitted = svc
        .admit(
            Credential::Session(Secret::new(token.clone())),
            request("session", create("Session")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let activated = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(activated.state, State::Activated);
    assert_eq!(admitted.tenant, "default");
    assert_eq!(admitted.actor, format!("user:{}", user.user_id));
    assert!(svc.get(credential(&owner), "session".into()).is_err());
    assert!(
        svc.admit(
            credential(&owner),
            request("session", create("Session")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.admit(
            Credential::Session(Secret::new(token.clone())),
            request("session", create("Different intent")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let neutral = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    assert!(
        neutral
            .get(
                Credential::Session(Secret::new(token.clone())),
                "session".into()
            )
            .is_err()
    );
    let (key_id, key) = match auth_call(
        &owner,
        strict,
        auth::Request::CreateKey {
            session: Secret::new(token.clone()),
        },
    ) {
        auth::Outcome::KeyCreated { info, key } => (info.id, key.expose().to_owned()),
        _ => panic!("key"),
    };
    let before: Option<String> = read(&root)
        .query_row(
            "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1' AND ?1 IS NOT NULL",
            [&key_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        svc.admit(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone())
            },
            request("bad-key-import", Target::Existing { source_id: 999 }),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let after: Option<String> = read(&root)
        .query_row(
            "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1' AND ?1 IS NOT NULL",
            [&key_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert!(
        svc.admit(
            Credential::RoutedKey {
                tenant: user.user_id.clone(),
                key: Secret::new(key.clone())
            },
            request("wrong-route", create("Wrong")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let keyed = svc
        .admit(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone()),
            },
            request("key", create("Key")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        svc.work_operation(
            &keyed.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false)
        )
        .unwrap()
        .unwrap()
        .state,
        State::Activated
    );
    assert_ne!(keyed.actor, admitted.actor);
    assert!(
        svc.get(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key.clone())
            },
            "session".into()
        )
        .is_err()
    );
    auth_call(
        &owner,
        strict,
        auth::Request::RevokeKey {
            session: Secret::new(token.clone()),
            key_id,
        },
    );
    assert!(
        svc.get(
            Credential::RoutedKey {
                tenant: "default".into(),
                key: Secret::new(key)
            },
            "key".into()
        )
        .is_err()
    );
    auth_call(
        &owner,
        strict,
        auth::Request::Logout {
            token: Secret::new(token.clone()),
        },
    );
    assert!(
        svc.get(Credential::Session(Secret::new(token)), "session".into())
            .is_err()
    );
    drop(neutral);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn changed_content_replay_and_changed_during_capture_are_refused() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let first = svc
        .admit(
            credential(&owner),
            request("bound", create("Bound")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let original = std::fs::read(files.join("triangle.stl")).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        String::from_utf8(original.clone())
            .unwrap()
            .replace("vertex 1 0 0", "vertex 3 0 0"),
    )
    .unwrap();
    assert!(
        svc.admit(
            credential(&owner),
            request("bound", create("Bound")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        svc.work_operation(
            &first.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    let failed = svc.get(credential(&owner), first.key).unwrap();
    assert_eq!(failed.state, State::Failed);
    assert_eq!(count(&root, "source_revisions"), 0);
    assert!(failed.cleanup_settled);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn schema37_backup_preserves35_and_future_or_corrupt_input_is_unchanged() {
    let (root, _files, owner) = fixture();
    owner.shutdown().unwrap();
    let db = root.join("print-partner.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    drop(conn);
    let before =
        graph(&Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap());
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(
        graph(
            &Connection::open_with_flags(ready.backup.unwrap(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap()
        ),
        before
    );
    owner.shutdown().unwrap();
    Connection::open(&db)
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let future = temp();
    std::fs::copy(&db, future.join("print-partner.db")).unwrap();
    let conn = Connection::open(future.join("print-partner.db")).unwrap();
    conn.execute(
        "UPDATE app_settings SET value='38' WHERE tenant_id='default' AND key='schema_version'",
        [],
    )
    .unwrap();
    drop(conn);
    let bytes = std::fs::read(future.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&future, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(future.join("print-partner.db")).unwrap(),
        bytes
    );
    assert!(!future.join(".desktop-owner.json").exists());
    let corrupt = temp();
    std::fs::copy(&db, corrupt.join("print-partner.db")).unwrap();
    let conn = Connection::open(corrupt.join("print-partner.db")).unwrap();
    conn.execute("DROP INDEX source_import_source", []).unwrap();
    drop(conn);
    let bytes = std::fs::read(corrupt.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&corrupt, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(corrupt.join("print-partner.db")).unwrap(),
        bytes
    );
    assert!(!corrupt.join(".desktop-owner.json").exists());
}

fn graph(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut query = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let n = query.column_count();
            let mut rows = query
                .query_map([], |r| {
                    let values = (0..n)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(format!("{values:?}"))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows.sort();
            (table, rows)
        })
        .collect()
}
#[test]
fn settlement_invalidates_stale_physical_usage_observation() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("first", create("First")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let stale = client.accounting_epoch();
    let old_bytes = pp_source::local_selection::stored_bytes(&root.join("repos")).unwrap();
    svc.work_operation(
        &admitted.job_id,
        Some(&files),
        Through::Settled,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        client
            .admit(
                credential(&owner),
                request("second", create("Second")),
                admitted.requested_files.clone(),
                old_bytes,
                stale,
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert_eq!(count(&root, "projects"), 1);
    let epoch = client.accounting_epoch();
    let bytes = pp_source::local_selection::stored_bytes(&root.join("repos")).unwrap();
    client
        .admit(
            credential(&owner),
            request("second", create("Second")),
            admitted.requested_files,
            bytes,
            epoch,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(count(&root, "projects"), 2);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn cancellation_after_activation_preserves_receipt_and_settles_cleanup() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("activated", create("Activated")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let activated = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Activated,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    cancel(&owner, activated.job_id);
    let settled = svc
        .work_next(Through::Settled, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(settled.receipt, activated.receipt);
    assert_eq!(settled.state, State::Activated);
    assert!(settled.cleanup_settled);
    assert_eq!(count(&root, "source_revisions"), 1);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn public_import_selects_its_own_job_and_directory_content() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let other = svc
        .admit(
            credential(&owner),
            request("other", create("Other")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let mut req = request("public", create("Public"));
    req.input = SourceImports::directory_input(&files).unwrap();
    let op = svc
        .import(credential(&owner), req, &files, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(op.key, "public");
    assert_eq!(op.state, State::Activated);
    let pending = svc.get(credential(&owner), other.key).unwrap();
    assert_eq!(pending.state, State::Admitted);
    assert_eq!(count(&root, "source_revisions"), 1);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn index_constraint_keeps_activation_receipt_and_previous_complete_doc_projection() {
    let (root, files, owner) = fixture();
    let svc = service(&owner);
    let first = svc
        .import(
            credential(&owner),
            request("initial", create("Docs")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let old_docs = read(&root)
        .prepare("SELECT id,path,content_hash FROM source_docs")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER ordinary_doc_constraint BEFORE INSERT ON source_docs WHEN NEW.path='README.md' BEGIN SELECT RAISE(ABORT,'ordinary document constraint'); END;").unwrap();
    drop(conn);
    std::fs::write(files.join("README.md"), "# Updated document\n").unwrap();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let svc = service(&owner);
    let op = svc
        .import(
            credential(&owner),
            request(
                "update",
                Target::Existing {
                    source_id: first.source_id,
                },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(op.state, State::Activated);
    assert_eq!(
        op.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::IndexError
    );
    let docs = read(&root)
        .prepare("SELECT id,path,content_hash FROM source_docs")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(old_docs, docs);
    assert_eq!(
        svc.get(credential(&owner), op.key.clone()).unwrap().receipt,
        op.receipt
    );
    drop(svc);
    owner.shutdown().unwrap();
}

fn progress_history_fixture() -> (PathBuf, PathBuf, WriterOwner) {
    let root = temp();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("../../pp-storage/tests/fixtures/required-units/shrink.db"),
    )
    .unwrap();
    let repos = root.join("repos/1/revisions/fixture");
    std::fs::create_dir_all(&repos).unwrap();
    for name in ["bracket", "gear", "excluded"] {
        std::fs::write(repos.join(format!("{name}.stl")), format!("solid {name}")).unwrap();
    }
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Changed Source\n").unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    (root, files, owner)
}
fn progress_secret() -> Secret {
    Secret::new("required-unit-fixture-secret".into())
}
fn select_progress(owner: &WriterOwner) -> serde_json::Value {
    let case: serde_json::Value = serde_json::from_str(include_str!(
        "../../pp-storage/tests/fixtures/required-units/shrink.json"
    ))
    .unwrap();
    let command = pp_storage::required_units::ReconciliationCommand::new(
        serde_json::from_value(serde_json::json!(1)).unwrap(),
        serde_json::from_value(serde_json::json!(2)).unwrap(),
        serde_json::from_value(case["request"].clone()).unwrap(),
        "source-progress-selection".into(),
        pp_storage::read_model::Credential::Session(progress_secret()),
    )
    .unwrap();
    serde_json::to_value(
        owner
            .required_units()
            .reconcile(command, &AtomicBool::new(false), Duration::from_secs(5))
            .unwrap(),
    )
    .unwrap()
}
fn complete_progress(owner: &WriterOwner) {
    let response = owner
        .checkoff_progress()
        .apply(
            catalog::Credentials::Session(progress_secret()),
            pp_storage::checkoff_progress::Request::CompletionCoordinate {
                part_id: 1,
                body: serde_json::json!({"unit_index":1,"completed":true}),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(response.status, 200);
}
fn pinned_accepted(owner: &WriterOwner) -> serde_json::Value {
    let batch = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(progress_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let accepted = serde_json::to_value(&batch.builds[0].accepted).unwrap();
    assert_eq!(accepted["kind"], "ready");
    accepted
}
#[test]
fn combined_pending_import_allows_progress_and_selection_then_preserves_pinned_history() {
    let (root, files, owner) = progress_history_fixture();
    let key = match auth_call(
        &owner,
        policy(),
        auth::Request::CreateKey {
            session: progress_secret(),
        },
    ) {
        auth::Outcome::KeyCreated { key, .. } => key.expose().to_owned(),
        _ => panic!("key"),
    };
    let key_credential = || Credential::RoutedKey {
        tenant: "default".into(),
        key: Secret::new(key.clone()),
    };
    let svc = service(&owner);
    let op = svc
        .admit(
            key_credential(),
            request("combined", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(op.actor.starts_with("key:"));
    assert!(!op.cleanup_settled);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    assert!(
        owner
            .jobs(policy())
            .unwrap()
            .submit(
                credential(&owner),
                jobs::UserOperation::Enqueue {
                    key: "generic-import".into(),
                    payload_version: 1,
                    payload: jobs::Payload::SuppliedSourceImport {
                        project_id: 1,
                        operation_key: "bypass".into(),
                        input_version: 1
                    },
                },
                &AtomicBool::new(false),
                Duration::from_secs(5)
            )
            .is_err()
    );
    complete_progress(&owner);
    let selected = select_progress(&owner);
    assert_eq!(selected["kind"], "ready");
    let accepted = pinned_accepted(&owner);
    let before = graph(&read(&root));
    let old_bytes = std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap();
    let completed = svc
        .work_operation(
            &op.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert!(completed.receipt.as_ref().unwrap().activated && completed.cleanup_settled);
    assert_ne!(completed.receipt.as_ref().unwrap().revision_id, 1);
    assert_eq!(pinned_accepted(&owner), accepted);
    assert_eq!(select_progress(&owner), selected);
    let after = graph(&read(&root));
    for (table, rows) in &before {
        if table.starts_with("plan_")
            || table.starts_with("accepted_")
            || ["parts", "required_units", "print_progress"].contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
    assert_eq!(
        std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap(),
        old_bytes
    );
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT COUNT(*) FROM source_docs WHERE project_id=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(read(&root).query_row("SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'", [], |r| r.get::<_,Option<String>>(0)).unwrap().is_some());
    assert_eq!(
        svc.get(key_credential(), "combined".into()).unwrap(),
        completed
    );
    drop(svc);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    assert_eq!(pinned_accepted(&owner), accepted);
    assert_eq!(select_progress(&owner), selected);
    let svc = service(&owner);
    assert_eq!(
        svc.get(key_credential(), "combined".into()).unwrap(),
        completed
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn combined_schema37_backup_preserves_selected_progress_and_jobs35_graph() {
    let (root, _, owner) = progress_history_fixture();
    complete_progress(&owner);
    let selected = select_progress(&owner);
    owner
        .jobs(policy())
        .unwrap()
        .submit(
            credential(&owner),
            jobs::UserOperation::Enqueue {
                key: "prior35".into(),
                payload_version: 1,
                payload: jobs::Payload::ImportScan { project_id: 1 },
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap();
    owner.shutdown().unwrap();
    let db = root.join("print-partner.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let before = graph(&conn);
    drop(conn);
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(ready.version, 37);
    let backup_copy = root.join("backup-copy.db");
    std::fs::copy(ready.backup.unwrap(), &backup_copy).unwrap();
    assert_eq!(graph(&Connection::open(backup_copy).unwrap()), before);
    assert_eq!(select_progress(&owner), selected);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    assert_eq!(count(&root, "source_import_operations"), 0);
    assert_eq!(count(&root, "durable_jobs"), 1);
    owner.shutdown().unwrap();
}
#[test]
fn combined_obsolete_receipt_refuses_without_changing_progress_history() {
    let (root, files, owner) = progress_history_fixture();
    complete_progress(&owner);
    assert_eq!(select_progress(&owner)["kind"], "ready");
    let svc = service(&owner);
    svc.import(
        credential(&owner),
        request("obsolete", Target::Existing { source_id: 1 }),
        &files,
        &AtomicBool::new(false),
    )
    .unwrap();
    drop(svc);
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute("UPDATE source_import_operations SET document=json_set(document,'$.receipt.postprocessing','complete')", []).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(conn);
    let before = std::fs::read(root.join("print-partner.db")).unwrap();
    assert!(WriterOwner::open(&root, Limits::default()).is_err());
    assert_eq!(
        std::fs::read(root.join("print-partner.db")).unwrap(),
        before
    );
    assert!(!root.join(".desktop-owner.json").exists());
}

#[test]
fn combined_owner_quota_crosses_tenants_while_local_progress_remains_available() {
    let (root, files, owner) = progress_history_fixture();
    let svc = SourceImports::new(&owner, policy(), 30 * 1024 * 1024).unwrap();
    let token = match auth_call(
        &owner,
        policy(),
        auth::Request::Register {
            email: "shared-capacity@example.test".into(),
            display_name: "Other tenant".into(),
            password: Secret::new("ordinary-password".into()),
        },
    ) {
        auth::Outcome::Session { token, .. } => token.expose().to_owned(),
        _ => panic!("session"),
    };
    let foreign = || Credential::Session(Secret::new(token.clone()));
    let pending = svc
        .admit(
            credential(&owner),
            request("pending-default", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        svc.admit(
            foreign(),
            request("foreign", create("Foreign")),
            &files,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(count(&root, "source_import_quota"), 1);
    complete_progress(&owner);
    let selected = select_progress(&owner);
    assert_eq!(selected["kind"], "ready");
    let first = svc
        .work_operation(
            &pending.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    let reused = svc
        .import(
            credential(&owner),
            request("reuse", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        reused.receipt.as_ref().unwrap().revision_id,
        first.receipt.as_ref().unwrap().revision_id
    );
    let other = svc
        .admit(
            foreign(),
            request("foreign", create("Foreign")),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_ne!(other.tenant, first.tenant);
    assert_eq!(select_progress(&owner), selected);
    assert_eq!(
        read(&root)
            .query_row(
                "SELECT SUM(reserved_bytes) FROM source_import_quota WHERE settled=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        20 * 1024 * 1024
    );
    assert!(svc.get(foreign(), "pending-default".into()).is_err());
    svc.work_operation(
        &other.job_id,
        Some(&files),
        Through::Settled,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(select_progress(&owner), selected);
    drop(svc);
    owner.shutdown().unwrap();
}

fn publication_secret() -> Secret {
    Secret::new("publication-fixture-secret".into())
}
fn publication_fixture() -> (PathBuf, PathBuf, WriterOwner, serde_json::Value) {
    let root = temp();
    std::fs::write(
        root.join("print-partner.db"),
        include_bytes!("fixtures/publication-source/node.db"),
    )
    .unwrap();
    let old = root.join("repos/1/revisions/fixture");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(
        old.join("bracket.stl"),
        include_bytes!("fixtures/publication-source/bracket.stl"),
    )
    .unwrap();
    let files = root.join("supplied");
    std::fs::create_dir(&files).unwrap();
    std::fs::write(
        files.join("triangle.stl"),
        include_bytes!("fixtures/source-import/triangle.stl"),
    )
    .unwrap();
    std::fs::write(files.join("README.md"), "# Later Source\n").unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    let initial: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/publication-source/request.json")).unwrap();
    let response = owner
        .checkoff_progress()
        .apply(
            catalog::Credentials::Session(publication_secret()),
            pp_storage::checkoff_progress::Request::CompletionCoordinate {
                part_id: 1,
                body: serde_json::json!({"unit_index":2,"completed":true}),
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(response.status, 200);
    let selected = owner.required_units().reconcile(
        pp_storage::required_units::ReconciliationCommand::new(
            serde_json::from_value(serde_json::json!(1)).unwrap(),
            serde_json::from_value(serde_json::json!(2)).unwrap(),
            serde_json::from_value(serde_json::json!({"expected_snapshot_digest":initial["expected_snapshot_digest"],"decisions":[]})).unwrap(),
            "publication-source-selection".into(),
            pp_storage::read_model::Credential::Session(publication_secret()),
        ).unwrap(), &AtomicBool::new(false), Duration::from_secs(5),
    ).unwrap();
    let selected = serde_json::to_value(selected).unwrap();
    assert_eq!(selected["kind"], "ready");
    let draft = &selected["workspace"]["draft"];
    let command = serde_json::json!({"expected_snapshot_digest":draft["snapshot_digest"],"expected_lifecycle_version":draft["lifecycle_version"],"expected_base":draft["base"],"remap_checkoff_links":true});
    assert_eq!(count(&root, "accepted_plate_revisions"), 1);
    assert_eq!(count(&root, "accepted_plates"), 1);
    assert!(count(&root, "accepted_plate_units") > 0);
    (root, files, owner, command)
}
fn publish_selected(owner: &WriterOwner, request: &serde_json::Value) -> serde_json::Value {
    serde_json::to_value(
        owner
            .publication()
            .apply(
                pp_storage::plan_publication::PublicationCommand::new(
                    serde_json::from_value(serde_json::json!(1)).unwrap(),
                    serde_json::from_value(serde_json::json!(2)).unwrap(),
                    serde_json::from_value(request.clone()).unwrap(),
                    "publication-source".into(),
                    pp_storage::read_model::Credential::Session(publication_secret()),
                )
                .unwrap(),
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap(),
    )
    .unwrap()
}
fn publication_foreign(root: &Path) -> Vec<(String, Vec<String>)> {
    let db = read(root);
    graph(&db)
        .into_iter()
        .filter_map(|(name, _)| {
            let mut query = db.prepare(&format!("SELECT * FROM {name}")).unwrap();
            let column = query
                .column_names()
                .iter()
                .position(|n| *n == "tenant_id" || *n == "tenant");
            column.map(|column| {
                let n = query.column_count();
                let rows = query
                    .query_map([], |r| {
                        let tenant: String = r.get(column)?;
                        let values = (0..n)
                            .map(|i| r.get::<_, rusqlite::types::Value>(i))
                            .collect::<Result<Vec<_>, _>>()?;
                        Ok((tenant, format!("{values:?}")))
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
                    .into_iter()
                    .filter(|(tenant, _)| tenant == "foreign")
                    .map(|(_, row)| row)
                    .collect();
                (name, rows)
            })
        })
        .collect()
}
fn assert_publication_preserves_source(root: &Path, before: &[(String, Vec<String>)]) {
    let after = graph(&read(root));
    for (table, rows) in before {
        if [
            "projects",
            "source_revisions",
            "source_docs",
            "source_import_operations",
            "source_import_quota",
            "durable_jobs",
            "durable_job_keys",
            "durable_job_history",
            "durable_job_reconciliations",
            "accepted_plate_revisions",
            "accepted_plates",
            "accepted_plate_units",
            "required_units",
        ]
        .contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
    assert_eq!(
        std::fs::read(root.join("repos/1/revisions/fixture/bracket.stl")).unwrap(),
        include_bytes!("fixtures/publication-source/bracket.stl")
    );
}
fn assert_source_preserves_publication(root: &Path, before: &[(String, Vec<String>)]) {
    let after = graph(&read(root));
    for (table, rows) in before {
        if table.starts_with("plan_")
            || table.starts_with("accepted_")
            || ["parts", "required_units", "print_progress"].contains(&table.as_str())
        {
            assert_eq!(
                &after.iter().find(|(name, _)| name == table).unwrap().1,
                rows,
                "{table}"
            );
        }
    }
}
#[test]
fn publication_pending_supplied_import_preserves_owned_job_and_pinned_source() {
    let (root, files, owner, command) = publication_fixture();
    let svc = service(&owner);
    let pending = svc
        .admit(
            credential(&owner),
            request("pending-publication", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = graph(&read(&root));
    let foreign = publication_foreign(&root);
    assert!(foreign.iter().any(|(_, rows)| !rows.is_empty()));
    let applied = publish_selected(&owner, &command);
    assert_eq!(applied["kind"], "applied");
    assert_publication_preserves_source(&root, &before);
    assert_eq!(publication_foreign(&root), foreign);
    assert_eq!(
        svc.get(credential(&owner), pending.key.clone()).unwrap(),
        pending
    );
    assert_eq!(
        publish_selected(&owner, &command)["receipt"],
        applied["receipt"]
    );
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn publication_active_supplied_claim_and_live_lease_remain_exact() {
    let (root, files, owner, command) = publication_fixture();
    let svc = service(&owner);
    let pending = svc
        .admit(
            credential(&owner),
            request("active-publication", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let worker = owner
        .job_worker(jobs::WorkerAdmission {
            kinds: vec![(jobs::JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let (job, attempt) = worker.claim_import(&pending.job_id).unwrap().unwrap();
    let mut live = worker
        .begin_source_work(
            &attempt,
            None,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let active = worker.import_phase(&attempt, Phase::Read).unwrap();
    let before = graph(&read(&root));
    assert_eq!(job.state, jobs::PersistentState::Running);
    assert_eq!(publish_selected(&owner, &command)["kind"], "applied");
    assert_publication_preserves_source(&root, &before);
    assert_eq!(worker.import_phase(&attempt, Phase::Read).unwrap(), active);
    assert!(matches!(
        owner
            .local_source_catalog()
            .execute(catalog::Request::Delete { id: 1 })
            .unwrap(),
        catalog::Outcome::Deletion(catalog::Deletion::ActiveWork)
    ));
    live.release().unwrap();
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn publication_then_source_activation_preserves_receipt_progress_and_plate_history() {
    let (root, files, owner, command) = publication_fixture();
    let svc = service(&owner);
    let pending = svc
        .admit(
            credential(&owner),
            request(
                "activate-after-publication",
                Target::Existing { source_id: 1 },
            ),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    let published = publish_selected(&owner, &command);
    assert_eq!(published["kind"], "applied");
    let before = graph(&read(&root));
    let foreign = publication_foreign(&root);
    let accepted = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(publication_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    let accepted = serde_json::to_value(&accepted.builds[0].accepted).unwrap();
    assert_eq!(accepted["kind"], "ready");
    let completed = svc
        .work_operation(
            &pending.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(completed.receipt.as_ref().unwrap().activated && completed.cleanup_settled);
    assert_eq!(
        completed.receipt.as_ref().unwrap().postprocessing,
        Postprocessing::DocumentMetadataIndexed
    );
    assert_source_preserves_publication(&root, &before);
    assert_eq!(publication_foreign(&root), foreign);
    assert_eq!(
        publish_selected(&owner, &command)["receipt"],
        published["receipt"]
    );
    drop(svc);
    owner.shutdown().unwrap();
    let owner = WriterOwner::open(&root, Limits::default()).unwrap().0;
    let replay = publish_selected(&owner, &command);
    assert_eq!(replay["kind"], "existing");
    assert_eq!(replay["receipt"], published["receipt"]);
    let read = owner
        .accepted_reads()
        .read(
            pp_storage::read_model::Credential::Session(publication_secret()),
            &[1],
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(&read.builds[0].accepted).unwrap(),
        accepted
    );
    let svc = service(&owner);
    assert_eq!(svc.get(credential(&owner), pending.key).unwrap(), completed);
    assert_source_preserves_publication(&root, &before);
    drop(svc);
    owner.shutdown().unwrap();
}
#[test]
fn publication_source_schema37_backup_retains_full35_and_foreign_graph() {
    let (root, files, owner, command) = publication_fixture();
    owner.shutdown().unwrap();
    let conn = Connection::open(root.join("print-partner.db")).unwrap();
    conn.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; DROP TABLE source_import_quota; DROP TABLE source_import_operations; UPDATE app_settings SET value='35' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let prior = graph(&conn);
    drop(conn);
    let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
    assert_eq!(ready.previous_version, 35);
    assert_eq!(ready.version, 37);
    let backup = root.join("publication-backup-copy.db");
    std::fs::copy(ready.backup.unwrap(), &backup).unwrap();
    assert_eq!(graph(&Connection::open(backup).unwrap()), prior);
    let foreign = publication_foreign(&root);
    let svc = service(&owner);
    let admitted = svc
        .admit(
            credential(&owner),
            request("backup-publication", Target::Existing { source_id: 1 }),
            &files,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(publish_selected(&owner, &command)["kind"], "applied");
    assert_eq!(publication_foreign(&root), foreign);
    let before = graph(&read(&root));
    let completed = svc
        .work_operation(
            &admitted.job_id,
            Some(&files),
            Through::Settled,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
    assert!(completed.receipt.unwrap().activated);
    assert_source_preserves_publication(&root, &before);
    assert_eq!(publication_foreign(&root), foreign);
    drop(svc);
    owner.shutdown().unwrap();
}
