use pp_gateway::ownership::{
    AdmissionError, Owner,
    manifest::{
        Claim, Disposition, OwnershipIndex, admit_bundled_manifest, admit_manifest_documents,
    },
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const DESKTOP_MODE: &str = "self-host/single-user-auth";
const HOOK_VERBS: &[&str] = &["start", "migrate", "sweep", "backfill", "prepare", "seed"];
const HOOK_FILES: &[&str] = &["app.ts", "mcp/stdio-server.ts", "desktop.ts", "index.ts"];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn server(relative: &str) -> String {
    read(&repo_root().join("web/apps/server/src").join(relative))
}

fn manifest_value() -> serde_json::Value {
    serde_json::from_str(include_str!("../ownership-manifest.json")).unwrap()
}

fn operations_text() -> &'static str {
    include_str!("../operations.json")
}

fn source_sync_text() -> &'static str {
    include_str!("../../../../web/apps/server/src/data/source-sync-ownership.json")
}

fn admit_value(manifest: &serde_json::Value) -> Result<OwnershipIndex, AdmissionError> {
    admit_manifest_documents(&manifest.to_string(), operations_text(), source_sync_text())
}

fn push_operation(manifest: &mut serde_json::Value, operation: &str, participants: &[&str]) {
    manifest["operations"].as_array_mut().unwrap().push(
        serde_json::json!({"operation": operation, "owner": "node", "participants": participants}),
    );
}

fn quoted_after<'a>(text: &'a str, marker: &str) -> Vec<&'a str> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(marker) {
        let tail = &rest[at + marker.len()..];
        let end = tail.find('"').unwrap();
        found.push(&tail[..end]);
        rest = &tail[end..];
    }
    found
}

/// `case "name"` labels, with the text up to the next label.
fn case_bodies(text: &str) -> Vec<(&str, &str)> {
    let starts: Vec<usize> = text
        .match_indices("case \"")
        .map(|(at, _)| at)
        .filter(|at| text[..*at].ends_with(' '))
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(index, start)| {
            let label_start = start + "case \"".len();
            let label_end = label_start + text[label_start..].find('"').unwrap();
            let end = starts.get(index + 1).copied().unwrap_or(text.len());
            (&text[label_start..label_end], &text[label_end..end])
        })
        .collect()
}

fn identifiers_before_paren(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$';
    let mut found = Vec::new();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte != b'(' {
            continue;
        }
        let mut start = at;
        while start > 0 && is_ident(bytes[start - 1]) {
            start -= 1;
        }
        if start < at {
            found.push(&text[start..at]);
        }
    }
    found
}

fn local_definitions(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for marker in ["const ", "function "] {
        for (at, _) in text.match_indices(marker) {
            let tail = &text[at + marker.len()..];
            let end = tail
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(tail.len());
            names.insert(tail[..end].to_string());
        }
    }
    names
}

/// Startup hooks the server entry points call: `start*`, `migrate*`, `sweep*`,
/// `backfill*`, `prepare*` and `seed*` functions they do not define themselves.
fn startup_hooks() -> BTreeSet<String> {
    let sources: Vec<String> = HOOK_FILES.iter().map(|file| server(file)).collect();
    let local: BTreeSet<String> = sources
        .iter()
        .flat_map(|text| local_definitions(text))
        .collect();
    let mut hooks = BTreeSet::new();
    for text in &sources {
        for name in identifiers_before_paren(text) {
            let hook = HOOK_VERBS.iter().any(|verb| {
                name.strip_prefix(verb)
                    .and_then(|rest| rest.chars().next())
                    .is_some_and(|first| first.is_ascii_uppercase())
            });
            if hook && !local.contains(name) {
                hooks.insert(name.to_string());
            }
        }
    }
    hooks
}

/// Every participant actual sources expose, derived without the manifest.
fn source_census() -> BTreeSet<String> {
    let root = repo_root();
    let mut census = BTreeSet::new();

    let fastify: serde_json::Value =
        serde_json::from_str(&read(&root.join("fixtures/http/routes-inventory.json"))).unwrap();
    for route in fastify["routes"].as_array().unwrap() {
        let registered = route
            .get("registeredByMode")
            .map(|modes| modes[DESKTOP_MODE]["registered"].as_bool().unwrap())
            .unwrap_or(true);
        if registered {
            census.insert(format!(
                "http.{} {}",
                route["method"].as_str().unwrap(),
                route["path"].as_str().unwrap()
            ));
        }
    }

    let tools = server("assistant/tools.ts");
    let invoke = tools
        .find("export async function invokeAssistantTool")
        .unwrap();
    let apply = tools
        .find("export async function applyAssistantAction")
        .unwrap();
    for (label, _) in case_bodies(&tools[invoke..apply]) {
        census.insert(format!("tool.{label}"));
    }
    for (label, body) in case_bodies(&tools[apply..]) {
        // A confirmed action already admitted under its Source Sync guard keeps that id.
        let guarded = quoted_after(body, "requireSourceSyncParticipant(\"");
        match guarded.first() {
            Some(id) => census.insert(id.to_string()),
            None => census.insert(format!("assistant.{label}")),
        };
    }

    let mcp = server("mcp/product-mcp.ts");
    let meta = &mcp[mcp.find("const META_TOOLS").unwrap()..];
    let meta = &meta[..meta.find("] as const").unwrap()];
    for name in quoted_after(meta, "\n    name: \"") {
        census.insert(format!("mcp.{name}"));
    }

    let contracts = read(&root.join("web/packages/contracts/src/index.ts"));
    let kinds = &contracts[contracts.find("export const JOB_KINDS = [").unwrap()..];
    let kinds = &kinds[..kinds.find(']').unwrap()];
    for kind in kinds.split('"').skip(1).step_by(2) {
        census.insert(format!("job.{kind}"));
    }
    census
}

fn hook_name(id: &str) -> Option<&str> {
    ["startup.", "worker.", "migration."]
        .iter()
        .find_map(|prefix| id.strip_prefix(prefix))
}

#[test]
fn ticket_t_7_ownership_manifest_claims_every_source_participant() {
    let index = admit_bundled_manifest().unwrap();
    let census = source_census();
    let hooks = startup_hooks();
    let claimed: BTreeSet<String> = index
        .claims()
        .keys()
        .filter(|id| hook_name(id).is_none())
        .cloned()
        .collect();
    let missing: Vec<_> = census.difference(&claimed).collect();
    let stale: Vec<_> = claimed.difference(&census).collect();
    assert!(
        missing.is_empty(),
        "source participants without an owner: {missing:?}"
    );
    assert!(
        stale.is_empty(),
        "manifest claims absent from sources: {stale:?}"
    );

    let claimed_hooks: BTreeSet<String> = index
        .claims()
        .keys()
        .filter_map(|id| hook_name(id).map(str::to_string))
        .collect();
    assert_eq!(claimed_hooks, hooks, "startup hook census");

    let count = |prefix: &str| census.iter().filter(|id| id.starts_with(prefix)).count();
    assert_eq!(
        [
            count("http."),
            count("tool."),
            count("assistant."),
            count("mcp."),
            count("job."),
            hooks.len()
        ],
        [824, 89, 38, 4, 10, 9],
        "census counts changed; review the new participants and their owners"
    );
}

#[test]
fn ticket_t_7_ownership_manifest_lookup_resolves_owners() {
    let index = admit_bundled_manifest().unwrap();
    let source_sync = |id: &str| index.lookup(id).unwrap().operation.clone();
    for id in [
        "http.POST /jobs/sync",
        "http.POST /api/v1/jobs/sync",
        "http.GET /sources/:id/docs",
        "http.HEAD /sources/:id/docs",
        "http.HEAD /api/v1/sources/:id/cover",
        "mcp.start_sync",
        "job.sync",
        "worker.startSourceWatcher",
    ] {
        assert_eq!(source_sync(id), "source.sync", "{id}");
    }
    assert_eq!(
        index.lookup("job.printer-upload").unwrap(),
        &Claim {
            operation: "job.printer-upload".to_string(),
            disposition: Disposition::Owned(Owner::Node),
        }
    );
    let plans = index.lookup("http.GET /plans").unwrap();
    assert_eq!(plans.disposition, Disposition::Owned(Owner::Node));
    assert_eq!(
        index.lookup("http.GET /api/v2/plans").unwrap().operation,
        plans.operation
    );
    assert_ne!(
        index.lookup("http.GET /api/v1/plans").unwrap().operation,
        plans.operation
    );
    assert_eq!(
        index.lookup("http.POST /auth/login").unwrap().disposition,
        Disposition::Refused
    );
    assert_eq!(
        index.lookup("http.POST /auth/logout").unwrap().disposition,
        Disposition::Gateway
    );
}

#[test]
fn ticket_t_7_ownership_manifest_unknown_participant_fails_closed() {
    let index = admit_bundled_manifest().unwrap();
    for id in [
        "tool.not_a_tool",
        "job.export-everything",
        "http.POST /future/unreviewed",
        "http.GET /board/posts",
        "startup.startServer",
        "",
    ] {
        assert_eq!(
            index.lookup(id),
            Err(AdmissionError::UnknownParticipant { id: id.to_string() }),
            "{id}"
        );
    }
}

#[test]
fn ticket_t_7_ownership_manifest_double_claim_rejected() {
    let mut manifest = manifest_value();
    manifest["node_participants"]["job"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("sync"));
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::ConflictingParticipant {
            operation: "job.sync".to_string(),
            left: "source.sync".to_string(),
            right: "job.sync".to_string(),
        }
    );

    let mut manifest = manifest_value();
    manifest["node_participants"]["tool"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("archive_plan"));
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::DuplicateParticipant {
            id: "tool.archive_plan".to_string()
        }
    );
}

#[test]
fn ticket_t_7_ownership_manifest_split_alias_rejected() {
    let mut manifest = manifest_value();
    push_operation(&mut manifest, "plans.list", &["http.GET /plans"]);
    let error = admit_value(&manifest).unwrap_err();
    assert!(
        matches!(&error, AdmissionError::ConflictingParticipant { operation, .. } if operation == "GET /plans current"),
        "{error}"
    );

    let mut manifest = manifest_value();
    push_operation(
        &mut manifest,
        "plans.list",
        &["http.GET /plans", "http.GET /api/v2/plans"],
    );
    let index = admit_value(&manifest).unwrap();
    assert_eq!(
        index.lookup("http.HEAD /api/v2/plans").unwrap().operation,
        "plans.list"
    );
}

#[test]
fn ticket_t_7_ownership_manifest_refused_and_unregistered_routes_cannot_be_claimed() {
    let mut manifest = manifest_value();
    push_operation(&mut manifest, "auth.login", &["http.POST /auth/login"]);
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::ConflictingParticipant {
            operation: "http.POST /auth/login".to_string(),
            left: "auth.login".to_string(),
            right: "gateway.denied".to_string(),
        }
    );

    let mut manifest = manifest_value();
    push_operation(&mut manifest, "board.list", &["http.GET /board/posts"]);
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::UnknownParticipant {
            id: "http.GET /board/posts".to_string()
        }
    );
}

#[test]
fn ticket_t_7_ownership_manifest_owner_and_kind_fail_closed() {
    let mut manifest = manifest_value();
    manifest["operations"][0]["owner"] = serde_json::json!("rust");
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::UnsupportedRustOwner {
            participant: "source.sync".to_string()
        }
    );

    let mut manifest = manifest_value();
    manifest["operations"][0]["owner"] = serde_json::json!("python");
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::UnknownOwner {
            value: "python".to_string()
        }
    );

    let mut manifest = manifest_value();
    push_operation(&mut manifest, "cron.nightly", &["cron.nightly"]);
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::UnknownParticipantKind {
            value: "cron".to_string()
        }
    );

    let mut manifest = manifest_value();
    manifest["node_participants"]["cron"] = serde_json::json!(["nightly"]);
    assert!(matches!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::Malformed(_)
    ));

    let mut manifest = manifest_value();
    manifest["schema"] = serde_json::json!("pp-ownership-manifest-v0");
    assert!(matches!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::Malformed(_)
    ));
}

#[test]
fn ticket_t_7_ownership_manifest_source_sync_group_matches_admission() {
    let mut manifest = manifest_value();
    manifest["operations"][0]["participants"]
        .as_array_mut()
        .unwrap()
        .retain(|id| id != "job.sync");
    manifest["node_participants"]["job"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("sync"));
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::ParticipantSetMismatch {
            missing: vec!["job.sync".to_string()],
            unexpected: vec![],
        }
    );

    let mut manifest = manifest_value();
    manifest["operations"] = serde_json::json!([]);
    assert_eq!(
        admit_value(&manifest).unwrap_err(),
        AdmissionError::UnknownOperation {
            value: "source.sync".to_string()
        }
    );
}

#[test]
fn ticket_t_7_ownership_manifest_registry_owner_fails_closed() {
    let mut registry: serde_json::Value = serde_json::from_str(operations_text()).unwrap();
    let route = registry["routes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|route| route["method"] == "POST" && route["path"] == "/jobs/sync")
        .unwrap();
    route["owner"] = serde_json::json!("unreviewed");
    assert_eq!(
        admit_manifest_documents(
            &manifest_value().to_string(),
            &registry.to_string(),
            source_sync_text(),
        )
        .unwrap_err(),
        AdmissionError::UnknownOwner {
            value: "unreviewed".to_string()
        }
    );
}

#[test]
fn ticket_t_7_ownership_manifest_registry_claim_without_manifest_entry() {
    let manifest = manifest_value().to_string();
    let mut registry: serde_json::Value = serde_json::from_str(operations_text()).unwrap();
    registry["routes"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "method": "POST", "path": "/future/registry-claim", "owner": "compat",
            "operation": "POST /future/registry-claim current"
        }));
    let index =
        admit_manifest_documents(&manifest, &registry.to_string(), source_sync_text()).unwrap();
    assert_eq!(
        index.lookup("http.POST /future/registry-claim"),
        Ok(&Claim {
            operation: "http:POST /future/registry-claim current".to_string(),
            disposition: Disposition::Owned(Owner::Node),
        })
    );

    for owner in ["unreviewed", "rust", "node", ""] {
        registry["routes"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["owner"] = serde_json::json!(owner);
        assert_eq!(
            admit_manifest_documents(&manifest, &registry.to_string(), source_sync_text())
                .unwrap_err(),
            AdmissionError::UnknownOwner {
                value: owner.to_string()
            },
            "{owner}"
        );
    }
}

#[test]
fn ticket_t_7_ownership_manifest_registry_double_claim_rejected() {
    let mut registry: serde_json::Value = serde_json::from_str(operations_text()).unwrap();
    let logout = serde_json::json!({
        "method": "POST", "path": "/auth/logout", "owner": "compat", "effect": "local_commit",
        "operation": "POST /auth/logout current", "contract": "current", "websocket": false,
        "effect_reason": "Node owns the complete local transaction or file publication"
    });
    registry["routes"].as_array_mut().unwrap().push(logout);
    let error = admit_manifest_documents(
        &manifest_value().to_string(),
        &registry.to_string(),
        source_sync_text(),
    )
    .unwrap_err();
    assert_eq!(
        error,
        AdmissionError::ConflictingParticipant {
            operation: "http.POST /auth/logout".to_string(),
            left: "http:POST /auth/logout current".to_string(),
            right: "gateway.owned".to_string(),
        }
    );
}
