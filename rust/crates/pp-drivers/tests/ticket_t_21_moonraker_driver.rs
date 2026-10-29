//! Replays `fixtures/drivers/moonraker/driver/routes.json` through the Rust
//! Moonraker driver and compares every result and the exact request transcript
//! with `node-oracle.json`. `moonraker.driver-oracle.test.ts` in the web server
//! checks that the Node adapter produces the same file.
use pp_drivers::moonraker_driver::Driver;
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

#[derive(Deserialize)]
struct Routes {
    routes: BTreeMap<String, String>,
    browse: Vec<String>,
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(FIXTURES).join(name)).unwrap()
}

struct Simulator {
    origin: String,
    heads: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl Simulator {
    /// `METHOD target` for every request received, in order.
    fn requests(&self) -> Vec<String> {
        let heads = self.heads.lock().unwrap();
        heads
            .iter()
            .map(|head| {
                let line = head.lines().next().unwrap();
                line.strip_suffix(" HTTP/1.1").unwrap().to_owned()
            })
            .collect()
    }
}

impl Drop for Simulator {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Serves `routes` (or `forced` for every request) and records each request head.
async fn simulator(routes: BTreeMap<String, String>, forced: Option<u16>) -> Simulator {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
    let heads = Arc::new(Mutex::new(Vec::new()));
    let (log, served) = (heads.clone(), origin.clone());
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0, "request ended before its head");
                head.extend_from_slice(&chunk[..count]);
            }
            let head = String::from_utf8(head).unwrap();
            let target = head.split(' ').nth(1).unwrap().to_owned();
            log.lock().unwrap().push(head);
            let (status, body) = match (forced, routes.get(&target)) {
                (None, Some(name)) => (
                    200,
                    String::from_utf8(fixture(name))
                        .unwrap()
                        .replace("{ORIGIN}", &served),
                ),
                (forced, _) => (forced.unwrap_or(404), "{}".into()),
            };
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    Simulator {
        origin,
        heads,
        task,
    }
}

fn driver(base_url: &str, api_key: Option<&str>) -> Driver {
    let guard = HttpGuard::new(
        Arc::new(SystemResolver),
        Duration::from_secs(5),
        2 * 1024 * 1024,
    )
    .unwrap();
    Driver::new(guard, base_url, api_key)
}

/// Node prints 60 where Rust prints 60.0; compare integral floats as integers.
fn integral(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => json!(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(items) => items.into_iter().map(integral).collect(),
        Value::Object(map) => map.into_iter().map(|(k, v)| (k, integral(v))).collect(),
        other => other,
    }
}

fn settle<T: serde::Serialize>(result: anyhow::Result<T>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

/// Every read call, shaped like the Node oracle test's `readCalls`.
async fn read_calls(driver: &Driver, paths: &[String]) -> Map<String, Value> {
    let mut browse = Map::new();
    let mut calls = Map::new();
    calls.insert(
        "test_connection".into(),
        json!(driver.test_connection().await),
    );
    calls.insert("status".into(), json!(driver.status().await));
    calls.insert("filament_used".into(), json!(driver.filament_used().await));
    calls.insert("object_list".into(), json!(driver.object_list().await));
    calls.insert("cameras".into(), settle(driver.cameras().await));
    for path in paths {
        browse.insert(path.clone(), settle(driver.browse(path).await));
    }
    calls.insert("browse".into(), Value::Object(browse));
    calls
}

#[tokio::test]
async fn ticket_t_21_read_contracts_match_node_oracle() {
    let routes: Routes = serde_json::from_slice(&fixture("routes.json")).unwrap();
    let oracle: Map<String, Value> = serde_json::from_slice(&fixture("node-oracle.json")).unwrap();
    // serde_json keeps file order when another workspace crate enables `preserve_order`.
    let mut scenarios: Vec<_> = oracle.keys().collect();
    scenarios.sort();
    assert_eq!(scenarios, ["http-404", "http-500", "recorded"]);
    for (scenario, expected) in &oracle {
        let forced = match scenario.as_str() {
            "recorded" => None,
            other => Some(other.trim_start_matches("http-").parse().unwrap()),
        };
        let simulator = simulator(routes.routes.clone(), forced).await;
        let driver = driver(&format!("{}/", simulator.origin), None);
        let mut actual = read_calls(&driver, &routes.browse).await;
        actual.insert("requests".into(), json!(simulator.requests()));
        assert_eq!(
            integral(Value::Object(actual)),
            integral(expected.clone()),
            "{scenario}"
        );
    }
}

#[tokio::test]
async fn ticket_t_21_reads_are_get_only_and_send_the_api_key() {
    let routes: Routes = serde_json::from_slice(&fixture("routes.json")).unwrap();
    let simulator = simulator(routes.routes, None).await;
    let driver = driver(&simulator.origin, Some(" key-123 "));
    assert!(driver.test_connection().await.ok);
    driver.status().await;
    driver.filament_used().await;
    driver.object_list().await;
    driver.cameras().await.unwrap();
    driver.browse("").await.unwrap();
    let requests = simulator.requests();
    assert_eq!(requests.len(), 7);
    for request in &requests {
        assert!(request.starts_with("GET /"), "{request}");
        assert!(!request.contains("/printer/print/"), "{request}");
        assert!(!request.contains("/server/files/upload"), "{request}");
    }
    for head in simulator.heads.lock().unwrap().iter() {
        assert!(head.contains("\r\nx-api-key: key-123\r\n"), "{head}");
        assert!(!head.contains("authorization:"), "{head}");
    }
}

#[derive(Deserialize)]
struct Bases {
    bases: Vec<String>,
}

#[tokio::test]
async fn ticket_t_21_unusable_base_urls_match_node_oracle() {
    let bases: Bases = serde_json::from_slice(&fixture("bases.json")).unwrap();
    let oracle: Map<String, Value> =
        serde_json::from_slice(&fixture("node-oracle-bases.json")).unwrap();
    assert_eq!(oracle.len(), bases.bases.len());
    for base in &bases.bases {
        let actual = read_calls(&driver(base, None), &[String::new()]).await;
        assert_eq!(Value::Object(actual), oracle[base], "{base:?}");
    }
}

/// Deliberate difference: Node appends the path into a query or drops it with
/// a fragment. Rust refuses the base before any request, like the watcher.
#[tokio::test]
async fn ticket_t_21_base_with_query_or_fragment_is_refused() {
    for base in ["http://printer.test/?x=1", "http://printer.test/#frag"] {
        let driver = driver(base, None);
        let tested = driver.test_connection().await;
        assert_eq!(
            (tested.ok, tested.message.as_str()),
            (false, "Invalid base_url")
        );
        let status = serde_json::to_value(driver.status().await).unwrap();
        assert_eq!(
            status,
            json!({ "state": "offline", "message": "Invalid base_url" })
        );
        assert_eq!(
            driver.cameras().await.unwrap_err().to_string(),
            "Invalid base_url"
        );
        assert_eq!(
            driver.browse("").await.unwrap_err().to_string(),
            "Invalid base_url"
        );
    }
}
