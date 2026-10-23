use pp_storage::{Limits, WriterOwner};
use reqwest::{Client, Method};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn open() -> (Arc<Mutex<WriterOwner>>, PathBuf) {
    let directory = std::env::temp_dir().join(format!("pp-jobs-http-{}", {
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

/// Without `desktop_rebuild`, jobs HTTP is not linked into pp-api.
#[cfg(not(feature = "desktop_rebuild"))]
async fn feature_off_404() {
    let (owner, directory) = open();
    let snapshot = files(&directory);
    let before = job_rows(&directory);
    let mut server = Server::spawn(bind().await, axum::Router::new()).await;
    let (status, body) = server.send(Method::GET, "/api/v1/jobs", &[]).await;
    assert_eq!(status, 404);
    assert!(body.get("jobs").is_none());
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
        .json(&serde_json::json!({"email": email, "password": "password-1234"}))
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

    let (owner, directory) = open();
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
