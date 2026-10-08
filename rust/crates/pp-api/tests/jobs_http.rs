use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use pp_api::jobs::{JobsHttpConfig, jobs_router};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    jobs::{
        Credential, JobKind, Outcome, Payload, UserOperation, WorkerAdmission, WorkerOperation,
    },
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
use tower::ServiceExt;

const WAIT: Duration = Duration::from_secs(5);

fn directory() -> PathBuf {
    let mut bytes = [0; 12];
    getrandom::fill(&mut bytes).unwrap();
    let path = std::env::temp_dir().join(format!("pp-jobs-http-{}", hex::encode(bytes)));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

fn register(owner: &WriterOwner, email: &str) -> String {
    let auth::Outcome::Session { token, .. } = owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::Register {
                email: email.to_owned(),
                display_name: "Jobs HTTP".into(),
                password: Secret::new("long-test-password".into()),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("session expected")
    };
    token.expose().to_owned()
}

fn enqueue(owner: &WriterOwner, token: &str, key: &str) -> String {
    let outcome = owner
        .jobs(policy())
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.to_owned())),
            UserOperation::Enqueue {
                key: key.to_owned(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap();
    let Outcome::Job(job, _) = outcome else {
        panic!("job expected")
    };
    job.job_id
}

fn list_request(token: &str) -> Request<Body> {
    let mut request = Request::builder()
        .uri("/api/v1/jobs")
        .header("host", "127.0.0.1:40123")
        .header("cookie", format!("pp_session={token}"))
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:51234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    request
}

#[tokio::test]
async fn retained_list_holds_serializer_admission_through_bounded_body_backpressure() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner, "serializer@example.com");
    for index in 0..1001 {
        enqueue(&owner, &token, &format!("serializer-{index}"));
    }
    let router = jobs_router(
        JobsHttpConfig::new("http://127.0.0.1:40123", "default").unwrap(),
        owner.jobs(policy()).unwrap(),
    );

    let first = router.clone().oneshot(list_request(&token)).await.unwrap();
    let second = router.clone().oneshot(list_request(&token)).await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);

    let busy = router.clone().oneshot(list_request(&token)).await.unwrap();
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    let busy_body = busy.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        busy_body,
        r#"{"detail":"Jobs service temporarily unavailable"}"#
    );
    println!(
        "serializer busy body: {}",
        std::str::from_utf8(&busy_body).unwrap()
    );

    drop(first);
    let mut body = second.into_body();
    let mut chunks = 0;
    let mut encoded = Vec::new();
    while let Some(frame) = body.frame().await {
        let data = frame.unwrap().into_data().unwrap();
        assert!(data.len() <= 16 * 1024);
        chunks += 1;
        encoded.extend_from_slice(&data);
    }
    assert!(chunks > 1);
    let document: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(document["jobs"].as_array().unwrap().len(), 1001);
    println!(
        "serializer resource proof: jobs=1001 chunks={chunks} max_chunk_bytes={} busy_status=503",
        16 * 1024
    );

    let released = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = router.clone().oneshot(list_request(&token)).await.unwrap();
            if response.status() == StatusCode::OK {
                drop(response);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(released.is_ok());

    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn loopback_websocket_logout_closes_before_any_later_protected_frame() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner, "websocket-revoke@example.com");
    let job_id = enqueue(&owner, &token, "websocket-revoke");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let origin = format!("http://{address}");
    let router = jobs_router(
        JobsHttpConfig::new(&origin, "default").unwrap(),
        owner.jobs(policy()).unwrap(),
    );
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });

    let mut request = format!("ws://{address}/ws/jobs/{job_id}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("cookie", format!("pp_session={token}").parse().unwrap());
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    assert!(socket.next().await.unwrap().unwrap().is_text());

    let auth::Outcome::Changed(true) = owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::Logout {
                token: Secret::new(token),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap()
    else {
        panic!("logout expected")
    };

    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let tokio_tungstenite::tungstenite::Message::Close(Some(close)) = message else {
        panic!("policy close expected")
    };
    assert_eq!(
        close.code,
        tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy
    );
    assert_eq!(close.reason, "Authentication required");
    println!(
        "websocket revocation proof: code={} reason={}",
        u16::from(close.code),
        close.reason
    );

    let _ = stop.send(());
    server.await.unwrap();
    owner.shutdown().unwrap();
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn eight_aliases_queries_wire_stream_and_tenant_isolation() {
    let path = directory();
    let (owner, _) = WriterOwner::open(&path, Limits::default()).unwrap();
    let token = register(&owner, "owner@example.com");
    let other = register(&owner, "other@example.com");
    let job_id = enqueue(&owner, &token, "http-job");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let origin = format!("http://{address}");
    let router = jobs_router(
        JobsHttpConfig::new(&origin, "default").unwrap(),
        owner.jobs(policy()).unwrap(),
    );
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });
    let client = reqwest::Client::new();
    let cookie = format!("pp_session={token}");

    let list = client
        .get(format!("{origin}/api/v1/jobs?status=&status=done"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), 200);
    assert_eq!(
        list.json::<Value>().await.unwrap()["jobs"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    let list = client
        .get(format!("{origin}/api/v1/jobs?since=invalid"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    let list: Value = list.json().await.unwrap();
    assert_eq!(list["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(list["jobs"][0]["job_id"], job_id);
    assert!(list["jobs"][0].get("id").is_none());
    assert!(list["jobs"][0].get("updated_at").is_some());
    let list_head = client
        .head(format!("{origin}/api/v1/jobs?since=invalid"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(list_head.status(), 200);
    assert_eq!(list_head.bytes().await.unwrap().len(), 0);

    for route in [
        format!("{origin}/jobs/{job_id}"),
        format!("{origin}/api/v1/jobs/{job_id}"),
    ] {
        let response = client
            .get(&route)
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["job_id"], job_id);
        assert!(body.get("id").is_none());
        assert!(body["created_at"].as_str().unwrap().ends_with('Z'));
        assert!(body.get("updated_at").is_none());
        let head = client
            .head(&route)
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), 200);
        assert_eq!(head.bytes().await.unwrap().len(), 0);
    }
    let wrong_tenant = client
        .get(format!("{origin}/jobs/{job_id}"))
        .header("cookie", format!("pp_session={other}"))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_tenant.status(), 404);
    assert_eq!(
        wrong_tenant.json::<Value>().await.unwrap(),
        serde_json::json!({"detail":"Job not found"})
    );

    let no_upgrade = client
        .get(format!("{origin}/ws/jobs/{job_id}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(no_upgrade.status(), 404);
    assert_eq!(no_upgrade.bytes().await.unwrap().len(), 0);
    let ws_head = client
        .head(format!("{origin}/ws/jobs/{job_id}"))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(ws_head.status(), 500);
    assert_eq!(ws_head.bytes().await.unwrap().len(), 0);

    let mut request = format!("ws://{address}/ws/jobs/{job_id}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    let initial: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(initial["status"], "pending");
    let worker = owner
        .job_worker_with_policy(
            policy(),
            WorkerAdmission {
                kinds: vec![(JobKind::CheckSourceUpdates, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    worker
        .update(&mut lease, WorkerOperation::Progress(10))
        .unwrap();
    worker
        .update(&mut lease, WorkerOperation::Finish(None))
        .unwrap();
    let mut statuses = Vec::new();
    for _ in 0..3 {
        let message = socket.next().await.unwrap().unwrap();
        statuses.push(
            serde_json::from_str::<Value>(message.to_text().unwrap()).unwrap()["status"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert_eq!(statuses, ["running", "running", "done"]);
    socket.close(None).await.unwrap();

    let _ = stop.send(());
    owner.shutdown().unwrap();
    server.await.unwrap();
    std::fs::remove_dir_all(path).unwrap();
}
