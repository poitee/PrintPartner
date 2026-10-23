use pp_storage::{Limits, WriterOwner};
use reqwest::{Client, Method};
use serde_json::Value;
#[cfg(feature = "desktop_rebuild")]
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn open() -> (Arc<Mutex<WriterOwner>>, PathBuf) {
    let directory = std::env::temp_dir().join(format!("pp-builds-http-{}", {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).unwrap();
        hex::encode(bytes)
    }));
    (
        Arc::new(Mutex::new(
            WriterOwner::open(&directory, Limits::default()).unwrap().0,
        )),
        directory,
    )
}

fn files(dir: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        for entry in std::fs::read_dir(&path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                pending.push(entry.path());
            } else {
                out.push((
                    entry
                        .path()
                        .strip_prefix(dir)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    entry.metadata().unwrap().len(),
                ));
            }
        }
    }
    out.sort();
    out
}

fn profiles(directory: &Path) -> Vec<(String, i64, String)> {
    let db = rusqlite::Connection::open_with_flags(
        directory.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let mut statement = db
        .prepare("SELECT tenant_id, id, name FROM build_profiles ORDER BY tenant_id, id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

struct Server {
    origin: String,
    client: Client,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Server {
    async fn spawn(listener: tokio::net::TcpListener, router: axum::Router) -> Self {
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        Self {
            origin,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .unwrap(),
            shutdown: Some(shutdown),
            task: Some(task),
        }
    }

    async fn send(&self, method: Method, path: &str, headers: &[(&str, &str)]) -> (u16, Value) {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        (
            response.status().as_u16(),
            response.json().await.unwrap_or(Value::Null),
        )
    }

    async fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn bind() -> tokio::net::TcpListener {
    tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
}

fn shutdown(owner: Arc<Mutex<WriterOwner>>, directory: PathBuf) {
    let owner = Arc::try_unwrap(owner).unwrap_or_else(|_| panic!("router still holds storage"));
    owner.into_inner().unwrap().shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

const READ_PATHS: &[&str] = &[
    "/plans",
    "/plans/1",
    "/api/v1/plans",
    "/api/v1/plans/1",
    "/api/v2/plans",
    "/api/v2/plans/1",
];

/// Without `desktop_rebuild`, Plan build HTTP is not linked into pp-api.
/// Linear keeps these names so `cargo test -p pp-api` (no features) still discovers them.
#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn build_reads_flag_off_are_404() {
    let (owner, directory) = open();
    let snapshot = files(&directory);
    let before = profiles(&directory);
    let mut server = Server::spawn(bind().await, axum::Router::new()).await;
    for path in READ_PATHS {
        for method in [Method::GET, Method::HEAD] {
            let (status, body) = server.send(method, path, &[]).await;
            assert_eq!(status, 404, "{path}");
            assert!(body.get("profiles").is_none() && body.get("id").is_none());
        }
    }
    server.stop().await;
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);
    shutdown(owner, directory);
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn build_reads_are_authenticated_and_tenant_scoped() {
    let (owner, directory) = open();
    let snapshot = files(&directory);
    let before = profiles(&directory);
    let mut server = Server::spawn(bind().await, axum::Router::new()).await;
    let (status, body) = server.send(Method::GET, "/plans", &[]).await;
    assert_eq!(status, 404);
    assert!(body.get("profiles").is_none());
    server.stop().await;
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
fn policy() -> pp_storage::auth::AuthPolicy {
    use pp_storage::auth::*;
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

#[cfg(feature = "desktop_rebuild")]
async fn register(server: &Server, email: &str) -> String {
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email": email, "password": "password-1234"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200, "{email}");
    registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

#[cfg(feature = "desktop_rebuild")]
fn assert_summary_shape(body: &Value, id: i64, name: &str) {
    assert_eq!(body["id"], id);
    assert_eq!(body["name"], name);
    assert!(body.get("order_number").is_some());
    assert!(body.get("special_request").is_some());
    assert_eq!(body["part_count"], 0);
    assert!(body["accepted_progress"].is_object());
    assert_eq!(body["build_stale"], false);
    assert!(body["freshness"].is_object());
    assert!(body.get("archived_at").is_some());
    assert!(body.get("last_used_at").is_some());
    assert!(body.get("layers").is_none());
}

/// Real `enabled=false` path: `build_router` with a non-opt-in `PP_DESKTOP_REBUILD`.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn build_reads_flag_off_are_404() {
    use pp_api::builds::{BuildHttpConfig, build_router};
    let (owner, directory) = open();
    let before = profiles(&directory);
    let snapshot = files(&directory);
    for flag in [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("TRUE"),
        Some(" true "),
    ] {
        let bound = bind().await;
        let origin = format!("http://{}", bound.local_addr().unwrap());
        let config = BuildHttpConfig::from_startup(&origin, "default", flag).unwrap();
        let router = build_router(
            config,
            owner
                .lock()
                .unwrap()
                .build_graph_with_policy(policy())
                .unwrap(),
        );
        let mut server = Server::spawn(bound, router).await;
        for path in READ_PATHS {
            for method in [Method::GET, Method::HEAD] {
                let (status, body) = server.send(method, path, &[]).await;
                assert_eq!(status, 404, "{flag:?} {path}");
                assert!(body.get("profiles").is_none() && body.get("id").is_none());
            }
        }
        server.stop().await;
    }
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn build_reads_are_authenticated_and_tenant_scoped() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        builds::{BuildHttpConfig, build_router},
    };
    use pp_storage::{
        auth::Secret,
        build_graph::{BuildCommand, BuildName, BuildOutcome},
        read_model::Credential,
    };
    use std::{sync::atomic::AtomicBool, time::Duration};

    let (owner, directory) = open();
    let chosen = policy();
    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let auth = owner.lock().unwrap().auth_with_policy(chosen).unwrap();
    let mut bootstrap = Server::spawn(
        bound,
        auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            auth,
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        ),
    )
    .await;
    let cookie_a = register(&bootstrap, "builds-a@example.test").await;
    let cookie_b = register(&bootstrap, "builds-b@example.test").await;
    let token_a = cookie_a.strip_prefix("pp_session=").unwrap().to_owned();
    let token_b = cookie_b.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;

    let create = |token: &str, name: &str| {
        let client = owner
            .lock()
            .unwrap()
            .build_graph_with_policy(chosen)
            .unwrap();
        match client
            .execute(
                Credential::Session(Secret::new(token.into())),
                BuildCommand::Create {
                    name: BuildName::parse(name.into()).unwrap(),
                    base_source: None,
                },
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
        {
            BuildOutcome::Created { profile, .. } => profile.id,
            other => panic!("{other:?}"),
        }
    };
    let id_a = create(&token_a, "Tenant A Plan");
    let id_b = create(&token_b, "Tenant B Plan");
    let tenant_a = profiles(&directory)
        .into_iter()
        .find(|row| row.1 == id_a)
        .map(|row| row.0)
        .expect("tenant A");

    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let (auth, graph) = {
        let locked = owner.lock().unwrap();
        (
            locked.auth_with_policy(chosen).unwrap(),
            locked.build_graph_with_policy(chosen).unwrap(),
        )
    };
    let mut server = Server::spawn(
        bound,
        build_router(
            BuildHttpConfig::from_startup(&origin, &tenant_a, Some("1")).unwrap(),
            graph,
        )
        .merge(auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            auth,
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        )),
    )
    .await;

    let before = profiles(&directory);
    let snapshot = files(&directory);
    let (status, body) = server.send(Method::GET, "/plans", &[]).await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (401, Some("Authentication required"))
    );
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);

    type Refusal<'a> = (&'a str, &'a [(&'a str, &'a str)], u16, &'a str);
    let refusals: &[Refusal<'_>] = &[
        (
            "/plans",
            &[("Cookie", cookie_a.as_str()), ("Host", "evil.test")],
            403,
            "Invalid request host",
        ),
        (
            "/plans",
            &[
                ("Cookie", cookie_a.as_str()),
                ("Origin", "https://evil.test"),
            ],
            403,
            "Invalid request origin",
        ),
        (
            "/plans",
            &[
                ("Cookie", cookie_a.as_str()),
                ("sec-fetch-site", "cross-site"),
            ],
            403,
            "Invalid request origin",
        ),
        (
            "/plans",
            &[
                ("Cookie", cookie_a.as_str()),
                ("x-forwarded-for", "1.2.3.4"),
            ],
            403,
            "Invalid request host",
        ),
        (
            "/plans",
            &[
                ("Cookie", cookie_a.as_str()),
                ("Authorization", "Bearer also"),
            ],
            401,
            "Authentication required",
        ),
    ];
    for &(path, headers, status, detail) in refusals {
        let before_files = files(&directory);
        let before_rows = profiles(&directory);
        let (got_status, body) = server.send(Method::GET, path, headers).await;
        assert_eq!(
            (got_status, body["detail"].as_str()),
            (status, Some(detail)),
            "{path} {headers:?}"
        );
        assert_eq!(files(&directory), before_files, "refusal mutated files");
        assert_eq!(profiles(&directory), before_rows, "refusal mutated rows");
    }

    let (status, list_a) = server
        .send(Method::GET, "/plans", &[("Cookie", cookie_a.as_str())])
        .await;
    assert_eq!(status, 200);
    assert_eq!(list_a["profiles"].as_array().unwrap().len(), 1);
    assert_summary_shape(&list_a["profiles"][0], id_a, "Tenant A Plan");

    let (status, list_b) = server
        .send(Method::GET, "/plans", &[("Cookie", cookie_b.as_str())])
        .await;
    assert_eq!(status, 200);
    assert_eq!(list_b["profiles"].as_array().unwrap().len(), 1);
    assert_summary_shape(&list_b["profiles"][0], id_b, "Tenant B Plan");

    for prefix in ["", "/api/v1", "/api/v2"] {
        let (status, body) = server
            .send(
                Method::GET,
                &format!("{prefix}/plans/{id_a}"),
                &[("Cookie", cookie_a.as_str())],
            )
            .await;
        assert_eq!(status, 200, "{prefix}");
        assert_summary_shape(&body, id_a, "Tenant A Plan");
        let (status, body) = server
            .send(
                Method::GET,
                &format!("{prefix}/plans/{id_b}"),
                &[("Cookie", cookie_a.as_str())],
            )
            .await;
        assert_eq!(
            (status, body["detail"].as_str()),
            (404, Some("Profile not found")),
            "{prefix}"
        );
        let (status, _) = server
            .send(
                Method::HEAD,
                &format!("{prefix}/plans"),
                &[("Cookie", cookie_a.as_str())],
            )
            .await;
        assert_eq!(status, 200, "HEAD list {prefix}");
        let (status, _) = server
            .send(
                Method::HEAD,
                &format!("{prefix}/plans/{id_a}"),
                &[("Cookie", cookie_a.as_str())],
            )
            .await;
        assert_eq!(status, 200, "HEAD detail {prefix}");
        let (status, body) = server
            .send(
                Method::HEAD,
                &format!("{prefix}/plans/{id_b}"),
                &[("Cookie", cookie_a.as_str())],
            )
            .await;
        assert_eq!(status, 404, "HEAD cross-tenant {prefix}");
        assert!(body.get("id").is_none());
    }

    let (status, body) = server
        .send(
            Method::GET,
            "/plans/9007199254740991",
            &[("Cookie", cookie_a.as_str())],
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Profile not found"))
    );
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);

    let key = server
        .client
        .post(format!("{}/settings/api-keys", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie_a)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(key.status(), 201);
    let key: Value = key.json().await.unwrap();
    let bearer = format!("Bearer {}", key["key"].as_str().unwrap());
    let (status, body) = server
        .send(Method::GET, "/plans", &[("Authorization", bearer.as_str())])
        .await;
    assert_eq!(status, 200);
    assert_eq!(body, list_a);
    let (status, body) = server
        .send(
            Method::GET,
            &format!("/plans/{id_b}"),
            &[("Authorization", bearer.as_str())],
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Profile not found"))
    );
    assert_eq!(profiles(&directory), before);
    server.stop().await;
    shutdown(owner, directory);
}
