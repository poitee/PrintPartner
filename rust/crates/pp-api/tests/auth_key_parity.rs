//! Replays Node's settings API-key contract (`fixtures/parity/auth-key/node.json`)
//! through `auth_router`. Regenerate the golden with
//! `node fixtures/parity/auth-key/generate.mjs`.
//!
//! Runs on the pooled auth client by default and on the rebuild client with
//! `desktop_rebuild`.

use pp_api::auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router};
#[cfg(not(feature = "desktop_rebuild"))]
use pp_storage::auth::AuthClient as Client;
#[cfg(feature = "desktop_rebuild")]
use pp_storage::auth::rebuild::RebuildAuthClient as Client;
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthPolicy, FirstUserTenant, Outcome, RegistrationPolicy, Request, Secret,
        SessionTenantPolicy,
    },
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

const GOLDEN: &str = include_str!("../../../../fixtures/parity/auth-key/node.json");

struct Server {
    origin: String,
    http: reqwest::Client,
    owner: WriterOwner,
    auth: Client,
    task: tokio::task::JoinHandle<()>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}
impl Server {
    async fn open(directory: &Path) -> Self {
        let owner = WriterOwner::open(directory, Limits::default()).unwrap().0;
        let policy = AuthPolicy {
            registration: RegistrationPolicy::Open,
            first_user: FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::AccountTenant,
        };
        #[cfg(feature = "desktop_rebuild")]
        let auth = owner
            .rebuild_auth_with_policy(policy, Default::default())
            .unwrap();
        #[cfg(not(feature = "desktop_rebuild"))]
        let auth = owner.auth_with_policy(policy).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, true, None, false).unwrap(),
            auth.clone(),
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        );
        let (shutdown, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .unwrap();
        });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        Self {
            origin,
            http,
            owner,
            auth,
            task,
            shutdown,
        }
    }
    async fn send(&self, method: Method, path: &str, cookie: Option<&str>) -> reqwest::Response {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request.send().await.unwrap()
    }
    async fn json(&self, method: Method, path: &str, cookie: &str) -> Value {
        let response = self.send(method, path, Some(cookie)).await;
        let status = response.status().as_u16();
        json!({"status":status,"body":response.json::<Value>().await.unwrap()})
    }
    /// Returns the session cookie and the tenant the session resolves to.
    async fn register(&self, email: &str) -> (String, String) {
        let response = self
            .http
            .post(format!("{}/auth/register", self.origin))
            .header("Origin", &self.origin)
            .json(&json!({"email":email,"password":"password-1234"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();
        let Outcome::User(Some(user)) = self
            .call(Request::ResolveSession {
                token: Secret::new(token),
            })
            .await
        else {
            panic!("registered session resolves")
        };
        (cookie, user.tenant_id)
    }
    async fn call(&self, request: Request) -> Outcome {
        let auth = self.auth.clone();
        tokio::task::spawn_blocking(move || {
            auth.submit(
                request,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(1),
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
        })
        .await
        .unwrap()
    }
    async fn accepted(&self, tenant: &str, key: &str) -> Option<String> {
        let Outcome::KeyResolved { principal, .. } = self
            .call(Request::ResolveKey {
                tenant_id: tenant.to_owned(),
                key: Secret::new(key.to_owned()),
            })
            .await
        else {
            panic!("key resolution outcome")
        };
        principal.map(|principal| principal.key_id)
    }
    async fn stop(self) {
        self.shutdown.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.shutdown().unwrap();
    }
}

fn stored_keys(directory: &Path, tenant: &str) -> String {
    rusqlite::Connection::open(directory.join("print-partner.db"))
        .unwrap()
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id=?1 AND key='api_keys_v1'",
            [tenant],
            |row| row.get(0),
        )
        .unwrap()
}

/// Accepts only a real UTC instant in the `toISOString` form both servers
/// write, such as `2026-10-18T13:35:59.446Z`.
fn generated_time(value: &str) -> bool {
    let shaped = value.len() == 24
        && value.bytes().enumerate().all(|(index, byte)| match index {
            4 | 7 => byte == b'-',
            10 => byte == b'T',
            13 | 16 => byte == b':',
            19 => byte == b'.',
            23 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        });
    if !shaped {
        return false;
    }
    let number = |range: std::ops::Range<usize>| value[range].parse::<u32>().unwrap();
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => 0,
    };
    (1..=days).contains(&day) && number(11..13) < 24 && number(14..16) < 60 && number(17..19) < 60
}

/// A raw string shaped like a normalization token would compare equal to the
/// token it imitates, so raw output may not contain one.
fn reserved(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            (text.starts_with("<id:") || text.starts_with("<key:")) && text.ends_with('>')
        }
        Value::Array(items) => items.iter().any(reserved),
        Value::Object(fields) => fields.values().any(reserved),
        _ => false,
    }
}

/// Mirrors `Tokens` in `fixtures/parity/auth-key/generate.mjs`.
#[derive(Default)]
struct Tokens {
    ids: Vec<String>,
    keys: Vec<String>,
    times: HashMap<String, Vec<String>>,
}
impl Tokens {
    fn raw(&self, value: &str) -> String {
        for (prefix, issued) in [("<id:", &self.ids), ("<key:", &self.keys)] {
            let index = value
                .strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix('>'))
                .and_then(|number| number.parse::<usize>().ok());
            if let Some(index) = index {
                return issued[index - 1].clone();
            }
        }
        value.to_owned()
    }
    fn token(&self, value: &str) -> Option<String> {
        let find = |issued: &Vec<String>| issued.iter().position(|raw| raw == value);
        find(&self.ids)
            .map(|index| format!("<id:{}>", index + 1))
            .or_else(|| find(&self.keys).map(|index| format!("<key:{}>", index + 1)))
    }
    fn issue(&mut self, body: &Value) {
        self.ids.push(body["id"].as_str().unwrap().to_owned());
        self.keys.push(body["key"].as_str().unwrap().to_owned());
    }
    /// Runs on raw output: an issued key may appear only as the `key` field of
    /// the response that created it.
    fn leaked(&self, issued_now: bool, result: &Value) -> bool {
        let mut visible = result.clone();
        if issued_now {
            visible["body"]["key"] = Value::Null;
        }
        let text = visible.to_string();
        self.keys.iter().any(|key| text.contains(key.as_str()))
    }
    fn normalize(&mut self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.token(text).unwrap_or_else(|| text.clone())),
            Value::Array(items) => items.iter().map(|item| self.normalize(item)).collect(),
            Value::Object(fields) => {
                let mut result: serde_json::Map<String, Value> = fields
                    .iter()
                    .map(|(name, item)| (name.clone(), self.normalize(item)))
                    .collect();
                let id = value["id"].as_str().and_then(|id| self.token(id));
                for field in ["createdAt", "lastUsedAt"] {
                    let (Some(id), Some(time)) = (&id, value[field].as_str()) else {
                        continue;
                    };
                    if !generated_time(time) {
                        continue;
                    }
                    let slot = format!("{}.{field}", &id[1..id.len() - 1]);
                    let seen = self.times.entry(slot.clone()).or_default();
                    if !seen.iter().any(|known| known == time) {
                        seen.push(time.to_owned());
                    }
                    let version = seen.iter().position(|known| known == time).unwrap() + 1;
                    result.insert(field.to_owned(), json!(format!("<{slot}#{version}>")));
                }
                Value::Object(result)
            }
            other => other.clone(),
        }
    }
}

fn issues(step: &Value, result: &Value) -> bool {
    matches!(step["op"].as_str(), Some("create" | "rotate")) && result["status"] == 201
}

struct Replay {
    steps: Vec<Value>,
    raw: Vec<Value>,
    issued: Vec<String>,
    directory: PathBuf,
    tenant: String,
}

async fn replay() -> Replay {
    let steps = serde_json::from_str::<Value>(GOLDEN).unwrap()["steps"]
        .as_array()
        .unwrap()
        .clone();
    let mut bytes = [0; 12];
    getrandom::fill(&mut bytes).unwrap();
    let directory = std::env::temp_dir().join(format!("pp-auth-key-parity-{}", hex::encode(bytes)));
    let mut server = Server::open(&directory).await;
    let (cookie, tenant) = server.register("owner@example.com").await;
    let mut tokens = Tokens::default();
    let mut raw_results = Vec::new();
    for step in &steps {
        let raw = |field: &str| tokens.raw(step[field].as_str().unwrap());
        let result = match step["op"].as_str().unwrap() {
            "list" => {
                server
                    .json(Method::GET, "/settings/api-keys", &cookie)
                    .await
            }
            "create" => {
                server
                    .json(Method::POST, "/settings/api-keys", &cookie)
                    .await
            }
            "revoke" => {
                let path = format!("/settings/api-keys/{}", raw("id"));
                server.json(Method::DELETE, &path, &cookie).await
            }
            "rotate" => {
                let path = format!("/settings/api-keys/{}/regenerate", raw("id"));
                server.json(Method::POST, &path, &cookie).await
            }
            "use" => json!({"accepted": server.accepted(&tenant, &raw("key")).await}),
            "reopen" => {
                server.stop().await;
                let mut stored: Value =
                    serde_json::from_str(&stored_keys(&directory, &tenant)).unwrap();
                for (id, expires) in step["expire"].as_object().unwrap() {
                    let id = tokens.raw(id);
                    let key = stored
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|key| key["id"] == id.as_str())
                        .unwrap();
                    key["expiresAt"] = expires.clone();
                }
                rusqlite::Connection::open(directory.join("print-partner.db"))
                    .unwrap()
                    .execute(
                        "UPDATE app_settings SET value=?2 WHERE tenant_id=?1 AND key='api_keys_v1'",
                        [&tenant, &stored.to_string()],
                    )
                    .unwrap();
                server = Server::open(&directory).await;
                json!({})
            }
            op => panic!("unknown step {op}"),
        };
        if issues(step, &result) {
            tokens.issue(&result["body"]);
        }
        raw_results.push(result);
    }
    server.stop().await;
    Replay {
        steps,
        raw: raw_results,
        issued: tokens.keys,
        directory,
        tenant,
    }
}

/// The one recorded gap: Node's `sendProblem` adds `title` and `status` to a
/// 404, and the shared Rust `Failure` body carries only `detail`. Remove this
/// once the auth wire format matches; the strict comparison below then fails.
fn rust_contract(node: &Value) -> Value {
    let mut expected = node.clone();
    if node["status"] == 404 {
        assert_eq!(
            node["body"],
            json!({"detail":"API key not found","title":"Not Found","status":404})
        );
        expected["body"] = json!({"detail":"API key not found"});
    }
    expected
}

/// Normalizes raw Rust results in order, as the generator does for Node, and
/// lists every step that leaks a key or differs from the Node contract.
fn mismatches(steps: &[Value], raw: &[Value]) -> Vec<String> {
    assert_eq!(steps.len(), raw.len());
    let mut tokens = Tokens::default();
    let mut differences = Vec::new();
    for (index, (step, result)) in steps.iter().zip(raw).enumerate() {
        let issued_now = issues(step, result);
        if issued_now {
            tokens.issue(&result["body"]);
        }
        let rust = tokens.normalize(result);
        if tokens.leaked(issued_now, result) || reserved(result) {
            differences.push(format!("step {index} leaks a key or carries a token"));
        } else if rust_contract(&step["node"]) != rust {
            differences.push(format!("step {index} {step}\n  rust {rust}"));
        }
    }
    differences
}

#[tokio::test]
async fn rust_key_routes_match_node_contract_and_redact_secrets() {
    assert_eq!(
        GOLDEN.matches("ppk_").count(),
        GOLDEN.matches("ppk_not-issued").count(),
        "golden stores only key tokens"
    );
    let replay = replay().await;
    let differences = mismatches(&replay.steps, &replay.raw);
    assert!(differences.is_empty(), "{}", differences.join("\n"));
    assert_eq!(replay.issued.len(), 4);
    let stored = stored_keys(&replay.directory, &replay.tenant);
    let stored_value: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored_value.as_array().unwrap().len(), 4);
    for key in &replay.issued {
        assert!(key.starts_with("ppk_") && key.len() == 68);
        assert!(
            !stored.contains(key.as_str()),
            "stored keys hold digests only"
        );
    }
    assert_eq!(
        stored_value
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key["isActive"].as_bool().unwrap())
            .collect::<Vec<_>>(),
        [false, false, true, true],
        "revocation survives reopen"
    );
    std::fs::remove_dir_all(&replay.directory).unwrap();
}

#[tokio::test]
async fn comparison_rejects_leaked_secret_and_accepted_revoked_key() {
    let replay = replay().await;
    std::fs::remove_dir_all(&replay.directory).unwrap();
    assert!(mismatches(&replay.steps, &replay.raw).is_empty());
    let step = |op: &str, after: usize| {
        (after..replay.steps.len())
            .find(|&index| replay.steps[index]["op"] == op)
            .unwrap()
    };
    let list = step("list", 1);
    let revoked_use = step("use", step("revoke", 0));
    assert_eq!(replay.steps[revoked_use]["key"], "<key:1>");
    let unknown_revoke = step("revoke", step("rotate", 0));
    let last = replay.steps.len() - 1;
    assert_eq!(replay.steps[last]["op"], "list");
    assert_eq!(replay.steps[unknown_revoke]["id"], "key_0000000000000000");
    let key = replay.raw[1]["body"]["key"].clone();
    let id = replay.raw[1]["body"]["id"].clone();
    let mutations = [
        ("key in list", list, "/body/keys/0/key", key.clone()),
        (
            "key as createdAt",
            list,
            "/body/keys/0/createdAt",
            key.clone(),
        ),
        ("key as detail", unknown_revoke, "/body/detail", key),
        (
            "invalid createdAt",
            list,
            "/body/keys/0/createdAt",
            json!("not-a-time"),
        ),
        (
            "changed createdAt",
            list,
            "/body/keys/0/createdAt",
            json!("2001-01-01T00:00:00.000Z"),
        ),
        ("revoked key accepted", revoked_use, "/accepted", id),
        (
            "impossible first lastUsedAt",
            last,
            "/body/keys/3/lastUsedAt",
            json!("2026-99-99T99:99:99.999Z"),
        ),
        (
            "lastUsedAt in an array",
            last,
            "/body/keys/3/lastUsedAt",
            json!([replay.raw[last]["body"]["keys"][3]["lastUsedAt"]]),
        ),
        (
            "token as raw lastUsedAt",
            last,
            "/body/keys/3/lastUsedAt",
            json!("<id:4.lastUsedAt#1>"),
        ),
        ("token as raw id", last, "/body/keys/3/id", json!("<id:4>")),
    ];
    for (name, index, pointer, value) in mutations {
        let mut raw = replay.raw.clone();
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        raw[index].pointer_mut(parent).unwrap()[field] = value;
        assert_eq!(mismatches(&replay.steps, &raw).len(), 1, "{name}");
    }
}

#[tokio::test]
async fn foreign_tenant_cannot_list_use_revoke_or_rotate_keys() {
    let node: Vec<Value> = serde_json::from_str::<Value>(GOLDEN).unwrap()["steps"]
        .as_array()
        .unwrap()
        .clone();
    let unknown = |op: &str| {
        rust_contract(
            &node
                .iter()
                .find(|step| step["op"] == op && step["id"] == "key_0000000000000000")
                .unwrap()["node"],
        )
    };
    let mut bytes = [0; 12];
    getrandom::fill(&mut bytes).unwrap();
    let directory = std::env::temp_dir().join(format!("pp-auth-key-tenant-{}", hex::encode(bytes)));
    let server = Server::open(&directory).await;
    let (owner, owner_tenant) = server.register("owner@example.com").await;
    let (foreign, foreign_tenant) = server.register("foreign@example.com").await;
    assert_ne!(owner_tenant, foreign_tenant);
    let created = server
        .json(Method::POST, "/settings/api-keys", &owner)
        .await;
    assert_eq!(created["status"], 201);
    let id = created["body"]["id"].as_str().unwrap();
    let key = created["body"]["key"].as_str().unwrap();

    assert_eq!(
        server
            .json(Method::GET, "/settings/api-keys", &foreign)
            .await,
        json!({"status":200,"body":{"keys":[],"total":0}})
    );
    assert_eq!(
        server
            .json(
                Method::DELETE,
                &format!("/settings/api-keys/{id}"),
                &foreign
            )
            .await,
        unknown("revoke")
    );
    assert_eq!(
        server
            .json(
                Method::POST,
                &format!("/settings/api-keys/{id}/regenerate"),
                &foreign
            )
            .await,
        unknown("rotate")
    );
    assert_eq!(server.accepted(&foreign_tenant, key).await, None);
    assert_eq!(
        server.accepted(&owner_tenant, key).await.as_deref(),
        Some(id)
    );
    let listed = server.json(Method::GET, "/settings/api-keys", &owner).await;
    assert_eq!(listed["body"]["total"], 1);
    assert_eq!(listed["body"]["keys"][0]["isActive"], true);
    assert!(!listed.to_string().contains(key));
    server.stop().await;
    std::fs::remove_dir_all(&directory).unwrap();
}
