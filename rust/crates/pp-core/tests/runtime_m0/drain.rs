use super::{launch, request, temporary};
use axum::http::StatusCode;
use fs2::FileExt;
use pp_compat::CompatExit;
use pp_core::{CoreRuntime, CoreStatus, MUTATION_DRAIN, ShutdownReceipt};
use pp_gateway::ownership::cutover::{CUTOVER_FILE, CutoverRefusal};
use serde_json::json;
use std::{fs, path::PathBuf, time::Duration};

async fn isolated_case(name: &str, rebuild: bool) -> Option<PathBuf> {
    if std::env::var("PP_DRAIN_CASE").ok().as_deref() == Some(name) {
        return Some(PathBuf::from(std::env::var_os("PP_DRAIN_DATA").unwrap()));
    }
    let data = temporary("t3-runtime-drain");
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
    child
        .args(["--exact", &format!("drain::{name}"), "--nocapture"])
        .env("PP_DRAIN_CASE", name)
        .env("PP_DRAIN_DATA", &data)
        .env("PP_DESKTOP_REBUILD", if rebuild { "1" } else { "0" })
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(240), child.output())
        .await
        .expect("isolated drain case exceeded four minutes")
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    println!("{stdout}");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("1 passed"), "child ran no tests");
    if name.contains("timeout") {
        assert!(!data.join(CUTOVER_FILE).exists());
        let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
        let receipt = runtime.shutdown().await;
        assert!(receipt.complete(), "{receipt:?}");
        println!(
            "{}",
            json!({"case": name, "restart_after_owner_exit": receipt})
        );
    }
    fs::remove_dir_all(data).unwrap();
    None
}

fn pid(runtime: &CoreRuntime) -> u32 {
    match *runtime.handle().subscribe().borrow() {
        CoreStatus::Ready { pid, .. } => pid,
        ref state => panic!("expected ready child: {state:?}"),
    }
}

async fn bootstrap(runtime: &mut CoreRuntime) -> String {
    let url = runtime.take_launch_target().unwrap().into_url();
    let path = url.strip_prefix(runtime.origin()).unwrap();
    let (status, headers, _) = request(runtime.origin(), path, "GET", None, None, None, None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

fn assert_clean(receipt: &ShutdownReceipt, child: u32) {
    assert!(receipt.complete(), "{receipt:?}");
    assert!(receipt.tracked_idle && receipt.gateway_idle);
    assert_eq!(receipt.compat_exit, Some(CompatExit::Graceful));
    assert!(pp_core::process_group_absent(child));
}

#[tokio::test]
async fn ticket_t_3_drain_runtime_cancels_rejects_and_restarts() {
    let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_cancels_rejects_and_restarts",
        false,
    )
    .await
    else {
        return;
    };
    let mut runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let child = pid(&runtime);
    let cookie = bootstrap(&mut runtime).await;
    let origin = runtime.origin().to_owned();
    let handle = runtime.handle();
    let work = handle.track_shutdown_work().unwrap();
    let cancelled = work.cancellation();
    let shutdown = tokio::spawn(runtime.shutdown());
    tokio::time::timeout(Duration::from_secs(2), cancelled.cancelled())
        .await
        .unwrap();
    assert!(handle.track_shutdown_work().is_err());
    let lock = fs::File::open(data.join(".desktop.lock")).unwrap();
    assert!(lock.try_lock_exclusive().is_err());
    assert_eq!(
        request(
            &origin,
            "/api/v1/plans",
            "POST",
            Some(&cookie),
            None,
            None,
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(!shutdown.is_finished());
    drop(work);
    let receipt = tokio::time::timeout(Duration::from_secs(15), shutdown)
        .await
        .unwrap()
        .unwrap();
    assert_clean(&receipt, child);
    lock.try_lock_exclusive().unwrap();
    FileExt::unlock(&lock).unwrap();
    println!(
        "{}",
        json!({"case": "cooperative", "shutdown": receipt, "old_child_absent": true})
    );
    let restarted = CoreRuntime::start(launch(data.clone())).await.unwrap();
    assert_ne!(pid(&restarted), child);
    assert!(CoreRuntime::start(launch(data)).await.is_err());
    let next_child = pid(&restarted);
    assert_clean(&restarted.shutdown().await, next_child);
}

async fn tracked_timeout(data: PathBuf, cutover: bool) {
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let child = pid(&runtime);
    let handle = runtime.handle();
    let work = handle.track_shutdown_work().unwrap();
    let started = tokio::time::Instant::now();
    let receipt = if cutover {
        #[cfg(feature = "desktop_rebuild")]
        {
            let (receipt, cutover) = runtime
                .shutdown_with_cutover(OPERATION, &parity())
                .await
                .unwrap_or_else(|error| panic!("{:?}", error.1));
            assert_eq!(
                serde_json::to_value(&cutover).unwrap(),
                json!({"outcome":"drain_timed_out", "operation":OPERATION, "tracked_idle":false, "gateway_idle":true})
            );
            assert_eq!(
                events(&data).last().unwrap(),
                &json!({"event":"cutover", "outcome":"drain_timed_out", "operation":OPERATION, "tracked_idle":false, "gateway_idle":true})
            );
            receipt
        }
        #[cfg(not(feature = "desktop_rebuild"))]
        panic!("cutover requires desktop_rebuild");
    } else {
        runtime.shutdown().await
    };
    let elapsed = started.elapsed();
    assert!(
        elapsed >= MUTATION_DRAIN && elapsed < Duration::from_secs(12),
        "{elapsed:?}"
    );
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        json!({
            "proof_class":"headless_unsigned", "tracked_idle":false, "gateway_idle":true,
            "compat_exit":"graceful", "compat_reaped":true, "gateway_stopped":true,
            "storage_released":false, "marker_removed":false, "runtime_removed":false,
            "errors":["tracked_drain_timed_out", "storage_ownership_retained"]
        })
    );
    assert!(!receipt.complete());
    assert!(pp_core::process_group_absent(child));
    assert!(handle.track_shutdown_work().is_err());
    assert!(work.cancellation().is_cancelled());
    assert!(!data.join(CUTOVER_FILE).exists());
    let lock = fs::File::open(data.join(".desktop.lock")).unwrap();
    assert!(lock.try_lock_exclusive().is_err());
    let error = CoreRuntime::start(launch(data.clone()))
        .await
        .err()
        .expect("timed-out task must retain ownership");
    assert!(
        error.to_string().contains("Closure was not proved"),
        "{error:#}"
    );
    drop(work);
    assert!(CoreRuntime::start(launch(data)).await.is_err());
    println!(
        "{}",
        json!({"case":"tracked_timeout", "shutdown":receipt, "elapsed_ms":elapsed.as_millis(), "restart_error":error.to_string(), "old_child_absent":true})
    );
}

#[tokio::test]
async fn ticket_t_3_drain_runtime_timeout_retains_storage_until_exit() {
    if let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_timeout_retains_storage_until_exit",
        false,
    )
    .await
    {
        tracked_timeout(data, false).await;
    }
}

#[tokio::test]
async fn ticket_t_3_drain_runtime_gateway_timeout_reports_incomplete() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_gateway_timeout_reports_incomplete",
        false,
    )
    .await
    else {
        return;
    };
    let mut runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let child = pid(&runtime);
    let cookie = bootstrap(&mut runtime).await;
    let origin = runtime.origin();
    let authority = origin.strip_prefix("http://").unwrap();
    let mut socket = tokio::net::TcpStream::connect(authority).await.unwrap();
    socket.write_all(format!(
        "POST /plans HTTP/1.1\r\nHost: {authority}\r\nOrigin: {origin}\r\nCookie: {cookie}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n"
    ).as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !response.ends_with(b"\r\n\r\n") {
            response.push(socket.read_u8().await.unwrap());
        }
    })
    .await
    .unwrap();
    assert_eq!(response, b"HTTP/1.1 100 Continue\r\n\r\n");
    let started = tokio::time::Instant::now();
    let receipt = runtime.shutdown().await;
    let elapsed = started.elapsed();
    assert!(
        elapsed >= MUTATION_DRAIN && elapsed < Duration::from_secs(12),
        "{elapsed:?}"
    );
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        json!({
            "proof_class":"headless_unsigned", "tracked_idle":true, "gateway_idle":false,
            "compat_exit":"graceful", "compat_reaped":true, "gateway_stopped":true,
            "storage_released":true, "marker_removed":true, "runtime_removed":true,
            "errors":["gateway_drain_timed_out"]
        })
    );
    assert!(!receipt.complete());
    assert!(pp_core::process_group_absent(child));
    drop(socket);
    println!(
        "{}",
        json!({"case":"gateway_timeout", "shutdown":receipt, "elapsed_ms":elapsed.as_millis()})
    );
}

#[tokio::test]
async fn ticket_t_3_drain_runtime_flag_off_refusal_keeps_running() {
    let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_flag_off_refusal_keeps_running",
        false,
    )
    .await
    else {
        return;
    };
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let child = pid(&runtime);
    let (runtime, refusal) = *runtime
        .shutdown_with_cutover("http:GET /filaments/catalog current", "{}")
        .await
        .expect_err("flag-off refusal");
    assert_eq!(refusal, CutoverRefusal::FlagOff);
    assert_eq!(pid(&runtime), child);
    assert!(runtime.handle().track_shutdown_work().is_ok());
    assert!(!data.join(CUTOVER_FILE).exists());
    assert_clean(&runtime.shutdown().await, child);
}

#[cfg(feature = "desktop_rebuild")]
const OPERATION: &str = "http:GET /filaments/catalog current";

#[cfg(feature = "desktop_rebuild")]
fn parity() -> String {
    json!({"schema":"pp-operation-parity-v1", "operation":OPERATION,
        "manifest_sha256":pp_gateway::ownership::manifest::admit_bundled_manifest().unwrap().digest(),
        "fixtures":1, "passed":1, "failed":0}).to_string()
}

#[cfg(feature = "desktop_rebuild")]
fn events(data: &std::path::Path) -> Vec<serde_json::Value> {
    fs::read_to_string(data.join(pp_gateway::ownership::cutover::EVIDENCE_FILE))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn ticket_t_3_drain_runtime_cutover_timeout_preserves_node() {
    if let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_cutover_timeout_preserves_node",
        true,
    )
    .await
    {
        tracked_timeout(data, true).await;
    }
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn ticket_t_3_drain_runtime_cutover_recovers_every_alias() {
    let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_cutover_recovers_every_alias",
        true,
    )
    .await
    else {
        return;
    };
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    assert!(runtime.desktop_rebuild().enabled());
    let child = pid(&runtime);
    let (shutdown, cutover) = runtime
        .shutdown_with_cutover(OPERATION, &parity())
        .await
        .unwrap_or_else(|error| panic!("{:?}", error.1));
    assert_clean(&shutdown, child);
    assert!(matches!(
        cutover,
        pp_gateway::ownership::cutover::CutoverReceipt::Committed {
            participants: 4,
            ..
        }
    ));
    let record = fs::read(data.join(CUTOVER_FILE)).unwrap();
    println!(
        "{}",
        json!({"case":"commit", "shutdown":shutdown, "cutover":cutover})
    );
    for _ in 0..2 {
        let mut runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
        assert!(pp_core::process_group_absent(child));
        let new_child = pid(&runtime);
        assert_ne!(child, new_child);
        let cookie = bootstrap(&mut runtime).await;
        for method in ["GET", "HEAD"] {
            for path in ["/filaments/catalog", "/api/v1/filaments/catalog"] {
                let (status, _, body) = request(
                    runtime.origin(),
                    path,
                    method,
                    Some(&cookie),
                    None,
                    None,
                    None,
                )
                .await;
                assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{method} {path}");
                if method == "GET" {
                    assert!(String::from_utf8_lossy(&body).contains("rust_owner_unavailable"));
                }
            }
        }
        assert_eq!(
            request(
                runtime.origin(),
                "/auth/me",
                "GET",
                Some(&cookie),
                None,
                None,
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        let (runtime, refusal) = *runtime
            .shutdown_with_cutover(OPERATION, &parity())
            .await
            .expect_err("already owned");
        assert_eq!(refusal, CutoverRefusal::AlreadyRustOwned);
        assert_clean(&runtime.shutdown().await, new_child);
        assert_eq!(fs::read(data.join(CUTOVER_FILE)).unwrap(), record);
    }
    let boots: Vec<_> = events(&data)
        .into_iter()
        .filter(|event| event["event"] == "boot")
        .collect();
    assert_eq!(
        boots,
        vec![
            json!({"event":"boot", "rust_operations":[OPERATION], "abandoned_temporaries":0, "evidence_saved":true});
            2
        ]
    );
    println!(
        "{}",
        json!({"case":"restart", "boots":boots, "authority_unchanged":true})
    );
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn ticket_t_3_drain_runtime_forced_compat_refuses_cutover() {
    let Some(data) = isolated_case(
        "ticket_t_3_drain_runtime_forced_compat_refuses_cutover",
        true,
    )
    .await
    else {
        return;
    };
    let runtime = CoreRuntime::start(launch(data.clone())).await.unwrap();
    let child = pid(&runtime);
    assert_eq!(unsafe { libc::kill(child as i32, libc::SIGSTOP) }, 0);
    let started = tokio::time::Instant::now();
    let (shutdown, cutover) = runtime
        .shutdown_with_cutover(OPERATION, &parity())
        .await
        .unwrap_or_else(|error| panic!("{:?}", error.1));
    let elapsed = started.elapsed();
    assert!(
        elapsed >= pp_core::SIGTERM_GRACE && elapsed < Duration::from_secs(18),
        "{elapsed:?}"
    );
    assert!(shutdown.complete(), "{shutdown:?}");
    assert_eq!(shutdown.compat_exit, Some(CompatExit::Forced));
    assert!(pp_core::process_group_absent(child));
    assert_eq!(
        serde_json::to_value(&cutover).unwrap(),
        json!({"outcome":"compat_force_killed", "operation":OPERATION})
    );
    assert_eq!(
        events(&data).last().unwrap(),
        &json!({"event":"cutover", "outcome":"compat_force_killed", "operation":OPERATION})
    );
    assert!(!data.join(CUTOVER_FILE).exists());
    let restarted = CoreRuntime::start(launch(data)).await.unwrap();
    let next_child = pid(&restarted);
    assert_ne!(child, next_child);
    assert_clean(&restarted.shutdown().await, next_child);
    println!(
        "{}",
        json!({"case":"forced_compat", "shutdown":shutdown, "cutover":cutover, "elapsed_ms":elapsed.as_millis(), "old_child_absent":true})
    );
}
