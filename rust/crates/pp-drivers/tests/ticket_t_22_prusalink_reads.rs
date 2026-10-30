//! PrusaLink storage browse, cameras and `object_list` (T-22). Replays
//! `fixtures/drivers/prusalink/driver/routes.json` through a simulator that
//! checks every Digest response, and compares results and the request log with
//! `node-oracle-reads.json` from the Node adapter.
use md5::{Digest, Md5};
use pp_drivers::prusalink::Driver;
use pp_net::outbound::{HttpGuard, SystemResolver};
use serde::Deserialize;
use serde_json::{Value, json};
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
    "/../../../fixtures/drivers/prusalink/driver"
);
const USER: &str = "fixture-user";
const PASSWORD: &str = "synthetic-fixture-password";

fn read(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(FIXTURES).join(name)).unwrap()
}

#[derive(Deserialize)]
struct Routes {
    routes: HashMap<String, String>,
    browse: Vec<String>,
    configs: HashMap<String, BTreeMap<String, String>>,
}

fn md5(value: &str) -> String {
    hex::encode(Md5::digest(value.as_bytes()))
}

/// Whether `header` is a valid `qop=auth` MD5 answer for `fixture-nonce`,
/// checked without the driver's code.
fn valid(header: &str, method: &str, path: &str) -> bool {
    let Some(fields) = header.strip_prefix("Digest ") else {
        return false;
    };
    let fields: HashMap<_, _> = fields
        .split(", ")
        .filter_map(|part| part.split_once('='))
        .map(|(k, v)| (k, v.trim_matches('"')))
        .collect();
    let field = |k: &str| fields.get(k).copied().unwrap_or("");
    let ha1 = md5(&format!(
        "{}:{}:{PASSWORD}",
        field("username"),
        field("realm")
    ));
    let ha2 = md5(&format!("{method}:{path}"));
    let expected = md5(&format!(
        "{ha1}:{}:{}:{}:auth:{ha2}",
        field("nonce"),
        field("nc"),
        field("cnonce")
    ));
    field("nonce") == "fixture-nonce" && field("uri") == path && field("response") == expected
}

/// A printer serving `routes`, or `forced` for every request. Returns its
/// origin and request log, formatted as the Node oracle records it.
async fn printer(
    routes: HashMap<String, String>,
    forced: Option<u16>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let shared = log.clone();
    let routes = Arc::new(routes);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (log, routes) = (shared.clone(), routes.clone());
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "connection closed mid-head");
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8(bytes).unwrap();
                let mut lines = head.split("\r\n");
                let line: Vec<_> = lines.next().unwrap().split(' ').collect();
                let (method, path) = (line[0], line[1]);
                let headers: HashMap<String, String> = lines
                    .filter_map(|l| l.split_once(": "))
                    .map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))
                    .collect();
                let authorization = headers.get("authorization");
                let range = headers
                    .get("range")
                    .map_or(String::new(), |r| format!(" range={r}"));
                let auth = if authorization.is_some() {
                    " +auth"
                } else {
                    ""
                };
                log.lock()
                    .unwrap()
                    .push(format!("{method} {path}{auth}{range}"));
                let (status, extra, body) = match forced {
                    Some(status) => (status, String::new(), b"{}".to_vec()),
                    None if !authorization.is_some_and(|a| valid(a, method, path)) => {
                        let challenge: Value =
                            serde_json::from_slice(&read("../digest-401.json")).unwrap();
                        let header = challenge["headers"]["www-authenticate"]
                            .as_str()
                            .unwrap()
                            .to_owned();
                        (401, format!("www-authenticate: {header}\r\n"), Vec::new())
                    }
                    None => match routes.get(path) {
                        Some(name) => (200, String::new(), read(name)),
                        None => (404, String::new(), b"{}".to_vec()),
                    },
                };
                let mut reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{extra}\r\n",
                    body.len()
                )
                .into_bytes();
                reply.extend_from_slice(&body);
                socket.write_all(&reply).await.unwrap();
            });
        }
    });
    (origin, log)
}

fn settle<T: serde::Serialize>(result: anyhow::Result<T>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

#[tokio::test]
async fn ticket_t_22_reads_match_node_oracle() {
    let routes: Routes = serde_json::from_slice(&read("routes.json")).unwrap();
    let oracle: Value = serde_json::from_slice(&read("node-oracle-reads.json")).unwrap();
    let scenarios = [
        ("recorded", "auto", None),
        ("pinned", "pinned", None),
        ("no-password", "auto", None),
        ("http-500", "auto", Some(500)),
        ("http-404", "auto", Some(404)),
    ];
    for (name, config, forced) in scenarios {
        let (origin, log) = printer(routes.routes.clone(), forced).await;
        let guard = HttpGuard::new(
            Arc::new(SystemResolver),
            Duration::from_secs(5),
            2 * 1024 * 1024,
        )
        .unwrap();
        let password = if name == "no-password" { "" } else { PASSWORD };
        let storage = routes.configs[config].get("storage").map(String::as_str);
        let driver = Driver::new(guard, &format!("{origin}/"), USER, Some(password), storage);
        let mut browse = serde_json::Map::new();
        let cameras = settle(driver.cameras().await);
        let object_list = json!(driver.object_list().await);
        for path in &routes.browse {
            browse.insert(path.clone(), settle(driver.browse(path).await));
        }
        let requests = log.lock().unwrap().clone();
        let actual = json!({
            "cameras": cameras,
            "object_list": object_list,
            "browse": browse,
            "requests": requests,
        });
        assert_eq!(actual, oracle[name], "{name}");
    }
}
