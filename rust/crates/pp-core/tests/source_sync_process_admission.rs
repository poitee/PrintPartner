//! Process probes for Source Sync admission.
//!
//! `std::process::Command` is confined to pp-core. These tests still spawn the
//! Node admission CLI and the gateway operations checker; they are not skipped.

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

fn bundled_value() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../web/apps/server/src/data/source-sync-ownership.json"
    ))
    .unwrap()
}

fn set_participant_owner(value: &mut serde_json::Value, id: &str, owner: &str) {
    let participants = value["participants"].as_array_mut().unwrap();
    let participant = participants
        .iter_mut()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("missing participant {id}"));
    participant["owner"] = serde_json::json!(owner);
}

fn command_text(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
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
    let combined = command_text(&output);
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
    let combined = command_text(&output);
    assert!(!output.status.success(), "{combined}");
    assert!(combined.contains("unknown owner postgres"), "{combined}");
}

#[test]
fn ticket_t_7_ownership_python_unknown_kind_preserves_registry() {
    let dir = scratch("ticket_t_7_ownership_python_unknown_kind");
    let operations = repo_root().join("rust/crates/pp-gateway/operations.json");
    let before = fs::read(&operations).unwrap();
    for kind in ["cron", "", "mcp_acton"] {
        let inventory = serde_json::json!({
            "routes": [],
            "operations": { "source.sync": { "participants": [
                { "id": "watcher", "kind": "worker", "owner": "node" },
                { "id": "boot", "kind": "startup_watcher", "owner": "node" },
                { "id": "sync", "kind": "mcp_action", "owner": "node" },
                { "id": "unknown", "kind": kind, "owner": "node" }
            ] } }
        });
        let path = dir.join("inventory.json");
        fs::write(&path, serde_json::to_vec(&inventory).unwrap()).unwrap();
        for checking in [false, true] {
            let mut command = Command::new("python3");
            command
                .arg(repo_root().join("rust/scripts/gateway-operations.py"))
                .arg(&path);
            if checking {
                command.arg("--check");
            }
            let output = command.output().unwrap();
            let text = command_text(&output);
            assert!(!output.status.success(), "{kind}: {text}");
            assert!(text.contains("unknown participant kind"), "{kind}: {text}");
            assert_eq!(fs::read(&operations).unwrap(), before);
        }
    }
}

#[test]
fn ticket_t_7_ownership_python_operation_requires_participants() {
    let dir = scratch("ticket_t_7_ownership_python_missing_participants");
    let operations = repo_root().join("rust/crates/pp-gateway/operations.json");
    let before = fs::read(&operations).unwrap();
    for body in [
        serde_json::json!({}),
        serde_json::json!({"participants": null}),
        serde_json::json!({"participants": "bad"}),
    ] {
        let inventory = serde_json::json!({
            "routes": [],
            "workers": [{"operation": "source.sync", "owner": "node"}],
            "startup": [{"operation": "source.sync", "owner": "node"}],
            "mcp": [{"operation": "source.sync", "owner": "node"}],
            "operations": {"source.sync": body}
        });
        let path = dir.join("inventory.json");
        fs::write(&path, serde_json::to_vec(&inventory).unwrap()).unwrap();
        for checking in [false, true] {
            let mut command = Command::new("python3");
            command
                .arg(repo_root().join("rust/scripts/gateway-operations.py"))
                .arg(&path);
            if checking {
                command.arg("--check");
            }
            let output = command.output().unwrap();
            let text = command_text(&output);
            assert!(!output.status.success(), "{text}");
            assert!(text.contains("malformed ownership manifest"), "{text}");
            assert_eq!(fs::read(&operations).unwrap(), before);
        }
    }
}

#[test]
fn ticket_t_7_ownership_python_self_test_unchanged() {
    let output = Command::new("python3")
        .arg(repo_root().join("rust/scripts/gateway-operations.py"))
        .arg(repo_root().join("rust/crates/pp-gateway/operations.json"))
        .arg("--self-test")
        .output()
        .unwrap();
    let combined = command_text(&output);
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
