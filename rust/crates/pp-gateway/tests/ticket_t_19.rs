use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, StatusCode, request::Builder},
};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use pp_compat::CompatHandle;
use pp_gateway::Gateway;
use std::path::PathBuf;

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

/// A top-level browser navigation, as the default browser sends it.
fn navigate(origin: &str, target: &str) -> Builder {
    request(origin, target)
        .header("accept", "text/html,application/xhtml+xml")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-site", "none")
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

fn browser_target(gateway: &Gateway) -> (String, String) {
    let origin = gateway.origin().to_owned();
    let url = gateway.bootstrap_minter().mint().unwrap().into_url();
    let target = url.strip_prefix(&origin).unwrap().to_owned();
    let token = target.split_once("token=").unwrap().1.to_owned();
    (target, token)
}

#[tokio::test]
async fn ticket_t_19_minted_bootstrap_signs_in_and_redirects_to_a_clean_url() {
    let mut gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let launch = gateway.take_launch_target().unwrap().into_url();
    let url = gateway.bootstrap_minter().mint().unwrap().into_url();
    assert_ne!(url, launch);
    assert!(url.starts_with(&format!("{origin}/__desktop/bootstrap?token=")));
    let (target, token) = browser_target(&gateway);
    assert_eq!(token.len(), 64);
    assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));

    let (status, headers, body) = exchange(&origin, navigate(&origin, &target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    private_response(&headers);
    assert_eq!(headers["location"], "/");
    assert!(body.is_empty());
    let set_cookie = headers["set-cookie"].to_str().unwrap();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"));
    assert!(!set_cookie.contains(&token));
    let cookie = set_cookie.split(';').next().unwrap();
    let (status, _, _) = exchange(
        &origin,
        request(&origin, "/__runtime").header("cookie", cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Minting a browser link left the webview launch token redeemable.
    let launch_target = launch.strip_prefix(&origin).unwrap();
    let (status, _, _) = exchange(&origin, request(&origin, launch_target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_19_replay_shows_a_private_page_without_the_token() {
    let gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (target, token) = browser_target(&gateway);
    let (status, _, _) = exchange(&origin, navigate(&origin, &target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);

    let (status, headers, body) = exchange(&origin, navigate(&origin, &target)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    private_response(&headers);
    assert!(!headers.contains_key("set-cookie"));
    assert!(!headers.contains_key("location"));
    assert_eq!(headers["content-type"], "text/html; charset=utf-8");
    assert_eq!(headers["content-security-policy"], "default-src 'none'");
    let page = String::from_utf8(body).unwrap();
    assert!(page.contains("Open in browser from the Print Partner tray menu"));
    assert!(!page.contains(&token));

    // Non-browser clients keep the JSON error.
    let (status, headers, body) = exchange(&origin, request(&origin, &target)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    private_response(&headers);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"detail": "Bootstrap expired or consumed"})
    );
    gateway.stop().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ticket_t_19_concurrent_redemption_admits_exactly_one() {
    let gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (target, _) = browser_target(&gateway);
    let attempts: Vec<_> = (0..16)
        .map(|_| {
            let origin = origin.clone();
            let target = target.clone();
            tokio::spawn(async move { exchange(&origin, navigate(&origin, &target)).await })
        })
        .collect();
    let mut accepted = 0;
    for attempt in attempts {
        let (status, headers, _) = attempt.await.unwrap();
        private_response(&headers);
        match status {
            StatusCode::SEE_OTHER => accepted += 1,
            StatusCode::UNAUTHORIZED => assert!(!headers.contains_key("set-cookie")),
            other => panic!("Unexpected bootstrap status {other}"),
        }
    }
    assert_eq!(accepted, 1);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_19_token_only_redeems_on_the_origin_and_port_that_minted_it() {
    let first = gateway().await;
    let second = gateway().await;
    let (target, _) = browser_target(&first);
    let other = second.origin().to_owned();
    let (status, _, _) = exchange(&other, navigate(&other, &target)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let origin = first.origin().to_owned();
    let wrong_host = Request::builder()
        .uri(&target)
        .header("host", other.strip_prefix("http://").unwrap());
    let (status, _, _) = exchange(&origin, wrong_host).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = exchange(&origin, navigate(&origin, &target)).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    first.stop().await.unwrap();
    second.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_19_logout_revokes_browser_sessions() {
    let gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let (target, _) = browser_target(&gateway);
    let (_, headers, _) = exchange(&origin, navigate(&origin, &target)).await;
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (status, _, _) = exchange(
        &origin,
        request(&origin, "/auth/logout")
            .method("POST")
            .header("origin", &origin)
            .header("cookie", &cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = exchange(
        &origin,
        request(&origin, "/__runtime").header("cookie", &cookie),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    gateway.stop().await.unwrap();
}

#[tokio::test]
async fn ticket_t_19_draining_refuses_new_browser_links() {
    let gateway = gateway().await;
    let origin = gateway.origin().to_owned();
    let minter = gateway.bootstrap_minter();
    let (target, _) = browser_target(&gateway);
    gateway.begin_drain();
    assert_eq!(
        minter.mint().err().unwrap().to_string(),
        "Runtime is stopping"
    );
    let (status, headers, _) = exchange(&origin, navigate(&origin, &target)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    private_response(&headers);
    gateway.stop().await.unwrap();
}
