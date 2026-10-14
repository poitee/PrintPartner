use axum::{
    body::Body,
    http::{HeaderMap, Request, Response, StatusCode},
};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use pp_compat::{CompatExit, CompatHandle, Endpoint};
use pp_gateway::{
    Gateway,
    ownership::{
        Owner,
        cutover::{
            self, BootReceipt, CUTOVER_FILE, CutoverError, CutoverReceipt, CutoverRefusal,
            DrainEvidence, EVIDENCE_FILE, Evidence, OperationOwners,
        },
        manifest::{OwnershipIndex, admit_manifest_documents},
    },
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
    let unresolved = manifest["resources"]["unresolved"].as_array_mut().unwrap();
    unresolved.retain(|id| {
        ![
            "http:GET /filaments/catalog current",
            "http:GET /ws/profile-sync current",
            "worker.startManagedProfileSync",
        ]
        .iter()
        .any(|old| id == old)
    });
    unresolved.extend([json!(CATALOG), json!(PROFILE_SYNC)]);
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
            manifest["resources"]["unresolved"]
                .as_array_mut()
                .unwrap()
                .push(json!("tool.ticket_t_3_drain_extra_tool"));
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
    let receipt = plan_for(index, &owners, operation).commit(dir, DRAINED);
    assert!(matches!(receipt, CutoverReceipt::Committed { .. }));
    receipt
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
    assert_json(
        switch(&index, &dir.0, CATALOG),
        json!({"outcome": "committed", "operation": CATALOG, "participants": 4, "manifest_sha256": index.digest(), "parity_sha256": sha256(&parity(CATALOG, index.digest(), 3, 3, 0)), "fixtures": 3, "directory_synced": true}),
    );
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_json(
        boot,
        json!({"rust_operations": [CATALOG], "abandoned_temporaries": 0, "evidence_saved": true}),
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

async fn exchange(
    origin: &str,
    path: &str,
    method: &str,
    cookie: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let authority = origin.strip_prefix("http://").unwrap();
    let socket = tokio::net::TcpStream::connect(authority).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut builder = Request::builder()
        .uri(path)
        .method(method)
        .header("host", authority)
        .header("origin", origin);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let body = if method == "POST" {
        builder = builder.header("content-type", "application/json");
        Body::from(r#"{"name":"cutover"}"#)
    } else {
        Body::empty()
    };
    let response = sender
        .send_request(builder.body(body).unwrap())
        .await
        .unwrap();
    let (head, body) = response.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (head.status, head.headers, bytes)
}

struct FakeNode {
    compat: CompatHandle,
    forwards: Arc<Mutex<Vec<String>>>,
    _publication: tokio::sync::watch::Sender<Option<Arc<Endpoint>>>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

fn fake_node(dir: &Path) -> FakeNode {
    fake_node_with_hold(dir, false)
}

fn fake_node_with_hold(dir: &Path, hold: bool) -> FakeNode {
    let socket = dir.join("node.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let forwards = Arc::new(Mutex::new(Vec::new()));
    let seen = forwards.clone();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (notify_entered, notify_release) = (entered.clone(), release.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let seen = seen.clone();
            let (entered, release) = (notify_entered.clone(), notify_release.clone());
            tokio::spawn(async move {
                let service =
                    hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                        if request.uri().path() != "/__desktop/moonraker-hosts" {
                            seen.lock().unwrap().push(format!(
                                "{} {}",
                                request.method(),
                                request.uri().path()
                            ));
                        }
                        let (entered, release) = (entered.clone(), release.clone());
                        async move {
                            if hold && request.uri().path() == "/plans" {
                                entered.notify_one();
                                release.notified().await;
                            }
                            Ok::<_, std::convert::Infallible>(Response::new(Body::from("{}")))
                        }
                    });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    let (compat, publication) = CompatHandle::replaceable(Some(Endpoint::bound_to(&socket)));
    FakeNode {
        compat,
        forwards,
        _publication: publication,
        entered,
        release,
    }
}

async fn session(gateway: &mut Gateway) -> (String, String) {
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let (status, headers, _) =
        exchange(&origin, launch.strip_prefix(&origin).unwrap(), "GET", None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (origin, cookie)
}

async fn rust_owned_gateway(dir: &Path, node: &FakeNode) -> Gateway {
    let index = fixture_index();
    for operation in [CATALOG, PLANS_CREATE] {
        switch(&index, dir, operation);
    }
    let (owners, _) = cutover::recover(dir, Some(&index)).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    Gateway::start(listener, PathBuf::new(), node.compat.clone(), &owners).unwrap()
}

fn assert_rust_owner_unavailable(status: StatusCode, headers: &HeaderMap, body: &[u8]) {
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!headers.contains_key("retry-after"));
    if !body.is_empty() {
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(body).unwrap(),
            json!({
                "detail": "Operation is owned by the Rust runtime and has no handler yet",
                "code": "rust_owner_unavailable",
            })
        );
    }
}

#[tokio::test]
async fn ticket_t_3_drain_cutover_gateway_routes_whole_operation() {
    let dir = Scratch::new("gateway");
    let node = fake_node(&dir.0);
    let mut gateway = rust_owned_gateway(&dir.0, &node).await;
    let (origin, cookie) = session(&mut gateway).await;
    for (method, path) in [
        ("GET", "/filaments/catalog"),
        ("GET", "/api/v1/filaments/catalog"),
        ("HEAD", "/filaments/catalog"),
        ("HEAD", "/api/v1/filaments/catalog"),
    ] {
        let (status, headers, body) = exchange(&origin, path, method, Some(&cookie)).await;
        assert_eq!(body.is_empty(), method == "HEAD", "{method} {path}");
        assert_rust_owner_unavailable(status, &headers, &body);
    }
    assert!(node.forwards.lock().unwrap().is_empty());
    let (status, _, _) = exchange(&origin, "/filaments/custom", "GET", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        *node.forwards.lock().unwrap(),
        vec!["GET /filaments/custom".to_owned()]
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_3_drain_cutover_no_mutation_failover() {
    let dir = Scratch::new("failover");
    let node = fake_node(&dir.0);
    let mut gateway = rust_owned_gateway(&dir.0, &node).await;
    let (origin, cookie) = session(&mut gateway).await;
    for path in ["/plans", "/api/v2/plans"] {
        let (status, headers, body) = exchange(&origin, path, "POST", Some(&cookie)).await;
        assert_rust_owner_unavailable(status, &headers, &body);
        assert!(!body.is_empty());
    }
    assert!(node.forwards.lock().unwrap().is_empty());
    let (status, _, _) = exchange(&origin, "/filaments/custom", "POST", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        *node.forwards.lock().unwrap(),
        vec!["POST /filaments/custom".to_owned()]
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_3_drain_cutover_gateway_refuses_unregistered_rust_route() {
    let mut registry: serde_json::Value =
        serde_json::from_str(include_str!("../operations.json")).unwrap();
    registry["routes"].as_array_mut().unwrap().push(json!({
        "method": "POST",
        "path": "/ticket-t-3-drain/rust-only",
        "owner": "compat",
        "effect": "local_commit",
        "operation": "POST /ticket-t-3-drain/rust-only current",
    }));
    let index = index_from(
        |manifest| {
            manifest["resources"]["unresolved"]
                .as_array_mut()
                .unwrap()
                .push(json!("http:POST /ticket-t-3-drain/rust-only current"));
        },
        &registry.to_string(),
    );
    let dir = Scratch::new("unregistered");
    let operation = "http:POST /ticket-t-3-drain/rust-only current";
    assert!(matches!(
        switch(&index, &dir.0, operation),
        CutoverReceipt::Committed {
            participants: 1,
            ..
        }
    ));
    let (owners, _) = cutover::recover(&dir.0, Some(&index)).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let error = Gateway::start(
        listener,
        PathBuf::new(),
        CompatHandle::unpublished(),
        &owners,
    )
    .err()
    .unwrap();
    assert_eq!(
        error.to_string(),
        "Rust-owned participant http.POST /ticket-t-3-drain/rust-only is not a registered route"
    );
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
    assert_json(
        error,
        json!({"reason": "participant_set_mismatch", "operation": CATALOG, "missing": [
                "http.GET /api/v1/filaments/catalog",
                "http.HEAD /api/v1/filaments/catalog",
                "http.HEAD /filaments/catalog",
            ], "unexpected": []}),
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
        assert_json(
            cutover::plan(
                Some(&index),
                &owners,
                operation,
                &parity(operation, index.digest(), 3, 3, 0),
            )
            .unwrap_err(),
            json!({"reason": "node_cannot_fence", "participant": participant}),
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
    assert_json(
        cutover::recover(&dir.0, Some(&index)).unwrap_err(),
        json!({"reason": "node_cannot_fence", "participant": "worker.startManagedProfileSync"}),
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
    assert_json(
        refuse(&parity(CATALOG, index.digest(), 0, 0, 0)),
        json!({"reason": "parity_no_fixtures"}),
    );
    for (passed, failed) in [(2, 1), (3, 1), (2, 0)] {
        assert_json(
            refuse(&parity(CATALOG, index.digest(), 3, passed, failed)),
            json!({"reason": "parity_failures", "fixtures": 3, "passed": passed, "failed": failed}),
        );
    }
    assert_json(
        refuse(&parity(PROFILE_SYNC, index.digest(), 3, 3, 0)),
        json!({"reason": "parity_operation_mismatch", "expected": CATALOG, "actual": PROFILE_SYNC}),
    );
    assert_ne!(index.digest(), other.digest());
    assert_json(
        refuse(&parity(CATALOG, other.digest(), 3, 3, 0)),
        json!({"reason": "parity_manifest_mismatch", "expected": index.digest(), "actual": other.digest()}),
    );
}

#[test]
fn ticket_t_3_drain_cutover_flag_off_refuses_and_writes_nothing() {
    let index = fixture_index();
    assert_json(
        cutover::plan(
            None,
            &OperationOwners::node_only(),
            CATALOG,
            &parity(CATALOG, index.digest(), 3, 3, 0),
        )
        .unwrap_err(),
        json!({"reason": "flag_off"}),
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
    switch(&index, &recorded.0, CATALOG);
    assert_json(
        cutover::recover(&recorded.0, None).unwrap_err(),
        json!({"reason": "record_without_flag"}),
    );
}

fn assert_commit_changes_nothing(drained: DrainEvidence, expected: CutoverReceipt) {
    let index = fixture_index();
    let dir = Scratch::new("unchanged");
    switch(&index, &dir.0, CATALOG);
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
    switch(&index, &committed.0, CATALOG);
    let dir = Scratch::new("before-rename");
    let temporary = dir.0.join(".operation-cutover.abc.tmp");
    fs::copy(committed.0.join(CUTOVER_FILE), &temporary).unwrap();
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_eq!(owners, OperationOwners::node_only());
    assert_json(
        boot,
        json!({"rust_operations": [], "abandoned_temporaries": 1, "evidence_saved": true}),
    );
    assert!(!temporary.exists());
    assert!(!dir.0.join(CUTOVER_FILE).exists());
    assert_eq!(
        evidence_lines(&dir.0),
        vec![
            json!({"event": "boot", "rust_operations": [], "abandoned_temporaries": 1, "evidence_saved": true})
        ]
    );
}

#[test]
fn ticket_t_3_drain_cutover_crash_after_rename_recovers_rust() {
    let index = fixture_index();
    let dir = Scratch::new("after-rename");
    switch(&index, &dir.0, CATALOG);
    let temporary = dir.0.join(".operation-cutover.def.tmp");
    fs::copy(dir.0.join(CUTOVER_FILE), &temporary).unwrap();
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_json(
        boot,
        json!({"rust_operations": [CATALOG], "abandoned_temporaries": 1, "evidence_saved": true}),
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
    switch(&index, &dir.0, CATALOG);
    let record = fs::read(dir.0.join(CUTOVER_FILE)).unwrap();
    let first = cutover::recover(&dir.0, Some(&index)).unwrap();
    let second = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert_eq!(first, second);
    assert_json(
        second.1,
        json!({"rust_operations": [CATALOG], "abandoned_temporaries": 0, "evidence_saved": true}),
    );
    assert_json(
        cutover::plan(
            Some(&index),
            &second.0,
            CATALOG,
            &parity(CATALOG, index.digest(), 3, 3, 0),
        )
        .unwrap_err(),
        json!({"reason": "already_rust_owned"}),
    );
    assert_eq!(fs::read(dir.0.join(CUTOVER_FILE)).unwrap(), record);
}

#[test]
fn ticket_t_3_drain_cutover_changed_manifest_on_restart_fails_closed() {
    let bundled = fixture_index();
    let upgraded = index_with_extra_tool();
    let dir = Scratch::new("manifest-changed");
    switch(&bundled, &dir.0, CATALOG);
    assert_json(
        cutover::recover(&dir.0, Some(&upgraded)).unwrap_err(),
        json!({"reason": "restart_manifest_changed", "recorded": bundled.digest(), "bundled": upgraded.digest()}),
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
            CutoverReceipt::CommitUnproved {
                operation: operation(),
            },
            json!({"outcome": "commit_unproved", "operation": CATALOG}),
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
        json!({"event": "boot", "rust_operations": [CATALOG], "abandoned_temporaries": 1, "evidence_saved": false})
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

#[tokio::test]
async fn ticket_t_3_drain_cutover_gateway_drain_waits_for_inflight_forward() {
    let dir = Scratch::new("inflight");
    let node = fake_node_with_hold(&dir.0, true);
    let owners = OperationOwners::node_only();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut gateway =
        Gateway::start(listener, PathBuf::new(), node.compat.clone(), &owners).unwrap();
    let (origin, cookie) = session(&mut gateway).await;
    let request =
        tokio::spawn(async move { exchange(&origin, "/plans", "POST", Some(&cookie)).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), node.entered.notified())
        .await
        .unwrap();
    gateway.begin_drain();
    let gateway_idle = gateway
        .wait_idle(std::time::Duration::from_millis(50))
        .await;
    assert!(!gateway_idle);
    let index = fixture_index();
    assert_json(
        plan_for(&index, &owners, PLANS_CREATE).commit(
            &dir.0,
            DrainEvidence {
                gateway_idle,
                ..DRAINED
            },
        ),
        json!({"outcome": "drain_timed_out", "operation": PLANS_CREATE, "tracked_idle": true, "gateway_idle": false}),
    );
    assert!(!dir.0.join(CUTOVER_FILE).exists());
    node.release.notify_one();
    assert_eq!(request.await.unwrap().0, StatusCode::OK);
    let gateway_idle = gateway.wait_idle(std::time::Duration::from_secs(1)).await;
    assert!(gateway_idle);
    assert!(matches!(
        plan_for(&index, &owners, PLANS_CREATE).commit(
            &dir.0,
            DrainEvidence {
                gateway_idle,
                ..DRAINED
            }
        ),
        CutoverReceipt::Committed { .. }
    ));
    gateway.stop().await.unwrap();
}

#[test]
fn ticket_t_3_drain_cutover_record_and_evidence_fail_closed() {
    use std::os::unix::fs::symlink;
    let index = fixture_index();
    let blocked = Scratch::new("failed-rename");
    fs::create_dir(blocked.0.join(CUTOVER_FILE)).unwrap();
    assert!(matches!(
        plan_for(&index, &OperationOwners::node_only(), CATALOG).commit(&blocked.0, DRAINED),
        CutoverReceipt::CommitFailed { .. }
    ));
    assert!(blocked.0.join(CUTOVER_FILE).is_dir());
    assert_eq!(fs::read_dir(&blocked.0).unwrap().count(), 1);
    let dir = Scratch::new("unsafe-record");
    let path = dir.0.join(CUTOVER_FILE);
    fs::write(&path, vec![b' '; 65537]).unwrap();
    assert!(matches!(
        cutover::recover(&dir.0, Some(&index)),
        Err(CutoverError::Malformed { .. })
    ));
    fs::remove_file(&path).unwrap();
    let target = dir.0.join("target");
    fs::write(&target, "{}").unwrap();
    symlink(&target, &path).unwrap();
    assert!(matches!(
        cutover::recover(&dir.0, Some(&index)),
        Err(CutoverError::Malformed { .. })
    ));
    fs::remove_file(&path).unwrap();
    switch(&index, &dir.0, CATALOG);
    fs::remove_file(dir.0.join(EVIDENCE_FILE)).unwrap();
    symlink(&target, dir.0.join(EVIDENCE_FILE)).unwrap();
    let (owners, boot) = cutover::recover(&dir.0, Some(&index)).unwrap();
    assert!(!boot.evidence_saved);
    assert_eq!(owners.owner_of(CATALOG_PARTICIPANTS[0]), Owner::Rust);
    assert_eq!(fs::read_to_string(target).unwrap(), "{}");
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["operations"][CATALOG]["fixtures"] = json!(0);
    fs::write(path, record.to_string()).unwrap();
    assert_json(
        cutover::recover(&dir.0, Some(&index)).unwrap_err(),
        json!({"reason": "no_parity_fixtures", "operation": CATALOG}),
    );
}

fn assert_json(value: impl serde::Serialize, expected: serde_json::Value) {
    assert_eq!(serde_json::to_value(value).unwrap(), expected);
}
