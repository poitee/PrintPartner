use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use pp_core::{CoreRuntime, CoreStatus, DesktopLaunch, SupervisorConfig, VerifiedBundle};
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
            runtime_version: release["runtime_version"].as_str().unwrap().into(),
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
    assert_eq!(
        health["version"],
        launch(data.clone()).bundle.runtime_version
    );
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
        CoreStatus::Starting
        | CoreStatus::Backoff { .. }
        | CoreStatus::Guarded
        | CoreStatus::Stopping
        | CoreStatus::Stopped
        | CoreStatus::Failed => panic!("not ready"),
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
        CoreStatus::Starting
        | CoreStatus::Backoff { .. }
        | CoreStatus::Guarded
        | CoreStatus::Stopping
        | CoreStatus::Stopped
        | CoreStatus::Failed => panic!("not ready"),
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
async fn cleanup_error_publishes_failed_and_preserves_failure() {
    let data = temporary("compat-cleanup-status");
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let handle = runtime.handle();
    let mut state = handle.subscribe();
    let pid = match *state.borrow() {
        CoreStatus::Ready { pid, .. } => pid,
        CoreStatus::Starting
        | CoreStatus::Backoff { .. }
        | CoreStatus::Guarded
        | CoreStatus::Stopping
        | CoreStatus::Stopped
        | CoreStatus::Failed => panic!("Runtime was not ready"),
    };
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(".desktop-owner.json")).unwrap()).unwrap();
    let directory = PathBuf::from(marker["runtime_dir"].as_str().unwrap());
    let socket = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "sock")
        })
        .unwrap();
    std::fs::rename(&socket, directory.join("retained-socket")).unwrap();
    std::fs::create_dir(&socket).unwrap();
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if matches!(*state.borrow(), CoreStatus::Failed) {
                break;
            }
            state.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(handle.recover_compat().await.is_err());
    let receipt = runtime.shutdown().await;
    assert!(!receipt.complete());
    assert!(receipt.errors.contains(&"compat_cleanup_unproved"));
    assert!(socket.is_dir());
    println!(
        "{}",
        serde_json::json!({"case":"compat_cleanup_terminal_status", "failed":true, "receipt":receipt})
    );
}

#[tokio::test]
async fn stable_child_resets_backoff_without_erasing_rapid_crash_escalation() {
    let window = Duration::from_secs(1);
    let stable_time = window + Duration::from_millis(100);
    let runtime = CoreRuntime::start_with_compat_config(
        launch(temporary("stable-backoff")),
        SupervisorConfig {
            crash_guard_window: window,
        },
    )
    .await
    .unwrap();
    let mut state = runtime.handle().subscribe();
    let mut prior_pid = 0;
    for (index, expected) in [0, 1, 0].into_iter().enumerate() {
        let pid = loop {
            if let CoreStatus::Ready { pid, .. } = *state.borrow()
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
        if index == 2 {
            tokio::time::sleep(stable_time).await;
        }
        assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
        let attempt = loop {
            if let CoreStatus::Backoff { attempt } = *state.borrow() {
                break attempt;
            }
            tokio::time::timeout(Duration::from_secs(20), state.changed())
                .await
                .unwrap()
                .unwrap();
        };
        assert_eq!(attempt, expected);
    }
    let receipt = runtime.shutdown().await;
    assert!(receipt.complete());
    println!(
        "{}",
        serde_json::json!({"case":"stable_backoff_reset", "observed_attempts":[0,1,0], "window_ms":window.as_millis(), "stable_ms":stable_time.as_millis(), "receipt":receipt})
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
        CoreStatus::Starting
        | CoreStatus::Backoff { .. }
        | CoreStatus::Guarded
        | CoreStatus::Stopping
        | CoreStatus::Stopped
        | CoreStatus::Failed => panic!("not ready"),
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
            && lock.try_lock_exclusive().is_ok()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Drop cleanup exceeded 16 seconds"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    println!(
        "{}",
        serde_json::json!({"case":"drop_after_runtime_teardown","child_pid":pid,"descendant_pid":descendant_pid,"child_reaped":true,"descendant_reaped":true,"marker_removed":true,"runtime_removed":true,"lock_reacquired":true})
    );
}

#[tokio::test]
async fn crash_left_marker_allows_later_start() {
    let data = temporary("stale-owner");
    std::fs::create_dir_all(&data).unwrap();
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
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
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
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
    let owner = serde_json::json!({"pid": std::process::id(), "kind": "standalone", "process_identity": "prior-boot:prior-start", "instance": "ab".repeat(16)});
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

// Run as a subprocess so SIGKILL ends the actual Rust owner, not the test runner.
#[tokio::test]
async fn core_process_fixture() {
    let Some(data) = std::env::var_os("PP_CORE_DEATH_FIXTURE") else {
        return;
    };
    let _runtime = CoreRuntime::start(launch(data.into())).await.unwrap();
    println!("PP_CORE_READY");
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    std::future::pending::<()>().await;
}

#[test]
fn core_death_with_live_child_refuses_standalone_node() {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let data = temporary("core-death-live-child");
    let mut core = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "core_process_fixture", "--nocapture"])
        .env("PP_CORE_DEATH_FIXTURE", &data)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut child_pid = None;
    let mut group_peer = None;
    let mut runtime_dir = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let output = BufReader::new(core.stdout.take().unwrap());
        assert!(
            output
                .lines()
                .any(|line| line.unwrap().contains("PP_CORE_READY"))
        );
        let marker_path = data.join(".desktop-owner.json");
        let contents = std::fs::read(&marker_path).unwrap();
        let marker: serde_json::Value = serde_json::from_slice(&contents).unwrap();
        assert_eq!(marker["pid"], core.id());
        let pid = marker["child_pid"].as_u64().unwrap() as i32;
        child_pid = Some(pid);
        runtime_dir = Some(PathBuf::from(marker["runtime_dir"].as_str().unwrap()));
        assert!(
            !marker["child_process_identity"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        // Keep the group non-orphaned after core death. Otherwise POSIX sends
        // SIGHUP/SIGCONT to the stopped group, killing the child before the check.
        group_peer = Some(
            Command::new("sleep")
                .arg("60")
                .process_group(pid)
                .spawn()
                .unwrap(),
        );
        // Freeze the child with its DB open to deterministically hold the shutdown window.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
        // waitpid cannot observe this non-child on macOS; ps works on both hosts.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let state = Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&state.stdout).contains('T') {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "child did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
        core.kill().unwrap();
        core.wait().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "child must remain alive");
        for legacy in [false, true] {
            let contents = if legacy {
                let mut legacy_marker = marker.clone();
                let fields = legacy_marker.as_object_mut().unwrap();
                fields.remove("storage_protocol_version");
                fields.remove("child_pid");
                fields.remove("child_process_identity");
                let bytes = serde_json::to_vec(&legacy_marker).unwrap();
                std::fs::write(&marker_path, &bytes).unwrap();
                bytes
            } else {
                contents.clone()
            };
            let input = launch(data.clone());
            let mut standalone = Command::new(input.bundle.node)
                .arg(
                    input
                        .bundle
                        .web_root
                        .join("apps/server/dist/current/index.js"),
                )
                .current_dir(&input.bundle.web_root)
                .env("PRINT_PARTNER_DATA_DIR", &data)
                .env("HOST", "127.0.0.1")
                .env("PORT", "0")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while standalone.try_wait().unwrap().is_none() {
                if std::time::Instant::now() >= deadline {
                    let _ = standalone.kill();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let standalone = standalone.wait_with_output().unwrap();
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                0,
                "child must survive the entire refusal check"
            );
            assert!(!standalone.status.success());
            assert!(
                String::from_utf8_lossy(&standalone.stderr).contains("already owned"),
                "{}",
                String::from_utf8_lossy(&standalone.stderr)
            );
            assert_eq!(std::fs::read(&marker_path).unwrap(), contents);
            // The Rust startup must obey the same two-process marker gate.
            let caller = tokio::runtime::Runtime::new().unwrap();
            assert!(
                caller
                    .block_on(CoreRuntime::start(launch(data.clone())))
                    .is_err()
            );
            assert_eq!(std::fs::read(&marker_path).unwrap(), contents);
        }
    }));
    let _ = core.kill();
    let _ = core.wait();
    if let Some(pid) = child_pid {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    if let Some(mut peer) = group_peer {
        let _ = peer.kill();
        let _ = peer.wait();
    }
    if let Some(path) = runtime_dir {
        let _ = std::fs::remove_dir_all(path);
    }
    let _ = std::fs::remove_dir_all(data);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[tokio::test]
async fn dead_core_marker_without_child_info_allows_start() {
    let data = temporary("missing-child-info");
    std::fs::create_dir_all(&data).unwrap();
    let mut dead = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = dead.id();
    dead.wait().unwrap();
    let marker = data.join(".desktop-owner.json");
    let contents =
        serde_json::json!({"storage_protocol_version": 1, "pid": pid, "process_identity": "prior", "lease_hash": "cd".repeat(32)})
            .to_string();
    std::fs::write(&marker, &contents).unwrap();
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(data.join(".desktop-lease/previous-marker.json")).unwrap(),
        contents
    );
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
    assert_eq!(current["storage_protocol_version"], 1);
    assert!(current["child_pid"].as_u64().is_some());
    assert!(runtime.shutdown().await.complete());
    assert!(!marker.exists());
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn dead_core_marker_with_partial_or_invalid_child_info_refuses_start() {
    let data = temporary("invalid-child-info");
    std::fs::create_dir_all(&data).unwrap();
    let mut dead = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = dead.id();
    dead.wait().unwrap();
    let marker = data.join(".desktop-owner.json");
    for child in [
        serde_json::json!({"child_pid": pid}),
        serde_json::json!({"child_process_identity": "prior"}),
        serde_json::json!({"child_pid": null, "child_process_identity": null}),
        serde_json::json!({"child_pid": 0, "child_process_identity": "prior"}),
        serde_json::json!({"child_pid": pid, "child_process_identity": ""}),
    ] {
        let mut owner = serde_json::json!({"storage_protocol_version": 1, "pid": pid, "process_identity": "prior", "lease_hash": "cd".repeat(32)});
        owner
            .as_object_mut()
            .unwrap()
            .extend(child.as_object().unwrap().clone());
        let contents = owner.to_string();
        std::fs::write(&marker, &contents).unwrap();
        assert!(CoreRuntime::start(launch(data.clone())).await.is_err());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), contents);
    }
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn childless_core_marker_without_known_protocol_refuses_start() {
    let data = temporary("legacy-childless");
    std::fs::create_dir_all(&data).unwrap();
    let mut dead = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = dead.id();
    dead.wait().unwrap();
    let marker = data.join(".desktop-owner.json");
    for version in [
        serde_json::json!({}),
        serde_json::json!({"storage_protocol_version": 0}),
        serde_json::json!({"storage_protocol_version": 2}),
        serde_json::json!({"storage_protocol_version": "1"}),
        serde_json::json!({"storage_protocol_version": null}),
    ] {
        let mut owner = serde_json::json!({"pid": pid, "process_identity": "prior", "lease_hash": "cd".repeat(32)});
        owner
            .as_object_mut()
            .unwrap()
            .extend(version.as_object().unwrap().clone());
        let contents = owner.to_string();
        std::fs::write(&marker, &contents).unwrap();
        assert!(CoreRuntime::start(launch(data.clone())).await.is_err());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), contents);
    }
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn desktop_marker_with_both_processes_dead_allows_start() {
    let data = temporary("both-processes-dead");
    std::fs::create_dir_all(&data).unwrap();
    let mut dead = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = dead.id();
    dead.wait().unwrap();
    std::fs::write(
        data.join(".desktop-owner.json"),
        serde_json::json!({
            "pid": pid, "process_identity": "prior-core", "child_pid": pid,
            "child_process_identity": "prior-child", "lease_hash": "cd".repeat(32)
        })
        .to_string(),
    )
    .unwrap();
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    assert!(runtime.shutdown().await.complete());
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test]
async fn ticket_t_4_real_gateway_hidden_status_and_config_cancellation() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let printer_url = format!("http://{}", listener.local_addr().unwrap());
    let mode = Arc::new(AtomicUsize::new(0));
    let served_mode = mode.clone();

    let simulator = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let count = stream.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..count]);
            assert!(request.starts_with("GET /printer/objects/query?"));
            assert!(request.contains("x-api-key: recorded-test-key"));
            seen.fetch_add(1, Ordering::SeqCst);
            let fixture: &[u8] = match served_mode.load(Ordering::SeqCst) {
                1 => include_bytes!("../../pp-drivers/tests/fixtures/moonraker-error.json"),
                2 => include_bytes!("../../pp-drivers/tests/fixtures/moonraker-offline.json"),
                _ => include_bytes!("../../pp-drivers/tests/fixtures/moonraker-success.json"),
            };
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                fixture.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(fixture).await.unwrap();
        }
    });
    let data =
        std::env::temp_dir().join(format!("pp-t4-{}", hex::encode(rand::random::<[u8; 8]>())));
    let mut runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let origin = runtime.origin().to_owned();
    let target = runtime.take_launch_target().unwrap().into_url();
    let bootstrap = request(
        &origin,
        target.strip_prefix(&origin).unwrap(),
        "GET",
        None,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(bootstrap.0, StatusCode::SEE_OTHER);
    let cookie = bootstrap.1["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let created = request(&origin,"/api/v1/integrations","POST",Some(cookie),None,None,Some(serde_json::json!({"name":"Isolated simulator","type":"moonraker","config":{"base_url":printer_url,"api_key":"recorded-test-key"}}))).await;
    assert_eq!(
        created.0,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&created.2)
    );
    let item: serde_json::Value = serde_json::from_slice(&created.2).unwrap();
    let id = item["id"].as_str().unwrap();
    assert_eq!(item["config"]["api_key"], "****");
    // No browser/window/request traffic drives the polling loop.
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(calls.load(Ordering::SeqCst) >= 2);
    let count = calls.load(Ordering::SeqCst);
    for alias in ["/api/v1/integrations/"] {
        let response = request(
            &origin,
            &format!("{alias}{id}/status"),
            "GET",
            Some(cookie),
            None,
            None,
            None,
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        assert_eq!(response.1["cache-control"], "no-store");
        let body: serde_json::Value = serde_json::from_slice(&response.2).unwrap();
        assert_eq!(body["state"], "printing");
        assert_eq!(body["filename"], "bracket.gcode");
        assert!(!String::from_utf8_lossy(&response.2).contains("recorded-test-key"));
    }
    let head = request(
        &origin,
        &format!("/api/v1/integrations/{id}/status"),
        "HEAD",
        Some(cookie),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(head.0, StatusCode::OK);
    assert_eq!(head.1["cache-control"], "no-store");
    assert!(head.2.is_empty());
    assert!(
        head.1["content-length"]
            .to_str()
            .unwrap()
            .parse::<usize>()
            .unwrap()
            > 0
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        count,
        "Reads must not make another outbound request"
    );
    // A stalled compatibility snapshot must not stall an already-cached read.
    let pid = match runtime.handle().subscribe().borrow().clone() {
        CoreStatus::Ready { pid, .. } => pid,
        _ => panic!("backend not ready"),
    };
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGSTOP) }, 0);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let cached_while_node_stopped = tokio::time::timeout(
        Duration::from_millis(300),
        request(
            &origin,
            &format!("/api/v1/integrations/{id}/status"),
            "GET",
            Some(cookie),
            None,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGCONT) }, 0);
    assert_eq!(
        cached_while_node_stopped
            .expect("cached read blocked on Node")
            .0,
        StatusCode::OK
    );
    for (fixture_mode, expected) in [(1, "error"), (2, "offline")] {
        mode.store(fixture_mode, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                let response = request(
                    &origin,
                    &format!("/api/v1/integrations/{id}/status"),
                    "GET",
                    Some(cookie),
                    None,
                    None,
                    None,
                )
                .await;
                if serde_json::from_slice::<serde_json::Value>(&response.2).unwrap()["state"]
                    == expected
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
        .await
        .unwrap();
    }
    mode.store(0, Ordering::SeqCst);
    let control = runtime.handle();
    tokio::time::timeout(Duration::from_millis(300), control.suspend_monitoring())
        .await
        .unwrap();
    let asleep = calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert_eq!(calls.load(Ordering::SeqCst), asleep);
    control.resume_monitoring();
    tokio::time::timeout(Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) == asleep {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        request(
            &origin,
            "/__desktop/moonraker-hosts",
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
    assert_eq!(
        request(
            &origin,
            &format!("/api/v1/integrations/{id}/status"),
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
    assert_eq!(
        request(
            &origin,
            &format!("/api/v1/integrations/{id}"),
            "PATCH",
            Some(cookie),
            None,
            None,
            Some(serde_json::json!({"config":{"enabled":false}}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let count = calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert_eq!(calls.load(Ordering::SeqCst), count);
    let response = request(
        &origin,
        &format!("/api/v1/integrations/{id}/status"),
        "GET",
        Some(cookie),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&response.2).unwrap()["state"],
        "offline"
    );
    assert_eq!(
        request(
            &origin,
            &format!("/api/v1/integrations/{id}"),
            "DELETE",
            Some(cookie),
            None,
            None,
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &origin,
            &format!("/api/v1/integrations/{id}/status"),
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
    let receipt = runtime.shutdown().await;
    assert!(receipt.complete(), "{receipt:?}");
    assert_eq!(calls.load(Ordering::SeqCst), count);
    simulator.abort();
    std::fs::remove_dir_all(data).unwrap();
    println!(
        "ticket_t_4 gateway: hidden polling, existing v1 alias, no request-driven polls, secret isolation, suspend/resume, disable/removal/shutdown passed"
    );
}
