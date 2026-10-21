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
            .route("/plans/{id}/drafts/{draft_id}/parts", patch(probe));
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
