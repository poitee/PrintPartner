use pp_gateway::ownership::{
    AdmissionError, Owner, SOURCE_SYNC_PARTICIPANTS, admit_bundled_source_sync, admit_observed,
    admit_planted_sections, boot_source_sync, fingerprint_tree,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn scratch(name: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let dir = base.join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn bundled_text() -> &'static str {
    include_str!("../../../../web/apps/server/src/data/source-sync-ownership.json")
}

fn bundled_value() -> serde_json::Value {
    serde_json::from_str(bundled_text()).unwrap()
}

fn set_participant_owner(value: &mut serde_json::Value, id: &str, owner: &str) {
    let participants = value["participants"].as_array_mut().unwrap();
    let participant = participants
        .iter_mut()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("missing participant {id}"));
    participant["owner"] = serde_json::json!(owner);
}

fn set_participant_resources(value: &mut serde_json::Value, id: &str, resources: &[&str]) {
    let participants = value["participants"].as_array_mut().unwrap();
    let participant = participants
        .iter_mut()
        .find(|item| item["id"] == id)
        .unwrap();
    participant["resources"] = serde_json::json!(resources);
}

fn remove_participant(value: &mut serde_json::Value, id: &str) {
    let participants = value["participants"].as_array_mut().unwrap();
    participants.retain(|item| item["id"] != id);
}

fn plant_tree(dir: &Path) {
    fs::write(dir.join("state.db"), b"db-bytes").unwrap();
    fs::write(dir.join("state.db-wal"), b"wal-bytes").unwrap();
    fs::create_dir_all(dir.join("sources")).unwrap();
    fs::write(dir.join("sources/fixture.txt"), b"source-bytes").unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn ticket_t_7_ownership_bundled_manifest_admits_node() {
    let admitted = admit_bundled_source_sync().unwrap();
    assert_eq!(admitted.operation, "source.sync");
    assert_eq!(admitted.owner, Owner::Node);
    assert_eq!(
        admitted.participant_ids.len(),
        SOURCE_SYNC_PARTICIPANTS.len()
    );
    for id in SOURCE_SYNC_PARTICIPANTS {
        assert!(admitted.participant_ids.contains(*id), "{id}");
    }
}

#[test]
fn ticket_t_7_ownership_conflicting_worker_startup_rejected() {
    let mut value = bundled_value();
    set_participant_owner(&mut value, "worker.startSourceWatcher", "rust");
    let error = admit_observed(
        &serde_json::to_string(&value).unwrap(),
        SOURCE_SYNC_PARTICIPANTS,
    )
    .unwrap_err();
    assert!(
        matches!(error, AdmissionError::ConflictingParticipant { .. }),
        "{error}"
    );
    assert!(
        error.to_string().contains("conflicting ownership"),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_unknown_owner_fail_closed() {
    let mut value = bundled_value();
    set_participant_owner(&mut value, "job.sync", "postgres");
    let error = admit_observed(
        &serde_json::to_string(&value).unwrap(),
        SOURCE_SYNC_PARTICIPANTS,
    )
    .unwrap_err();
    assert!(
        matches!(error, AdmissionError::UnknownOwner { ref value } if value == "postgres"),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_unknown_operation_rejected() {
    let mut value = bundled_value();
    value["operation"] = serde_json::json!("source.publish");
    let error = admit_observed(&serde_json::to_string(&value).unwrap(), &[]).unwrap_err();
    assert!(
        matches!(error, AdmissionError::UnknownOperation { .. }),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_unknown_kind_rejected() {
    let mut value = bundled_value();
    value["participants"][0]["kind"] = serde_json::json!("cron");
    let error = admit_observed(&serde_json::to_string(&value).unwrap(), &[]).unwrap_err();
    assert!(
        matches!(error, AdmissionError::UnknownParticipantKind { .. }),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_unknown_rollback_fail_closed() {
    let mut value = bundled_value();
    value["live_format"]["rollback"] = serde_json::json!("best-effort");
    let error = admit_observed(&serde_json::to_string(&value).unwrap(), &[]).unwrap_err();
    assert!(
        matches!(error, AdmissionError::UnknownLiveFormat { .. }),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_all_rust_unsupported() {
    let mut value = bundled_value();
    value["owner"] = serde_json::json!("rust");
    for participant in value["participants"].as_array_mut().unwrap() {
        participant["owner"] = serde_json::json!("rust");
    }
    let error = admit_observed(
        &serde_json::to_string(&value).unwrap(),
        SOURCE_SYNC_PARTICIPANTS,
    )
    .unwrap_err();
    assert!(
        matches!(error, AdmissionError::UnsupportedRustOwner { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("Node remains"), "{error}");
}

#[test]
fn ticket_t_7_ownership_single_rust_participant_conflicts() {
    let mut value = bundled_value();
    set_participant_owner(&mut value, "mcp.start_sync", "rust");
    set_participant_resources(&mut value, "mcp.start_sync", &["file:mcp-only"]);
    let error = admit_observed(
        &serde_json::to_string(&value).unwrap(),
        SOURCE_SYNC_PARTICIPANTS,
    )
    .unwrap_err();
    assert!(
        matches!(error, AdmissionError::ConflictingParticipant { .. }),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_conflicting_resource_rejected() {
    let mut value = bundled_value();
    set_participant_owner(&mut value, "mcp.start_sync", "rust");
    let error = admit_observed(
        &serde_json::to_string(&value).unwrap(),
        SOURCE_SYNC_PARTICIPANTS,
    )
    .unwrap_err();
    assert!(
        matches!(error, AdmissionError::ConflictingResource { .. }),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_incompatible_rollback_preserves_tree() {
    let mut value = bundled_value();
    value["live_format"]["rollback"] = serde_json::json!("incompatible");
    let dir = scratch("ticket_t_7_ownership_incompatible");
    plant_tree(&dir);
    let before = fingerprint_tree(&dir).unwrap();
    let error = boot_source_sync(&dir, &serde_json::to_string(&value).unwrap()).unwrap_err();
    assert!(
        matches!(error, AdmissionError::IncompatibleRollback { .. }),
        "{error}"
    );
    assert_eq!(fingerprint_tree(&dir).unwrap(), before);
    assert!(!dir.join("source-sync-admission.json").exists());
    assert!(!dir.join(".source-sync-admission.json.tmp").exists());
    assert_eq!(fs::read(dir.join("state.db")).unwrap(), b"db-bytes");
    assert_eq!(fs::read(dir.join("state.db-wal")).unwrap(), b"wal-bytes");
    assert_eq!(
        fs::read(dir.join("sources/fixture.txt")).unwrap(),
        b"source-bytes"
    );
}

#[test]
fn ticket_t_7_ownership_missing_participant_rejected() {
    for id in ["startup.startSourceWatcher", "mcp.start_sync"] {
        let mut value = bundled_value();
        remove_participant(&mut value, id);
        let error = admit_observed(
            &serde_json::to_string(&value).unwrap(),
            SOURCE_SYNC_PARTICIPANTS,
        )
        .unwrap_err();
        assert!(
            matches!(error, AdmissionError::ParticipantSetMismatch { .. }),
            "{id}: {error}"
        );
    }
}

#[test]
fn ticket_t_7_ownership_restart_reuses_receipt() {
    let dir = scratch("ticket_t_7_ownership_restart");
    let first = boot_source_sync(&dir, bundled_text()).unwrap();
    let second = boot_source_sync(&dir, bundled_text()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.operation, "source.sync");
    assert_eq!(first.owner, "node");
    assert_eq!(first.admission_count, 1);
    assert!(first.participant_count > 0);
    assert_eq!(first.worker_pid, std::process::id());
    let persisted: pp_gateway::ownership::AdmissionReceipt =
        serde_json::from_str(&read(&dir.join("source-sync-admission.json"))).unwrap();
    assert_eq!(persisted, first);
}

#[test]
fn ticket_t_7_ownership_failure_then_valid_boot() {
    let dir = scratch("ticket_t_7_ownership_failure_then_valid");
    plant_tree(&dir);
    let before = fingerprint_tree(&dir).unwrap();
    let mut value = bundled_value();
    value["owner"] = serde_json::json!("oracle");
    let error = boot_source_sync(&dir, &serde_json::to_string(&value).unwrap()).unwrap_err();
    assert!(
        matches!(error, AdmissionError::UnknownOwner { .. }),
        "{error}"
    );
    assert_eq!(fingerprint_tree(&dir).unwrap(), before);
    assert!(!dir.join("source-sync-admission.json").exists());
    let receipt = boot_source_sync(&dir, bundled_text()).unwrap();
    assert_eq!(receipt.admission_count, 1);
    assert_eq!(receipt.owner, "node");
    assert!(receipt.participant_count > 0);
}

#[test]
fn ticket_t_7_ownership_restart_manifest_changed() {
    let dir = scratch("ticket_t_7_ownership_manifest_changed");
    let first = boot_source_sync(&dir, bundled_text()).unwrap();
    let persisted = read(&dir.join("source-sync-admission.json"));
    let mut value = bundled_value();
    value["live_format"]["id"] = serde_json::json!("source-revision-workspace-v2");
    let error = boot_source_sync(&dir, &serde_json::to_string(&value).unwrap()).unwrap_err();
    assert!(
        matches!(error, AdmissionError::RestartManifestChanged),
        "{error}"
    );
    assert_eq!(read(&dir.join("source-sync-admission.json")), persisted);
    assert!(persisted.contains(&first.manifest_sha256));
}

#[test]
fn ticket_t_7_ownership_planted_sections_conflict() {
    let document = serde_json::json!({
        "routes": [],
        "workers": [{"operation": "source.sync", "id": "startSourceWatcher", "owner": "rust"}],
        "startup": [{"operation": "source.sync", "id": "startSourceWatcher", "owner": "compat"}],
        "mcp": []
    });
    let error = admit_planted_sections(&document).unwrap_err();
    assert!(
        matches!(error, AdmissionError::ConflictingParticipant { .. }),
        "{error}"
    );
    assert!(
        error.to_string().contains("conflicting ownership"),
        "{error}"
    );
}

#[test]
fn ticket_t_7_ownership_python_conflict_exits_nonzero() {
    let dir = scratch("ticket_t_7_ownership_python_conflict");
    let inventory = serde_json::json!({
        "routes": [],
        "workers": [{"operation": "source.sync", "id": "startSourceWatcher", "owner": "rust"}],
        "startup": [{"operation": "source.sync", "id": "startSourceWatcher", "owner": "compat"}],
        "mcp": []
    });
    let inventory_path = dir.join("inventory.json");
    fs::write(
        &inventory_path,
        serde_json::to_vec_pretty(&inventory).unwrap(),
    )
    .unwrap();
    let operations = repo_root().join("rust/crates/pp-gateway/operations.json");
    let before = fs::read(&operations).unwrap();
    let output = Command::new("python3")
        .arg(repo_root().join("rust/scripts/gateway-operations.py"))
        .arg(&inventory_path)
        .arg("--check")
        .output()
        .unwrap();
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.status.success(), "{combined}");
    assert!(combined.contains("conflicting ownership"), "{combined}");
    assert!(!combined.contains("Gateway registry differs"), "{combined}");
    assert_eq!(fs::read(&operations).unwrap(), before);
}

#[test]
fn ticket_t_7_ownership_python_unknown_owner_exits_nonzero() {
    let dir = scratch("ticket_t_7_ownership_python_unknown");
    let inventory = serde_json::json!({
        "routes": [],
        "workers": [{"operation": "source.sync", "id": "startSourceWatcher", "owner": "postgres"}],
        "startup": [{"operation": "source.sync", "id": "startSourceWatcher", "owner": "node"}],
        "mcp": [{"operation": "source.sync", "id": "start_sync", "owner": "node"}]
    });
    let inventory_path = dir.join("inventory.json");
    fs::write(&inventory_path, serde_json::to_vec(&inventory).unwrap()).unwrap();
    let output = Command::new("python3")
        .arg(repo_root().join("rust/scripts/gateway-operations.py"))
        .arg(&inventory_path)
        .arg("--check")
        .output()
        .unwrap();
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.status.success(), "{combined}");
    assert!(combined.contains("unknown owner postgres"), "{combined}");
}

#[test]
fn ticket_t_7_ownership_python_self_test_unchanged() {
    let output = Command::new("python3")
        .arg(repo_root().join("rust/scripts/gateway-operations.py"))
        .arg(repo_root().join("rust/crates/pp-gateway/operations.json"))
        .arg("--self-test")
        .output()
        .unwrap();
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{combined}");
    assert!(
        combined.contains("corrected_registered_reads"),
        "{combined}"
    );
}

#[test]
fn ticket_t_7_ownership_node_runtime_rejects_conflict_and_unknown_owner() {
    let script = repo_root().join("web/apps/server/src/ownership/source-sync-admission.ts");
    let conflict_dir = scratch("ticket_t_7_ownership_node_conflict");
    let mut conflict = bundled_value();
    set_participant_owner(&mut conflict, "worker.startSourceWatcher", "rust");
    let conflict_path = conflict_dir.join("manifest.json");
    fs::write(
        &conflict_path,
        serde_json::to_vec_pretty(&conflict).unwrap(),
    )
    .unwrap();
    let conflict_output = node_admit(&script, &conflict_path, "startup.startSourceWatcher");
    assert!(!conflict_output.status.success(), "{conflict_output:?}");
    let conflict_text = command_text(&conflict_output);
    assert!(
        conflict_text.contains("conflicting ownership"),
        "{conflict_text}"
    );

    let unknown_dir = scratch("ticket_t_7_ownership_node_unknown");
    let mut unknown = bundled_value();
    set_participant_owner(&mut unknown, "job.sync", "postgres");
    let unknown_path = unknown_dir.join("manifest.json");
    fs::write(&unknown_path, serde_json::to_vec_pretty(&unknown).unwrap()).unwrap();
    let unknown_output = node_admit(&script, &unknown_path, "job.sync");
    assert!(!unknown_output.status.success(), "{unknown_output:?}");
    let unknown_text = command_text(&unknown_output);
    assert!(
        unknown_text.contains("unknown owner postgres"),
        "{unknown_text}"
    );
    assert!(!conflict_dir.join("source-sync-admission.json").exists());
    assert!(!unknown_dir.join("source-sync-admission.json").exists());
}

#[test]
fn ticket_t_7_ownership_node_runtime_admits_bundled_manifest() {
    let script = repo_root().join("web/apps/server/src/ownership/source-sync-admission.ts");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../web/apps/server/src/data/source-sync-ownership.json");
    let output = node_admit(&script, &manifest, "worker.startSourceWatcher");
    assert!(output.status.success(), "{}", command_text(&output));
}

#[test]
fn ticket_t_7_ownership_call_sites_match_manifest() {
    let root = repo_root();
    let jobs = read(&root.join("web/apps/server/src/routes/jobs.ts"));
    let sources = read(&root.join("web/apps/server/src/routes/sources.ts"));
    let tools = read(&root.join("web/apps/server/src/assistant/tools.ts"));
    let runner = read(&root.join("web/apps/server/src/services/job-runner.ts"));
    let watcher = read(&root.join("web/apps/server/src/services/source-watcher.ts"));
    let schema = read(&root.join("web/apps/server/src/db/schema.ts"));
    let workspace = read(&root.join("web/apps/server/src/services/source-workspace.ts"));
    let aliases = read(&root.join("web/apps/server/src/routes/api-v1.ts"));
    let gateway = read(&root.join("rust/crates/pp-gateway/src/lib.rs"));
    let app = read(&root.join("web/apps/server/src/app.ts"));
    let admission = read(&root.join("web/apps/server/src/ownership/source-sync-admission.ts"));

    let jobs_route = &jobs[jobs.find("app.post(\"/jobs/sync\"").unwrap()..];
    let start_job = jobs_route.find("jobs.start(\"sync\"").unwrap();
    assert!(
        jobs_route[..start_job].contains("requireSourceSyncParticipant(\"http.POST /jobs/sync\")")
    );
    assert!(
        jobs_route[..start_job]
            .contains("requireSourceSyncParticipant(\"http.POST /api/v1/jobs/sync\")")
    );
    assert!(aliases.contains("registerCoreRoutes"));

    let sources_route = &sources[sources.find("app.post(\"/sources\"").unwrap()..];
    let create = sources_route.find("createSource(").unwrap();
    assert!(
        create
            > sources_route
                .find("requireSourceSyncParticipant(\"http.POST /sources\")")
                .unwrap()
    );

    let sync_case = &tools[tools.find("case \"start_sync\"").unwrap()..];
    let dispatch = sync_case.find("jobs.start(\"sync\"").unwrap();
    assert!(sync_case[..dispatch].contains("requireSourceSyncParticipant(\"mcp.start_sync\")"));

    let start_fn = runner.find("async start(").unwrap();
    let queued = runner[start_fn..].find("randomUUID").unwrap();
    assert!(
        runner[start_fn..start_fn + queued].contains("requireSourceSyncParticipant(\"job.sync\")")
    );
    let run_sync = runner.find("this.runSync").unwrap();
    assert!(runner[..run_sync].contains("requireSourceSyncParticipant(\"job.sync\")"));

    let watcher_fn = watcher.find("export function startSourceWatcher").unwrap();
    let body = &watcher[watcher_fn..];
    let startup = body
        .find("requireSourceSyncParticipant(\"startup.startSourceWatcher\")")
        .unwrap();
    let worker = body
        .find("requireSourceSyncParticipant(\"worker.startSourceWatcher\")")
        .unwrap();
    let timeout = body.find("setTimeout").unwrap();
    let interval = body.find("setInterval").unwrap();
    assert!(startup < timeout && worker < timeout);
    assert!(startup < interval && worker < interval);

    assert!(schema.contains("\"projects\""));
    assert!(schema.contains("\"source_revisions\""));
    assert!(workspace.contains("function sourceWorkspaceRoot"));
    assert!(gateway.contains("ownership::admit_bundled_source_sync()"));
    assert!(!gateway.contains("boot_source_sync("));
    let admit_at = app.find("beginSourceSyncAdmission(").unwrap();
    let watcher_at = app.find("startSourceWatcher(").unwrap();
    assert!(admit_at < watcher_at);
    assert!(admission.contains("../data/source-sync-ownership.json"));
    assert!(!admission.contains("rust/crates/pp-gateway/source-sync-ownership.json"));

    let manifest = bundled_value();
    let mut tables = Vec::new();
    for participant in manifest["participants"].as_array().unwrap() {
        for resource in participant["resources"].as_array().unwrap() {
            let resource = resource.as_str().unwrap();
            if let Some(name) = resource.strip_prefix("table:") {
                tables.push(name.to_string());
            } else {
                assert!(resource.starts_with("file:"), "{resource}");
            }
        }
    }
    assert!(tables.contains(&"projects".to_string()));
    assert!(tables.contains(&"source_revisions".to_string()));
}

fn node_admit(script: &Path, manifest: &Path, participant: &str) -> std::process::Output {
    Command::new("node")
        .arg("--experimental-strip-types")
        .arg(script)
        .arg("--manifest")
        .arg(manifest)
        .arg("--participant")
        .arg(participant)
        .output()
        .unwrap()
}

fn command_text(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}
