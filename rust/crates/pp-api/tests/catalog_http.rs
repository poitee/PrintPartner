use pp_storage::{
    Limits, WriterOwner,
    catalog::{CreateSource, Outcome, Request, SourceSummary},
};
#[cfg(feature = "desktop_rebuild")]
use pp_storage::{
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::Credentials,
};
use reqwest::{Client, Method};
use serde_json::{Map, Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[cfg(feature = "desktop_rebuild")]
#[path = "../../pp-storage/tests/common/process.rs"]
mod child_process;

#[cfg(feature = "desktop_rebuild")]
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
    }
}

fn open() -> (Arc<Mutex<WriterOwner>>, PathBuf) {
    let directory = std::env::temp_dir().join(format!("pp-catalog-http-{}", random()));
    let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
    (Arc::new(Mutex::new(owner)), directory)
}

fn random() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    hex::encode(bytes)
}

fn sample(name: &str, note: &str) -> CreateSource {
    let metadata: Map<String, Value> = serde_json::from_value(json!({
        "note": note,
        "remote_update_status": "up_to_date",
        "remote_checked_at": "2026-01-02T00:00:00.000Z"
    }))
    .unwrap();
    CreateSource {
        name: name.into(),
        url: Some(format!("https://example.test/{name}")),
        branch: Some("main".into()),
        tag: Some("v1".into()),
        source_kind: Some("github".into()),
        source_type: Some("git".into()),
        role: Some("reference".into()),
        metadata: Some(metadata),
    }
}

fn list(owner: &WriterOwner) -> Vec<SourceSummary> {
    match owner
        .local_source_catalog()
        .execute(Request::List {})
        .unwrap()
    {
        Outcome::Sources(rows) => rows,
        _ => panic!("list"),
    }
}

fn seed(owner: &WriterOwner) -> Vec<SourceSummary> {
    let catalog = owner.local_source_catalog();
    for (name, note) in [("Alpha", "kept"), ("Zebra", "other")] {
        catalog
            .execute(Request::Create {
                source: sample(name, note),
            })
            .unwrap();
    }
    let rows = list(owner);
    assert_eq!(
        rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
        ["Alpha", "Zebra"]
    );
    assert_eq!(rows[0].metadata.as_ref().unwrap()["note"], "kept");
    assert_eq!(rows[0].update_status.as_deref(), Some("up_to_date"));
    assert!(rows[0].content_available && rows[0].local_path.is_some());
    rows
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
                let rel = entry
                    .path()
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, entry.metadata().unwrap().len()));
            }
        }
    }
    out.sort();
    out
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
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        Self {
            origin,
            client,
            shutdown: Some(shutdown),
            task: Some(task),
        }
    }

    async fn send(&self, method: Method, path: &str, headers: &[(&str, &str)]) -> (u16, Value) {
        self.exchange(method, path, headers, None).await
    }

    async fn exchange(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> (u16, Value) {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        if let Some(body) = body {
            request = request.json(body);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        if matches!(status, 200 | 400 | 401 | 403 | 409) {
            assert_eq!(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok()),
                Some("application/json")
            );
        }
        (status, response.json().await.unwrap_or(Value::Null))
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

async fn listener() -> (tokio::net::TcpListener, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    (listener, origin)
}

fn shutdown(owner: Arc<Mutex<WriterOwner>>, directory: PathBuf) {
    seal(owner);
    std::fs::remove_dir_all(directory).unwrap();
}

fn seal(owner: Arc<Mutex<WriterOwner>>) {
    let Ok(owner) = Arc::try_unwrap(owner) else {
        panic!("router still holds storage");
    };
    owner.into_inner().unwrap().shutdown().unwrap();
}

#[cfg(feature = "desktop_rebuild")]
fn insert_safeguards(directory: &Path, history_id: i64, referenced_id: i64) {
    let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    db.execute_batch(&format!(
        "PRAGMA foreign_keys=ON;
         INSERT INTO source_revisions(tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at) VALUES('default',{history_id},'retained-a','digest','{history_id}/revisions/retained-a','2026-10-03');
         INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Build');
         INSERT INTO profile_layers(tenant_id,profile_id,layer_type,project_id) VALUES('default',1,'base',{referenced_id});"
    ))
    .unwrap();
}

#[cfg(feature = "desktop_rebuild")]
fn stored_rows(directory: &Path) -> Vec<String> {
    let db = rusqlite::Connection::open_with_flags(
        directory.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let mut rows = Vec::new();
    for sql in [
        "SELECT id || ':' || name FROM projects ORDER BY id",
        "SELECT project_id || ':' || upstream_revision_key || ':' || manifest_digest || ':' || snapshot_locator || ':' || synced_at FROM source_revisions ORDER BY id",
        "SELECT project_id || ':' || layer_type FROM profile_layers ORDER BY id",
    ] {
        let mut statement = db.prepare(sql).unwrap();
        rows.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(|row| row.unwrap()),
        );
    }
    rows
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn catalog_reads_flag_off_are_404() {
    let (owner, directory) = open();
    let before = {
        let guard = owner.lock().unwrap();
        seed(&guard)
    };
    let snapshot = files(&directory);
    let (listener, _) = listener().await;
    let mut server = Server::spawn(listener, axum::Router::new()).await;
    refuse_mounted_reads(&server).await;
    server.stop().await;
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), before);
    shutdown(owner, directory);
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn catalog_create_patch_match_node_coercions() {
    unmounted_write(
        Method::POST,
        "/sources",
        json!({"name":12,"source_kind":"GitHub","metadata":{"category":" A / B "}}),
    )
    .await;
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn catalog_patch_wrong_owner_is_refused() {
    unmounted_write(
        Method::PATCH,
        "/api/v1/sources/1",
        json!({"name":"Stolen","metadata":{"note":"stolen"}}),
    )
    .await;
}

#[cfg(not(feature = "desktop_rebuild"))]
async fn unmounted_write(method: Method, path: &str, body: Value) {
    let (owner, directory) = open();
    let before = {
        let guard = owner.lock().unwrap();
        seed(&guard)
    };
    let snapshot = files(&directory);
    let (listener, _) = listener().await;
    let mut server = Server::spawn(listener, axum::Router::new()).await;
    let (status, response) = server.exchange(method, path, &[], Some(&body)).await;
    assert_eq!(status, 404, "{path}");
    assert!(response.get("name").is_none());
    server.stop().await;
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), before);
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_reads_flag_off_are_404() {
    use pp_api::catalog::{CatalogHttpConfig, admit_catalog_routes};
    let (owner, directory) = open();
    let before = {
        let guard = owner.lock().unwrap();
        seed(&guard)
    };
    let snapshot = files(&directory);
    for flag in [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("TRUE"),
        Some(" true "),
    ] {
        let (bound, origin) = listener().await;
        let router = admit_catalog_routes(
            CatalogHttpConfig::from_startup(&origin, "default", policy(), flag).unwrap(),
            Arc::clone(&owner),
        );
        let mut server = Server::spawn(bound, router).await;
        refuse_mounted_reads(&server).await;
        server.stop().await;
    }
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), before);
    shutdown(owner, directory);
}

async fn refuse_mounted_reads(server: &Server) {
    for path in [
        "/sources",
        "/sources/1",
        "/api/v1/sources",
        "/api/v1/sources/1",
    ] {
        let (status, body) = server.send(Method::GET, path, &[]).await;
        assert_eq!(status, 404, "{path}");
        assert!(body.get("sources").is_none() && body.get("name").is_none());
    }
    for path in ["/sources/1", "/api/v1/sources/1"] {
        let (status, body) = server
            .exchange(
                Method::PATCH,
                path,
                &[],
                Some(&json!({"name":"Stolen","metadata":{"note":"stolen"}})),
            )
            .await;
        assert_eq!(status, 404, "{path}");
        assert!(body.get("name").is_none());
    }
    let (status, _) = server.send(Method::POST, "/sources", &[]).await;
    assert_eq!(status, 404);
    for path in ["/sources/1", "/api/v1/sources/1"] {
        let (status, body) = server.send(Method::DELETE, path, &[]).await;
        assert_eq!(status, 404, "{path}");
        assert!(body.get("name").is_none());
    }
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_reads_match_existing_source_metadata() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        catalog::{CatalogHttpConfig, admit_catalog_routes},
    };
    let (owner, directory) = open();
    let seeded = {
        let guard = owner.lock().unwrap();
        seed(&guard)
    };
    let (bound, origin) = listener().await;
    let auth = owner.lock().unwrap().auth_with_policy(policy()).unwrap();
    let router = admit_catalog_routes(
        CatalogHttpConfig::from_startup(&origin, "default", policy(), Some("true")).unwrap(),
        Arc::clone(&owner),
    )
    .merge(auth_router(
        AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false).unwrap(),
        auth,
        ProviderClient::new(None, None).unwrap(),
        ResetMailer::disabled(),
    ));
    let mut server = Server::spawn(bound, router).await;
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email":"reader@example.test","password":"password-1234"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let token = cookie.strip_prefix("pp_session=").unwrap();
    let session_rows = {
        let guard = owner.lock().unwrap();
        match guard
            .source_catalog_with_policy(Credentials::Session(Secret::new(token.into())), policy())
            .unwrap()
            .execute(Request::List {})
            .unwrap()
        {
            Outcome::Sources(rows) => rows,
            _ => panic!("session list"),
        }
    };
    assert_eq!(session_rows, seeded);
    let expected = json!({ "sources": session_rows });
    for prefix in ["", "/api/v1"] {
        let (status, body) = server
            .send(
                Method::GET,
                &format!("{prefix}/sources"),
                &[("Cookie", &cookie)],
            )
            .await;
        assert_eq!(status, 200, "{prefix}");
        assert_eq!(body, expected);
        for row in &session_rows {
            let (status, body) = server
                .send(
                    Method::GET,
                    &format!("{prefix}/sources/{}", row.id),
                    &[("Cookie", &cookie)],
                )
                .await;
            assert_eq!(status, 200);
            assert_eq!(body, serde_json::to_value(row).unwrap());
        }
    }
    let key = server
        .client
        .post(format!("{}/settings/api-keys", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(key.status(), 201);
    let key: Value = key.json().await.unwrap();
    let bearer = format!("Bearer {}", key["key"].as_str().unwrap());
    let (status, body) = server
        .send(Method::GET, "/sources", &[("Authorization", &bearer)])
        .await;
    assert_eq!(status, 200);
    assert_eq!(body, expected);
    let rows = list(&owner.lock().unwrap());
    let snapshot = files(&directory);
    let (status, body) = server.send(Method::GET, "/sources", &[]).await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (401, Some("Authentication required"))
    );
    let (status, body) = server
        .send(
            Method::GET,
            "/sources",
            &[("Cookie", &cookie), ("x-forwarded-for", "203.0.113.8")],
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (403, Some("Invalid request host"))
    );
    let (status, body) = server
        .send(Method::GET, "/sources/nope", &[("Cookie", &cookie)])
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Source not found"))
    );
    let (status, body) = server
        .exchange(
            Method::POST,
            "/sources",
            &[("Cookie", &cookie)],
            Some(&json!({})),
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (400, Some("Source name is required"))
    );
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), rows);
    let (status, body) = server
        .send(Method::GET, "/sources/999999", &[("Cookie", &cookie)])
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Source not found"))
    );
    assert_eq!(list(&owner.lock().unwrap()), rows);
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
fn node_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/catalog-source-http/node.json"
    ))
    .unwrap()
}

#[cfg(feature = "desktop_rebuild")]
fn assert_source(actual: &Value, expected: &Value, directory: &Path) {
    for (key, value) in expected.as_object().unwrap() {
        assert_eq!(&actual[key], value, "{key}");
    }
    let id = actual["id"].as_i64().unwrap();
    let path = directory
        .canonicalize()
        .unwrap()
        .join("repos")
        .join(id.to_string());
    assert_eq!(actual["local_path"].as_str(), path.to_str());
    assert_eq!(
        actual.as_object().unwrap().len(),
        expected.as_object().unwrap().len() + 2
    );
}

#[cfg(feature = "desktop_rebuild")]
async fn serve(account_tenant: bool) -> (Arc<Mutex<WriterOwner>>, PathBuf, Server, String) {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        catalog::{CatalogHttpConfig, admit_catalog_routes},
    };
    use pp_storage::auth::SessionTenantPolicy;
    let (owner, directory) = open();
    let chosen = if account_tenant {
        AuthPolicy {
            registration: pp_storage::auth::RegistrationPolicy::FirstAccountOnly,
            first_user: pp_storage::auth::FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::AccountTenant,
        }
    } else {
        policy()
    };
    let (bound, origin) = listener().await;
    let auth = owner.lock().unwrap().auth_with_policy(chosen).unwrap();
    let router = admit_catalog_routes(
        CatalogHttpConfig::from_startup(&origin, "default", chosen, Some("1")).unwrap(),
        Arc::clone(&owner),
    )
    .merge(auth_router(
        AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false).unwrap(),
        auth,
        ProviderClient::new(None, None).unwrap(),
        ResetMailer::disabled(),
    ));
    let server = Server::spawn(bound, router).await;
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email":"owner@example.test","password":"password-1234"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (owner, directory, server, cookie)
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_create_patch_match_node_coercions() {
    let fixture = node_fixture();
    let (owner, directory, mut server, cookie) = serve(false).await;
    let (status, created) = server
        .exchange(
            Method::POST,
            "/sources",
            &[("Cookie", &cookie)],
            Some(&fixture["create"]["body"]),
        )
        .await;
    assert_eq!(status, 200);
    assert_source(&created, &fixture["create"]["source"], &directory);
    let id = created["id"].as_i64().unwrap();
    let (status, patched) = server
        .exchange(
            Method::PATCH,
            &format!("/api/v1/sources/{id}"),
            &[("Cookie", &cookie)],
            Some(&fixture["patch"]["body"]),
        )
        .await;
    assert_eq!(status, 200);
    assert_source(&patched, &fixture["patch"]["source"], &directory);
    let snapshot = files(&directory);
    let rows = list(&owner.lock().unwrap());
    let (status, body) = server
        .exchange(
            Method::PATCH,
            &format!("/sources/{id}"),
            &[("Cookie", &cookie)],
            Some(&json!({"local_path":"/tmp/outside","metadata":{"note":"nope"}})),
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (400, Some("Raw local_path requires native Source selection"))
    );
    let (status, stored) = server
        .send(
            Method::GET,
            &format!("/sources/{id}"),
            &[("Cookie", &cookie)],
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(stored, patched);
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), rows);
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_patch_wrong_owner_is_refused() {
    let (owner, directory) = open();
    let seeded = {
        let guard = owner.lock().unwrap();
        seed(&guard)
    };
    let foreign_id = seeded[0].id;
    let (bound, origin) = listener().await;
    let account = AuthPolicy {
        registration: pp_storage::auth::RegistrationPolicy::FirstAccountOnly,
        first_user: pp_storage::auth::FirstUserTenant::NewUser,
        session_tenant: pp_storage::auth::SessionTenantPolicy::AccountTenant,
    };
    let auth = owner.lock().unwrap().auth_with_policy(account).unwrap();
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        catalog::{CatalogHttpConfig, admit_catalog_routes},
    };
    let router = admit_catalog_routes(
        CatalogHttpConfig::from_startup(&origin, "default", account, Some("true")).unwrap(),
        Arc::clone(&owner),
    )
    .merge(auth_router(
        AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false).unwrap(),
        auth,
        ProviderClient::new(None, None).unwrap(),
        ResetMailer::disabled(),
    ));
    let mut server = Server::spawn(bound, router).await;
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email":"stranger@example.test","password":"password-1234"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (status, body) = server
        .send(Method::GET, "/sources", &[("Cookie", &cookie)])
        .await;
    assert_eq!((status, &body), (200, &json!({"sources":[]})));
    let snapshot = files(&directory);
    let (status, body) = server
        .exchange(
            Method::PATCH,
            &format!("/api/v1/sources/{foreign_id}"),
            &[("Cookie", &cookie)],
            Some(&json!({"name":"Stolen","metadata":{"note":"stolen"}})),
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Source not found"))
    );
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), seeded);
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_delete_wrong_owner_is_refused() {
    let (owner, directory) = open();
    let seeded = {
        let guard = owner.lock().unwrap();
        seed(&guard)
    };
    let foreign_id = seeded[0].id;
    let (bound, origin) = listener().await;
    let account = AuthPolicy {
        registration: pp_storage::auth::RegistrationPolicy::FirstAccountOnly,
        first_user: pp_storage::auth::FirstUserTenant::NewUser,
        session_tenant: pp_storage::auth::SessionTenantPolicy::AccountTenant,
    };
    let auth = owner.lock().unwrap().auth_with_policy(account).unwrap();
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        catalog::{CatalogHttpConfig, admit_catalog_routes},
    };
    let router = admit_catalog_routes(
        CatalogHttpConfig::from_startup(&origin, "default", account, Some("true")).unwrap(),
        Arc::clone(&owner),
    )
    .merge(auth_router(
        AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false).unwrap(),
        auth,
        ProviderClient::new(None, None).unwrap(),
        ResetMailer::disabled(),
    ));
    let mut server = Server::spawn(bound, router).await;
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email":"stranger@example.test","password":"password-1234"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (status, body) = server
        .send(Method::GET, "/sources", &[("Cookie", &cookie)])
        .await;
    assert_eq!((status, &body), (200, &json!({"sources":[]})));
    let snapshot = files(&directory);
    let (status, body) = server
        .send(
            Method::DELETE,
            &format!("/api/v1/sources/{foreign_id}"),
            &[("Cookie", &cookie)],
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Source not found"))
    );
    assert_eq!(files(&directory), snapshot);
    assert_eq!(list(&owner.lock().unwrap()), seeded);
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
async fn post_source(server: &Server, cookie: &str, name: &str) -> Value {
    let (status, body) = server
        .exchange(
            Method::POST,
            "/sources",
            &[("Cookie", cookie)],
            Some(&json!({"name": name, "source_kind": "local"})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body
}

#[cfg(feature = "desktop_rebuild")]
async fn refuse(server: &Server, cookie: &str, path: &str, detail: &str) {
    let (status, body) = server
        .send(Method::DELETE, path, &[("Cookie", cookie)])
        .await;
    assert_eq!((status, body), (409, json!({ "detail": detail })), "{path}");
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_delete_busy_source_preserves_revisions() {
    let (owner, directory, mut server, cookie) = serve(false).await;
    let history = post_source(&server, &cookie, "History").await;
    let referenced = post_source(&server, &cookie, "Referenced").await;
    let history_id = history["id"].as_i64().unwrap();
    let referenced_id = referenced["id"].as_i64().unwrap();
    insert_safeguards(&directory, history_id, referenced_id);
    let before = stored_rows(&directory);
    let mut lease = {
        let guard = owner.lock().unwrap();
        guard
            .local_source_catalog()
            .begin_work(
                history_id,
                &std::sync::atomic::AtomicBool::new(false),
                std::time::Duration::from_secs(5),
            )
            .unwrap()
    };
    refuse(
        &server,
        &cookie,
        &format!("/sources/{history_id}"),
        "Source has active work and cannot be deleted",
    )
    .await;
    refuse(
        &server,
        &cookie,
        &format!("/api/v1/sources/{referenced_id}"),
        "Source is referenced and cannot be deleted",
    )
    .await;
    assert_eq!(stored_rows(&directory), before);
    lease.release().unwrap();
    refuse(
        &server,
        &cookie,
        &format!("/sources/{history_id}"),
        "Source has immutable revision history and cannot be deleted",
    )
    .await;
    assert_eq!(stored_rows(&directory), before);
    for (id, previous) in [(history_id, &history), (referenced_id, &referenced)] {
        let (status, body) = server
            .send(
                Method::GET,
                &format!("/sources/{id}"),
                &[("Cookie", &cookie)],
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(body["id"], previous["id"]);
        assert_eq!(body["name"], previous["name"]);
    }
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_delete_unreferenced_source_succeeds() {
    let (owner, directory, mut server, cookie) = serve(false).await;
    let keeper = post_source(&server, &cookie, "Keeper").await;
    let disposable = post_source(&server, &cookie, "Disposable").await;
    let id = disposable["id"].as_i64().unwrap();
    let keeper_id = keeper["id"].as_i64().unwrap();
    let path = PathBuf::from(disposable["local_path"].as_str().unwrap());
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("kept.stl"), b"retained").unwrap();
    let (status, body) = server
        .send(
            Method::DELETE,
            &format!("/api/v1/sources/{id}"),
            &[("Cookie", &cookie)],
        )
        .await;
    assert_eq!((status, body), (204, Value::Null));
    let (status, body) = server
        .send(
            Method::GET,
            &format!("/sources/{id}"),
            &[("Cookie", &cookie)],
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (404, Some("Source not found"))
    );
    let (status, body) = server
        .send(
            Method::GET,
            &format!("/sources/{keeper_id}"),
            &[("Cookie", &cookie)],
        )
        .await;
    assert_eq!((status, body), (200, keeper));
    assert_eq!(std::fs::read(path.join("kept.stl")).unwrap(), b"retained");
    let rows = stored_rows(&directory);
    assert!(rows.iter().any(|row| row == &format!("{keeper_id}:Keeper")));
    assert!(rows.iter().all(|row| row != &format!("{id}:Disposable")));
    assert!(rows.iter().all(|row| !row.starts_with(&format!("{id}:"))));
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn catalog_patch_stale_metadata_is_conflict() {
    if !matches!(
        std::env::var("PP_DESKTOP_REBUILD").ok().as_deref(),
        Some("1" | "true")
    ) {
        let output = child_process::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "catalog_patch_stale_metadata_is_conflict",
                "--test-threads=1",
            ])
            .env("PP_DESKTOP_REBUILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let fixture = node_fixture();
    let (owner, directory, mut server, cookie) = serve(false).await;
    let (status, created) = server
        .exchange(
            Method::POST,
            "/sources",
            &[("Cookie", &cookie)],
            Some(&fixture["create"]["body"]),
        )
        .await;
    assert_eq!(status, 200);
    let id = created["id"].as_i64().unwrap();
    let stale = match created["catalog_metadata_version"].as_i64() {
        Some(version) if version != 0 => 0,
        _ => 4,
    };
    let snapshot = files(&directory);
    let (status, body) = server
        .exchange(
            Method::PATCH,
            &format!("/sources/{id}"),
            &[("Cookie", &cookie)],
            Some(&json!({
                "metadata": {"note": "stale"},
                "metadata_version": stale
            })),
        )
        .await;
    assert_eq!(
        (status, body["detail"].as_str()),
        (
            409,
            Some("Catalog metadata changed; retry from the current version")
        )
    );
    let (status, stored) = server
        .send(
            Method::GET,
            &format!("/sources/{id}"),
            &[("Cookie", &cookie)],
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(stored["metadata"]["note"], created["metadata"]["note"]);
    assert_eq!(files(&directory), snapshot);
    server.stop().await;
    shutdown(owner, directory);
}
