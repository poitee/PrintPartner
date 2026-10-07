use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog::CreateSource,
    jobs::{Credential, Payload},
    uploads::{
        Admission, AdmissionLimits, Basis, CaptureId, CapturedInputV2, CapturedPayloadV1, File,
        Input, Operation, RecordedArchiveLabels, State, Target,
    },
};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::atomic::AtomicBool};

const RESERVED: u64 = 3_506_438_144;
const MAX_INPUT: u64 = 268_435_456;
const MAX_PREPARED: u64 = 1_073_741_824;

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "source-import-codec-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
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

fn limits() -> AdmissionLimits {
    AdmissionLimits {
        reserved_bytes: RESERVED,
        max_input_bytes: MAX_INPUT,
        max_prepared_bytes: MAX_PREPARED,
    }
}

fn expected(path: &str, byte: char) -> Vec<File> {
    vec![File {
        path: path.into(),
        size: 3,
        sha256: byte.to_string().repeat(64),
        kind: "input".into(),
    }]
}

fn captured_admission(
    key: &str,
    capture_id: &str,
    name: &str,
    actor: &str,
    files: &[File],
) -> Admission {
    let target = target(name);
    let input = Input::Captured(
        CapturedInputV2::bind(
            CaptureId::new(capture_id).unwrap(),
            CapturedPayloadV1::zip("upload.zip".into()),
            actor,
            key,
            &target,
            limits(),
            files,
        )
        .unwrap(),
    );
    Admission {
        key: key.into(),
        target,
        input,
        reserved_bytes: RESERVED,
        max_input_bytes: MAX_INPUT,
        max_prepared_bytes: MAX_PREPARED,
    }
}

fn physical(owner: &WriterOwner) -> Credential {
    Credential::PhysicalOwner(owner.job_physical_owner())
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn basis() -> Basis {
    Basis {
        current_source_revision_id: None,
        url: String::new(),
        branch: "main".into(),
        tag: None,
        source_kind: "local".into(),
        source_type: "local".into(),
        local_path: None,
        last_commit_sha: None,
        legacy_manifest_cutover: false,
    }
}

fn legacy_case(key: &str, input: Input, files: Vec<File>) -> Value {
    let admission = Admission {
        key: key.into(),
        target: Target::Existing { source_id: 42 },
        input: input.clone(),
        reserved_bytes: RESERVED,
        max_input_bytes: MAX_INPUT,
        max_prepared_bytes: MAX_PREPARED,
    };
    let requested_bytes = serde_json::to_vec(&files).unwrap();
    let requested_digest = hash(&requested_bytes);
    let intent_bytes = serde_json::to_vec(&(&admission, &files)).unwrap();
    let intent_digest = hash(&intent_bytes);
    let operation = Operation {
        tenant: "default".into(),
        actor: "physical-owner".into(),
        key: key.into(),
        intent_digest: intent_digest.clone(),
        source_id: 42,
        job_id: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
        input_version: 1,
        input: input.clone(),
        requested_files: files,
        requested_digest: requested_digest.clone(),
        state: State::Admitted,
        basis: basis(),
        default_rules: true,
        original_rules: None,
        reserved_bytes: RESERVED,
        max_input_bytes: MAX_INPUT,
        max_prepared_bytes: MAX_PREPARED,
        owned: None,
        artifact: None,
        receipt: None,
        cleanup_settled: false,
        authority_revision: None,
        observation_cursor: None,
    };
    let payload = Payload::SuppliedSourceImport {
        project_id: 42,
        operation_key: key.into(),
        input_version: 1,
    };
    let job_intent = serde_json::to_vec(&(1u32, &payload)).unwrap();
    json!({
        "input": encoded(&input),
        "admission": encoded(&admission),
        "operation": encoded(&operation),
        "supplied_job_payload": encoded(&payload),
        "requested": {"utf8": String::from_utf8(requested_bytes).unwrap(), "sha256": requested_digest},
        "intent": {"utf8": String::from_utf8(intent_bytes).unwrap(), "sha256": intent_digest},
        "job_intent": {"utf8": String::from_utf8(job_intent.clone()).unwrap(), "sha256": hash(&job_intent)},
    })
}

fn encoded<T: Serialize>(value: &T) -> Value {
    let bytes = serde_json::to_vec(value).unwrap();
    json!({"utf8": String::from_utf8(bytes.clone()).unwrap(), "sha256": hash(&bytes)})
}

#[test]
fn legacy_files_and_zip_match_the_detached_prior_serializer() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/source-import-v1-serde.json")).unwrap();
    assert_eq!(
        fixture["baseline_commit"],
        "2f24c9b42ba637bb13138837356099b32f5704aa"
    );
    assert_eq!(
        fixture["legacy"]["cases"]["files"],
        legacy_case(
            "legacy-files-1",
            Input::Files {
                paths: vec!["part.stl".into()]
            },
            expected("part.stl", 'b')
        )
    );
    assert_eq!(
        fixture["legacy"]["cases"]["zip"],
        legacy_case(
            "legacy-zip-1",
            Input::Zip {
                path: "upload.zip".into()
            },
            expected("upload.zip", 'a')
        )
    );
}

#[test]
fn captured_wire_is_ordered_closed_and_redacted() {
    let files = expected("upload.zip", 'a');
    let target = Target::Existing { source_id: 42 };
    let input = Input::Captured(
        CapturedInputV2::bind(
            CaptureId::new("capture-visible-only-on-wire").unwrap(),
            CapturedPayloadV1::zip("upload.zip".into()),
            "physical-owner",
            "captured-wire",
            &target,
            limits(),
            &files,
        )
        .unwrap(),
    );
    let value = serde_json::to_value(&input).unwrap();
    let keys = value.as_object().unwrap().keys().collect::<Vec<_>>();
    assert_eq!(
        keys,
        [
            "kind",
            "capture_version",
            "capture_id",
            "payload",
            "policy_digest",
            "target_digest",
            "manifest_digest"
        ]
    );
    assert_eq!(input.version(), 2);
    assert_eq!(input.requested_paths(), ["upload.zip"]);
    assert_eq!(
        input.zip_input().unwrap().labels,
        RecordedArchiveLabels::CapturedNfcAtAcquisition
    );
    let zip_debug = format!("{input:?}");
    for private_value in [
        "capture-visible-only-on-wire",
        "upload.zip",
        value["policy_digest"].as_str().unwrap(),
        value["target_digest"].as_str().unwrap(),
        value["manifest_digest"].as_str().unwrap(),
    ] {
        assert!(!zip_debug.contains(private_value), "{private_value}");
    }
    assert_eq!(
        value["payload"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["kind", "path", "policy"]
    );
    assert_eq!(
        value["payload"]["policy"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        [
            "policy_version",
            "archive_labels",
            "canonical_paths",
            "max_raw_input_bytes",
            "max_prepared_bytes",
            "max_zip_entries"
        ]
    );

    let captured_files = Input::Captured(
        CapturedInputV2::bind(
            CaptureId::new("capture-files").unwrap(),
            CapturedPayloadV1::files(vec!["part.stl".into()]),
            "physical-owner",
            "captured-files",
            &target,
            limits(),
            &expected("part.stl", 'b'),
        )
        .unwrap(),
    );
    assert_eq!(captured_files.requested_paths(), ["part.stl"]);
    assert!(captured_files.zip_input().is_none());
    let files_value = serde_json::to_value(&captured_files).unwrap();
    let files_debug = format!("{captured_files:?}");
    for private_value in [
        "capture-files",
        "part.stl",
        files_value["policy_digest"].as_str().unwrap(),
        files_value["target_digest"].as_str().unwrap(),
        files_value["manifest_digest"].as_str().unwrap(),
    ] {
        assert!(!files_debug.contains(private_value), "{private_value}");
    }

    let legacy = Input::Zip {
        path: "upload.zip".into(),
    };
    assert_eq!(legacy.version(), 1);
    assert_eq!(
        legacy.zip_input().unwrap().labels,
        RecordedArchiveLabels::LegacyStrict
    );
}

#[test]
fn captured_wire_refuses_missing_unknown_and_malformed_identity_fields() {
    let files = expected("upload.zip", 'a');
    let target = Target::Existing { source_id: 42 };
    let input = Input::Captured(
        CapturedInputV2::bind(
            CaptureId::new("capture-wire-refusal").unwrap(),
            CapturedPayloadV1::zip("upload.zip".into()),
            "physical-owner",
            "wire-refusal",
            &target,
            limits(),
            &files,
        )
        .unwrap(),
    );
    let value = serde_json::to_value(&input).unwrap();
    for field in [
        "capture_version",
        "capture_id",
        "payload",
        "policy_digest",
        "target_digest",
        "manifest_digest",
    ] {
        let mut changed = value.clone();
        changed.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Input>(changed).is_err(), "{field}");
    }
    let mut unknown = value.clone();
    unknown["unexpected"] = json!(true);
    assert!(serde_json::from_value::<Input>(unknown).is_err());
    let mut bad_digest = value.clone();
    bad_digest["target_digest"] = json!("A".repeat(64));
    assert!(serde_json::from_value::<Input>(bad_digest).is_err());
    let mut bad_capture = value;
    bad_capture["capture_id"] = json!("");
    assert!(serde_json::from_value::<Input>(bad_capture).is_err());
    assert!(
        serde_json::from_value::<Input>(json!({"kind": "future", "path": "upload.zip"})).is_err()
    );
    let mut bad_policy = serde_json::to_value(input).unwrap();
    bad_policy["payload"]["policy"]["archive_labels"] = json!("future");
    assert!(serde_json::from_value::<Input>(bad_policy).is_err());
    assert!(CaptureId::new("x".repeat(129)).is_err());
    assert!(CaptureId::new("capture\ncontrol").is_err());
}

#[test]
fn captured_admission_replays_exactly_and_valid_conflicts_do_not_mutate() {
    let root = temp();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
    let files = expected("upload.zip", 'a');
    let admit = |request| {
        client.admit(
            physical(&owner),
            request,
            files.clone(),
            0,
            client.accounting_epoch(),
            &AtomicBool::new(false),
        )
    };
    let first = admit(captured_admission(
        "captured-replay",
        "capture-one",
        "Captured Replay",
        "physical-owner",
        &files,
    ))
    .unwrap();
    assert_eq!(first.input_version, 2);
    let replay = admit(captured_admission(
        "captured-replay",
        "capture-one",
        "Captured Replay",
        "physical-owner",
        &files,
    ))
    .unwrap();
    assert_eq!(replay, first);
    assert!(
        admit(captured_admission(
            "captured-replay",
            "capture-two",
            "Captured Replay",
            "physical-owner",
            &files,
        ))
        .is_err()
    );
    let connection = Connection::open(root.join("print-partner.db")).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM source_import_operations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    drop(connection);
    drop(client);
    owner.shutdown().unwrap();
}

#[test]
fn captured_binding_mismatches_refuse_before_target_mutation() {
    let root = temp();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
    let files = expected("upload.zip", 'a');
    let valid = captured_admission(
        "captured-mismatch",
        "capture-mismatch",
        "Mismatch",
        "physical-owner",
        &files,
    );
    let mut cases = Vec::new();

    let mut wrong_key: Value = serde_json::to_value(&valid).unwrap();
    wrong_key["key"] = json!("changed-key");
    cases.push(wrong_key);

    let mut wrong_target: Value = serde_json::to_value(&valid).unwrap();
    wrong_target["target"]["metadata"]["name"] = json!("Changed Target");
    cases.push(wrong_target);

    let mut wrong_limits: Value = serde_json::to_value(&valid).unwrap();
    wrong_limits["reserved_bytes"] = json!(RESERVED + 1);
    cases.push(wrong_limits);

    let mut wrong_policy: Value = serde_json::to_value(&valid).unwrap();
    wrong_policy["input"]["payload"]["policy"]["max_zip_entries"] = json!(9_999);
    cases.push(wrong_policy);

    let mut wrong_policy_version: Value = serde_json::to_value(&valid).unwrap();
    wrong_policy_version["input"]["payload"]["policy"]["policy_version"] = json!(2);
    cases.push(wrong_policy_version);

    let mut wrong_capture_version: Value = serde_json::to_value(&valid).unwrap();
    wrong_capture_version["input"]["capture_version"] = json!(2);
    cases.push(wrong_capture_version);

    let mut wrong_manifest: Value = serde_json::to_value(&valid).unwrap();
    wrong_manifest["input"]["manifest_digest"] = json!("0".repeat(64));
    cases.push(wrong_manifest);

    cases.push(
        serde_json::to_value(captured_admission(
            "captured-mismatch",
            "capture-mismatch",
            "Mismatch",
            "another-actor",
            &files,
        ))
        .unwrap(),
    );

    for value in cases {
        let request: Admission = serde_json::from_value(value).unwrap();
        assert!(
            client
                .admit(
                    physical(&owner),
                    request,
                    files.clone(),
                    0,
                    client.accounting_epoch(),
                    &AtomicBool::new(false),
                )
                .is_err()
        );
    }
    let wrong_inventory = expected("upload.zip", 'b');
    assert!(
        client
            .admit(
                physical(&owner),
                valid,
                wrong_inventory,
                0,
                client.accounting_epoch(),
                &AtomicBool::new(false),
            )
            .is_err()
    );
    assert_eq!(
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(client);
    owner.shutdown().unwrap();
}

#[test]
fn changed_fixed_policy_is_rejected_before_target_mutation() {
    let files = expected("upload.zip", 'a');
    let admission = captured_admission(
        "policy-change",
        "capture-policy-change",
        "Policy Change",
        "physical-owner",
        &files,
    );
    let mut changed = serde_json::to_value(&admission).unwrap();
    changed["input"]["payload"]["policy"]["max_zip_entries"] = json!(9_999);
    let changed: Admission = serde_json::from_value(changed).unwrap();

    let root = temp();
    let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
    let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
    assert!(
        client
            .admit(
                physical(&owner),
                changed,
                files,
                0,
                client.accounting_epoch(),
                &AtomicBool::new(false),
            )
            .is_err()
    );
    assert_eq!(
        Connection::open(root.join("print-partner.db"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(client);
    owner.shutdown().unwrap();
}

#[test]
fn captured_and_job_versions_are_closed_and_correlated_at_startup() {
    for mutation in ["operation", "job"] {
        let root = temp();
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let client = owner.imports(policy(), 8 * 1024 * 1024 * 1024).unwrap();
        let files = expected("upload.zip", 'a');
        let operation = client
            .admit(
                physical(&owner),
                captured_admission(
                    "captured-version",
                    "capture-version",
                    "Version",
                    "physical-owner",
                    &files,
                ),
                files,
                0,
                client.accounting_epoch(),
                &AtomicBool::new(false),
            )
            .unwrap();
        drop(client);
        owner.shutdown().unwrap();

        let connection = Connection::open(root.join("print-partner.db")).unwrap();
        let table = if mutation == "operation" {
            "source_import_operations"
        } else {
            "durable_jobs"
        };
        let id_column = if mutation == "operation" {
            "operation_key"
        } else {
            "id"
        };
        let id = if mutation == "operation" {
            operation.key.as_str()
        } else {
            operation.job_id.as_str()
        };
        let raw: String = connection
            .query_row(
                &format!("SELECT document FROM {table} WHERE {id_column}=?1"),
                [id],
                |row| row.get(0),
            )
            .unwrap();
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        if mutation == "operation" {
            value["input_version"] = json!(1);
        } else {
            value["payload"]["payload"]["input_version"] = json!(1);
        }
        connection
            .execute(
                &format!("UPDATE {table} SET document=?2 WHERE {id_column}=?1"),
                params![id, serde_json::to_string(&value).unwrap()],
            )
            .unwrap();
        drop(connection);
        assert!(WriterOwner::open(&root, Limits::default()).is_err());
    }

    for input_version in [1, 2] {
        assert!(
            Payload::SuppliedSourceImport {
                project_id: 1,
                operation_key: "version".into(),
                input_version,
            }
            .validate()
            .is_ok()
        );
    }
    for input_version in [0, 3] {
        assert!(
            Payload::SuppliedSourceImport {
                project_id: 1,
                operation_key: "version".into(),
                input_version,
            }
            .validate()
            .is_err()
        );
    }
}

#[test]
fn fixture_bytes_have_the_recorded_hashes() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/source-import-v1-serde.json")).unwrap();
    for case in ["files", "zip"] {
        for field in [
            "input",
            "admission",
            "operation",
            "supplied_job_payload",
            "requested",
            "intent",
            "job_intent",
        ] {
            let value = &fixture["legacy"]["cases"][case][field];
            assert_eq!(
                hash(value["utf8"].as_str().unwrap().as_bytes()),
                value["sha256"]
            );
        }
    }
    assert_eq!(
        encoded(&Input::Zip {
            path: "upload.zip".into()
        }),
        fixture["legacy"]["cases"]["zip"]["input"]
    );
}
