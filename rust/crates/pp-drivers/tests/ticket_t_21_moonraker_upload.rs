//! Replays `fixtures/drivers/moonraker/driver/upload-scenarios.json` through
//! `Driver::upload_file` and compares the result and every recorded request,
//! multipart bytes included, with `node-oracle-upload.json` from the Node adapter. The remaining tests cover
//! lost connections, where Rust deliberately reports an unknown outcome.
use pp_drivers::moonraker_driver::{Driver, UploadResult, UploadSource};
use pp_net::outbound::{HttpGuard, SystemResolver};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../fixtures/drivers/moonraker/driver"
);
const UPLOAD: &str = "/server/files/upload";
const START: &str = "/printer/print/start";

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum Reply {
    Respond(u16, String),
    /// Close the socket after the request head, before reading the body.
    #[serde(skip)]
    DropBeforeBody,
    /// Read the whole request, then close without answering.
    #[serde(skip)]
    DropAfterBody,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    filename: String,
    start: bool,
    replies: BTreeMap<String, Reply>,
}

#[derive(Deserialize)]
struct Scenarios {
    file: String,
    scenarios: Vec<Scenario>,
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(FIXTURES).join(name)).unwrap()
}

/// One request the way the Node oracle records it: line, content type and body,
/// with the random multipart boundary replaced by `<BOUNDARY>`.
fn record(head: &str, body: &[u8]) -> Value {
    let line = head.lines().next().unwrap();
    let line = line.strip_suffix(" HTTP/1.1").unwrap();
    let content_type = head
        .lines()
        .find_map(|line| line.strip_prefix("content-type: "));
    let mut body = String::from_utf8(body.to_vec()).unwrap();
    let mut content_type = content_type.map(str::to_owned);
    let boundary = content_type
        .as_deref()
        .and_then(|value| value.split_once("boundary="))
        .map(|(_, boundary)| boundary.to_owned());
    if let Some(boundary) = boundary {
        body = body.replace(&boundary, "<BOUNDARY>");
        content_type = content_type.map(|value| value.replace(&boundary, "<BOUNDARY>"));
    }
    json!({ "line": line, "content_type": content_type, "body": body })
}

struct Simulator {
    origin: String,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Simulator {
    fn lines(&self) -> Vec<String> {
        let requests = self.requests.lock().unwrap();
        requests
            .iter()
            .map(|request| request["line"].as_str().unwrap().to_owned())
            .collect()
    }
}

impl Drop for Simulator {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Answers by request path; unlisted paths get 404.
async fn simulator(replies: BTreeMap<String, Reply>) -> Simulator {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let end = loop {
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0, "request ended before its head");
                bytes.extend_from_slice(&chunk[..count]);
            };
            let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let path = head.split([' ', '?']).nth(1).unwrap();
            let reply = replies
                .get(path)
                .cloned()
                .unwrap_or_else(|| Reply::Respond(404, "{}".into()));
            if matches!(reply, Reply::DropBeforeBody) {
                log.lock().unwrap().push(record(&head, b""));
                continue;
            }
            let length: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .map_or(0, |value| value.parse().unwrap());
            let mut body = bytes[end..].to_vec();
            while body.len() < length {
                let mut chunk = [0; 65536];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0, "request ended before its body");
                body.extend_from_slice(&chunk[..count]);
            }
            assert_eq!(body.len(), length, "body longer than its content-length");
            log.lock().unwrap().push(record(&head, &body));
            let Reply::Respond(status, text) = reply else {
                continue;
            };
            let location = if (300..400).contains(&status) {
                "Location: /elsewhere\r\n"
            } else {
                ""
            };
            let response = format!(
                "HTTP/1.1 {status} X\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    Simulator {
        origin,
        requests,
        task,
    }
}

fn driver(base_url: &str) -> Driver {
    let guard = HttpGuard::new(
        Arc::new(SystemResolver),
        Duration::from_secs(5),
        2 * 1024 * 1024,
    )
    .unwrap();
    Driver::new(guard, base_url, None)
}

fn scenarios() -> Scenarios {
    serde_json::from_slice(&fixture("upload-scenarios.json")).unwrap()
}

#[tokio::test]
async fn ticket_t_21_upload_matches_node_oracle() {
    let scenarios = scenarios();
    let oracle: Map<String, Value> =
        serde_json::from_slice(&fixture("node-oracle-upload.json")).unwrap();
    assert_eq!(oracle.len(), scenarios.scenarios.len());
    for scenario in scenarios.scenarios {
        let simulator = simulator(scenario.replies).await;
        let source = UploadSource::Bytes(scenarios.file.clone().into_bytes());
        let result = driver(&simulator.origin)
            .upload_file(source, &scenario.filename, scenario.start)
            .await;
        assert!(!result.outcome_unknown, "{}", scenario.name);
        let actual = json!({
            "result": result,
            "requests": *simulator.requests.lock().unwrap(),
        });
        assert_eq!(actual, oracle[&scenario.name], "{}", scenario.name);
    }
}

#[tokio::test]
async fn ticket_t_21_upload_only_never_calls_print_start() {
    let scenarios = scenarios();
    let mut checked = 0;
    for scenario in scenarios.scenarios.into_iter().filter(|s| !s.start) {
        let simulator = simulator(scenario.replies).await;
        let source = UploadSource::Bytes(scenarios.file.clone().into_bytes());
        let result = driver(&simulator.origin)
            .upload_file(source, &scenario.filename, false)
            .await;
        assert_eq!(result.started, Some(false), "{}", scenario.name);
        let lines = simulator.lines();
        assert_eq!(lines.len(), 1, "{}: {lines:?}", scenario.name);
        assert!(lines[0].starts_with(&format!("POST {UPLOAD}")));
        assert!(lines.iter().all(|line| !line.contains(START)));
        checked += 1;
    }
    assert_eq!(checked, 2);
}

#[tokio::test]
async fn ticket_t_21_upload_from_path_sends_the_same_bytes() {
    let file = scenarios().file;
    let path = std::env::temp_dir().join(format!("pp-t21-upload-{}.gcode", std::process::id()));
    std::fs::write(&path, &file).unwrap();
    let replies = BTreeMap::from([(UPLOAD.to_owned(), Reply::Respond(201, "{}".into()))]);
    let from_path = simulator(replies.clone()).await;
    let result = driver(&from_path.origin)
        .upload_file(UploadSource::Path(path.clone()), "a.gcode", false)
        .await;
    std::fs::remove_file(&path).unwrap();
    assert!(result.ok, "{}", result.message);
    let from_bytes = simulator(replies).await;
    driver(&from_bytes.origin)
        .upload_file(UploadSource::Bytes(file.into_bytes()), "a.gcode", false)
        .await;
    assert_eq!(
        *from_path.requests.lock().unwrap(),
        *from_bytes.requests.lock().unwrap()
    );

    let missing = simulator(BTreeMap::new()).await;
    let result = driver(&missing.origin)
        .upload_file(UploadSource::Path(path), "a.gcode", true)
        .await;
    assert!(!result.ok && !result.outcome_unknown, "{result:?}");
    assert!(missing.lines().is_empty());
}

#[tokio::test]
async fn ticket_t_21_lost_upload_is_unknown_and_not_resent() {
    for drop in [Reply::DropBeforeBody, Reply::DropAfterBody] {
        let replies = BTreeMap::from([
            (UPLOAD.to_owned(), drop.clone()),
            (START.to_owned(), Reply::Respond(200, "{}".into())),
        ]);
        let simulator = simulator(replies).await;
        let source = UploadSource::Bytes(b"G28\n".to_vec());
        let result = driver(&simulator.origin)
            .upload_file(source, "a.gcode", true)
            .await;
        assert!(!result.ok, "{drop:?}: {result:?}");
        assert!(result.outcome_unknown, "{drop:?}: {result:?}");
        assert!(
            result.message.starts_with("Upload outcome unknown: "),
            "{result:?}"
        );
        // One upload attempt, no resend and no print start.
        assert_eq!(simulator.lines(), [format!("POST {UPLOAD}")], "{drop:?}");
    }
}

#[tokio::test]
async fn ticket_t_21_lost_start_keeps_the_upload_and_is_unknown() {
    let replies = BTreeMap::from([
        (UPLOAD.to_owned(), Reply::Respond(201, "{}".into())),
        (START.to_owned(), Reply::DropAfterBody),
    ]);
    let simulator = simulator(replies).await;
    let result = driver(&simulator.origin)
        .upload_file(UploadSource::Bytes(b"G28\n".to_vec()), "a.gcode", true)
        .await;
    assert_eq!(
        (result.ok, result.started, result.outcome_unknown),
        (true, Some(false), true),
        "{result:?}"
    );
    assert!(
        result
            .message
            .starts_with("Uploaded, but start outcome unknown: ")
    );
    assert_eq!(
        simulator.lines(),
        [
            format!("POST {UPLOAD}"),
            format!("POST {START}?filename=a.gcode")
        ]
    );
}

#[tokio::test]
async fn ticket_t_21_unreachable_printer_is_a_plain_failure() {
    // Bind then drop, so the port refuses connections.
    let port = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let result: UploadResult = driver(&format!("http://127.0.0.1:{port}"))
        .upload_file(UploadSource::Bytes(b"G28\n".to_vec()), "a.gcode", true)
        .await;
    assert!(!result.ok && !result.outcome_unknown, "{result:?}");
    assert_eq!(
        serde_json::to_value(
            driver("")
                .upload_file(UploadSource::Bytes(Vec::new()), "a", true)
                .await
        )
        .unwrap(),
        json!({ "ok": false, "message": "base_url is required" })
    );
}

#[tokio::test]
async fn ticket_t_21_bad_base_is_refused_before_the_source_opens() {
    let missing = UploadSource::Path("/nonexistent/pp-t21/a.gcode".into());
    let result = driver("ftp://localhost:1")
        .upload_file(missing, "a.gcode", true)
        .await;
    assert_eq!(
        (result.ok, result.outcome_unknown, result.message.as_str()),
        (false, false, "Unsupported URL protocol: ftp:")
    );
    let https = driver("https://localhost:1")
        .upload_file(UploadSource::Bytes(Vec::new()), "a.gcode", false)
        .await;
    assert_eq!(
        https.message,
        "HTTPS Moonraker hosts are not supported until GRE-359"
    );
}
