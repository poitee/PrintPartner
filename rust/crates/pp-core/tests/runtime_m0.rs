use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use pp_core::{CoreRuntime, CoreStatus, DesktopLaunch, VerifiedBundle};
use std::{path::PathBuf, time::Duration};

fn launch(data: PathBuf) -> DesktopLaunch {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let manifest = std::env::var_os("PP_DESKTOP_RELEASE_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("rust/bundle-manifest.json"));
    let release: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    let web = root.join("web");
    DesktopLaunch {
        data_dir: data,
        assets: web.join("apps/web/dist"),
        bundle: VerifiedBundle {
            node: std::env::var_os("PP_TEST_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/usr/bin/node")),
            entry: web.join("apps/server/dist/current/desktop.js"),
            web_root: web,
            runtime_version: "3.3.0-web".into(),
            commit: release["commit"].as_str().unwrap().into(),
        },
    }
}

async fn request(
    origin: &str,
    path: &str,
    method: &str,
    cookie: Option<&str>,
    host: Option<&str>,
    foreign: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
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
        .header("host", host.unwrap_or(authority))
        .header("origin", foreign.unwrap_or(origin));
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let body = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
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

#[tokio::test]
async fn protected_real_node_lifecycle() {
    let data =
        std::env::temp_dir().join(format!("pp-m0-{}", hex::encode(rand::random::<[u8; 8]>())));
    let mut runtime = CoreRuntime::start(launch(data.clone()))
        .await
        .expect("real Node reaches verified readiness");
    let origin = runtime.origin().to_owned();
    let target = runtime.take_launch_target().unwrap().into_url();
    assert!(runtime.take_launch_target().is_err());
    let bootstrap = target.strip_prefix(&origin).unwrap();
    assert_eq!(
        request(&origin, "/health", "GET", None, None, None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &origin,
            bootstrap,
            "GET",
            None,
            Some("foreign.invalid"),
            None,
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &origin,
            bootstrap,
            "GET",
            None,
            None,
            Some("http://foreign.invalid"),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, headers, _) = request(&origin, bootstrap, "GET", None, None, None, None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers["location"], "/");
    assert_eq!(headers["cache-control"], "no-store");
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    assert_eq!(
        request(&origin, bootstrap, "GET", None, None, None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, _, bytes) =
        request(&origin, "/health", "GET", Some(cookie), None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    let health: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(health["authenticated"], true);
    assert_eq!(health["authentication_required"], true);
    assert_eq!(health["version"], "3.3.0-web");
    let (status, _, bytes) =
        request(&origin, "/auth/me", "GET", Some(cookie), None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["user"]["provider"],
        "desktop"
    );
    assert_eq!(
        request(
            &origin,
            "/plans",
            "POST",
            Some(cookie),
            None,
            Some("http://foreign.invalid"),
            Some(serde_json::json!({"name":"refused"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &origin,
            "/api/v1/mcp",
            "POST",
            Some(cookie),
            None,
            None,
            Some(serde_json::json!({}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &origin,
            "/unknown-api",
            "GET",
            Some(cookie),
            None,
            None,
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, _, bytes) = request(
        &origin,
        "/plans",
        "POST",
        Some(cookie),
        None,
        None,
        Some(serde_json::json!({"name":"Rust protected Build"})),
    )
    .await;
    assert!(status.is_success(), "create Build returned {status}");
    let build: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(build["id"].as_u64().is_some());
    assert!(CoreRuntime::start(launch(data.clone())).await.is_err());
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(".desktop-owner.json")).unwrap()).unwrap();
    assert_eq!(marker["pid"], std::process::id());
    let child_pid = match runtime.handle().subscribe().borrow().clone() {
        CoreStatus::Ready { pid, .. } => pid,
        _ => panic!("not ready"),
    };
    let receipt = tokio::time::timeout(Duration::from_secs(16), runtime.shutdown())
        .await
        .unwrap();
    assert!(receipt.compat_reaped && receipt.storage_released);
    assert!(!data.join(".desktop-owner.json").exists());
    assert_eq!(unsafe { libc::kill(child_pid as i32, 0) }, -1);
    let second = CoreRuntime::start(launch(data.clone())).await.unwrap();
    assert_eq!(second.origin(), origin);
    second.shutdown().await;
    println!(
        "{}",
        serde_json::json!({"proof_class":"headless_unsigned","case":"protected_real_node_lifecycle","origin":origin,"child_reaped":true,"persisted_origin":true,"build_id":build["id"],"data_dir":data})
    );
}

#[tokio::test]
async fn authenticated_logout_requests_complete_shutdown() {
    use fs2::FileExt;

    let data = temporary("logout");
    let mut runtime = CoreRuntime::start(launch(data.clone()))
        .await
        .expect("real Node reaches verified readiness");
    let origin = runtime.origin().to_owned();
    let target = runtime.take_launch_target().unwrap().into_url();
    let bootstrap = target.strip_prefix(&origin).unwrap();
    let (status, headers, _) = request(&origin, bootstrap, "GET", None, None, None, None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    assert_eq!(
        request(&origin, bootstrap, "GET", None, None, None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    for (cookie, host, foreign, expected) in [
        (None, None, None, StatusCode::UNAUTHORIZED),
        (
            Some(cookie),
            Some("foreign.invalid"),
            None,
            StatusCode::BAD_REQUEST,
        ),
        (
            Some(cookie),
            None,
            Some("http://foreign.invalid"),
            StatusCode::FORBIDDEN,
        ),
    ] {
        assert_eq!(
            request(&origin, "/auth/logout", "POST", cookie, host, foreign, None,)
                .await
                .0,
            expected
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), runtime.shutdown_requested())
                .await
                .is_err(),
            "rejected logout requested shutdown"
        );
    }
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(".desktop-owner.json")).unwrap()).unwrap();
    let runtime_dir = PathBuf::from(marker["runtime_dir"].as_str().unwrap());
    let child_pid = match runtime.handle().subscribe().borrow().clone() {
        CoreStatus::Ready { pid, .. } => pid,
        _ => panic!("not ready"),
    };
    let first = runtime.shutdown_requested();
    let second = runtime.shutdown_requested();
    let (status, _, body) = request(
        &origin,
        "/auth/logout",
        "POST",
        Some(cookie),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"ok":true})
    );
    tokio::time::timeout(Duration::from_secs(1), first)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), second)
        .await
        .unwrap();
    let receipt = tokio::time::timeout(Duration::from_secs(16), runtime.shutdown())
        .await
        .unwrap();
    assert!(receipt.complete(), "incomplete receipt: {receipt:?}");
    assert_eq!(unsafe { libc::kill(child_pid as i32, 0) }, -1);
    assert!(!data.join(".desktop-owner.json").exists());
    assert!(!runtime_dir.exists());
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(data.join(".desktop.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    println!(
        "{}",
        serde_json::json!({"proof_class":"headless_unsigned","case":"authenticated_logout_requests_complete_shutdown","receipt":receipt,"child_reaped":true,"marker_removed":true,"runtime_removed":true,"lock_reacquired":true})
    );
}

#[tokio::test]
async fn failed_bind_releases_owner_before_any_child() {
    let data = std::env::temp_dir().join(format!(
        "pp-bind-m0-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir(&data).unwrap();
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(
        data.join("desktop.toml"),
        format!("port = {}\n", occupied.local_addr().unwrap().port()),
    )
    .unwrap();
    assert!(CoreRuntime::start(launch(data.clone())).await.is_err());
    assert!(!data.join(".desktop-owner.json").exists());
    assert!(!data.join("print-partner.db").exists());
    drop(occupied);
    let runtime = CoreRuntime::start(launch(data)).await.unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn wrong_release_is_rejected_before_storage_or_child() {
    let data = std::env::temp_dir().join(format!(
        "pp-version-m0-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let mut wrong = launch(data.clone());
    wrong.bundle.runtime_version = "0.0.0-web".into();
    let error = CoreRuntime::start(wrong).await.err().unwrap();
    assert!(error.to_string().contains("Requested release differs"));
    let mut wrong = launch(data.clone());
    wrong.bundle.commit = "0".repeat(40);
    let error = CoreRuntime::start(wrong).await.err().unwrap();
    assert!(error.to_string().contains("Requested release differs"));
    assert!(!data.join(".desktop-owner.json").exists());
    let runtime = CoreRuntime::start(launch(data)).await.unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn expired_bootstrap_is_denied_by_real_listener() {
    let data = std::env::temp_dir().join(format!(
        "pp-expiry-m0-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let mut runtime = CoreRuntime::start(launch(data)).await.unwrap();
    let origin = runtime.origin().to_owned();
    let target = runtime.take_launch_target().unwrap().into_url();
    tokio::time::sleep(Duration::from_secs(61)).await;
    assert_eq!(
        request(
            &origin,
            target.strip_prefix(&origin).unwrap(),
            "GET",
            None,
            None,
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn crash_guard_stops_after_five_failures_and_recovers_explicitly() {
    let data = std::env::temp_dir().join(format!(
        "pp-guard-m0-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    let runtime = CoreRuntime::start(launch(data)).await.unwrap();
    let handle = runtime.handle();
    assert!(handle.recover_compat().await.is_err());
    let mut state = handle.subscribe();
    let mut prior_pid = 0;
    for attempt in 0..5 {
        let pid = loop {
            let current = state.borrow().clone();
            if let CoreStatus::Ready { pid, .. } = current
                && pid != prior_pid
            {
                break pid;
            }
            tokio::time::timeout(Duration::from_secs(20), state.changed())
                .await
                .unwrap()
                .unwrap();
        };
        prior_pid = pid;
        assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
        loop {
            let current = state.borrow().clone();
            if attempt == 4 && matches!(current, CoreStatus::Guarded) {
                break;
            }
            if attempt < 4 && matches!(current, CoreStatus::Backoff { .. } | CoreStatus::Starting) {
                break;
            }
            tokio::time::timeout(Duration::from_secs(20), state.changed())
                .await
                .unwrap()
                .unwrap();
        }
    }
    assert!(matches!(*state.borrow(), CoreStatus::Guarded));
    handle.recover_compat().await.unwrap();
    loop {
        if matches!(*state.borrow(), CoreStatus::Ready { .. }) {
            break;
        }
        tokio::time::timeout(Duration::from_secs(20), state.changed())
            .await
            .unwrap()
            .unwrap();
    }
    runtime.shutdown().await;
}

fn temporary(case: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "pp-{case}-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ))
}

fn copy_directory(source: &std::path::Path, target: &std::path::Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.path().is_dir() {
            copy_directory(&entry.path(), &destination);
        } else {
            std::fs::copy(entry.path(), destination).unwrap();
        }
    }
}

#[tokio::test]
async fn changed_or_missing_built_artifacts_are_rejected() {
    use std::io::Write;
    let root = temporary("integrity");
    let source = launch(root.join("data"));
    let assets = root.join("assets");
    copy_directory(&source.assets, &assets);
    let script = std::fs::read_dir(assets.join("assets"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "js"))
        .unwrap();
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&script)
            .unwrap(),
        "changed after build"
    )
    .unwrap();
    let mut changed = launch(root.join("changed-frontend"));
    changed.assets = assets.clone();
    assert!(CoreRuntime::start(changed).await.is_err());
    std::fs::remove_file(script).unwrap();
    let mut missing = launch(root.join("missing-frontend"));
    missing.assets = assets;
    assert!(CoreRuntime::start(missing).await.is_err());
    let backend = root.join("backend");
    copy_directory(source.bundle.entry.parent().unwrap(), &backend);
    let entry = backend.join("desktop.js");
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&entry)
            .unwrap(),
        "changed after build"
    )
    .unwrap();
    let mut changed = launch(root.join("changed-backend"));
    changed.bundle.entry = entry.clone();
    assert!(CoreRuntime::start(changed).await.is_err());
    std::fs::remove_file(entry).unwrap();
    let mut missing = launch(root.join("missing-backend"));
    missing.bundle.entry = backend.join("desktop.js");
    assert!(CoreRuntime::start(missing).await.is_err());
    let mut changed = launch(root.join("changed-node"));
    changed.bundle.node = root.join("node");
    std::fs::write(&changed.bundle.node, b"changed executable").unwrap();
    assert!(CoreRuntime::start(changed).await.is_err());
    for case in [
        "changed-frontend",
        "missing-frontend",
        "changed-backend",
        "missing-backend",
        "changed-node",
    ] {
        assert!(!root.join(case).exists());
    }
    println!(
        "{}",
        serde_json::json!({"case":"measured_release_negatives","changed_frontend_denied":true,"missing_frontend_denied":true,"changed_backend_denied":true,"missing_backend_denied":true,"changed_node_denied":true})
    );
}

#[tokio::test]
async fn unexpected_marker_directory_is_preserved_and_reported() {
    let data = temporary("cleanup-failure");
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let marker = data.join(".desktop-owner.json");
    std::fs::remove_file(&marker).unwrap();
    std::fs::create_dir(&marker).unwrap();
    std::fs::write(marker.join("retain"), b"must not delete").unwrap();
    let receipt = runtime.shutdown().await;
    assert!(receipt.compat_reaped);
    assert!(!receipt.storage_released);
    assert!(!receipt.marker_removed);
    assert!(!receipt.complete());
    assert!(receipt.errors.contains(&"owner_marker_cleanup_failed"));
    assert!(marker.join("retain").is_file());
    println!(
        "{}",
        serde_json::json!({"case":"truthful_cleanup_failure","receipt":receipt,"unexpected_marker_preserved":true})
    );
}

#[test]
fn drop_after_caller_runtime_teardown_reaps_writer_and_descendant() {
    use fs2::FileExt;
    use std::os::unix::process::CommandExt;
    let data = temporary("drop-after-runtime");
    let caller = tokio::runtime::Runtime::new().unwrap();
    let runtime = caller
        .block_on(CoreRuntime::start(launch(data.clone())))
        .unwrap();
    let pid = match *runtime.handle().subscribe().borrow() {
        CoreStatus::Ready { pid, .. } => pid,
        _ => panic!("not ready"),
    };
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(".desktop-owner.json")).unwrap()).unwrap();
    let runtime_dir = PathBuf::from(marker["runtime_dir"].as_str().unwrap());
    let mut descendant = std::process::Command::new("sleep")
        .arg("60")
        .process_group(pid as i32)
        .spawn()
        .unwrap();
    let descendant_pid = descendant.id();
    caller.shutdown_timeout(Duration::from_secs(2));
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(data.join(".desktop.lock"))
        .unwrap();
    assert!(lock.try_lock_exclusive().is_err());
    drop(runtime);
    let deadline = std::time::Instant::now() + Duration::from_secs(16);
    loop {
        let descendant_reaped = descendant.try_wait().unwrap().is_some();
        let child_reaped = unsafe { libc::kill(pid as i32, 0) } < 0;
        if descendant_reaped
            && child_reaped
            && !data.join(".desktop-owner.json").exists()
            && !runtime_dir.exists()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Drop cleanup exceeded 16 seconds"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    lock.try_lock_exclusive().unwrap();
    println!(
        "{}",
        serde_json::json!({"case":"drop_after_runtime_teardown","child_pid":pid,"descendant_pid":descendant_pid,"child_reaped":true,"descendant_reaped":true,"marker_removed":true,"runtime_removed":true,"lock_reacquired":true})
    );
}

#[tokio::test]
async fn crash_left_marker_allows_later_start() {
    let data = temporary("stale-owner");
    std::fs::create_dir_all(&data).unwrap();
    let mut child = std::process::Command::new("/bin/true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    std::fs::write(
        data.join(".desktop-owner.json"),
        serde_json::json!({"pid": pid, "kind": "standalone"}).to_string(),
    )
    .unwrap();
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    assert!(matches!(
        *runtime.handle().subscribe().borrow(),
        CoreStatus::Ready { .. }
    ));
    assert!(runtime.shutdown().await.complete());
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn live_marker_owner_still_blocks_start() {
    let data = temporary("live-marker-owner");
    std::fs::create_dir_all(&data).unwrap();
    let marker = data.join(".desktop-owner.json");
    let contents = serde_json::json!({"pid": std::process::id(), "kind": "standalone"}).to_string();
    std::fs::write(&marker, &contents).unwrap();
    assert!(CoreRuntime::start(launch(data.clone())).await.is_err());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), contents);
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn compatibility_cleanup_failure_reports_failed_instead_of_ready() {
    let data = temporary("compat-cleanup-failure");
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let state = runtime.handle().subscribe();
    assert!(matches!(*state.borrow(), CoreStatus::Ready { .. }));
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(".desktop-owner.json")).unwrap()).unwrap();
    let runtime_dir = PathBuf::from(marker["runtime_dir"].as_str().unwrap());
    let socket = std::fs::read_dir(&runtime_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "sock"))
        .unwrap();
    std::fs::remove_file(&socket).unwrap();
    std::fs::create_dir(&socket).unwrap();
    let receipt = runtime.shutdown().await;
    assert!(!receipt.compat_reaped);
    assert!(!receipt.complete());
    assert!(receipt.errors.contains(&"compat_cleanup_unproved"));
    assert!(matches!(*state.borrow(), CoreStatus::Failed));
    std::fs::remove_dir_all(runtime_dir).unwrap();
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn stale_owner_recovery_admits_only_one_concurrent_start() {
    let data = temporary("stale-owner-race");
    std::fs::create_dir_all(&data).unwrap();
    let mut child = std::process::Command::new("/bin/true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    std::fs::write(
        data.join(".desktop-owner.json"),
        serde_json::json!({"pid": pid, "kind": "standalone"}).to_string(),
    )
    .unwrap();
    let (first, second) = tokio::join!(
        CoreRuntime::start(launch(data.clone())),
        CoreRuntime::start(launch(data.clone()))
    );
    let runtime = match (first, second) {
        (Ok(runtime), Err(_)) | (Err(_), Ok(runtime)) => runtime,
        _ => panic!("exactly one concurrent owner must acquire storage"),
    };
    assert!(runtime.shutdown().await.complete());
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn reused_pid_with_different_identity_recovers_marker_and_lease() {
    let data = temporary("reused-pid");
    std::fs::create_dir_all(data.join(".desktop-lease")).unwrap();
    let owner = serde_json::json!({"pid": std::process::id(), "process_identity": "prior-boot:prior-start", "instance": "ab".repeat(16)});
    std::fs::write(data.join(".desktop-owner.json"), owner.to_string()).unwrap();
    std::fs::write(data.join(".desktop-lease/owner.json"), owner.to_string()).unwrap();
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(".desktop-owner.json")).unwrap()).unwrap();
    assert_ne!(current["process_identity"], owner["process_identity"]);
    assert!(CoreRuntime::start(launch(data.clone())).await.is_err());
    assert!(runtime.shutdown().await.complete());
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn desktop_manifest_and_icons_are_served_as_assets() {
    let data = temporary("desktop-icons");
    let mut runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let bootstrap = runtime.take_launch_target().unwrap().into_url();
    let (_, headers, _) = request(
        runtime.origin(),
        bootstrap.strip_prefix(runtime.origin()).unwrap(),
        "GET",
        None,
        None,
        None,
        None,
    )
    .await;
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    for (path, expected_type) in [
        ("/manifest.json", "application/manifest+json"),
        ("/icons/icon-192.png", "image/png"),
        ("/icons/icon-512.png", "image/png"),
        ("/icons/icon.svg", "image/svg+xml"),
    ] {
        let (status, headers, bytes) = request(
            runtime.origin(),
            path,
            "GET",
            Some(cookie),
            None,
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(headers["content-type"], expected_type);
        assert!(!bytes.is_empty());
    }
    let (status, _, _) = request(
        runtime.origin(),
        "/icons/../../Cargo.toml",
        "GET",
        Some(cookie),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(runtime.shutdown().await.complete());
    std::fs::remove_dir_all(data).unwrap();
}
