use pp_core::{
    source_acquisition::{CaptureRequest, CapturedFile, SourceAcquisitions},
    uploads::{SourceImports, Through},
};
use pp_source::{
    SourcePath,
    retained_capture::{FreezeResult, RetainedCaptureId, RetainedCaptureVault},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::CreateSource,
    jobs::{Credential, JobKind, WorkerAdmission},
    uploads::{
        AdmissionLimits, CaptureId, CaptureJournalCorrelation, CapturedPayloadV1, File, OwnedInput,
        Phase, Target,
    },
};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

fn temporary_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pp-source-acquisition-{name}-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn open_owner(root: &Path) -> WriterOwner {
    WriterOwner::open(root, Limits::default()).unwrap().0
}

fn credential(owner: &WriterOwner) -> Credential {
    Credential::PhysicalOwner(owner.job_physical_owner())
}

fn limits() -> AdmissionLimits {
    AdmissionLimits {
        reserved_bytes: 20 * 1024 * 1024,
        max_input_bytes: 64 * 1024,
        max_prepared_bytes: 64 * 1024,
    }
}

fn target(name: &str) -> Target {
    Target::Create {
        metadata: Box::new(CreateSource {
            name: name.into(),
            source_kind: Some("local".into()),
            source_type: Some("local".into()),
            ..Default::default()
        }),
    }
}

fn triangle() -> Vec<u8> {
    include_bytes!("fixtures/source-import/triangle.stl").to_vec()
}

struct PanicReader;

impl std::io::Read for PanicReader {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        panic!("unauthenticated input was read")
    }
}

fn request(owner: &WriterOwner, key: &str) -> CaptureRequest {
    CaptureRequest {
        credential: credential(owner),
        operation_key: key.into(),
        target: target(key),
        payload: CapturedPayloadV1::files(vec!["triangle.stl".into(), "README.md".into()]),
        limits: limits(),
        files: vec![
            CapturedFile {
                path: SourcePath::try_from("triangle.stl".to_owned()).unwrap(),
                input: Box::new(Cursor::new(triangle())),
            },
            CapturedFile {
                path: SourcePath::try_from("README.md".to_owned()).unwrap(),
                input: Box::new(Cursor::new(b"# Retained source\n".to_vec())),
            },
        ],
    }
}

fn retained_capture_count(root: &Path) -> usize {
    std::fs::read_dir(root.join("source-captures")).map_or(0, |entries| entries.count())
}

struct StagedCapture {
    id: String,
    manifest: Vec<u8>,
    files: Vec<File>,
    operation: Option<pp_storage::uploads::Operation>,
}

fn stage_capture(owner: &WriterOwner, root: &Path, key: &str, admit: bool) -> StagedCapture {
    let client = owner.imports(policy(), 128 * 1024 * 1024).unwrap();
    let preflight = client
        .preflight_capture(
            credential(owner),
            key.into(),
            target(key),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits(),
        )
        .unwrap();
    let vault = RetainedCaptureVault::open(root).unwrap();
    let mut candidate = vault.allocate().unwrap();
    let id = candidate.capture_id().as_str().to_owned();
    let bytes = triangle();
    candidate
        .write_file(
            SourcePath::try_from("triangle.stl".to_owned()).unwrap(),
            &bytes,
            limits().max_input_bytes,
        )
        .unwrap();
    let files = vec![File {
        path: "triangle.stl".into(),
        size: bytes.len().try_into().unwrap(),
        sha256: hex::encode(Sha256::digest(&bytes)),
        kind: "input".into(),
    }];
    let prepared = preflight
        .prepare(
            CaptureId::new(id.clone()).unwrap(),
            key.into(),
            CapturedPayloadV1::files(vec!["triangle.stl".into()]),
            limits(),
            files.clone(),
        )
        .unwrap();
    let manifest = prepared.manifest().to_vec();
    assert!(matches!(
        candidate.freeze_owned(&manifest),
        FreezeResult::Frozen(_)
    ));
    let operation = admit.then(|| {
        client
            .admit_prepared(prepared, 0, client.accounting_epoch())
            .unwrap()
    });
    StagedCapture {
        id,
        manifest,
        files,
        operation,
    }
}

#[test]
fn captured_admitted_restart_resolves_without_caller_path_and_lost_reply() {
    let root = temporary_root("restart");
    let first = open_owner(&root);
    let staged = stage_capture(&first, &root, "restart-without-caller", true);
    let operation = staged.operation.unwrap();
    first.shutdown().unwrap();

    let reopened = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&reopened, policy(), 128 * 1024 * 1024, 2).unwrap();
    assert_eq!(acquisitions.recover_before_accepting().unwrap(), 1);
    assert_eq!(retained_capture_count(&root), 0);
    let imports = SourceImports::new(&reopened, policy(), 128 * 1024 * 1024).unwrap();
    let settled = imports.get(credential(&reopened), operation.key).unwrap();
    assert!(settled.cleanup_settled);
    assert!(settled.receipt.unwrap().activated);
    assert_eq!(
        acquisitions
            .shutdown(Duration::from_secs(1))
            .unwrap()
            .retained,
        0
    );
    drop(imports);
    drop(acquisitions);
    reopened.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn authentication_precedes_input_reads_and_pre_freeze_cancellation_releases_capacity() {
    let root = temporary_root("auth-cancel");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    assert!(
        acquisitions
            .acquire(
                request(&owner, "startup-gate-closed"),
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert_eq!(retained_capture_count(&root), 0);
    acquisitions.recover_before_accepting().unwrap();

    let mut unauthenticated = request(&owner, "unauthenticated");
    unauthenticated.credential = Credential::Session(Secret::new("unknown-session".into()));
    unauthenticated.files[0].input = Box::new(PanicReader);
    assert!(
        acquisitions
            .acquire(unauthenticated, &AtomicBool::new(false))
            .is_err()
    );
    assert_eq!(retained_capture_count(&root), 0);

    assert!(
        acquisitions
            .acquire(request(&owner, "cancelled"), &AtomicBool::new(true))
            .is_err()
    );
    assert_eq!(retained_capture_count(&root), 0);
    assert!(
        acquisitions
            .acquire(request(&owner, "after-cancel"), &AtomicBool::new(false))
            .unwrap()
            .wait()
            .unwrap()
            .cleanup_settled
    );
    acquisitions.shutdown(Duration::from_secs(1)).unwrap();
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dropped_reply_and_shutdown_budget_keep_service_owned_work() {
    let root = temporary_root("dropped-reply");
    let owner = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 1).unwrap();
    acquisitions.recover_before_accepting().unwrap();
    let cancelled = AtomicBool::new(false);
    let reply = acquisitions
        .acquire(request(&owner, "dropped-reply"), &cancelled)
        .unwrap();
    cancelled.store(true, std::sync::atomic::Ordering::Release);
    drop(reply);
    assert!(
        acquisitions
            .acquire(request(&owner, "bounded-second"), &AtomicBool::new(false))
            .is_err()
    );
    let first = acquisitions.shutdown(Duration::ZERO).unwrap();
    assert_eq!(first.retained, 1);
    let second = acquisitions.shutdown(Duration::from_secs(10)).unwrap();
    assert_eq!(second.retained, 0);
    assert_eq!(retained_capture_count(&root), 0);
    drop(acquisitions);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordered_absence_and_owned_or_later_cleanup_converge() {
    let root = temporary_root("ordered-cleanup");
    let owner = open_owner(&root);
    let absent = stage_capture(&owner, &root, "ordered-absent", false);
    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    let vault = RetainedCaptureVault::open(&root).unwrap();
    assert!(
        imports
            .work_frozen(
                vault
                    .open_frozen(&RetainedCaptureId::parse(absent.id).unwrap())
                    .unwrap(),
                Through::Settled,
                &AtomicBool::new(false),
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(retained_capture_count(&root), 0);

    let owned = stage_capture(&owner, &root, "owned-or-later", true);
    let resolved = match owner
        .imports(policy(), 128 * 1024 * 1024)
        .unwrap()
        .correlate_capture_manifest(owned.manifest, owned.files.clone())
        .unwrap()
    {
        CaptureJournalCorrelation::ExactAdmitted(claim) => claim,
        _ => panic!("capture did not resolve"),
    };
    let worker = owner
        .job_worker(WorkerAdmission {
            kinds: vec![(JobKind::SuppliedSourceImport, 1)],
            total: 1,
            per_resource: 1,
            lease_seconds: 3600,
        })
        .unwrap();
    let (_, lease) = worker.claim_resolved_import(resolved).unwrap().unwrap();
    let operation = owned.operation.unwrap();
    worker
        .import_phase(
            &lease,
            Phase::Owned(OwnedInput {
                locator: format!(".pp-imports/{}", operation.job_id),
                digest: hex::encode(Sha256::digest(serde_json::to_vec(&owned.files).unwrap())),
                files: owned.files,
            }),
        )
        .unwrap();
    let vault = RetainedCaptureVault::open(&root).unwrap();
    assert!(
        imports
            .work_frozen(
                vault
                    .open_frozen(&RetainedCaptureId::parse(owned.id).unwrap())
                    .unwrap(),
                Through::Settled,
                &AtomicBool::new(false),
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(retained_capture_count(&root), 0);
    drop(worker);
    drop(imports);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn generic_claim_and_work_next_skip_admitted_capture() {
    let root = temporary_root("generic-skip");
    let owner = open_owner(&root);
    stage_capture(&owner, &root, "generic-skip", true);
    let imports = SourceImports::new(&owner, policy(), 128 * 1024 * 1024).unwrap();
    assert!(
        imports
            .work_next(Through::Settled, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert_eq!(retained_capture_count(&root), 1);
    drop(imports);
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn oversized_retained_manifest_keeps_restart_ingress_closed_and_evidence_unchanged() {
    let root = temporary_root("oversized-retained-manifest");
    let first = open_owner(&root);
    let staged = stage_capture(&first, &root, "oversized-retained-manifest", false);
    let frozen = root.join("source-captures").join(&staged.id).join("frozen");
    let manifest_path = frozen.join("capture-manifest.json");
    let input_path = frozen.join("input/triangle.stl");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["admission_limits"]["max_input_bytes"] = serde_json::Value::from(268_435_457u64);
    manifest["admission_limits"]["reserved_bytes"] = serde_json::Value::from(3_506_438_145u64);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let manifest_before = std::fs::read(&manifest_path).unwrap();
    let input_before = std::fs::read(&input_path).unwrap();
    first.shutdown().unwrap();

    let reopened = open_owner(&root);
    let acquisitions = SourceAcquisitions::new(&reopened, policy(), 128 * 1024 * 1024, 1).unwrap();
    let error = acquisitions.recover_before_accepting().unwrap_err();
    assert!(format!("{error:#}").contains("Invalid import limits"));
    assert_eq!(std::fs::read(&manifest_path).unwrap(), manifest_before);
    assert_eq!(std::fs::read(&input_path).unwrap(), input_before);
    let error = match acquisitions.acquire(
        request(&reopened, "closed-after-oversized-manifest"),
        &AtomicBool::new(false),
    ) {
        Ok(_) => panic!("oversized retained manifest left ingress open"),
        Err(error) => error,
    };
    assert!(format!("{error:#}").contains("Source acquisition ingress is closed"));
    assert_eq!(std::fs::read(&manifest_path).unwrap(), manifest_before);
    assert_eq!(std::fs::read(&input_path).unwrap(), input_before);
    drop(acquisitions);
    reopened.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_untrusted_root_and_malformed_evidence_require_repair() {
    let root = temporary_root("repair");
    let owner = open_owner(&root);
    let staged = stage_capture(&owner, &root, "missing-root", true);
    std::fs::remove_file(
        root.join("source-captures")
            .join(&staged.id)
            .join("frozen/input/triangle.stl"),
    )
    .unwrap();
    let acquisitions = SourceAcquisitions::new(&owner, policy(), 128 * 1024 * 1024, 2).unwrap();
    assert!(acquisitions.recover_before_accepting().is_err());
    assert!(acquisitions.recover_before_accepting().is_err());
    assert!(
        acquisitions
            .acquire(
                request(&owner, "closed-after-repair"),
                &AtomicBool::new(false)
            )
            .is_err()
    );
    assert!(
        root.join("source-captures")
            .join(staged.id)
            .join("frozen")
            .is_dir()
    );
    drop(acquisitions);
    owner.shutdown().unwrap();

    let malformed = temporary_root("malformed");
    let malformed_owner = open_owner(&malformed);
    std::fs::create_dir_all(malformed.join("source-captures/not-a-capture/frozen/input")).unwrap();
    let acquisitions =
        SourceAcquisitions::new(&malformed_owner, policy(), 128 * 1024 * 1024, 2).unwrap();
    assert!(acquisitions.recover_before_accepting().is_err());
    assert!(acquisitions.recover_before_accepting().is_err());
    assert!(malformed.join("source-captures/not-a-capture").is_dir());
    drop(acquisitions);
    malformed_owner.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(malformed).unwrap();
}
