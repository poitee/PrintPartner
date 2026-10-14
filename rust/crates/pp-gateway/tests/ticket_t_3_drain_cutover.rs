use pp_compat::CompatExit;
use pp_gateway::ownership::{
    Owner,
    cutover::{
        self, BootReceipt, CUTOVER_FILE, CutoverError, CutoverReceipt, CutoverRefusal,
        DrainEvidence, EVIDENCE_FILE, Evidence, OperationOwners,
    },
    manifest::{OwnershipIndex, admit_manifest_documents},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const CATALOG: &str = "filament.catalog";
const PROFILE_SYNC: &str = "profile.sync";
const PLANS_CREATE: &str = "http:POST /plans current";
const CATALOG_PARTICIPANTS: [&str; 4] = [
    "http.GET /api/v1/filaments/catalog",
    "http.GET /filaments/catalog",
    "http.HEAD /api/v1/filaments/catalog",
    "http.HEAD /filaments/catalog",
];
const DRAINED: DrainEvidence = DrainEvidence {
    tracked_idle: true,
    gateway_idle: true,
    compat: Some(CompatExit::Graceful),
};

fn source_sync_text() -> &'static str {
    include_str!("../../../../web/apps/server/src/data/source-sync-ownership.json")
}

fn index_from(edit: impl FnOnce(&mut serde_json::Value), operations: &str) -> OwnershipIndex {
    let mut manifest: serde_json::Value =
        serde_json::from_str(include_str!("../ownership-manifest.json")).unwrap();
    let groups = manifest["operations"].as_array_mut().unwrap();
    groups.push(json!({
        "operation": CATALOG,
        "owner": "node",
        "participants": ["http.GET /filaments/catalog", "http.GET /api/v1/filaments/catalog"],
    }));
    groups.push(json!({
        "operation": PROFILE_SYNC,
        "owner": "node",
        "participants": ["http.GET /ws/profile-sync", "worker.startManagedProfileSync"],
    }));
    manifest["node_participants"]["worker"]
        .as_array_mut()
        .unwrap()
        .retain(|worker| worker != "startManagedProfileSync");
    edit(&mut manifest);
    admit_manifest_documents(&manifest.to_string(), operations, source_sync_text()).unwrap()
}

fn fixture_index() -> OwnershipIndex {
    index_from(|_| {}, include_str!("../operations.json"))
}

fn index_with_extra_tool() -> OwnershipIndex {
    index_from(
        |manifest| {
            manifest["node_participants"]["tool"]
                .as_array_mut()
                .unwrap()
                .push(json!("ticket_t_3_drain_extra_tool"));
        },
        include_str!("../operations.json"),
    )
}

fn parity(
    operation: &str,
    manifest_sha256: &str,
    fixtures: u32,
    passed: u32,
    failed: u32,
) -> String {
    json!({
        "schema": "pp-operation-parity-v1",
        "operation": operation,
        "manifest_sha256": manifest_sha256,
        "fixtures": fixtures,
        "passed": passed,
        "failed": failed,
    })
    .to_string()
}

fn sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-t3-cutover-{label}-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn listing(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

fn evidence_lines(dir: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(dir.join(EVIDENCE_FILE))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn plan_for(
    index: &OwnershipIndex,
    owners: &OperationOwners,
    operation: &str,
) -> cutover::CutoverPlan {
    cutover::plan(
        Some(index),
        owners,
        operation,
        &parity(operation, index.digest(), 3, 3, 0),
    )
    .unwrap()
}

fn switch(index: &OwnershipIndex, dir: &Path, operation: &str) -> CutoverReceipt {
    let (owners, _) = cutover::recover(dir, Some(index)).unwrap();
    plan_for(index, &owners, operation).commit(dir, DRAINED)
}

fn plant_record(dir: &Path, digest: &str, operation: &str, participants: &[&str]) {
    let record = json!({
        "schema": "pp-operation-cutover-v1",
        "manifest_sha256": digest,
        "operations": {
            operation: {
                "parity_sha256": "00",
                "fixtures": 3,
                "participants": participants,
            },
        },
    });
    fs::write(dir.join(CUTOVER_FILE), record.to_string()).unwrap();
}

#[test]
fn ticket_t_3_drain_cutover_switches_whole_operation() {
    let index = fixture_index();
    let dir = Scratch::new("whole");
    assert_eq!(
        index.participants_of(CATALOG),
        BTreeSet::from(CATALOG_PARTICIPANTS)
    );
    assert_eq!(
        switch(&index, &dir.0, CATALOG),
        CutoverReceipt::Committed {
            operation: CATALOG.into(),
            participants: 4,
            manifest_sha256: index.digest().into(),
            parity_sha256: sha256(&parity(CATALOG, index.digest(), 3, 3, 0)),
            fixtures: 3,
            directory_synced: true,
        }
    );
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_eq!(
        boot,
        BootReceipt {
            rust_operations: vec![CATALOG.into()],
            abandoned_temporaries: 0,
            evidence_saved: true,
        }
    );
    let rust_owned: BTreeSet<&str> = index
        .claims()
        .keys()
        .map(String::as_str)
        .filter(|id| owners.owner_of(id) == Owner::Rust)
        .collect();
    assert_eq!(rust_owned, BTreeSet::from(CATALOG_PARTICIPANTS));
    assert_eq!(owners.owner_of("http.GET /filaments/custom"), Owner::Node);
}

#[test]
fn ticket_t_3_drain_cutover_subset_record_fails_closed() {
    let index = fixture_index();
    let dir = Scratch::new("subset");
    plant_record(
        &dir.0,
        index.digest(),
        CATALOG,
        &["http.GET /filaments/catalog"],
    );
    let error = cutover::recover(&dir.0, Some(&index)).unwrap_err();
    assert_eq!(
        error,
        CutoverError::ParticipantSetMismatch {
            operation: CATALOG.into(),
            missing: vec![
                "http.GET /api/v1/filaments/catalog".into(),
                "http.HEAD /api/v1/filaments/catalog".into(),
                "http.HEAD /filaments/catalog".into(),
            ],
            unexpected: Vec::new(),
        }
    );
    assert_eq!(
        evidence_lines(&dir.0),
        vec![json!({
            "event": "boot_failed",
            "reason": "participant_set_mismatch",
            "operation": CATALOG,
            "missing": [
                "http.GET /api/v1/filaments/catalog",
                "http.HEAD /api/v1/filaments/catalog",
                "http.HEAD /filaments/catalog",
            ],
            "unexpected": [],
        })]
    );
}

#[test]
fn ticket_t_3_drain_cutover_refuses_operation_with_worker() {
    let index = fixture_index();
    let owners = OperationOwners::node_only();
    for (operation, participant) in [
        (PROFILE_SYNC, "worker.startManagedProfileSync"),
        ("source.sync", "assistant.propose_import_source_files"),
    ] {
        assert_eq!(
            cutover::plan(
                Some(&index),
                &owners,
                operation,
                &parity(operation, index.digest(), 3, 3, 0),
            )
            .unwrap_err(),
            CutoverRefusal::NodeCannotFence {
                participant: participant.into()
            }
        );
    }
    let dir = Scratch::new("worker");
    let participants: Vec<&str> = index.participants_of(PROFILE_SYNC).into_iter().collect();
    assert_eq!(
        participants,
        [
            "http.GET /ws/profile-sync",
            "http.HEAD /ws/profile-sync",
            "worker.startManagedProfileSync",
        ]
    );
    plant_record(&dir.0, index.digest(), PROFILE_SYNC, &participants);
    assert_eq!(
        cutover::recover(&dir.0, Some(&index)).unwrap_err(),
        CutoverError::NodeCannotFence {
            participant: "worker.startManagedProfileSync".into()
        }
    );
}

#[test]
fn ticket_t_3_drain_cutover_parity_refusals() {
    let index = fixture_index();
    let other = index_with_extra_tool();
    let owners = OperationOwners::node_only();
    let refuse = |text: &str| cutover::plan(Some(&index), &owners, CATALOG, text).unwrap_err();
    let mut unknown_field: serde_json::Value =
        serde_json::from_str(&parity(CATALOG, index.digest(), 3, 3, 0)).unwrap();
    unknown_field["skipped"] = json!(0);
    let mut wrong_schema = unknown_field.clone();
    wrong_schema.as_object_mut().unwrap().remove("skipped");
    wrong_schema["schema"] = json!("pp-operation-parity-v0");
    for malformed in [
        String::new(),
        "{".to_owned(),
        unknown_field.to_string(),
        wrong_schema.to_string(),
    ] {
        assert!(
            matches!(refuse(&malformed), CutoverRefusal::ParityMalformed { .. }),
            "{malformed}"
        );
    }
    assert_eq!(
        refuse(&parity(CATALOG, index.digest(), 0, 0, 0)),
        CutoverRefusal::ParityNoFixtures
    );
    for (passed, failed) in [(2, 1), (3, 1), (2, 0)] {
        assert_eq!(
            refuse(&parity(CATALOG, index.digest(), 3, passed, failed)),
            CutoverRefusal::ParityFailures {
                fixtures: 3,
                passed,
                failed
            }
        );
    }
    assert_eq!(
        refuse(&parity(PROFILE_SYNC, index.digest(), 3, 3, 0)),
        CutoverRefusal::ParityOperationMismatch {
            expected: CATALOG.into(),
            actual: PROFILE_SYNC.into(),
        }
    );
    assert_ne!(index.digest(), other.digest());
    assert_eq!(
        refuse(&parity(CATALOG, other.digest(), 3, 3, 0)),
        CutoverRefusal::ParityManifestMismatch {
            expected: index.digest().into(),
            actual: other.digest().into(),
        }
    );
}

#[test]
fn ticket_t_3_drain_cutover_flag_off_refuses_and_writes_nothing() {
    let index = fixture_index();
    assert_eq!(
        cutover::plan(
            None,
            &OperationOwners::node_only(),
            CATALOG,
            &parity(CATALOG, index.digest(), 3, 3, 0),
        )
        .unwrap_err(),
        CutoverRefusal::FlagOff
    );
    let empty = Scratch::new("flag-off-empty");
    assert_eq!(
        cutover::recover(&empty.0, None).unwrap(),
        (
            OperationOwners::node_only(),
            BootReceipt {
                rust_operations: Vec::new(),
                abandoned_temporaries: 0,
                evidence_saved: true,
            }
        )
    );
    assert!(listing(&empty.0).is_empty());
    let recorded = Scratch::new("flag-off-record");
    assert!(matches!(
        switch(&index, &recorded.0, CATALOG),
        CutoverReceipt::Committed { .. }
    ));
    assert_eq!(
        cutover::recover(&recorded.0, None).unwrap_err(),
        CutoverError::RecordWithoutFlag
    );
}

fn assert_commit_changes_nothing(drained: DrainEvidence, expected: CutoverReceipt) {
    let index = fixture_index();
    let dir = Scratch::new("unchanged");
    assert!(matches!(
        switch(&index, &dir.0, CATALOG),
        CutoverReceipt::Committed { .. }
    ));
    let (owners, _) = cutover::recover(&dir.0, Some(&index)).unwrap();
    let before = listing(&dir.0);
    let record = fs::read(dir.0.join(CUTOVER_FILE)).unwrap();
    assert_eq!(
        plan_for(&index, &owners, PLANS_CREATE).commit(&dir.0, drained),
        expected
    );
    assert_eq!(fs::read(dir.0.join(CUTOVER_FILE)).unwrap(), record);
    assert_eq!(listing(&dir.0), before);
}

#[test]
fn ticket_t_3_drain_cutover_drain_timeout_changes_nothing() {
    for (tracked_idle, gateway_idle) in [(true, false), (false, true), (false, false)] {
        assert_commit_changes_nothing(
            DrainEvidence {
                tracked_idle,
                gateway_idle,
                compat: Some(CompatExit::Graceful),
            },
            CutoverReceipt::DrainTimedOut {
                operation: PLANS_CREATE.into(),
                tracked_idle,
                gateway_idle,
            },
        );
    }
}

#[test]
fn ticket_t_3_drain_cutover_unreaped_compat_changes_nothing() {
    assert_commit_changes_nothing(
        DrainEvidence {
            compat: None,
            ..DRAINED
        },
        CutoverReceipt::CompatNotReaped {
            operation: PLANS_CREATE.into(),
        },
    );
}

#[test]
fn ticket_t_3_drain_cutover_force_killed_compat_changes_nothing() {
    assert_commit_changes_nothing(
        DrainEvidence {
            compat: Some(CompatExit::Forced),
            ..DRAINED
        },
        CutoverReceipt::CompatForceKilled {
            operation: PLANS_CREATE.into(),
        },
    );
}

#[test]
fn ticket_t_3_drain_cutover_crash_before_rename_recovers_node() {
    let index = fixture_index();
    let committed = Scratch::new("committed-body");
    assert!(matches!(
        switch(&index, &committed.0, CATALOG),
        CutoverReceipt::Committed { .. }
    ));
    let dir = Scratch::new("before-rename");
    let temporary = dir.0.join(".operation-cutover.abc.tmp");
    fs::copy(committed.0.join(CUTOVER_FILE), &temporary).unwrap();
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_eq!(owners, OperationOwners::node_only());
    assert_eq!(
        boot,
        BootReceipt {
            rust_operations: Vec::new(),
            abandoned_temporaries: 1,
            evidence_saved: true,
        }
    );
    assert!(!temporary.exists());
    assert!(!dir.0.join(CUTOVER_FILE).exists());
    assert_eq!(
        evidence_lines(&dir.0),
        vec![json!({"event": "boot", "rust_operations": [], "abandoned_temporaries": 1})]
    );
}

#[test]
fn ticket_t_3_drain_cutover_crash_after_rename_recovers_rust() {
    let index = fixture_index();
    let dir = Scratch::new("after-rename");
    assert!(matches!(
        switch(&index, &dir.0, CATALOG),
        CutoverReceipt::Committed { .. }
    ));
    let temporary = dir.0.join(".operation-cutover.def.tmp");
    fs::copy(dir.0.join(CUTOVER_FILE), &temporary).unwrap();
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_eq!(
        boot,
        BootReceipt {
            rust_operations: vec![CATALOG.into()],
            abandoned_temporaries: 1,
            evidence_saved: true,
        }
    );
    assert_eq!(
        owners.owner_of("http.HEAD /api/v1/filaments/catalog"),
        Owner::Rust
    );
    assert!(!temporary.exists());
}

#[test]
fn ticket_t_3_drain_cutover_restart_is_idempotent() {
    let index = fixture_index();
    let dir = Scratch::new("idempotent");
    assert!(matches!(
        switch(&index, &dir.0, CATALOG),
        CutoverReceipt::Committed { .. }
    ));
    let record = fs::read(dir.0.join(CUTOVER_FILE)).unwrap();
    let first = cutover::recover(&dir.0, Some(&index)).unwrap();
    let second = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_eq!(first, second);
    assert_eq!(
        second.1,
        BootReceipt {
            rust_operations: vec![CATALOG.into()],
            abandoned_temporaries: 0,
            evidence_saved: true,
        }
    );
    assert_eq!(
        cutover::plan(
            Some(&index),
            &second.0,
            CATALOG,
            &parity(CATALOG, index.digest(), 3, 3, 0),
        )
        .unwrap_err(),
        CutoverRefusal::AlreadyRustOwned
    );
    assert_eq!(fs::read(dir.0.join(CUTOVER_FILE)).unwrap(), record);
}

#[test]
fn ticket_t_3_drain_cutover_changed_manifest_on_restart_fails_closed() {
    let bundled = fixture_index();
    let upgraded = index_with_extra_tool();
    let dir = Scratch::new("manifest-changed");
    assert!(matches!(
        switch(&bundled, &dir.0, CATALOG),
        CutoverReceipt::Committed { .. }
    ));
    assert_eq!(
        cutover::recover(&dir.0, Some(&upgraded)).unwrap_err(),
        CutoverError::RestartManifestChanged {
            recorded: bundled.digest().into(),
            bundled: upgraded.digest().into(),
        }
    );
}

#[test]
fn ticket_t_3_drain_cutover_receipts_serialize_exactly() {
    let operation = || CATALOG.to_owned();
    for (receipt, expected) in [
        (
            CutoverReceipt::Committed {
                operation: operation(),
                participants: 4,
                manifest_sha256: "aa".into(),
                parity_sha256: "bb".into(),
                fixtures: 3,
                directory_synced: false,
            },
            json!({"outcome": "committed", "operation": CATALOG, "participants": 4,
                "manifest_sha256": "aa", "parity_sha256": "bb", "fixtures": 3,
                "directory_synced": false}),
        ),
        (
            CutoverReceipt::DrainTimedOut {
                operation: operation(),
                tracked_idle: true,
                gateway_idle: false,
            },
            json!({"outcome": "drain_timed_out", "operation": CATALOG,
                "tracked_idle": true, "gateway_idle": false}),
        ),
        (
            CutoverReceipt::CompatNotReaped {
                operation: operation(),
            },
            json!({"outcome": "compat_not_reaped", "operation": CATALOG}),
        ),
        (
            CutoverReceipt::CompatForceKilled {
                operation: operation(),
            },
            json!({"outcome": "compat_force_killed", "operation": CATALOG}),
        ),
        (
            CutoverReceipt::CommitFailed {
                operation: operation(),
                detail: "disk full".into(),
            },
            json!({"outcome": "commit_failed", "operation": CATALOG, "detail": "disk full"}),
        ),
    ] {
        assert_eq!(serde_json::to_value(&receipt).unwrap(), expected);
        let mut line = expected.clone();
        line["event"] = json!("cutover");
        assert_eq!(
            serde_json::to_value(Evidence::Cutover(&receipt)).unwrap(),
            line
        );
    }
    assert_eq!(
        serde_json::to_value(Evidence::Refused {
            operation: CATALOG,
            refusal: &CutoverRefusal::ParityFailures {
                fixtures: 3,
                passed: 2,
                failed: 1,
            },
        })
        .unwrap(),
        json!({"event": "refused", "operation": CATALOG, "reason": "parity_failures",
            "fixtures": 3, "passed": 2, "failed": 1})
    );
    assert_eq!(
        serde_json::to_value(Evidence::Refused {
            operation: CATALOG,
            refusal: &CutoverRefusal::FlagOff,
        })
        .unwrap(),
        json!({"event": "refused", "operation": CATALOG, "reason": "flag_off"})
    );
    assert_eq!(
        serde_json::to_value(Evidence::Boot(&BootReceipt {
            rust_operations: vec![CATALOG.into()],
            abandoned_temporaries: 1,
            evidence_saved: false,
        }))
        .unwrap(),
        json!({"event": "boot", "rust_operations": [CATALOG], "abandoned_temporaries": 1})
    );
    assert_eq!(
        serde_json::to_value(Evidence::BootFailed(
            &CutoverError::RestartManifestChanged {
                recorded: "aa".into(),
                bundled: "bb".into(),
            }
        ))
        .unwrap(),
        json!({"event": "boot_failed", "reason": "restart_manifest_changed",
            "recorded": "aa", "bundled": "bb"})
    );
}

#[test]
fn ticket_t_3_drain_cutover_evidence_log_appends_exact_lines() {
    use std::os::unix::fs::PermissionsExt;
    let index = fixture_index();
    let dir = Scratch::new("evidence");
    let owners = OperationOwners::node_only();
    let refusal = cutover::plan(Some(&index), &owners, PROFILE_SYNC, "{}").unwrap_err();
    cutover::append_evidence(
        &dir.0,
        &Evidence::Refused {
            operation: PROFILE_SYNC,
            refusal: &refusal,
        },
    )
    .unwrap();
    let timed_out = plan_for(&index, &owners, CATALOG).commit(
        &dir.0,
        DrainEvidence {
            gateway_idle: false,
            ..DRAINED
        },
    );
    cutover::append_evidence(&dir.0, &Evidence::Cutover(&timed_out)).unwrap();
    let committed = plan_for(&index, &owners, CATALOG).commit(&dir.0, DRAINED);
    cutover::append_evidence(&dir.0, &Evidence::Cutover(&committed)).unwrap();
    assert_eq!(
        evidence_lines(&dir.0),
        vec![
            json!({"event": "refused", "operation": PROFILE_SYNC, "reason": "node_cannot_fence",
                "participant": "worker.startManagedProfileSync"}),
            json!({"event": "cutover", "outcome": "drain_timed_out", "operation": CATALOG,
                "tracked_idle": true, "gateway_idle": false}),
            json!({"event": "cutover", "outcome": "committed", "operation": CATALOG,
                "participants": 4, "manifest_sha256": index.digest(),
                "parity_sha256": sha256(&parity(CATALOG, index.digest(), 3, 3, 0)),
                "fixtures": 3, "directory_synced": true}),
        ]
    );
    let mode = fs::metadata(dir.0.join(EVIDENCE_FILE))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}
