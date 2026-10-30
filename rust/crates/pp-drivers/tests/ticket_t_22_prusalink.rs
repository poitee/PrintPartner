//! PrusaLink driver (T-22). Checks the Digest code against the Node oracle in
//! `fixtures/drivers/prusalink/driver`, then replays the recorded responses in
//! `fixtures/drivers/prusalink` through a local printer simulator that checks
//! every Digest response, rotates nonces and records every request.
use md5::{Digest, Md5};
use pp_api_types::printer_status::PrinterHostState as State;
use pp_drivers::{
    digest,
    moonraker_driver::{UploadResult, UploadSource},
    prusalink::Driver,
};
use pp_net::outbound::{HttpGuard, SystemResolver};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../fixtures/drivers/prusalink"
);
const USER: &str = "fixture-user";
const PASSWORD: &str = "synthetic-fixture-password";
const UPLOAD: &str = "/api/v1/files/usb/benchy.gcode";
const GCODE: &[u8] = b"; synthetic gcode\n";

fn read(name: &str) -> Value {
    let text = std::fs::read_to_string(Path::new(FIXTURES).join(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    header: String,
    username: String,
    password: String,
    method: String,
    uri: String,
    nc: u32,
    cnonce: String,
}

#[test]
fn ticket_t_22_digest_vectors_match_node_oracle() {
    let vectors: Vec<Vector> = serde_json::from_value(read("driver/digest-vectors.json")).unwrap();
    let oracle = read("driver/node-oracle-digest.json");
    let oracle = oracle.as_array().unwrap();
    assert_eq!(vectors.len(), oracle.len());
    for (vector, expected) in vectors.iter().zip(oracle) {
        assert_eq!(expected["name"], vector.name.as_str());
        let params = digest::parse_www_authenticate(&vector.header);
        let params_json: BTreeMap<String, String> =
            serde_json::from_value(expected["params"].clone()).unwrap();
        assert_eq!(params, params_json, "{}", vector.name);
        let request = digest::Request {
            username: &vector.username,
            password: &vector.password,
            method: &vector.method,
            uri: &vector.uri,
            nc: vector.nc,
            cnonce: &vector.cnonce,
        };
        match digest::authorization(&request, &params) {
            Ok(header) => assert_eq!(
                expected["authorization"],
                header.as_str(),
                "{}",
                vector.name
            ),
            Err(error) => assert_eq!(
                expected["error"],
                error.to_string().as_str(),
                "{}",
                vector.name
            ),
        }
    }
}

#[test]
fn ticket_t_22_rfc2617_example_response() {
    let vectors: Vec<Vector> = serde_json::from_value(read("driver/digest-vectors.json")).unwrap();
    let v = &vectors[0];
    assert_eq!(v.name, "rfc2617-section-3.5");
    let request = digest::Request {
        username: &v.username,
        password: &v.password,
        method: &v.method,
        uri: &v.uri,
        nc: v.nc,
        cnonce: &v.cnonce,
    };
    let header =
        digest::authorization(&request, &digest::parse_www_authenticate(&v.header)).unwrap();
    // RFC 2617 section 3.5.
    assert!(
        header.contains("response=\"6629fae49393a05397450978507c4ef1\""),
        "{header}"
    );
    assert_eq!(digest::cnonce().len(), 16);
    assert_ne!(digest::cnonce(), digest::cnonce());
}

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Seen {
    fn authorized(&self) -> bool {
        self.headers.contains_key("authorization")
    }
}

#[derive(Default)]
struct Printer {
    /// Path to fixture name, or to an inline reply body.
    routes: HashMap<&'static str, Reply>,
    /// The nonce the printer accepts. A probe hands out `fixture-nonce`; when
    /// this differs, the first authorized request is answered stale.
    accepted: &'static str,
    seen: Vec<Seen>,
}

#[derive(Clone)]
enum Reply {
    Fixture(&'static str),
    Json(&'static str),
}

fn md5(value: &str) -> String {
    hex::encode(Md5::digest(value.as_bytes()))
}

/// `nonce` of a valid `qop=auth` MD5 response, checked without the driver's code.
fn valid_nonce(header: &str, method: &str, path: &str) -> Option<String> {
    let fields: HashMap<_, _> = header
        .strip_prefix("Digest ")?
        .split(", ")
        .filter_map(|part| part.split_once('='))
        .map(|(k, v)| (k, v.trim_matches('"')))
        .collect();
    let (realm, nonce, nc, cnonce) = (
        fields["realm"],
        fields["nonce"],
        fields["nc"],
        fields["cnonce"],
    );
    let ha1 = md5(&format!("{}:{realm}:{PASSWORD}", fields["username"]));
    let ha2 = md5(&format!("{method}:{path}"));
    let expected = md5(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"));
    (fields["uri"] == path && fields["response"] == expected && fields["qop"] == "auth")
        .then(|| nonce.to_owned())
}

fn fixture_reply(name: &str) -> (u16, Vec<(String, String)>, String) {
    let fixture = read(name);
    let headers = fixture["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect();
    let body = match &fixture["body"] {
        Value::Null => String::new(),
        body => body.to_string(),
    };
    (fixture["status"].as_u64().unwrap() as u16, headers, body)
}

impl Printer {
    fn answer(&mut self, seen: &Seen) -> (u16, Vec<(String, String)>, String) {
        let Some(header) = seen.headers.get("authorization") else {
            return fixture_reply("digest-401.json");
        };
        match valid_nonce(header, &seen.method, &seen.path) {
            None => return fixture_reply("digest-401.json"),
            Some(nonce) if nonce != self.accepted => {
                return fixture_reply("driver/digest-401-stale.json");
            }
            Some(_) => {}
        }
        match self.routes.get(seen.path.as_str()) {
            Some(Reply::Fixture(name)) => fixture_reply(name),
            Some(Reply::Json(body)) => (200, vec![], (*body).to_owned()),
            None => (404, vec![], String::new()),
        }
    }
}

/// Start a printer and return its origin and request log.
async fn printer(
    routes: &[(&'static str, Reply)],
    accepted: &'static str,
) -> (String, Arc<Mutex<Printer>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(Printer {
        routes: routes.iter().cloned().collect(),
        accepted,
        seen: Vec::new(),
    }));
    let shared = state.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let head_end = loop {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "connection closed mid-head");
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8(bytes[..head_end].to_vec()).unwrap();
                let mut lines = head.split("\r\n");
                let line: Vec<_> = lines.next().unwrap().split(' ').collect();
                let headers: HashMap<String, String> = lines
                    .filter_map(|l| l.split_once(": "))
                    .map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))
                    .collect();
                let length: usize = headers
                    .get("content-length")
                    .map_or(0, |v| v.parse().unwrap());
                while bytes.len() < head_end + length {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "connection closed mid-body");
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let seen = Seen {
                    method: line[0].to_owned(),
                    path: line[1].to_owned(),
                    headers,
                    body: bytes[head_end..].to_vec(),
                };
                let (status, headers, body) = {
                    let mut printer = shared.lock().unwrap();
                    printer.seen.push(seen.clone());
                    printer.answer(&seen)
                };
                let mut reply =
                    format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\n", body.len());
                for (k, v) in headers {
                    reply.push_str(&format!("{k}: {v}\r\n"));
                }
                reply.push_str("\r\n");
                reply.push_str(&body);
                socket.write_all(reply.as_bytes()).await.unwrap();
            });
        }
    });
    (origin, state)
}

fn driver(origin: &str, password: &str) -> Driver {
    let guard = HttpGuard::new(
        Arc::new(SystemResolver),
        Duration::from_secs(5),
        2 * 1024 * 1024,
    )
    .unwrap();
    Driver::new(guard, origin, USER, Some(password), None)
}

/// (method, path, authorized) per request, after checking that every
/// unauthorized request is the bodyless status probe.
fn log(state: &Mutex<Printer>) -> Vec<(String, String, bool)> {
    let seen = state.lock().unwrap().seen.clone();
    for request in seen.iter().filter(|r| !r.authorized()) {
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/api/v1/status")
        );
        assert!(request.body.is_empty());
        assert!(
            request
                .headers
                .get("content-length")
                .is_none_or(|v| v == "0")
        );
    }
    seen.iter()
        .map(|r| (r.method.clone(), r.path.clone(), r.authorized()))
        .collect()
}

fn calls(list: &[(&str, &str, bool)]) -> Vec<(String, String, bool)> {
    list.iter()
        .map(|(m, p, a)| ((*m).into(), (*p).into(), *a))
        .collect()
}

const PROBE: (&str, &str, bool) = ("GET", "/api/v1/status", false);

#[tokio::test]
async fn ticket_t_22_status_printing_probes_then_authorizes() {
    let (origin, state) = printer(
        &[("/api/v1/status", Reply::Fixture("status-printing.json"))],
        "fixture-nonce",
    )
    .await;
    let status = driver(&origin, PASSWORD).status().await;
    assert_eq!(status.state, State::Printing);
    assert_eq!(status.progress, Some(33.0));
    assert_eq!(status.filename.as_deref(), Some("benchy.gcode"));
    assert_eq!(status.eta_seconds, Some(1200.0));
    assert_eq!(status.message.as_deref(), Some("Printing benchy.gcode"));
    assert_eq!(status.ip_address.as_deref(), Some("127.0.0.1"));
    assert_eq!(
        (
            status.nozzle_temperature_c,
            status.nozzle_target_c,
            status.bed_temperature_c,
            status.bed_target_c
        ),
        (Some(214.5), Some(215.0), Some(59.5), Some(60.0))
    );
    // Printing reads /api/v1/job too; this printer has none (404).
    assert_eq!(
        log(&state),
        calls(&[
            PROBE,
            ("GET", "/api/v1/status", true),
            PROBE,
            ("GET", "/api/v1/job", true)
        ])
    );
}

#[tokio::test]
async fn ticket_t_22_job_fills_missing_status_fields() {
    let routes = [
        (
            "/api/v1/status",
            Reply::Json(r#"{"printer":{"state":"PRINTING"}}"#),
        ),
        ("/api/v1/job", Reply::Fixture("job.json")),
    ];
    let (origin, _) = printer(&routes, "fixture-nonce").await;
    let status = driver(&origin, PASSWORD).status().await;
    assert_eq!(status.state, State::Printing);
    assert_eq!(status.filename.as_deref(), Some("bracket.bgcode"));
    assert_eq!(
        (status.progress, status.eta_seconds),
        (Some(43.0), Some(900.0))
    );
    assert_eq!(status.message.as_deref(), Some("Printing bracket.bgcode"));
}

#[tokio::test]
async fn ticket_t_22_idle_error_and_connection_test() {
    let (origin, _) = printer(
        &[("/api/v1/status", Reply::Fixture("status-error.json"))],
        "fixture-nonce",
    )
    .await;
    let status = driver(&origin, PASSWORD).status().await;
    assert_eq!(
        (status.state, status.message.as_deref()),
        (State::Error, Some("ERROR"))
    );
    assert_eq!(status.progress, None);

    let routes = [
        ("/api/v1/status", Reply::Fixture("status-idle.json")),
        ("/api/v1/info", Reply::Fixture("info.json")),
    ];
    let (origin, _) = printer(&routes, "fixture-nonce").await;
    let status = driver(&origin, PASSWORD).status().await;
    assert_eq!(
        (status.state, status.message.as_deref()),
        (State::Idle, Some("Idle"))
    );
    let result = driver(&origin, PASSWORD).test_connection().await;
    assert!(result.ok);
    assert_eq!(result.message, "Connected (Fixture Prusa, state: idle)");
}

#[tokio::test]
async fn ticket_t_22_stale_nonce_get_retries_once_with_the_new_nonce() {
    let (origin, state) = printer(
        &[("/api/v1/status", Reply::Fixture("status-idle.json"))],
        "fixture-nonce-2",
    )
    .await;
    let status = driver(&origin, PASSWORD).status().await;
    assert_eq!(status.state, State::Idle);
    assert_eq!(
        log(&state),
        calls(&[
            PROBE,
            ("GET", "/api/v1/status", true),
            ("GET", "/api/v1/status", true)
        ])
    );
    let seen = state.lock().unwrap().seen.clone();
    assert!(seen[1].headers["authorization"].contains("nonce=\"fixture-nonce\""));
    assert!(seen[2].headers["authorization"].contains("nonce=\"fixture-nonce-2\""));
}

#[tokio::test]
async fn ticket_t_22_auth_failure_get_stops_after_one_retry() {
    let (origin, state) = printer(
        &[("/api/v1/status", Reply::Fixture("status-idle.json"))],
        "fixture-nonce",
    )
    .await;
    let status = driver(&origin, "wrong-password").status().await;
    assert_eq!(status.state, State::Offline);
    assert_eq!(
        status.message.as_deref(),
        Some("PrusaLink returned HTTP 401")
    );
    assert_eq!(
        log(&state),
        calls(&[
            PROBE,
            ("GET", "/api/v1/status", true),
            ("GET", "/api/v1/status", true)
        ])
    );
}

async fn upload(
    password: &str,
    accepted: &'static str,
    start: bool,
) -> (UploadResult, Vec<Seen>, Vec<(String, String, bool)>) {
    let (origin, state) = printer(
        &[(UPLOAD, Reply::Fixture("upload-response.json"))],
        accepted,
    )
    .await;
    let result = driver(&origin, password)
        .upload_file(UploadSource::Bytes(GCODE.to_vec()), "benchy.gcode", start)
        .await;
    let seen = state.lock().unwrap().seen.clone();
    (result, seen, log(&state))
}

#[tokio::test]
async fn ticket_t_22_upload_puts_the_body_once() {
    let (result, seen, log) = upload(PASSWORD, "fixture-nonce", false).await;
    assert_eq!(
        (
            result.ok,
            result.remote_path.as_deref(),
            result.started,
            result.message.as_str()
        ),
        (
            true,
            Some("usb/benchy.gcode"),
            Some(false),
            "Uploaded benchy.gcode"
        )
    );
    assert_eq!(log, calls(&[PROBE, ("PUT", UPLOAD, true)]));
    let put = &seen[1];
    assert_eq!(put.body, GCODE);
    assert_eq!(put.headers["content-type"], "application/octet-stream");
    assert_eq!(put.headers["print-after-upload"], "?0");
    assert_eq!(put.headers["overwrite"], "?1");

    let (result, seen, _) = upload(PASSWORD, "fixture-nonce", true).await;
    assert_eq!(
        (result.started, result.message.as_str()),
        (Some(true), "Uploaded and started benchy.gcode")
    );
    assert_eq!(seen[1].headers["print-after-upload"], "?1");
}

#[tokio::test]
async fn ticket_t_22_stale_nonce_upload_is_not_replayed() {
    let (result, _, log) = upload(PASSWORD, "fixture-nonce-2", true).await;
    assert!(!result.ok && !result.outcome_unknown);
    assert_eq!(
        result.message,
        "Upload failed (HTTP 401): the Digest nonce went stale; send again"
    );
    assert_eq!(log, calls(&[PROBE, ("PUT", UPLOAD, true)]));
}

#[tokio::test]
async fn ticket_t_22_auth_failure_upload_is_not_replayed() {
    let (result, _, log) = upload("wrong-password", "fixture-nonce", false).await;
    assert!(!result.ok && !result.outcome_unknown);
    assert_eq!(
        result.message,
        "Upload failed (HTTP 401): PrusaLink rejected the username or password"
    );
    assert_eq!(log, calls(&[PROBE, ("PUT", UPLOAD, true)]));
}

#[tokio::test]
async fn ticket_t_22_refusals_send_nothing() {
    let (origin, state) = printer(&[], "fixture-nonce").await;
    let guard = || HttpGuard::new(Arc::new(SystemResolver), Duration::from_secs(5), 1024).unwrap();
    let no_password = Driver::new(guard(), &origin, USER, Some("****"), None);
    assert_eq!(
        no_password.status().await.message.as_deref(),
        Some("username and password are required")
    );
    let upload = no_password
        .upload_file(UploadSource::Bytes(GCODE.to_vec()), "a.gcode", false)
        .await;
    assert_eq!(upload.message, "username and password are required");
    let https = Driver::new(guard(), "https://printer.test", USER, Some(PASSWORD), None);
    assert_eq!(
        https.status().await.message.as_deref(),
        Some("HTTPS PrusaLink hosts are not supported until GRE-359")
    );
    let no_base = Driver::new(guard(), " ", USER, Some(PASSWORD), None);
    assert_eq!(
        no_base.test_connection().await.message,
        "base_url is required"
    );
    assert!(state.lock().unwrap().seen.is_empty());
}
