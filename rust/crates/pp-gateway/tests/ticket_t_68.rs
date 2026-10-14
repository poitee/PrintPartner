use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, StatusCode, request::Builder},
};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use pp_compat::CompatHandle;
use pp_gateway::Gateway;
use std::{path::PathBuf, time::Duration};

async fn gateway() -> Gateway {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    Gateway::start(
        listener,
        PathBuf::new(),
        CompatHandle::unpublished(),
        &pp_gateway::ownership::cutover::OperationOwners::node_only(),
    )
    .unwrap()
}

async fn exchange(origin: &str, request: Builder) -> (StatusCode, HeaderMap, Vec<u8>) {
    let socket = tokio::net::TcpStream::connect(origin.strip_prefix("http://").unwrap())
        .await
        .unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
        .await
        .unwrap();
    let connection = tokio::spawn(connection);
    let response = sender
        .send_request(
            request
                .header("connection", "close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (head, body) = response.into_parts();
    let body = body.collect().await.unwrap().to_bytes().to_vec();
    drop(sender);
    connection.await.unwrap().unwrap();
    (head.status, head.headers, body)
}

fn request(origin: &str, target: &str) -> Builder {
    Request::builder()
        .uri(target)
        .header("host", origin.strip_prefix("http://").unwrap())
}

fn private_response(headers: &HeaderMap) {
    assert_eq!(
        headers.get("cache-control"),
        Some(&HeaderValue::from_static("no-store"))
    );
    assert_eq!(
        headers.get("referrer-policy"),
        Some(&HeaderValue::from_static("no-referrer"))
    );
}

#[tokio::test]
async fn ticket_t_68_rejections_keep_bootstrap_private_and_unconsumed() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let target = launch.strip_prefix(&origin).unwrap();
    let token = target.split_once("token=").unwrap().1;
    let invalid_target = target.replace("/__desktop/", "/%2e%2e/__desktop/");
    let cases = [
        (
            request(&origin, "/__desktop/bootstrap?token=invalid"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            Request::builder()
                .uri(target)
                .header("host", "foreign.invalid"),
            StatusCode::BAD_REQUEST,
        ),
        (
            request(&origin, target).header("origin", "http://foreign.invalid"),
            StatusCode::FORBIDDEN,
        ),
        (request(&origin, &invalid_target), StatusCode::BAD_REQUEST),
        (
            request(&origin, target).method("POST"),
            StatusCode::FORBIDDEN,
        ),
    ];
    for (request, expected) in cases {
        let (status, headers, body) = exchange(&origin, request).await;
        assert_eq!(status, expected);
        private_response(&headers);
        assert!(!headers.contains_key("set-cookie"));
        assert!(!headers.contains_key("location"));
        assert!(!String::from_utf8(body).unwrap().contains(token));
    }
    let (status, headers, body) = exchange(&origin, request(&origin, target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    private_response(&headers);
    assert_eq!(headers["location"], "/");
    assert!(body.is_empty());
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let (status, _, body) = exchange(
        &origin,
        request(&origin, "/__runtime").header("cookie", cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["compat"]["state"],
        "starting"
    );
    let (status, headers, _) = exchange(&origin, request(&origin, target)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    private_response(&headers);
    gateway.begin_drain();
    let (status, headers, _) = exchange(&origin, request(&origin, target)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    private_response(&headers);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_ambiguous_host_cannot_redeem_bootstrap() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let target = launch.strip_prefix(&origin).unwrap();
    for builder in [
        request(&origin, target).header("host", "foreign.invalid"),
        request(&origin, target).header("host", origin.strip_prefix("http://").unwrap()),
        Request::builder()
            .uri(target)
            .header("host", HeaderValue::from_bytes(b"\xff").unwrap()),
    ] {
        let (status, headers, _) = exchange(&origin, builder).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        private_response(&headers);
        assert!(!headers.contains_key("set-cookie"));
    }
    let (status, _, _) = exchange(&origin, request(&origin, target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_ambiguous_origin_cannot_redeem_bootstrap() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let target = launch.strip_prefix(&origin).unwrap();
    let cases = [
        request(&origin, target)
            .header("origin", &origin)
            .header("origin", "http://foreign.invalid"),
        request(&origin, target)
            .header("origin", "http://foreign.invalid")
            .header("origin", &origin),
        request(&origin, target)
            .header("origin", &origin)
            .header("origin", &origin),
        request(&origin, target).header("origin", HeaderValue::from_bytes(b"\xff").unwrap()),
        request(&origin, target).header("origin", "null"),
        request(&origin, target).header("origin", ""),
    ];
    for request in cases {
        let (status, headers, _) = exchange(&origin, request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!headers.contains_key("set-cookie"));
        private_response(&headers);
    }
    let (status, headers, _) =
        exchange(&origin, request(&origin, target).header("origin", &origin)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    private_response(&headers);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_session_requires_origin_for_logout_and_revokes_access() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let (status, headers, _) = exchange(
        &origin,
        request(&origin, launch.strip_prefix(&origin).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    for builder in [
        request(&origin, "/auth/logout").method("POST"),
        request(&origin, "/__runtime").header("upgrade", "websocket"),
        request(&origin, "/__runtime").header("origin", HeaderValue::from_bytes(b"\xff").unwrap()),
    ] {
        let (status, headers, _) = exchange(&origin, builder.header("cookie", cookie)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        private_response(&headers);
    }
    let (status, _, _) = exchange(
        &origin,
        request(&origin, "/__runtime").header("cookie", cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for (builder, expected) in [
        (
            request(&origin, "/api/v1/assistant/history"),
            StatusCode::FORBIDDEN,
        ),
        (
            request(&origin, "/api/v1/assistant/history").header("origin", &origin),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            request(&origin, "/api/v1/assistant/history").header("sec-fetch-site", "same-origin"),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            request(&origin, "/api/v1/assistant/history")
                .header("sec-fetch-site", "same-origin")
                .header("origin", HeaderValue::from_bytes(b"\xff").unwrap()),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (status, _, _) = exchange(&origin, builder.header("cookie", cookie)).await;
        assert_eq!(status, expected);
    }
    let (status, _, body) = exchange(
        &origin,
        request(&origin, "/auth/logout")
            .method("POST")
            .header("cookie", cookie)
            .header("origin", &origin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"ok":true})
    );
    let (status, headers, _) = exchange(
        &origin,
        request(&origin, "/__runtime").header("cookie", cookie),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    private_response(&headers);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_concurrent_redemption_has_one_private_success() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let target = launch.strip_prefix(&origin).unwrap();
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let request = request(&origin, target);
        let origin = origin.clone();
        requests.spawn(async move { exchange(&origin, request).await });
    }
    let mut accepted = 0;
    let mut denied = 0;
    while let Some(result) = requests.join_next().await {
        let (status, headers, _) = result.unwrap();
        private_response(&headers);
        match status {
            StatusCode::SEE_OTHER => {
                accepted += 1;
                assert_eq!(headers["location"], "/");
                assert!(headers.contains_key("set-cookie"));
            }
            StatusCode::UNAUTHORIZED => {
                denied += 1;
                assert!(!headers.contains_key("set-cookie"));
            }
            other => panic!("Unexpected bootstrap status {other}"),
        }
    }
    assert_eq!((accepted, denied), (1, 15));
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_expired_bootstrap_remains_private() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    tokio::time::sleep(Duration::from_secs(61)).await;
    let (status, headers, body) = exchange(
        &origin,
        request(&origin, launch.strip_prefix(&origin).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    private_response(&headers);
    assert!(!headers.contains_key("set-cookie"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"detail": "Bootstrap expired or consumed"})
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_ipv4_wildcard_listener_is_rejected() {
    rejects_listener("0.0.0.0:0").await;
}

#[tokio::test]
async fn ticket_t_68_ipv6_wildcard_listener_is_rejected() {
    rejects_listener("[::]:0").await;
}

async fn rejects_listener(address: &str) {
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    match Gateway::start(
        listener,
        PathBuf::new(),
        CompatHandle::unpublished(),
        &pp_gateway::ownership::cutover::OperationOwners::node_only(),
    ) {
        Ok(gateway) => {
            gateway.stop().await.unwrap();
            panic!("Gateway admitted a non-loopback listener at {address}");
        }
        Err(error) => assert_eq!(
            error.to_string(),
            "Desktop gateway requires a loopback listener"
        ),
    }
}

#[tokio::test]
async fn ticket_t_68_loopback_listeners_preserve_protected_bootstrap() {
    for address in ["127.0.0.1:0", "[::1]:0"] {
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let mut gateway = Gateway::start(
            listener,
            PathBuf::new(),
            CompatHandle::unpublished(),
            &pp_gateway::ownership::cutover::OperationOwners::node_only(),
        )
        .unwrap();
        let origin = gateway.origin().to_owned();
        let launch = gateway.take_launch_target().unwrap().into_url();
        let (status, _, _) = exchange(&origin, request(&origin, "/__runtime")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, headers, _) = exchange(
            &origin,
            request(&origin, launch.strip_prefix(&origin).unwrap()),
        )
        .await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        private_response(&headers);
        assert_eq!(headers["location"], "/");
        let cookie = headers["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let (status, _, body) = exchange(
            &origin,
            request(&origin, "/__runtime").header("cookie", cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["compat"]["state"],
            "starting"
        );
        gateway.stop().await.unwrap();
    }
}

async fn bootstrap_session(gateway: &mut Gateway) -> (String, String) {
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let target = launch.strip_prefix(&origin).unwrap();
    let token = target.split_once("token=").unwrap().1.to_owned();
    let (status, headers, body) = exchange(&origin, request(&origin, target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    private_response(&headers);
    assert!(body.is_empty());
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (cookie, token)
}

fn session_rejection(response: (StatusCode, HeaderMap, Vec<u8>), cookie: &str, token: &str) {
    let (status, headers, body) = response;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    private_response(&headers);
    assert!(!headers.contains_key("set-cookie"));
    assert!(!headers.contains_key("location"));
    let body = String::from_utf8(body).unwrap();
    assert!(!body.contains(token));
    assert!(!body.contains(cookie.split_once('=').unwrap().1));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"detail": "Desktop session required"})
    );
}

#[tokio::test]
async fn ticket_t_68_cookie_same_line_duplicate_valid_first_is_rejected() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    let name = cookie.split_once('=').unwrap().0;
    session_rejection(
        exchange(
            &origin,
            request(&origin, "/__runtime").header("cookie", format!("{cookie}; {name}=wrong")),
        )
        .await,
        &cookie,
        &token,
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_cookie_split_duplicate_valid_first_is_rejected() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    let name = cookie.split_once('=').unwrap().0;
    session_rejection(
        exchange(
            &origin,
            request(&origin, "/__runtime")
                .header("cookie", &cookie)
                .header("cookie", format!("{name}=wrong")),
        )
        .await,
        &cookie,
        &token,
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_cookie_non_text_second_header_is_rejected() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    session_rejection(
        exchange(
            &origin,
            request(&origin, "/__runtime")
                .header("cookie", &cookie)
                .header("cookie", HeaderValue::from_bytes(b"\xff").unwrap()),
        )
        .await,
        &cookie,
        &token,
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_cookie_non_text_first_header_is_rejected() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    session_rejection(
        exchange(
            &origin,
            request(&origin, "/__runtime")
                .header("cookie", HeaderValue::from_bytes(b"\xff").unwrap())
                .header("cookie", &cookie),
        )
        .await,
        &cookie,
        &token,
    );
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_cookie_duplicate_variants_are_rejected() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    let name = cookie.split_once('=').unwrap().0;
    for other in [format!("{name}=wrong"), cookie.clone(), format!("{name}=")] {
        for (first, second) in [(&cookie, &other), (&other, &cookie)] {
            for builder in [
                request(&origin, "/__runtime").header("cookie", format!("{first}; {second}")),
                request(&origin, "/__runtime")
                    .header("cookie", first)
                    .header("cookie", second),
            ] {
                session_rejection(exchange(&origin, builder).await, &cookie, &token);
            }
        }
    }
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_cookie_unrelated_pairs_and_split_valid_second_are_admitted() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    let unrelated = "bare_flag; theme=dark; pp_desktop_0=old; pp_desktop_0=older";
    for builder in [
        request(&origin, "/__runtime").header("cookie", &cookie),
        request(&origin, "/__runtime").header("cookie", format!("{unrelated}; {cookie}")),
        request(&origin, "/__runtime").header("cookie", format!("{cookie}; {unrelated}")),
        request(&origin, "/__runtime")
            .header("cookie", unrelated)
            .header("cookie", &cookie),
        request(&origin, "/__runtime")
            .header("cookie", &cookie)
            .header("cookie", unrelated),
    ] {
        let (status, headers, body) = exchange(&origin, builder).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!headers.contains_key("set-cookie"));
        let body = String::from_utf8(body).unwrap();
        assert!(!body.contains(&token));
        assert!(!body.contains(cookie.split_once('=').unwrap().1));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["compat"]["state"],
            "starting"
        );
    }
    let name = cookie.split_once('=').unwrap().0;
    for builder in [
        request(&origin, "/__runtime"),
        request(&origin, "/__runtime").header("cookie", unrelated),
        request(&origin, "/__runtime").header("cookie", format!("{name}=wrong")),
    ] {
        session_rejection(exchange(&origin, builder).await, &cookie, &token);
    }
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_68_cookie_ambiguous_logout_cannot_revoke_session() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (cookie, token) = bootstrap_session(&mut gateway).await;
    let name = cookie.split_once('=').unwrap().0;
    for builder in [
        request(&origin, "/auth/logout").header("cookie", format!("{cookie}; {name}=wrong")),
        request(&origin, "/auth/logout")
            .header("cookie", &cookie)
            .header("cookie", &cookie),
        request(&origin, "/auth/logout")
            .header("cookie", &cookie)
            .header("cookie", HeaderValue::from_bytes(b"\xff").unwrap()),
    ] {
        session_rejection(
            exchange(&origin, builder.method("POST").header("origin", &origin)).await,
            &cookie,
            &token,
        );
        let (status, headers, _) = exchange(
            &origin,
            request(&origin, "/__runtime").header("cookie", &cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!headers.contains_key("set-cookie"));
    }
    let (status, headers, body) = exchange(
        &origin,
        request(&origin, "/auth/logout")
            .method("POST")
            .header("origin", &origin)
            .header("cookie", &cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!headers.contains_key("set-cookie"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"ok": true})
    );
    session_rejection(
        exchange(
            &origin,
            request(&origin, "/__runtime").header("cookie", &cookie),
        )
        .await,
        &cookie,
        &token,
    );
    gateway.stop().await.unwrap();
}
