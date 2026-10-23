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
    let directory = std::env::temp_dir().join(format!("pp-manifest-http-{}", {
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

const KIT_PATHS: &[&str] = &[
    "/plans/1/kit-manifest",
    "/api/v1/plans/1/kit-manifest",
    "/api/v2/plans/1/kit-manifest",
];

/// Without `desktop_rebuild`, kit-manifest HTTP is not linked into pp-api.
#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn kit_manifest_read_flag_off_is_404() {
    let (owner, directory) = open();
    let snapshot = files(&directory);
    let before = profiles(&directory);
    let mut server = Server::spawn(bind().await, axum::Router::new()).await;
    for path in KIT_PATHS {
        let (status, body) = server.send(Method::GET, path, &[]).await;
        assert_eq!(status, 404, "{path}");
        assert!(body.get("kit").is_none());
    }
    server.stop().await;
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);
    shutdown(owner, directory);
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn kit_manifest_read_matches_storage() {
    let (owner, directory) = open();
    let mut server = Server::spawn(bind().await, axum::Router::new()).await;
    let (status, body) = server.send(Method::GET, "/plans/1/kit-manifest", &[]).await;
    assert_eq!(status, 404);
    assert!(body.get("kit").is_none());
    server.stop().await;
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
fn store_kit(directory: &Path, tenant: &str, build: i64, kit: &Value) {
    let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute(
        "INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,?3)
         ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value",
        rusqlite::params![tenant, format!("kit_manifest_{build}"), kit.to_string()],
    )
    .unwrap();
}

#[cfg(feature = "desktop_rebuild")]
fn read_kit_storage(owner: &Mutex<WriterOwner>, token: &str, build: i64) -> Value {
    use pp_storage::{
        auth::Secret,
        build_graph::{BuildCommand, BuildOutcome, ManifestOptionsCommand, PositiveId},
        read_model::Credential,
    };
    use std::{sync::atomic::AtomicBool, time::Duration};
    let client = owner
        .lock()
        .unwrap()
        .build_graph_with_policy(policy())
        .unwrap();
    match client
        .execute(
            Credential::Session(Secret::new(token.into())),
            BuildCommand::Manifest(ManifestOptionsCommand::ReadKit {
                build: PositiveId::new(build as u64).unwrap(),
            }),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .unwrap()
    {
        BuildOutcome::Manifest(manifest) => {
            serde_json::from_slice(&manifest.into_success_body().unwrap().into_bytes()).unwrap()
        }
        other => panic!("{other:?}"),
    }
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn kit_manifest_read_flag_off_is_404() {
    use pp_api::builds::{BuildHttpConfig, build_router};
    let (owner, directory) = open();
    let before = profiles(&directory);
    let snapshot = files(&directory);
    for flag in [None, Some(""), Some("0"), Some("false"), Some("TRUE")] {
        let bound = bind().await;
        let origin = format!("http://{}", bound.local_addr().unwrap());
        let router = build_router(
            BuildHttpConfig::from_startup(&origin, "default", flag).unwrap(),
            owner
                .lock()
                .unwrap()
                .build_graph_with_policy(policy())
                .unwrap(),
        );
        let mut server = Server::spawn(bound, router).await;
        for path in KIT_PATHS {
            let (status, body) = server.send(Method::GET, path, &[]).await;
            assert_eq!(status, 404, "{flag:?} {path}");
            assert!(body.get("kit").is_none());
        }
        server.stop().await;
    }
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn kit_manifest_read_matches_storage() {
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
    let cookie_a = register(&bootstrap, "kit-a@example.test").await;
    let cookie_b = register(&bootstrap, "kit-b@example.test").await;
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

    let stored = json!({
        "name": "Saved",
        "layers": [],
        "base_source_id": null,
        "addon_source_ids": [],
        "selections": {"toolhead": "mini"},
        "include": ["part.stl"],
        "exclude": [],
        "replacements": {},
        "choice_tree": [],
        "category_links": []
    });
    store_kit(&directory, &tenant_a, id_a, &stored);
    let expected = read_kit_storage(&owner, &token_a, id_a);
    assert_eq!(expected["kit"], stored);

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
    let (status, body) = server
        .send(Method::GET, &format!("/plans/{id_a}/kit-manifest"), &[])
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (401, Some("Authentication required"))
    );

    for prefix in ["", "/api/v1", "/api/v2"] {
        let path = format!("{prefix}/plans/{id_a}/kit-manifest");
        let (status, body) = server
            .send(Method::GET, &path, &[("Cookie", cookie_a.as_str())])
            .await;
        assert_eq!((status, &body), (200, &expected), "{prefix}");
        let (status, _) = server
            .send(Method::HEAD, &path, &[("Cookie", cookie_a.as_str())])
            .await;
        assert_eq!(status, 200, "HEAD {prefix}");
        let (status, body) = server
            .send(
                Method::GET,
                &format!("{prefix}/plans/{id_b}/kit-manifest"),
                &[("Cookie", cookie_a.as_str())],
            )
            .await;
        assert_eq!(
            (status, body["detail"].as_str()),
            (404, Some("Profile not found")),
            "{prefix}"
        );
    }

    let empty = read_kit_storage(&owner, &token_b, id_b);
    let (status, body) = server
        .send(
            Method::GET,
            &format!("/plans/{id_b}/kit-manifest"),
            &[("Cookie", cookie_b.as_str())],
        )
        .await;
    assert_eq!((status, body), (200, empty));
    assert_eq!(files(&directory), snapshot);
    assert_eq!(profiles(&directory), before);
    server.stop().await;
    shutdown(owner, directory);
}
