use pp_storage::{Limits, WriterOwner};
use reqwest::{Client, Method};

#[cfg(feature = "desktop_rebuild")]
use reqwest::Response;
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[path = "../../pp-storage/tests/common/scratch.rs"]
mod scratch;
use scratch::Scratch;
#[path = "../../pp-storage/tests/common/cleanup.rs"]
mod cleanup;

/// Returns the directory first so that, on panic, `owner` drops before the
/// scratch directory is removed.
fn open() -> (Scratch, Arc<Mutex<WriterOwner>>) {
    let directory = Scratch::new("pp-jobs-http-");
    let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
    (directory, Arc::new(Mutex::new(owner)))
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

fn job_rows(directory: &Path) -> Vec<(String, String, String)> {
    let db = rusqlite::Connection::open_with_flags(
        directory.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    let mut statement = db
        .prepare("SELECT tenant, id, kind FROM durable_jobs ORDER BY tenant, id")
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
        self.send_with_origin(method, path, headers, Some(&self.origin))
            .await
    }

    async fn send_with_origin(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        origin: Option<&str>,
    ) -> (u16, Value) {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin));
        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        (
            response.status().as_u16(),
            response.json().await.unwrap_or(Value::Null),
        )
    }

    /// Sends a request whose body is not parsed: `POST` refusals carry no JSON.
    #[cfg(feature = "desktop_rebuild")]
    async fn send_raw(&self, method: Method, path: &str, headers: &[(&str, &str)]) -> Response {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.send().await.unwrap()
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

fn shutdown(owner: Arc<Mutex<WriterOwner>>, directory: Scratch) {
    let owner = Arc::try_unwrap(owner).unwrap_or_else(|_| panic!("router still holds storage"));
    owner.into_inner().unwrap().shutdown().unwrap();
    drop(directory);
}

/// Without `desktop_rebuild`, jobs HTTP is not linked into pp-api.
#[cfg(not(feature = "desktop_rebuild"))]
async fn feature_off_404() {
    let (directory, owner) = open();
    let snapshot = files(&directory);
    let before = job_rows(&directory);
    let mut server = Server::spawn(bind().await, axum::Router::new()).await;
    for path in ["/api/v1/jobs", "/api/v1/jobs/missing", "/jobs/missing"] {
        let (status, body) = server.send(Method::GET, path, &[]).await;
        assert_eq!(status, 404, "{path}");
        assert!(body.get("jobs").is_none() && body.get("job_id").is_none());
    }
    server.stop().await;
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (snapshot, before)
    );
    shutdown(owner, directory);
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn jobs_list_matches_node_filters() {
    feature_off_404().await;
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn jobs_list_flag_off_and_wrong_tenant_are_refused() {
    feature_off_404().await;
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn job_detail_aliases_match() {
    feature_off_404().await;
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn job_detail_head_has_no_body_and_keeps_status() {
    feature_off_404().await;
}

#[cfg(not(feature = "desktop_rebuild"))]
#[tokio::test]
async fn job_detail_mutations_and_ws_unregistered() {
    feature_off_404().await;
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
async fn register_account(server: &Server, email: &str) -> (String, String) {
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&serde_json::json!({"email": email, "password": "password-1234"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200, "{email}");
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let user: Value = registered.json().await.unwrap();
    let tenant = user["user"]["user_id"].as_str().unwrap().to_owned();
    (cookie, tenant)
}

#[cfg(feature = "desktop_rebuild")]
async fn register(server: &Server, email: &str) -> String {
    register_account(server, email).await.0
}

#[cfg(feature = "desktop_rebuild")]
async fn create_api_key(server: &Server, cookie: &str) -> String {
    let created = server
        .client
        .post(format!("{}/settings/api-keys", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", cookie)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let body: Value = created.json().await.unwrap();
    body["key"].as_str().unwrap().to_owned()
}

#[cfg(feature = "desktop_rebuild")]
fn kinds(body: &Value) -> Vec<(String, String)> {
    body["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|job| {
            (
                job["kind"].as_str().unwrap().into(),
                job["status"].as_str().unwrap().into(),
            )
        })
        .collect()
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn jobs_list_matches_node_filters() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };
    use pp_storage::{
        auth::Secret,
        jobs::{
            CompletedResult, Credential, JobKind, Outcome, Payload, SourceUpdatesResult,
            UserOperation, WorkerAdmission, WorkerOperation,
        },
    };
    use std::{sync::atomic::AtomicBool, time::Duration};

    let (directory, owner) = open();
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
    let cookie = register(&bootstrap, "jobs-list@example.test").await;
    let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;

    let enqueue = |key: &str, payload: Payload| match owner
        .lock()
        .unwrap()
        .jobs(chosen)
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.clone())),
            UserOperation::Enqueue {
                key: key.into(),
                payload_version: 1,
                payload,
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        Outcome::Job(job, _) => job.job_id,
        _ => panic!("enqueued job expected"),
    };
    let worker = owner
        .lock()
        .unwrap()
        .job_worker_with_policy(
            chosen,
            WorkerAdmission {
                kinds: vec![
                    (JobKind::CheckSourceUpdates, 1),
                    (JobKind::ExportChecklistHtml, 1),
                ],
                total: 2,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let check_id = enqueue("check", Payload::CheckSourceUpdates {});
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert_eq!(lease.job_id(), check_id);
    worker
        .update(&mut lease, WorkerOperation::Progress(10))
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::FinishPublic {
                artifact: None,
                result: Box::new(CompletedResult::SourceUpdates(SourceUpdatesResult {
                    checked: vec![],
                    skipped: vec![],
                    updates_available: 0,
                    checked_count: 0,
                })),
            },
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let export_id = enqueue("export", Payload::ExportChecklistHtml { profile_id: 7 });
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert_eq!(lease.job_id(), export_id);
    worker
        .update(&mut lease, WorkerOperation::Progress(10))
        .unwrap();
    worker.update(&mut lease, WorkerOperation::Fail).unwrap();

    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("1")).unwrap(),
            jobs,
        ),
    )
    .await;
    let headers = [("Cookie", cookie.as_str())];
    let all: Vec<(String, String)> = [
        ("export-checklist-html", "error"),
        ("check-source-updates", "done"),
    ]
    .into_iter()
    .map(|(k, s)| (k.into(), s.into()))
    .collect();
    // Literal Node retained fixtures from fixtures/parity/jobs-engine.
    let cases: &[(&str, Vec<(String, String)>)] = &[
        ("", all.clone()),
        (
            "?status=done",
            vec![("check-source-updates".into(), "done".into())],
        ),
        ("?status=bogus", vec![]),
        (
            "?profile_id=7",
            vec![("export-checklist-html".into(), "error".into())],
        ),
        ("?profile_id=8", vec![]),
        ("?profile_id=NaN", vec![]),
        ("?since=1970-01-01T00:00:00.000Z", all.clone()),
        ("?since=2100-01-01T00:00:00.000Z", vec![]),
        ("?since=invalid", all.clone()),
        ("?status=&status=done", vec![]),
    ];
    for (query, want) in cases {
        let (status, body) = server
            .send(Method::GET, &format!("/api/v1/jobs{query}"), &headers)
            .await;
        assert_eq!(status, 200, "{query}");
        assert_eq!(kinds(&body), *want, "{query}");
    }
    let head = server
        .client
        .request(
            Method::HEAD,
            format!("{}/api/v1/jobs?since=invalid", server.origin),
        )
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(head.bytes().await.unwrap().len(), 0);
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn jobs_list_flag_off_and_wrong_tenant_are_refused() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };
    use pp_storage::{
        auth::Secret,
        jobs::{Credential, Outcome, Payload, UserOperation},
    };
    use std::{sync::atomic::AtomicBool, time::Duration};

    let (directory, owner) = open();
    let snapshot = files(&directory);
    let before = job_rows(&directory);
    for flag in [None, Some(""), Some("0"), Some("false"), Some("TRUE")] {
        let bound = bind().await;
        let origin = format!("http://{}", bound.local_addr().unwrap());
        let jobs = owner.lock().unwrap().jobs(policy()).unwrap();
        let mut server = Server::spawn(
            bound,
            jobs_router(
                JobsHttpConfig::from_startup(&origin, "default", flag).unwrap(),
                jobs,
            ),
        )
        .await;
        for method in [Method::GET, Method::HEAD] {
            let (status, body) = server.send(method, "/api/v1/jobs", &[]).await;
            assert_eq!(status, 404, "{flag:?}");
            assert!(body.get("jobs").is_none());
        }
        server.stop().await;
    }
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (snapshot, before)
    );

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
    let cookie_a = register(&bootstrap, "jobs-a@example.test").await;
    let cookie_b = register(&bootstrap, "jobs-b@example.test").await;
    let token_a = cookie_a.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;
    match owner
        .lock()
        .unwrap()
        .jobs(chosen)
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token_a)),
            UserOperation::Enqueue {
                key: "owned".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        Outcome::Job(_, _) => {}
        _ => panic!("enqueued job expected"),
    }
    let before_files = files(&directory);
    let before_jobs = job_rows(&directory);
    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("true")).unwrap(),
            jobs,
        ),
    )
    .await;
    let (status, body) = server.send(Method::GET, "/api/v1/jobs", &[]).await;
    assert_eq!(status, 401);
    assert_eq!(
        body,
        serde_json::json!({"detail": "Authentication required"})
    );
    let (status, body) = server
        .send(
            Method::GET,
            "/api/v1/jobs",
            &[("Cookie", cookie_b.as_str())],
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["jobs"], serde_json::json!([]));
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (before_files, before_jobs)
    );
    let (status, body) = server
        .send(
            Method::GET,
            "/api/v1/jobs",
            &[("Cookie", cookie_a.as_str())],
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["jobs"].as_array().unwrap().len(), 1);
    server.stop().await;
    shutdown(owner, directory);
}

/// The configured API-key tenant selects the tenant. A key minted for another
/// tenant is refused before any job row or file can change.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn jobs_list_refuses_wrong_tenant_api_key() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };
    use pp_storage::{
        auth::Secret,
        jobs::{Credential, Outcome, Payload, UserOperation},
    };
    use std::{sync::atomic::AtomicBool, time::Duration};

    let (directory, owner) = open();
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
    let (cookie, tenant) = register_account(&bootstrap, "jobs-key@example.test").await;
    let key = create_api_key(&bootstrap, &cookie).await;
    let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;
    match owner
        .lock()
        .unwrap()
        .jobs(chosen)
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token)),
            UserOperation::Enqueue {
                key: "owned".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        Outcome::Job(_, _) => {}
        _ => panic!("enqueued job expected"),
    }

    let snapshot = files(&directory);
    let before = job_rows(&directory);
    let authorization = format!("Bearer {key}");

    // The key belongs to `tenant`, so the configured `default` tenant must refuse it.
    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("1")).unwrap(),
            jobs,
        ),
    )
    .await;
    for method in [Method::GET, Method::HEAD] {
        let get = method == Method::GET;
        let (status, body) = server
            .send(
                method,
                "/api/v1/jobs",
                &[("Authorization", authorization.as_str())],
            )
            .await;
        assert_eq!(status, 401);
        if get {
            assert_eq!(
                body,
                serde_json::json!({"detail": "Authentication required"})
            );
        } else {
            assert_eq!(body, Value::Null);
        }
    }
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (snapshot.clone(), before.clone())
    );
    server.stop().await;

    // The same key resolves under its own tenant, proving the refusal was tenant routing.
    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, &tenant, Some("1")).unwrap(),
            jobs,
        ),
    )
    .await;
    let (status, body) = server
        .send(
            Method::GET,
            "/api/v1/jobs",
            &[("Authorization", authorization.as_str())],
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["jobs"].as_array().unwrap().len(), 1);
    server.stop().await;
    shutdown(owner, directory);
}

/// Foreign transport identity is refused by the shared `loopback::admit` before
/// the jobs handler runs, so no job row or file changes.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn jobs_list_refuses_foreign_host_and_origin() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };
    use pp_storage::{
        auth::Secret,
        jobs::{Credential, Outcome, Payload, UserOperation},
    };
    use std::{sync::atomic::AtomicBool, time::Duration};

    let (directory, owner) = open();
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
    let (cookie, _tenant) = register_account(&bootstrap, "jobs-admit@example.test").await;
    let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;
    match owner
        .lock()
        .unwrap()
        .jobs(chosen)
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token)),
            UserOperation::Enqueue {
                key: "owned".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        Outcome::Job(_, _) => {}
        _ => panic!("enqueued job expected"),
    }

    let snapshot = files(&directory);
    let before = job_rows(&directory);
    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("true")).unwrap(),
            jobs,
        ),
    )
    .await;
    for method in [Method::GET, Method::HEAD] {
        let get = method == Method::GET;
        let (status, body) = server
            .send(
                method.clone(),
                "/api/v1/jobs",
                &[("Cookie", cookie.as_str()), ("Host", "evil.example")],
            )
            .await;
        assert_eq!(status, 403, "foreign host via {method}");
        if get {
            assert_eq!(body, serde_json::json!({"detail": "Invalid request host"}));
        } else {
            assert_eq!(body, Value::Null);
        }
        let (status, body) = server
            .send_with_origin(
                method.clone(),
                "/api/v1/jobs",
                &[("Cookie", cookie.as_str())],
                Some("http://evil.example"),
            )
            .await;
        assert_eq!(status, 403, "foreign origin via {method}");
        if get {
            assert_eq!(
                body,
                serde_json::json!({"detail": "Invalid request origin"})
            );
        } else {
            assert_eq!(body, Value::Null);
        }
    }
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (snapshot, before)
    );

    // The same route admits the loopback Host/Origin and returns the row.
    let (status, body) = server
        .send(Method::GET, "/api/v1/jobs", &[("Cookie", cookie.as_str())])
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["jobs"].as_array().unwrap().len(), 1);
    server.stop().await;
    shutdown(owner, directory);
}

#[cfg(feature = "desktop_rebuild")]
async fn enqueue_and_finish_public(
    owner: &Arc<Mutex<WriterOwner>>,
    chosen: pp_storage::auth::AuthPolicy,
    token: &str,
) -> String {
    use pp_storage::{
        auth::Secret,
        jobs::{
            CompletedResult, Credential, JobKind, Outcome, Payload, SourceUpdatesResult,
            UserOperation, WorkerAdmission, WorkerOperation,
        },
    };
    use std::{sync::atomic::AtomicBool, time::Duration};

    let job_id = match owner
        .lock()
        .unwrap()
        .jobs(chosen)
        .unwrap()
        .submit(
            Credential::Session(Secret::new(token.to_owned())),
            UserOperation::Enqueue {
                key: "detail".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            },
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )
        .unwrap()
        .receive()
        .unwrap()
    {
        Outcome::Job(job, _) => job.job_id,
        _ => panic!("enqueued job expected"),
    };
    let worker = owner
        .lock()
        .unwrap()
        .job_worker_with_policy(
            chosen,
            WorkerAdmission {
                kinds: vec![(JobKind::CheckSourceUpdates, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 60,
            },
        )
        .unwrap();
    let mut lease = worker.claim().unwrap().unwrap().lease;
    assert_eq!(lease.job_id(), job_id);
    worker
        .update(&mut lease, WorkerOperation::Progress(40))
        .unwrap();
    worker
        .update(
            &mut lease,
            WorkerOperation::FinishPublic {
                artifact: None,
                result: Box::new(CompletedResult::SourceUpdates(SourceUpdatesResult {
                    checked: vec![],
                    skipped: vec![],
                    updates_available: 0,
                    checked_count: 0,
                })),
            },
        )
        .unwrap();
    job_id
}

/// `/jobs/{id}` and `/api/v1/jobs/{id}` return the same public snapshot; refusals
/// leave rows and files unchanged.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn job_detail_aliases_match() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };

    let (directory, owner) = open();
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
    let cookie_a = register(&bootstrap, "job-detail-a@example.test").await;
    let cookie_b = register(&bootstrap, "job-detail-b@example.test").await;
    let token = cookie_a.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;

    let job_id = enqueue_and_finish_public(&owner, chosen, &token).await;
    let snapshot = files(&directory);
    let before = job_rows(&directory);

    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("1")).unwrap(),
            jobs,
        ),
    )
    .await;
    let headers = [("Cookie", cookie_a.as_str())];
    let (status_v1, body_v1) = server
        .send(Method::GET, &format!("/api/v1/jobs/{job_id}"), &headers)
        .await;
    let (status_root, body_root) = server
        .send(Method::GET, &format!("/jobs/{job_id}"), &headers)
        .await;
    assert_eq!(status_v1, 200);
    assert_eq!((status_root, body_root), (status_v1, body_v1.clone()));
    assert_eq!(body_v1["job_id"], job_id);
    assert_eq!(body_v1["status"], "done");
    assert_eq!(body_v1["kind"], "check-source-updates");
    assert!(body_v1.get("result").is_some());
    assert_eq!(body_v1["error"], Value::Null);

    for path in [
        format!("/api/v1/jobs/{job_id}-missing"),
        format!("/jobs/{job_id}-missing"),
    ] {
        let (status, body) = server.send(Method::GET, &path, &headers).await;
        assert_eq!(status, 404, "{path}");
        assert_eq!(body, serde_json::json!({"detail": "Job not found"}));
    }
    let (status, body) = server
        .send(
            Method::GET,
            &format!("/api/v1/jobs/{job_id}"),
            &[("Cookie", cookie_b.as_str())],
        )
        .await;
    assert_eq!(status, 404);
    assert_eq!(body, serde_json::json!({"detail": "Job not found"}));
    let (status, body) = server
        .send(Method::GET, &format!("/jobs/{job_id}"), &[])
        .await;
    assert_eq!(status, 401);
    assert_eq!(
        body,
        serde_json::json!({"detail": "Authentication required"})
    );
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (snapshot, before)
    );
    // Flag-off 404 for these aliases is covered by feature-off stubs and
    // `jobs_list_flag_off_and_wrong_tenant_are_refused` (empty router).
    server.stop().await;
    shutdown(owner, directory);
}

/// The API-key credential selects the configured tenant exactly as the session
/// cookie does: same status and body at both aliases, while a key minted for
/// another tenant stays refused. Rows are unchanged; only WAL bytes may grow,
/// because every admitted command opens a `BEGIN IMMEDIATE` transaction.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn job_detail_api_key_matches_cookie() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };

    let (directory, owner) = open();
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
    let (cookie_a, tenant_a) = register_account(&bootstrap, "job-detail-key-a@example.test").await;
    let (cookie_b, _tenant_b) = register_account(&bootstrap, "job-detail-key-b@example.test").await;
    let key_a = create_api_key(&bootstrap, &cookie_a).await;
    let key_b = create_api_key(&bootstrap, &cookie_b).await;
    let token = cookie_a.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;

    let job_id = enqueue_and_finish_public(&owner, chosen, &token).await;
    let before = job_rows(&directory);

    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, &tenant_a, Some("1")).unwrap(),
            jobs,
        ),
    )
    .await;
    let bearer_a = format!("Bearer {key_a}");
    let bearer_b = format!("Bearer {key_b}");
    for path in [format!("/api/v1/jobs/{job_id}"), format!("/jobs/{job_id}")] {
        let (status_key, body_key) = server
            .send(Method::GET, &path, &[("Authorization", bearer_a.as_str())])
            .await;
        let (status_cookie, body_cookie) = server
            .send(Method::GET, &path, &[("Cookie", cookie_a.as_str())])
            .await;
        assert_eq!(status_key, 200, "{path}");
        assert_eq!(
            (status_cookie, body_cookie),
            (status_key, body_key.clone()),
            "{path}"
        );
        assert_eq!(body_key["job_id"], job_id, "{path}");
        assert_eq!(body_key["status"], "done", "{path}");
        assert_eq!(body_key["kind"], "check-source-updates", "{path}");
        assert!(body_key.get("result").is_some(), "{path}");

        // A key minted for another tenant cannot read this row through either alias.
        let (status, body) = server
            .send(Method::GET, &path, &[("Authorization", bearer_b.as_str())])
            .await;
        assert_eq!(status, 401, "{path}");
        assert_eq!(
            body,
            serde_json::json!({"detail": "Authentication required"}),
            "{path}"
        );
    }
    assert_eq!(job_rows(&directory), before);
    server.stop().await;
    shutdown(owner, directory);
}

/// Mutation routes and `/ws/jobs/{id}` stay unregistered: `POST` answers 405 on
/// both aliases with an empty body, and a full WS upgrade handshake to
/// `/ws/jobs/{id}` answers 404. No row is created or changed.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn job_detail_mutations_and_ws_unregistered() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };

    let (directory, owner) = open();
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
    let cookie = register(&bootstrap, "job-detail-405@example.test").await;
    let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;

    let job_id = enqueue_and_finish_public(&owner, chosen, &token).await;
    let before = job_rows(&directory);

    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("1")).unwrap(),
            jobs,
        ),
    )
    .await;
    let headers = [("Cookie", cookie.as_str())];

    // The path matches a registered route but the method does not, so the router
    // refuses with 405 rather than falling through to 404.
    for path in [format!("/jobs/{job_id}"), format!("/api/v1/jobs/{job_id}")] {
        let response = server.send_raw(Method::POST, &path, &headers).await;
        assert_eq!(response.status(), 405, "{path}");
        assert_eq!(response.bytes().await.unwrap().len(), 0, "{path}");
    }

    // `/ws/jobs/{id}` is not mounted even with a full WS upgrade handshake.
    let ws = server
        .client
        .get(format!("{}/ws/jobs/{job_id}", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Sec-WebSocket-Version", "13")
        .send()
        .await
        .unwrap();
    assert_eq!(ws.status(), 404);

    // The same id still reads back over GET, so the 405 was method-only.
    let (status, body) = server
        .send(Method::GET, &format!("/jobs/{job_id}"), &headers)
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["job_id"], job_id);
    assert_eq!(job_rows(&directory), before);
    server.stop().await;
    shutdown(owner, directory);
}

/// HEAD shares status and auth with GET and returns an empty body.
#[cfg(feature = "desktop_rebuild")]
#[tokio::test]
async fn job_detail_head_has_no_body_and_keeps_status() {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        jobs::{JobsHttpConfig, jobs_router},
    };

    let (directory, owner) = open();
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
    let cookie = register(&bootstrap, "job-detail-head@example.test").await;
    let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();
    bootstrap.stop().await;

    let job_id = enqueue_and_finish_public(&owner, chosen, &token).await;
    let snapshot = files(&directory);
    let before = job_rows(&directory);

    let bound = bind().await;
    let origin = format!("http://{}", bound.local_addr().unwrap());
    let jobs = owner.lock().unwrap().jobs(chosen).unwrap();
    let mut server = Server::spawn(
        bound,
        jobs_router(
            JobsHttpConfig::from_startup(&origin, "default", Some("true")).unwrap(),
            jobs,
        ),
    )
    .await;
    for path in [format!("/api/v1/jobs/{job_id}"), format!("/jobs/{job_id}")] {
        let get = server
            .client
            .request(Method::GET, format!("{}{path}", server.origin))
            .header("Origin", &server.origin)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        let get_status = get.status();
        let get_body = get.bytes().await.unwrap();
        assert_eq!(get_status, 200, "{path}");
        assert!(!get_body.is_empty(), "{path}");

        let head = server
            .client
            .request(Method::HEAD, format!("{}{path}", server.origin))
            .header("Origin", &server.origin)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), get_status, "{path}");
        assert_eq!(head.bytes().await.unwrap().len(), 0, "{path}");
    }

    let missing = format!("/jobs/{job_id}-missing");
    let get = server
        .client
        .request(Method::GET, format!("{}{missing}", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(get.status(), 404);
    let _ = get.bytes().await.unwrap();
    let head = server
        .client
        .request(Method::HEAD, format!("{}{missing}", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), 404);
    assert_eq!(head.bytes().await.unwrap().len(), 0);
    assert_eq!(
        (files(&directory), job_rows(&directory)),
        (snapshot, before)
    );
    server.stop().await;
    shutdown(owner, directory);
}

#[test]
fn scratch_root_is_empty_after_jobs_http_tests() {
    cleanup::assert_test_run_clean(&["--skip", "scratch_root_is_empty_after_jobs_http_tests"]);
}
