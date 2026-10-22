use super::*;
use axum::{
    Extension,
    body::Body,
    routing::{get, patch},
};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const COOKIE: &str = "pp_session=fixture-session";
/// Header value replaced by the server's own origin.
const SELF: &str = "<origin>";
const SESSION: &[(&str, &str)] = &[("Origin", SELF), ("Cookie", COOKIE)];

/// Echoes the admitted principal so tests observe what handlers get.
async fn probe(Extension(principal): Extension<Principal>) -> Json<Value> {
    Json(match principal {
        Principal::Session(secret) => json!({"session":secret}),
        Principal::ApiKey { tenant, secret } => json!({"tenant":tenant,"key":secret}),
    })
}

/// Extracts the whole body, so Axum's own extractor limit would apply here.
async fn measure(body: Bytes) -> Json<Value> {
    Json(json!({"len":body.len()}))
}

struct Server {
    origin: String,
    client: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn start(flag: Option<&str>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let config = DraftHttpConfig::from_startup(&origin, "default", flag).unwrap();
        let routes = Router::new()
            .route("/plans/{id}/drafts", get(probe))
            .route("/plans/{id}/drafts/{draft_id}/parts", patch(probe))
            .route("/plans/{id}/drafts/{draft_id}/body", patch(measure));
        let service =
            admit_draft_routes(config, routes).into_make_service_with_connect_info::<SocketAddr>();
        let task = tokio::spawn(async move { axum::serve(listener, service).await.unwrap() });
        let client = Client::builder().no_proxy().build().unwrap();
        Self {
            origin,
            client,
            task,
        }
    }
    fn host(&self) -> &str {
        self.origin.strip_prefix("http://").unwrap()
    }
    /// Sends `GET` to the list path or `PATCH` to the parts path under `prefix`.
    async fn send(&self, prefix: &str, edit: bool, headers: &[(&str, &str)]) -> (u16, Value) {
        let (method, path) = match edit {
            true => (Method::PATCH, "/plans/1/drafts/2/parts"),
            false => (Method::GET, "/plans/1/drafts"),
        };
        let url = format!("{}{prefix}{path}", self.origin);
        let mut request = self.client.request(method, url);
        for (name, value) in headers {
            request = request.header(*name, value.replace(SELF, &self.origin));
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        if status != 404 {
            assert_eq!(response.headers()["content-type"], "application/json");
        }
        (status, response.json().await.unwrap_or(Value::Null))
    }
    async fn raw(&self, head: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(self.host()).await.unwrap();
        let host = self.host();
        let request =
            format!("{head}\r\nHost: {host}\r\nCookie: {COOKIE}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let read = stream.read_to_end(&mut response);
        tokio::time::timeout(Duration::from_secs(8), read)
            .await
            .unwrap()
            .unwrap();
        String::from_utf8(response).unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn request(uri: &str, host: Option<&str>, peer: Option<[u8; 4]>) -> axum::extract::Request {
    let mut builder = axum::extract::Request::builder().uri(uri);
    if let Some(host) = host {
        builder = builder.header("host", host);
    }
    let mut request = builder.body(Body::empty()).unwrap();
    if let Some(peer) = peer {
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((peer, 9000))));
    }
    request
}

#[test]
fn transport_admission_requires_loopback_peer_and_matching_authority() {
    let config = DraftHttpConfig::new("https://127.0.0.1:1234", "default").unwrap();
    let (local, host, lo) = (
        "https://127.0.0.1:1234/plans/1/drafts",
        Some("127.0.0.1:1234"),
        Some([127, 0, 0, 1]),
    );
    for (uri, host, peer, status) in [
        ("/plans/1/drafts", host, None, Some(500)),
        ("/plans/1/drafts", host, Some([192, 0, 2, 1]), Some(403)),
        ("/plans/1/drafts", host, lo, None),
        ("/plans/1/drafts", None, lo, Some(403)),
        (local, None, lo, None),
        (local, host, lo, None),
        (local, Some("evil.test"), lo, Some(403)),
        ("https://evil.test/plans/1/drafts", host, lo, Some(403)),
    ] {
        let result = admit(&config, &request(uri, host, peer));
        assert_eq!(
            result.err().map(|error| error.0.as_u16()),
            status,
            "{uri} {host:?}"
        );
    }
    let mut duplicate = request("/plans/1/drafts", host, lo);
    duplicate
        .headers_mut()
        .append("host", "127.0.0.1:1234".parse().unwrap());
    assert_eq!(admit(&config, &duplicate).unwrap_err().0, 403);
}

#[test]
fn startup_config_accepts_only_loopback_origins_and_bounded_tenants() {
    for (origin, tenant, valid) in [
        ("http://example.test", "default", false),
        ("http://127.0.0.1:1234/path", "default", false),
        ("ftp://127.0.0.1", "default", false),
        ("http://[::1]:1234", "default", true),
        ("http://127.0.0.1", " ", false),
        ("http://127.0.0.1", &"t".repeat(512), true),
        ("http://127.0.0.1", &"t".repeat(513), false),
    ] {
        assert_eq!(
            DraftHttpConfig::new(origin, tenant).is_ok(),
            valid,
            "{origin}"
        );
    }
}

#[tokio::test]
async fn runtime_gate_is_exact_and_mounts_both_prefixes() {
    let flags = [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("TRUE"),
        Some(" true "),
        Some("yes"),
    ];
    for flag in flags.into_iter().chain([Some("1"), Some("true")]) {
        let s = Server::start(flag).await;
        let enabled = matches!(flag, Some("1" | "true"));
        for (prefix, edit) in [
            ("", false),
            ("", true),
            ("/api/v2", false),
            ("/api/v2", true),
        ] {
            let (status, _) = s.send(prefix, edit, SESSION).await;
            assert_eq!(status, if enabled { 200 } else { 404 }, "{flag:?}");
        }
        let (status, _) = s.send("", false, &[("Host", "wrong.test")]).await;
        assert_eq!(status, if enabled { 403 } else { 404 });
    }
}

/// `method | headers | status | detail`; headers are `name=value` joined by `,`.
const REFUSALS: &str = "
GET   | Origin=<origin>,Cookie=pp_session=s,forwarded=x         | 403 | Invalid request host
GET   | Origin=<origin>,Cookie=pp_session=s,x-forwarded-host=x  | 403 | Invalid request host
GET   | Origin=<origin>,Cookie=pp_session=s,x-forwarded-for=x   | 403 | Invalid request host
GET   | Origin=<origin>,Cookie=pp_session=s,x-forwarded-proto=x | 403 | Invalid request host
GET   | Origin=<origin>,Cookie=pp_session=s,Host=evil.test      | 403 | Invalid request host
GET   | Origin=https://evil.test,Cookie=pp_session=s            | 403 | Invalid request origin
GET   | Origin=<origin>,Cookie=pp_session=s,sec-fetch-site=cross-site | 403 | Invalid request origin
PATCH | Cookie=pp_session=s                                     | 403 | Invalid request origin
PATCH | Authorization=Bearer k,Origin=http://evil.test          | 403 | Invalid request origin
PATCH | Authorization=Bearer k,Origin=null                      | 403 | Invalid request origin
PATCH | Authorization=Bearer k,Cookie=pp_session=s              | 403 | Invalid request origin
GET   |                                                         | 401 | Authentication required
GET   | Authorization=Basic k                                   | 401 | Authentication required
GET   | Authorization=Bearer                                    | 401 | Authentication required
GET   | Origin=<origin>,Cookie=pp_session=s,Authorization=Bearer k | 401 | Authentication required
GET   | Authorization=Bearer a,Authorization=Bearer b           | 401 | Authentication required
GET   | Authorization=Bearer a,x-print-partner-api-key=b        | 401 | Authentication required
GET   | x-print-partner-api-key=a,x-print-partner-api-key=b     | 401 | Authentication required
GET   | Cookie=pp_session=a; pp_session=b                       | 401 | Authentication required
GET   | Cookie=pp_session=                                      | 401 | Authentication required
";

#[tokio::test]
async fn admission_rejects_ambiguous_credentials_hosts_and_origins() {
    let s = Server::start(Some("true")).await;
    for row in REFUSALS.trim().lines() {
        let [method, headers, status, detail] =
            row.split('|').map(str::trim).collect::<Vec<_>>()[..]
        else {
            panic!("{row}");
        };
        let headers: Vec<_> = headers
            .split(',')
            .filter_map(|pair| pair.split_once('='))
            .collect();
        let reply = s.send("", method == "PATCH", &headers).await;
        assert_eq!(
            reply,
            (status.parse().unwrap(), json!({"detail":detail})),
            "{row}"
        );
    }
    let oversized = format!("Bearer {}", "k".repeat(4097));
    let reply = s.send("", false, &[("Authorization", &oversized)]).await;
    assert_eq!(reply.0, 401);
    let session = json!({"session":"fixture-session"});
    assert_eq!(s.send("/api/v2", false, SESSION).await, (200, session));
    let routed = (200, json!({"tenant":"default","key":"secret"}));
    let keyed = [
        ("Authorization", "Bearer  secret "),
        ("x-tenant-id", "foreign"),
    ];
    assert_eq!(s.send("", true, &keyed).await, routed);
    let custom = [("x-print-partner-api-key", "secret")];
    assert_eq!(s.send("", false, &custom).await, routed);
    let twice = format!("GET /plans/1/drafts HTTP/1.1\r\nHost: {}", s.host());
    let raw = s.raw(&twice).await;
    assert!(
        raw.starts_with("HTTP/1.1 400") || raw.starts_with("HTTP/1.1 403"),
        "{raw}"
    );
    let twice = format!(
        "GET /plans/1/drafts HTTP/1.1\r\nOrigin: {0}\r\nOrigin: {0}",
        s.origin
    );
    let raw = s.raw(&twice).await;
    assert!(
        raw.starts_with("HTTP/1.1 403") && raw.contains("Invalid request origin"),
        "{raw}"
    );
}

impl Server {
    async fn body(&self, method: Method, body: reqwest::Body) -> (u16, Value) {
        let path = match method {
            Method::PATCH => "/plans/1/drafts/2/body",
            _ => "/plans/1/drafts",
        };
        let response = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin)
            .header("Cookie", COOKIE)
            .body(body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }
    /// Opens a PATCH that promises a body and never sends it.
    async fn stall(&self) -> tokio::net::TcpStream {
        let mut stream = tokio::net::TcpStream::connect(self.host()).await.unwrap();
        let head = format!(
            "PATCH /plans/1/drafts/2/parts HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\n\
             Cookie: {COOKIE}\r\nContent-Length: 10\r\n\r\n",
            self.host(),
            self.origin
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream
    }
    async fn busy(&self) -> bool {
        let (status, body) = self.send("", false, SESSION).await;
        match status {
            503 => {
                assert_eq!(
                    body,
                    json!({"detail":"Draft service temporarily unavailable"})
                );
                true
            }
            200 => false,
            other => panic!("unexpected {other}"),
        }
    }
    /// Waits for in-flight stalls to release their permits.
    async fn recovers(&self) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while self.busy().await {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn bodies_are_bounded_by_method_and_patch_limit() {
    let s = Server::start(Some("1")).await;
    let large = vec![b'x'; 3 * 1024 * 1024];
    assert_eq!(
        s.body(Method::PATCH, large.into()).await,
        (200, json!({"len":3 * 1024 * 1024}))
    );
    let too_large = (413, json!({"detail":"Request body too large"}));
    let read = vec![b'x'; 1024 * 1024 + 1];
    assert_eq!(s.body(Method::GET, read.into()).await, too_large);
    let edit = vec![b'x'; 8 * 1024 * 1024 + 1];
    assert_eq!(s.body(Method::PATCH, edit.into()).await, too_large);
    let mut stream = tokio::net::TcpStream::connect(s.host()).await.unwrap();
    let head = format!(
        "PATCH /plans/1/drafts/2/body HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\n\
         Cookie: {COOKIE}\r\nTransfer-Encoding: chunked\r\n\r\n",
        s.host(),
        s.origin
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let chunk = [b"100000\r\n".as_slice(), &[b'x'; 1 << 20], b"\r\n"].concat();
    for _ in 0..9 {
        // The server may answer and stop reading before every chunk is sent.
        if stream.write_all(&chunk).await.is_err() {
            break;
        }
    }
    let mut response = vec![0; 1024];
    let read = stream.read(&mut response).await.unwrap();
    let response = String::from_utf8_lossy(&response[..read]);
    assert!(
        response.starts_with("HTTP/1.1 413") && response.contains("Request body too large"),
        "{response}"
    );
    let target = format!("{}/plans/1/drafts?q={}", s.origin, "x".repeat(16 * 1024));
    let response = s.client.get(target).header("Cookie", COOKIE).send().await;
    let response = response.unwrap();
    assert_eq!(response.status(), 414);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"detail":"Request target too long"})
    );
}

#[tokio::test]
async fn stalled_bodies_exhaust_admission_then_release_it() {
    let s = Server::start(Some("1")).await;
    let mut stalls = Vec::new();
    for _ in 0..64 {
        stalls.push(s.stall().await);
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while !s.busy().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    for mut stream in stalls {
        let mut response = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(8), stream.read_to_end(&mut response));
        let _ = read.await.unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(
            response.starts_with("HTTP/1.1 408") && response.contains("Request body timed out"),
            "{response}"
        );
    }
    s.recovers().await;

    let mut stalls = Vec::new();
    for _ in 0..64 {
        stalls.push(s.stall().await);
    }
    while !s.busy().await {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    drop(stalls);
    s.recovers().await;
}

#[tokio::test]
async fn response_body_holds_admission_until_consumed_or_dropped() {
    let admission = Arc::new(Semaphore::new(1));
    for consume in [true, false] {
        let body = Body::new(AdmittedBody {
            body: Body::from("workspace response"),
            _permit: admission.clone().try_acquire_owned().unwrap(),
        });
        assert_eq!(admission.available_permits(), 0);
        if consume {
            assert_eq!(to_bytes(body, 1024).await.unwrap(), "workspace response");
        } else {
            drop(body);
        }
        assert_eq!(admission.available_permits(), 1);
    }
}

#[test]
fn limits_can_only_be_lowered() {
    let config = DraftHttpConfig::new("http://127.0.0.1:1", "default").unwrap();
    let wait = Duration::from_millis(100);
    let lowered = config.clone().with_limits(1024, Duration::ZERO).unwrap();
    assert_eq!((lowered.body_limit, lowered.wait), (1024, Duration::ZERO));
    assert!(config.clone().with_limits(8 * 1024 * 1024, wait).is_ok());
    assert!(
        config
            .clone()
            .with_limits(8 * 1024 * 1024 + 1, wait)
            .is_err()
    );
    assert!(config.clone().with_limits(1024, wait * 2).is_err());
    assert!(config.with_limits(0, wait).is_err());
}
