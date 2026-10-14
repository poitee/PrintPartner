#![cfg(test)]

use super::*;
use http_body_util::BodyExt;

struct Fixture {
    gateway: Gateway,
    root: PathBuf,
    cookie: String,
}

impl Fixture {
    async fn start() -> Self {
        let root = std::env::temp_dir().join(format!("pp-t11-{}", rand::random::<u64>()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), b"<html>desktop</html>").unwrap();
        std::fs::write(root.join("assets/app.js"), b"export default 1;").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut gateway =
            Gateway::start(listener, root.clone(), CompatHandle::unpublished()).unwrap();
        let launch = gateway.take_launch_target().unwrap().into_url();
        let request = Request::builder()
            .uri(launch.strip_prefix(gateway.origin()).unwrap())
            .header("host", &gateway.state.host)
            .body(Body::empty())
            .unwrap();
        let response = handle(State(gateway.state.clone()), request).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        Self {
            gateway,
            root,
            cookie,
        }
    }

    fn request(&self, method: &str, path: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", &self.gateway.state.host)
            .header("origin", self.gateway.origin())
            .header("cookie", &self.cookie)
            .header("accept", "text/html")
            .body(Body::empty())
            .unwrap()
    }

    async fn response(&self, method: &str, path: &str) -> Response<Body> {
        handle(
            State(self.gateway.state.clone()),
            self.request(method, path),
        )
        .await
    }

    async fn stop(self) {
        self.gateway.stop().await.unwrap();
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn ticket_t_11_spa_head_and_asset_methods() {
    let fixture = Fixture::start().await;
    for path in ["/plans/42/studio", "/assets/app.js"] {
        let get = fixture.response("GET", path).await;
        assert_eq!(get.status(), StatusCode::OK);
        let mime = get.headers()["content-type"].clone();
        let bytes = get.into_body().collect().await.unwrap().to_bytes();
        let head = fixture.response("HEAD", path).await;
        assert_eq!(head.status(), StatusCode::OK, "{path}");
        assert_eq!(head.headers()["content-type"], mime);
        assert_eq!(head.headers()["content-length"], bytes.len().to_string());
        assert!(
            head.into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
    }
    for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
        let response = fixture.response(method, "/assets/app.js").await;
        assert_eq!(
            response.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method}"
        );
        assert_eq!(response.headers()["allow"], "GET, HEAD");
    }
    fixture.stop().await;
}

#[tokio::test]
async fn ticket_t_11_asset_content_types_and_containment() {
    let fixture = Fixture::start().await;
    for (name, mime) in [
        ("app.js", "text/javascript"),
        ("app.css", "text/css"),
        ("font.woff2", "font/woff2"),
        ("image.webp", "image/webp"),
        ("favicon.ico", "image/x-icon"),
        ("module.wasm", "application/wasm"),
        ("data.json", "application/json"),
    ] {
        std::fs::write(fixture.root.join("assets").join(name), b"asset").unwrap();
        let response = fixture.response("GET", &format!("/assets/{name}")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], mime, "{name}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "asset"
        );
    }
    std::fs::write(fixture.root.join("manifest.json"), b"{}").unwrap();
    let manifest = fixture.response("GET", "/manifest.json").await;
    assert_eq!(
        manifest.headers()["content-type"],
        "application/manifest+json"
    );
    drop(manifest);
    for path in ["/assets/missing.js", "/assets/", "/not-a-spa-page"] {
        assert_eq!(
            fixture.response("GET", path).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    let outside = fixture.root.with_extension("txt");
    std::fs::write(&outside, b"outside-secret").unwrap();
    std::os::unix::fs::symlink(&outside, fixture.root.join("assets/outside.txt")).unwrap();
    let escaped = fixture.response("GET", "/assets/outside.txt").await;
    assert_eq!(escaped.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        escaped.into_body().collect().await.unwrap().to_bytes(),
        r#"{"detail":"Asset not found"}"#
    );
    std::fs::remove_file(outside).unwrap();
    assert_eq!(
        fixture
            .response("GET", "/assets/%2e%2e/index.html")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        fixture
            .response("GET", "/api/v1/filaments/custom")
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut unauthenticated = fixture.request("GET", "/assets/app.js");
    unauthenticated.headers_mut().remove("cookie");
    assert_eq!(
        handle(State(fixture.gateway.state.clone()), unauthenticated)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    fixture.stop().await;
}

#[tokio::test]
async fn ticket_t_11_asset_stream_is_bounded_and_retains_admission() {
    let fixture = Fixture::start().await;
    let payload = vec![0x5a; 2 * 1024 * 1024];
    std::fs::write(fixture.root.join("assets/large.bin"), &payload).unwrap();
    let response = fixture.response("GET", "/assets/large.bin").await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(
        first.len() <= 64 * 1024,
        "one frame buffered {} bytes",
        first.len()
    );
    assert_eq!(first, vec![0x5a; first.len()]);
    assert_eq!(fixture.gateway.inflight(), 1);
    assert!(!fixture.gateway.wait_idle(Duration::from_millis(20)).await);
    let mut total = first.len();
    while let Some(frame) = body.frame().await {
        let bytes = frame.unwrap().into_data().unwrap();
        assert!(bytes.len() <= 64 * 1024);
        assert_eq!(bytes, vec![0x5a; bytes.len()]);
        total += bytes.len();
    }
    assert_eq!(total, payload.len());
    drop(body);
    assert_eq!(fixture.gateway.inflight(), 0);
    let mut interrupted = fixture
        .response("GET", "/assets/large.bin")
        .await
        .into_body();
    assert_eq!(fixture.gateway.inflight(), 1);
    fixture.gateway.finish_drain();
    assert!(interrupted.frame().await.unwrap().is_err());
    drop(interrupted);
    assert_eq!(fixture.gateway.inflight(), 0);
    fixture.stop().await;
}

#[tokio::test]
async fn ticket_t_11_slow_asset_client_does_not_block_requests_or_shutdown() {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let fixture = Fixture::start().await;
    let file = std::fs::File::create(fixture.root.join("assets/slow.bin")).unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    drop(file);
    let socket = tokio::net::TcpStream::connect(&fixture.gateway.state.host)
        .await
        .unwrap();
    let mut socket = BufReader::new(socket);
    socket.write_all(format!(
        "GET /assets/slow.bin HTTP/1.1\r\nHost: {}\r\nCookie: {}\r\nConnection: close\r\n\r\n",
        fixture.gateway.state.host, fixture.cookie
    ).as_bytes()).await.unwrap();
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(2), socket.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert!(!line.is_empty(), "connection closed before headers");
        headers.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    assert!(headers.starts_with("HTTP/1.1 200 OK\r\n"), "{headers}");
    assert!(
        headers.contains("content-length: 67108864\r\n"),
        "{headers}"
    );
    assert!(!fixture.gateway.wait_idle(Duration::from_millis(100)).await);
    let probe = tokio::net::TcpStream::connect(&fixture.gateway.state.host)
        .await
        .unwrap();
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(probe))
            .await
            .unwrap();
    let connection = tokio::spawn(connection);
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        sender.send_request(fixture.request("HEAD", "/plans/42/studio")),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], "20");
    assert!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    drop(sender);
    connection.await.unwrap().unwrap();
    let root = fixture.root;
    fixture.gateway.drain_for(Duration::from_millis(20)).await;
    tokio::time::timeout(Duration::from_secs(3), fixture.gateway.stop())
        .await
        .unwrap()
        .unwrap();
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert!(
        received.len() < 64 * 1024 * 1024,
        "shutdown did not cancel the stream"
    );
    assert!(received.iter().all(|byte| *byte == 0));
    std::fs::remove_dir_all(root).unwrap();
}
