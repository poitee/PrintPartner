use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    catalog::{CatalogHttpConfig, catalog_router},
    drafts::{DraftHttpClients, DraftHttpConfig, draft_router},
};
use pp_core::{
    draft_observations::{DraftReadConfiguration, FilesystemPolicy, issue_working_drafts},
    review_observations::{FilamentProviderConfig, ObservationLimits, SnapshotReviewObserver},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    working_drafts::observation::PreparationLimits,
};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
    }
}

fn directory() -> PathBuf {
    let mut bytes = [0; 12];
    getrandom::fill(&mut bytes).unwrap();
    std::env::temp_dir().join(format!("pp-drafts-http-{}", hex::encode(bytes)))
}

fn draft_configuration(repos: PathBuf) -> DraftReadConfiguration {
    DraftReadConfiguration {
        relative_base: repos.clone(),
        shipped_hints: [
            repos.join("missing-shipped-hints-1.yaml"),
            repos.join("missing-shipped-hints-2.yaml"),
        ],
        repos,
        limits: PreparationLimits::default(),
        policy: FilesystemPolicy::Isolated,
        custom_hints: None,
        community_manifests: BTreeMap::new(),
    }
}

struct Server {
    origin: String,
    client: Client,
    owner: Option<WriterOwner>,
    task: tokio::task::JoinHandle<()>,
    stop: tokio::sync::oneshot::Sender<()>,
    directory: PathBuf,
}

impl Server {
    async fn start() -> Self {
        Self::start_with_fixture(None, None, None).await
    }

    async fn seeded() -> Self {
        Self::start_with_fixture(
            Some(include_bytes!(
                "../../pp-storage/tests/fixtures/required-units/unchanged.db"
            )),
            None,
            None,
        )
        .await
    }

    async fn seeded_with_limits(limits: ObservationLimits) -> Self {
        Self::start_with_fixture(
            Some(include_bytes!(
                "../../pp-storage/tests/fixtures/required-units/unchanged.db"
            )),
            Some(limits),
            None,
        )
        .await
    }

    async fn seeded_with_provider(provider: FilamentProviderConfig) -> Self {
        Self::start_with_fixture(
            Some(include_bytes!(
                "../../pp-storage/tests/fixtures/required-units/unchanged.db"
            )),
            None,
            Some(provider),
        )
        .await
    }

    async fn first_publication_fixture() -> Self {
        Self::start_with_fixture(
            Some(include_bytes!(
                "../../pp-storage/tests/fixtures/plan-publication/first.db"
            )),
            None,
            None,
        )
        .await
    }

    async fn start_with_fixture(
        fixture: Option<&'static [u8]>,
        limits: Option<ObservationLimits>,
        provider: Option<FilamentProviderConfig>,
    ) -> Self {
        let directory = directory();
        std::fs::create_dir_all(&directory).unwrap();
        if let Some(fixture) = fixture {
            std::fs::write(directory.join("print-partner.db"), fixture).unwrap();
            if provider.is_some() {
                let sql = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
                sql.execute(
                    "UPDATE parts SET filament_color_id=?1,spoolman_spool_id=?2 WHERE relative_path='bracket.stl'",
                    [
                        "spoolman:fixture:filament:7",
                        "spoolman:fixture:spool:11",
                    ],
                )
                .unwrap();
            }
            let revision = directory.join("repos/1/revisions/fixture");
            std::fs::create_dir_all(&revision).unwrap();
            std::fs::write(revision.join("bracket.stl"), b"solid bracket").unwrap();
            std::fs::write(revision.join("excluded.stl"), b"solid excluded").unwrap();
            std::fs::write(revision.join("gear.stl"), b"solid gear").unwrap();
        }
        Self::start_in(directory, limits, provider).await
    }

    async fn start_in(
        directory: PathBuf,
        limits: Option<ObservationLimits>,
        provider: Option<FilamentProviderConfig>,
    ) -> Self {
        let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
        let repos = directory.join("repos");
        std::fs::create_dir_all(&repos).unwrap();
        let policy = policy();
        let drafts =
            issue_working_drafts(&owner, policy, draft_configuration(repos.clone())).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mut observer =
            SnapshotReviewObserver::new(repos.clone(), Some(directory.join("thumbs"))).unwrap();
        if let Some(limits) = limits {
            observer = observer.with_observation_limits(limits).unwrap();
        }
        if let Some(provider) = provider {
            observer = observer.with_filament_provider(provider);
        }
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            owner.auth_with_policy(policy).unwrap(),
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        )
        .merge(catalog_router(
            CatalogHttpConfig::new(&origin).unwrap(),
            owner.catalog_access(policy).unwrap(),
            Some(owner.catalog_key_access(policy, "default".into()).unwrap()),
        ))
        .merge(draft_router(
            DraftHttpConfig::new(&origin, "default").unwrap(),
            DraftHttpClients {
                saves: drafts.plan_save(),
                publication: owner.publication_with_policy(policy).unwrap(),
                accepted: owner.accepted_reads_with_policy(policy).unwrap(),
                drafts,
            },
            Arc::new(observer),
        ));
        let (stop, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
            .unwrap();
        });
        Self {
            origin,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            owner: Some(owner),
            task,
            stop,
            directory,
        }
    }

    async fn restart(mut self) -> Self {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.take().unwrap().shutdown().unwrap();
        Self::start_in(self.directory, None, None).await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: Option<&str>,
    ) -> Response {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request.send().await.unwrap()
    }

    async fn keyed(
        &self,
        method: Method,
        path: &str,
        key: &str,
        body: Value,
        cookie: &str,
    ) -> Response {
        self.client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin)
            .header("Cookie", cookie)
            .header("Idempotency-Key", key)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn review(&self) -> Value {
        self.request(
            Method::GET,
            "/plans/1/review?include_excluded=true",
            None,
            Some(fixture_cookie()),
        )
        .await
        .json()
        .await
        .unwrap()
    }

    async fn register(&self) -> String {
        let response = self
            .request(
                Method::POST,
                "/auth/register",
                Some(json!({"email":"drafts@example.test","password":"draft-password-123"})),
                None,
            )
            .await;
        assert_eq!(response.status(), 200);
        self.request(
            Method::POST,
            "/auth/login",
            Some(json!({"email":"drafts@example.test","password":"draft-password-123"})),
            None,
        )
        .await
        .headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into()
    }

    fn stop_writer(&mut self) {
        self.owner.take().unwrap().shutdown().unwrap();
    }

    async fn close(mut self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        if let Some(owner) = self.owner.take() {
            owner.shutdown().unwrap();
        }
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

fn fixture_cookie() -> &'static str {
    "pp_session=required-unit-fixture-secret"
}

fn publication_fixture_cookie() -> &'static str {
    "pp_session=publication-fixture-secret"
}

fn apply_request() -> Value {
    json!({
        "expected_snapshot_digest":"ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3",
        "expected_lifecycle_version":0,
        "expected_base":{"revision_id":1,"plan_version":1},
        "remap_checkoff_links":false,
    })
}

fn save_request() -> Value {
    json!({
        "expected_base":{"revision_id":1,"plan_version":1},
        "expected_draft":{
            "draft_id":2,
            "state":"open",
            "lifecycle_version":0,
            "snapshot_digest":"ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3",
            "base":{"revision_id":1,"plan_version":1}
        },
        "remap_checkoff_links":false,
        "decisions":[{
            "kind":"set_quantity_override",
            "target":{
                "part_key":"bracket.stl",
                "relative_path":"bracket.stl",
                "source_layer":"base:Fixture Source"
            },
            "value":4
        }]
    })
}

#[tokio::test]
async fn aliases_authentication_and_head_use_one_owner() {
    let server = Server::start().await;
    let cookie = server.register().await;
    let mut count = 0;
    for prefix in ["", "/api/v2"] {
        for path in [
            format!("{prefix}/plans/1/drafts"),
            format!("{prefix}/plans/1/drafts/1"),
        ] {
            for method in [Method::GET, Method::HEAD] {
                let response = server
                    .request(method.clone(), &path, None, Some(&cookie))
                    .await;
                assert_eq!(response.status(), 404, "{method} {path}");
                if method == Method::HEAD {
                    assert!(response.bytes().await.unwrap().is_empty());
                }
                count += 1;
            }
        }
        for (method, path) in [
            (Method::POST, format!("{prefix}/plans/1/drafts/recompute")),
            (Method::PATCH, format!("{prefix}/plans/1/drafts/1/parts")),
            (Method::POST, format!("{prefix}/plans/1/drafts/1/abandon")),
            (Method::POST, format!("{prefix}/plans/1/drafts/1/rebase")),
            (
                Method::PUT,
                format!("{prefix}/plans/1/drafts/1/reconciliation"),
            ),
            (Method::POST, format!("{prefix}/plans/1/drafts/1/apply")),
            (Method::POST, format!("{prefix}/plans/1/save")),
        ] {
            let response = server
                .request(method, &path, Some(json!({})), Some(&cookie))
                .await;
            assert_eq!(response.status(), 400, "{path}");
            count += 1;
        }
    }
    for prefix in ["", "/api/v2", "/api/v1"] {
        for method in [Method::GET, Method::HEAD] {
            let path = format!("{prefix}/plans/1/review");
            let response = server
                .request(method.clone(), &path, None, Some(&cookie))
                .await;
            assert_eq!(response.status(), 404, "{method} {path}");
            count += 1;
        }
    }
    assert_eq!(count, 28);
    assert_eq!(
        server
            .request(Method::GET, "/plans/1/drafts", None, None)
            .await
            .status(),
        401
    );
    let response = server
        .client
        .get(format!("{}/plans/1/drafts", server.origin))
        .header("Host", server.origin.trim_start_matches("http://"))
        .header("Origin", &server.origin)
        .header("X-Forwarded-For", "127.0.0.1")
        .header("Cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    server.close().await;
}

#[tokio::test]
async fn read_and_review_aliases_return_success_bodies_and_head_statuses() {
    let server = Server::seeded().await;
    for prefix in ["", "/api/v2"] {
        for path in [
            format!("{prefix}/plans/1/drafts"),
            format!("{prefix}/plans/1/drafts/2"),
        ] {
            let get = server
                .request(Method::GET, &path, None, Some(fixture_cookie()))
                .await;
            assert_eq!(get.status(), 200, "GET {path}");
            assert!(get.json::<Value>().await.unwrap().is_object());
            let head = server
                .request(Method::HEAD, &path, None, Some(fixture_cookie()))
                .await;
            assert_eq!(head.status(), 200, "HEAD {path}");
            assert!(head.bytes().await.unwrap().is_empty());
        }
    }
    for prefix in ["", "/api/v2", "/api/v1"] {
        let path = format!("{prefix}/plans/1/review?include_excluded=true");
        let get = server
            .request(Method::GET, &path, None, Some(fixture_cookie()))
            .await;
        assert_eq!(get.status(), 200, "GET {path}");
        let review: Value = get.json().await.unwrap();
        assert_eq!(review["kind"], "ready");
        assert_eq!(review["body"]["accepted_basis"]["plan_version"], 1);
        let head = server
            .request(Method::HEAD, &path, None, Some(fixture_cookie()))
            .await;
        assert_eq!(head.status(), 200, "HEAD {path}");
        assert!(head.bytes().await.unwrap().is_empty());
    }
    server.close().await;
}

#[tokio::test]
async fn write_aliases_return_public_success_bodies() {
    let server = Server::seeded().await;
    let reconciled = server
        .keyed(
            Method::PUT,
            "/api/v2/plans/1/drafts/2/reconciliation",
            "reconcile-v2-success",
            json!({
                "expected_snapshot_digest":apply_request()["expected_snapshot_digest"],
                "decisions":[]
            }),
            fixture_cookie(),
        )
        .await;
    let reconciled_status = reconciled.status();
    let reconciled: Value = reconciled.json().await.unwrap();
    assert_eq!(reconciled_status, 200, "{reconciled}");

    let edited = server
        .request(
            Method::PATCH,
            "/api/v2/plans/1/drafts/2/parts",
            Some(json!({
                "expected_snapshot_digest":reconciled["draft"]["snapshot_digest"],
                "decision":{"kind":"set_included","draft_part_ids":[5],"value":true}
            })),
            Some(fixture_cookie()),
        )
        .await;
    let edited_status = edited.status();
    let edited: Value = edited.json().await.unwrap();
    assert_eq!(edited_status, 200, "{edited}");
    assert_eq!(edited["parts"][1]["included"], true);

    let abandoned = server
        .request(
            Method::POST,
            "/plans/1/drafts/2/abandon",
            Some(json!({
                "expected_lifecycle_version":edited["draft"]["lifecycle_version"]
            })),
            Some(fixture_cookie()),
        )
        .await;
    let abandoned_status = abandoned.status();
    let abandoned: Value = abandoned.json().await.unwrap();
    assert_eq!(abandoned_status, 200, "{abandoned}");
    assert_eq!(abandoned["state"], "abandoned");
    server.close().await;

    let server = Server::seeded().await;
    let applied = server
        .keyed(
            Method::POST,
            "/api/v2/plans/1/drafts/2/apply",
            "apply-v2-auto-reconciled",
            apply_request(),
            fixture_cookie(),
        )
        .await;
    let applied_status = applied.status();
    let applied: Value = applied.json().await.unwrap();
    assert_eq!(applied_status, 200, "{applied}");
    assert_eq!(applied["profile_id"], 1);
    assert_eq!(applied["draft_id"], 2);
    server.close().await;
}

#[tokio::test]
async fn changed_draft_refusals_return_conflict_with_current_workspace() {
    let server = Server::seeded().await;
    let stale_edit = server
        .request(
            Method::PATCH,
            "/plans/1/drafts/2/parts",
            Some(json!({
                "expected_snapshot_digest":"b".repeat(64),
                "decision":{"kind":"set_included","draft_part_ids":[5],"value":true}
            })),
            Some(fixture_cookie()),
        )
        .await;
    let stale_edit_status = stale_edit.status();
    let stale_edit: Value = stale_edit.json().await.unwrap();
    assert_eq!(stale_edit_status, 409, "{stale_edit}");
    assert_eq!(stale_edit["code"], "draft_changed");
    assert_eq!(stale_edit["workspace"]["draft"]["draft_id"], 2);

    let stale_transition = server
        .request(
            Method::POST,
            "/plans/1/drafts/2/abandon",
            Some(json!({"expected_lifecycle_version":1})),
            Some(fixture_cookie()),
        )
        .await;
    let stale_transition_status = stale_transition.status();
    let stale_transition: Value = stale_transition.json().await.unwrap();
    assert_eq!(stale_transition_status, 409, "{stale_transition}");
    assert_eq!(stale_transition["code"], "draft_changed");
    assert_eq!(stale_transition["workspace"]["draft"]["draft_id"], 2);

    let stale_rebase = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/rebase",
            "rebase-stale-source",
            json!({
                "expected_source_state":"open",
                "expected_source_lifecycle_version":0,
                "expected_source_snapshot_digest":"b".repeat(64)
            }),
            fixture_cookie(),
        )
        .await;
    let stale_rebase_status = stale_rebase.status();
    let stale_rebase: Value = stale_rebase.json().await.unwrap();
    assert_eq!(stale_rebase_status, 409, "{stale_rebase}");
    assert_eq!(stale_rebase["code"], "draft_changed");
    assert_eq!(stale_rebase["workspace"]["draft"]["draft_id"], 2);
    server.close().await;
}

#[tokio::test]
async fn save_apply_and_reconciliation_refusals_keep_operation_statuses() {
    let server = Server::seeded().await;
    let mut wrong_base = save_request();
    wrong_base["expected_base"]["revision_id"] = json!(2);
    wrong_base["expected_base"]["plan_version"] = json!(2);
    wrong_base["expected_draft"]["base"] = wrong_base["expected_base"].clone();
    let response = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-wrong-base",
            wrong_base,
            fixture_cookie(),
        )
        .await;
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "base_changed");

    let mut wrong_draft = save_request();
    wrong_draft["expected_draft"]["snapshot_digest"] = json!("b".repeat(64));
    let response = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-wrong-draft",
            wrong_draft,
            fixture_cookie(),
        )
        .await;
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "draft_changed");

    let mut missing_part = save_request();
    missing_part["decisions"][0]["target"]["part_key"] = json!("missing.stl");
    missing_part["decisions"][0]["target"]["relative_path"] = json!("missing.stl");
    let response = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-missing-part",
            missing_part,
            fixture_cookie(),
        )
        .await;
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["code"], "part_not_found");

    let response = server
        .keyed(
            Method::PUT,
            "/plans/1/drafts/2/reconciliation",
            "reconcile-stale",
            json!({"expected_snapshot_digest":"b".repeat(64),"decisions":[]}),
            fixture_cookie(),
        )
        .await;
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "draft_changed");
    assert_eq!(body["workspace"]["draft"]["draft_id"], 2);

    let mut stale_apply = apply_request();
    stale_apply["expected_snapshot_digest"] = json!("b".repeat(64));
    let response = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-stale",
            stale_apply,
            fixture_cookie(),
        )
        .await;
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "draft_changed");

    let response = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/999/apply",
            "apply-missing",
            apply_request(),
            fixture_cookie(),
        )
        .await;
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["code"], "draft_not_found");
    server.close().await;
}

#[tokio::test]
async fn admission_and_request_boundaries_keep_authority_at_http() {
    let server = Server::seeded().await;
    assert_eq!(
        server
            .request(Method::GET, "/plans/2/drafts", None, Some(fixture_cookie()))
            .await
            .status(),
        404
    );
    assert_eq!(
        server
            .request(Method::GET, "/plans/0/drafts", None, Some(fixture_cookie()))
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .request(
                Method::GET,
                "/plans/1/drafts/not-an-id",
                None,
                Some(fixture_cookie())
            )
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/plans/1/drafts/recompute",
                Some(json!({"apply_manifest":false,"tenant":"foreign"})),
                Some(fixture_cookie())
            )
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .keyed(
                Method::POST,
                "/plans/1/drafts/recompute",
                &"k".repeat(161),
                json!({"apply_manifest":false}),
                fixture_cookie(),
            )
            .await
            .status(),
        400
    );
    let wrong_origin = server
        .client
        .post(format!("{}/plans/1/drafts/recompute", server.origin))
        .header("Origin", "http://127.0.0.1:1")
        .header("Cookie", fixture_cookie())
        .header("Idempotency-Key", "wrong-origin")
        .json(&json!({"apply_manifest":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_origin.status(), 403);
    let missing_origin = server
        .client
        .post(format!("{}/plans/1/drafts/recompute", server.origin))
        .header("Cookie", fixture_cookie())
        .header("Idempotency-Key", "missing-origin")
        .json(&json!({"apply_manifest":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_origin.status(), 403);
    let wrong_host = server
        .client
        .get(format!("{}/plans/1/drafts", server.origin))
        .header("Host", "localhost.invalid")
        .header("Cookie", fixture_cookie())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_host.status(), 403);
    let oversized = server
        .client
        .post(format!("{}/plans/1/drafts/recompute", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", fixture_cookie())
        .header("Idempotency-Key", "oversized-body")
        .header("Content-Type", "application/json")
        .body(format!("{{\"payload\":\"{}\"}}", "x".repeat(1024 * 1024)))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), 413);
    server.close().await;
}

#[tokio::test]
async fn empty_review_and_stopped_owner_keep_distinct_public_outcomes() {
    let server = Server::first_publication_fixture().await;
    let review = server
        .request(
            Method::GET,
            "/plans/1/review",
            None,
            Some(publication_fixture_cookie()),
        )
        .await;
    let review_status = review.status();
    let review: Value = review.json().await.unwrap();
    assert_eq!(review_status, 200, "{review}");
    assert_eq!(review["kind"], "empty");
    server.close().await;

    let mut server = Server::seeded().await;
    server.stop_writer();
    let stopped = server
        .request(Method::GET, "/plans/1/drafts", None, Some(fixture_cookie()))
        .await;
    let stopped_status = stopped.status();
    let stopped: Value = stopped.json().await.unwrap();
    assert_eq!(stopped_status, 503, "{stopped}");
    assert_eq!(stopped["code"], "writer_stopped");
    server.close().await;
}

#[tokio::test]
async fn authenticated_draft_apply_and_replay_return_public_contracts() {
    let server = Server::seeded().await;
    let cookie = fixture_cookie();

    let listed = server
        .request(Method::GET, "/plans/1/drafts", None, Some(cookie))
        .await;
    assert_eq!(listed.status(), 200);
    let listed: Value = listed.json().await.unwrap();
    assert_eq!(listed["profile_id"], 1);
    assert_eq!(listed["drafts"][1]["draft_id"], 2);
    assert!(listed["drafts"][1].get("snapshotDigest").is_none());

    let workspace = server
        .request(Method::GET, "/plans/1/drafts/2", None, Some(cookie))
        .await;
    assert_eq!(workspace.status(), 200);
    let workspace: Value = workspace.json().await.unwrap();
    assert_eq!(workspace["draft"]["draft_id"], 2);
    assert!(workspace.get("kind").is_none());

    let prepared = server
        .keyed(
            Method::PUT,
            "/plans/1/drafts/2/reconciliation",
            "reconcile-before-apply",
            json!({
                "expected_snapshot_digest":apply_request()["expected_snapshot_digest"],
                "decisions":[]
            }),
            cookie,
        )
        .await;
    let prepared_status = prepared.status();
    let prepared: Value = prepared.json().await.unwrap();
    assert_eq!(prepared_status, 200, "{prepared}");
    let admitted = json!({
        "expected_snapshot_digest":prepared["draft"]["snapshot_digest"],
        "expected_lifecycle_version":prepared["draft"]["lifecycle_version"],
        "expected_base":prepared["draft"]["base"],
        "remap_checkoff_links":false,
    });

    let first = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-1",
            admitted.clone(),
            cookie,
        )
        .await;
    let first_status = first.status();
    let first: Value = first.json().await.unwrap();
    assert_eq!(first_status, 200, "{first}");
    assert_eq!(first["profile_id"], 1);
    assert_eq!(first["draft_id"], 2);
    assert_eq!(first["plan_version"], 2);
    assert!(first.get("kind").is_none());

    let replay_response = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-1",
            admitted.clone(),
            cookie,
        )
        .await;
    let replay_status = replay_response.status();
    let replay: Value = replay_response.json().await.unwrap();
    assert_eq!(replay_status, 200, "{replay}");
    assert_eq!(replay, first);

    let mut legacy_remap = admitted.clone();
    legacy_remap["remap_checkoff_links"] = json!(true);
    let legacy_remap_response = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-1",
            legacy_remap,
            cookie,
        )
        .await;
    let legacy_remap_status = legacy_remap_response.status();
    let legacy_remap: Value = legacy_remap_response.json().await.unwrap();
    assert_eq!(legacy_remap_status, 200, "{legacy_remap}");
    assert_eq!(legacy_remap, first);

    let mut conflict = admitted;
    conflict["expected_snapshot_digest"] = json!("b".repeat(64));
    let conflict = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-1",
            conflict,
            cookie,
        )
        .await;
    assert_eq!(conflict.status(), 409);
    assert_eq!(
        conflict.json::<Value>().await.unwrap()["code"],
        "idempotency_conflict"
    );

    for path in [
        "/plans/1/review?include_excluded=true",
        "/api/v2/plans/1/review?include_excluded=true",
        "/api/v1/plans/1/review?include_excluded=true",
    ] {
        let review = server.request(Method::GET, path, None, Some(cookie)).await;
        assert_eq!(review.status(), 200, "{path}");
        let review: Value = review.json().await.unwrap();
        assert_eq!(review["kind"], "ready");
        assert_eq!(review["body"]["accepted_basis"]["plan_version"], 2);
    }
    server.close().await;
}

#[tokio::test]
async fn normalized_apply_replays_the_original_admitted_request() {
    let server = Server::seeded().await;
    let admitted = apply_request();
    let first = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-normalized",
            admitted.clone(),
            fixture_cookie(),
        )
        .await;
    let first_status = first.status();
    let first: Value = first.json().await.unwrap();
    assert_eq!(first_status, 200, "{first}");
    let server = server.restart().await;
    let database = rusqlite::Connection::open(server.directory.join("print-partner.db")).unwrap();
    let (parent_digest, child_digest, execution_snapshot): (String, String, String) = database
        .query_row(
            "SELECT request.request_digest,admission.request_digest,request.expected_snapshot_digest FROM plan_apply_requests request JOIN plan_apply_admissions admission ON admission.apply_request_id=request.id WHERE request.idempotency_key='apply-http-normalized'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_ne!(parent_digest, child_digest);
    assert_eq!(
        database
            .query_row(
                "SELECT COUNT(*) FROM plan_apply_requests WHERE idempotency_key='apply-http-normalized'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM plan_apply_admissions", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        1
    );
    drop(database);

    let replay = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-normalized",
            admitted,
            fixture_cookie(),
        )
        .await;
    let replay_status = replay.status();
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay_status, 200, "{replay}");
    assert_eq!(replay, first);

    let mut remap = apply_request();
    remap["remap_checkoff_links"] = json!(true);
    let remap = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-normalized",
            remap,
            fixture_cookie(),
        )
        .await;
    let remap_status = remap.status();
    let remap: Value = remap.json().await.unwrap();
    assert_eq!(remap_status, 200, "{remap}");
    assert_eq!(remap, first);

    let mut execution = apply_request();
    execution["expected_snapshot_digest"] = json!(execution_snapshot);
    let conflict = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/apply",
            "apply-http-normalized",
            execution,
            fixture_cookie(),
        )
        .await;
    assert_eq!(conflict.status(), 409);

    let mut changed_snapshot = apply_request();
    changed_snapshot["expected_snapshot_digest"] = json!("d".repeat(64));
    let mut changed_lifecycle = apply_request();
    changed_lifecycle["expected_lifecycle_version"] = json!(1);
    let mut changed_base = apply_request();
    changed_base["expected_base"] = json!({"revision_id":null,"plan_version":0});
    for changed in [changed_snapshot, changed_lifecycle, changed_base] {
        let conflict = server
            .keyed(
                Method::POST,
                "/plans/1/drafts/2/apply",
                "apply-http-normalized",
                changed,
                fixture_cookie(),
            )
            .await;
        assert_eq!(conflict.status(), 409);
    }
    server.close().await;
}

#[tokio::test]
async fn recompute_returns_a_real_workspace_through_both_aliases() {
    for prefix in ["", "/api/v2"] {
        let server = Server::seeded().await;
        let response = server
            .keyed(
                Method::POST,
                &format!("{prefix}/plans/1/drafts/recompute"),
                &format!("recompute-http{}", prefix.replace('/', "-")),
                json!({"apply_manifest":false}),
                fixture_cookie(),
            )
            .await;
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert_eq!(status, 200, "{prefix}: {body}");
        assert_eq!(body["draft"]["draft_id"], 3);
        assert_eq!(body["draft"]["state"], "open");
        assert_eq!(body["reconciliation"]["kind"], "ready");
        server.close().await;
    }
}

#[tokio::test]
async fn edit_reconcile_and_abandon_return_public_bodies() {
    let server = Server::seeded().await;
    let cookie = fixture_cookie();
    let reconciled = server
        .keyed(
            Method::PUT,
            "/plans/1/drafts/2/reconciliation",
            "reconcile-http-1",
            json!({
                "expected_snapshot_digest":"ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3",
                "decisions":[]
            }),
            cookie,
        )
        .await;
    assert_eq!(reconciled.status(), 200);
    let reconciled: Value = reconciled.json().await.unwrap();
    assert_eq!(reconciled["reconciliation"]["kind"], "ready");
    assert!(reconciled.get("kind").is_none());

    let edited = server
        .request(
            Method::PATCH,
            "/plans/1/drafts/2/parts",
            Some(json!({
                "expected_snapshot_digest":reconciled["draft"]["snapshot_digest"],
                "decision":{"kind":"set_included","draft_part_ids":[5],"value":true}
            })),
            Some(cookie),
        )
        .await;
    assert_eq!(edited.status(), 200);
    let edited: Value = edited.json().await.unwrap();
    assert_eq!(edited["parts"][1]["included"], true);
    assert_eq!(edited["reconciliation"]["kind"], "ready");

    let abandoned = server
        .request(
            Method::POST,
            "/api/v2/plans/1/drafts/2/abandon",
            Some(json!({
                "expected_lifecycle_version":edited["draft"]["lifecycle_version"]
            })),
            Some(cookie),
        )
        .await;
    assert_eq!(abandoned.status(), 200);
    let abandoned: Value = abandoned.json().await.unwrap();
    assert_eq!(abandoned["state"], "abandoned");
    assert!(abandoned.get("id").is_none());

    let rebased = server
        .keyed(
            Method::POST,
            "/plans/1/drafts/2/rebase",
            "rebase-http-1",
            json!({
                "expected_source_state":"abandoned",
                "expected_source_lifecycle_version":abandoned["lifecycle_version"],
                "expected_source_snapshot_digest":abandoned["snapshot_digest"]
            }),
            cookie,
        )
        .await;
    assert_eq!(rebased.status(), 409);
    let rebased: Value = rebased.json().await.unwrap();
    assert_eq!(rebased["code"], "base_unchanged");

    let mut advance = save_request();
    advance["expected_draft"] = Value::Null;
    advance["decisions"][0]["value"] = json!(5);
    let advanced = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-before-rebase",
            advance,
            cookie,
        )
        .await;
    let advanced_status = advanced.status();
    let advanced: Value = advanced.json().await.unwrap();
    assert_eq!(advanced_status, 200, "{advanced}");
    assert_eq!(advanced["receipt"]["plan_version"], 2);

    let rebased = server
        .keyed(
            Method::POST,
            "/api/v2/plans/1/drafts/2/rebase",
            "rebase-http-2",
            json!({
                "expected_source_state":"abandoned",
                "expected_source_lifecycle_version":abandoned["lifecycle_version"],
                "expected_source_snapshot_digest":abandoned["snapshot_digest"]
            }),
            cookie,
        )
        .await;
    let rebased_status = rebased.status();
    let rebased: Value = rebased.json().await.unwrap();
    assert_eq!(rebased_status, 200, "{rebased}");
    assert_eq!(rebased["draft"]["state"], "open");
    assert_eq!(rebased["draft"]["base"]["plan_version"], 2);
    let rebased_id = rebased["draft"]["draft_id"].as_u64().unwrap();
    assert!(rebased_id > 2, "{rebased}");
    let persisted = server
        .request(
            Method::GET,
            &format!("/plans/1/drafts/{rebased_id}"),
            None,
            Some(cookie),
        )
        .await;
    let persisted_status = persisted.status();
    let persisted: Value = persisted.json().await.unwrap();
    assert_eq!(persisted_status, 200, "{persisted}");
    assert_eq!(persisted, rebased);

    server.close().await;
}

#[tokio::test]
async fn authenticated_save_replay_and_review_share_the_committed_snapshot() {
    let server = Server::seeded().await;
    let cookie = fixture_cookie();
    let first = server
        .keyed(
            Method::POST,
            "/api/v2/plans/1/save",
            "save-http-1",
            save_request(),
            cookie,
        )
        .await;
    let status = first.status();
    let first: Value = first.json().await.unwrap();
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["receipt"]["plan_version"], 2);
    assert_eq!(first["review"]["kind"], "ready");
    assert_eq!(first["review"]["body"]["accepted_basis"]["plan_version"], 2);
    assert_eq!(first["profile"]["accepted_progress"]["kind"], "ready");
    assert_eq!(first["closed_draft_ids"], json!([2]));

    let replay: Value = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-http-1",
            save_request(),
            cookie,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(replay["receipt"], first["receipt"]);
    assert_eq!(replay["review"], first["review"]);
    assert_eq!(replay["profile"], first["profile"]);
    assert_eq!(replay["closed_draft_ids"], first["closed_draft_ids"]);

    let mut later_request = save_request();
    later_request["expected_base"] =
        json!({"revision_id":first["receipt"]["revision_id"],"plan_version":2});
    later_request["expected_draft"] = Value::Null;
    later_request["decisions"][0]["value"] = json!(5);
    let later = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-http-2",
            later_request,
            cookie,
        )
        .await;
    let later_status = later.status();
    let later: Value = later.json().await.unwrap();
    assert_eq!(later_status, 200, "{later}");
    assert_eq!(later["receipt"]["plan_version"], 3);

    let historical = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-http-1",
            save_request(),
            cookie,
        )
        .await;
    let historical_status = historical.status();
    let historical: Value = historical.json().await.unwrap();
    assert_eq!(historical_status, 200, "{historical}");
    assert_eq!(historical["receipt"], first["receipt"]);
    assert_eq!(historical["review"], later["review"]);
    assert_eq!(historical["profile"], later["profile"]);
    assert_eq!(historical["closed_draft_ids"], first["closed_draft_ids"]);

    let review: Value = server
        .request(
            Method::GET,
            "/plans/1/review?include_excluded=true",
            None,
            Some(cookie),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(review, later["review"]);

    let mut conflict = save_request();
    conflict["decisions"][0]["value"] = json!(5);
    let conflict = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-http-1",
            conflict,
            cookie,
        )
        .await;
    assert_eq!(conflict.status(), 409);
    let conflict: Value = conflict.json().await.unwrap();
    assert_eq!(conflict["code"], "idempotency_conflict");
    assert_eq!(
        conflict["detail"],
        "Plan choices could not be saved. Your pending choices have been kept."
    );
    server.close().await;
}

#[tokio::test]
async fn save_response_keeps_its_capture_when_a_later_save_commits_during_enrichment() {
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let filament_calls = calls.clone();
    let filament_entered = entered.clone();
    let filament_release = release.clone();
    let provider = axum::Router::new()
        .route(
            "/api/v1/filament",
            axum::routing::get(move || {
                let calls = filament_calls.clone();
                let entered = filament_entered.clone();
                let release = filament_release.clone();
                async move {
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        entered.notify_one();
                        release.notified().await;
                    }
                    axum::Json(json!([{
                        "id":7,
                        "name":"Signal Red",
                        "material":"PLA",
                        "vendor":{"name":"Fixture Maker"},
                        "color_hex":"ff1122"
                    }]))
                }
            }),
        )
        .route(
            "/api/v1/spool",
            axum::routing::get(move || async move {
                axum::Json(json!([{
                    "id":11,"filament_id":7,"remaining_weight":321.5,"archived":false
                }]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_origin = format!("http://{}", listener.local_addr().unwrap());
    let provider_task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let server = Server::seeded_with_provider(
        FilamentProviderConfig::new(&provider_origin, "fixture", None).unwrap(),
    )
    .await;
    let client = server.client.clone();
    let origin = server.origin.clone();
    let first = tokio::spawn(async move {
        client
            .post(format!("{origin}/plans/1/save"))
            .header("Origin", &origin)
            .header("Cookie", fixture_cookie())
            .header("Idempotency-Key", "save-captured-before-enrichment")
            .json(&save_request())
            .send()
            .await
            .unwrap()
    });
    entered.notified().await;

    let mut later_request = save_request();
    later_request["expected_base"] = json!({"revision_id":2,"plan_version":2});
    later_request["expected_draft"] = Value::Null;
    later_request["decisions"][0]["value"] = json!(5);
    let later = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-during-enrichment",
            later_request,
            fixture_cookie(),
        )
        .await;
    let later_status = later.status();
    let later: Value = later.json().await.unwrap();
    assert_eq!(later_status, 200, "{later}");
    release.notify_one();

    let first = first.await.unwrap();
    let first_status = first.status();
    let first: Value = first.json().await.unwrap();
    assert_eq!(first_status, 200, "{first}");
    assert_eq!(first["receipt"]["plan_version"], 2);
    assert_eq!(first["review"]["body"]["accepted_basis"]["plan_version"], 2);
    assert_eq!(
        first["review"]["body"]["part_groups"][0]["parts"][0]["quantity_effective"],
        4
    );
    assert_eq!(first["profile"]["accepted_progress"]["total_units"], 6);
    assert_eq!(later["receipt"]["plan_version"], 3);
    assert_eq!(
        later["review"]["body"]["part_groups"][0]["parts"][0]["quantity_effective"],
        5
    );
    assert_eq!(later["profile"]["accepted_progress"]["total_units"], 7);
    let current = server.review().await;
    assert_eq!(current, later["review"]);

    server.close().await;
    provider_task.abort();
}

#[tokio::test]
async fn committed_save_observation_failure_returns_replayable_uncertainty() {
    let server = Server::seeded_with_limits(ObservationLimits {
        entries: 1,
        ..Default::default()
    })
    .await;
    let first = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-observation-uncertain",
            save_request(),
            fixture_cookie(),
        )
        .await;
    let first_status = first.status();
    let first: Value = first.json().await.unwrap();
    assert_eq!(first_status, 500, "{first}");
    assert_eq!(first["code"], "save_response_uncertain");
    assert_eq!(first["stage"], "review_observation");
    assert_eq!(first["idempotency_key"], "save-observation-uncertain");
    assert_eq!(first["receipt"]["plan_version"], 2);
    assert_eq!(first["closed_draft_ids"], json!([2]));

    let replay = server
        .keyed(
            Method::POST,
            "/plans/1/save",
            "save-observation-uncertain",
            save_request(),
            fixture_cookie(),
        )
        .await;
    let replay_status = replay.status();
    let replay: Value = replay.json().await.unwrap();
    assert_eq!(replay_status, 500, "{replay}");
    assert_eq!(replay["receipt"], first["receipt"]);
    assert_eq!(replay["idempotency_key"], first["idempotency_key"]);
    server.close().await;
}

#[tokio::test]
async fn review_uses_bounded_local_filament_snapshot_and_falls_back_on_size_limit() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let provider = axum::Router::new()
        .route(
            "/api/v1/filament",
            axum::routing::get(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!([{
                        "id":7,
                        "name":"Signal Red",
                        "material":"PLA",
                        "vendor":{"name":"Fixture Maker"},
                        "color_hex":"ff1122"
                    }]))
                }
            }),
        )
        .route(
            "/api/v1/spool",
            axum::routing::get(move || async move {
                axum::Json(json!([{
                    "id":11,"filament_id":7,"remaining_weight":321.5,"archived":false
                }]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let provider_task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });

    let config = FilamentProviderConfig::new(&origin, "fixture", None).unwrap();
    let server = Server::seeded_with_provider(config).await;
    let response = server
        .request(
            Method::GET,
            "/plans/1/review?include_excluded=true",
            None,
            Some(fixture_cookie()),
        )
        .await;
    assert_eq!(response.status(), 200);
    let response: Value = response.json().await.unwrap();
    let bracket = &response["body"]["part_groups"][0]["parts"][0];
    assert_eq!(
        bracket["filament_display"],
        "Fixture Maker PLA · Signal Red"
    );
    assert_eq!(bracket["filament_hex"], "#ff1122");
    assert_eq!(bracket["spool_summary"][0]["spool_id"], 11);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.close().await;

    let limited = FilamentProviderConfig::new(&origin, "fixture", None)
        .unwrap()
        .with_limits(std::time::Duration::from_secs(1), 8, 0)
        .unwrap();
    let server = Server::seeded_with_provider(limited).await;
    let response = server
        .request(Method::GET, "/plans/1/review", None, Some(fixture_cookie()))
        .await;
    assert_eq!(response.status(), 200);
    let response: Value = response.json().await.unwrap();
    assert_eq!(
        response["body"]["part_groups"][0]["parts"][0]["filament_display"],
        ""
    );
    server.close().await;
    provider_task.abort();
}

#[tokio::test]
async fn review_provider_timeout_and_redirect_limit_fail_open() {
    let slow = axum::Router::new()
        .route(
            "/api/v1/filament",
            axum::routing::get(move || async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                axum::Json(json!([]))
            }),
        )
        .route(
            "/api/v1/spool",
            axum::routing::get(move || async move { axum::Json(json!([])) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, slow).await.unwrap();
    });
    let config = FilamentProviderConfig::new(&origin, "fixture", None)
        .unwrap()
        .with_limits(std::time::Duration::from_millis(10), 1024, 0)
        .unwrap();
    let server = Server::seeded_with_provider(config).await;
    let review = server.review().await;
    assert_eq!(
        review["body"]["part_groups"][0]["parts"][0]["filament_display"],
        ""
    );
    server.close().await;
    task.abort();

    let redirected = axum::Router::new()
        .route(
            "/api/v1/filament",
            axum::routing::get(move || async move {
                (
                    axum::http::StatusCode::FOUND,
                    [(axum::http::header::LOCATION, "/api/v1/filament-again")],
                )
            }),
        )
        .route(
            "/api/v1/filament-again",
            axum::routing::get(move || async move { axum::Json(json!([])) }),
        )
        .route(
            "/api/v1/spool",
            axum::routing::get(move || async move { axum::Json(json!([])) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, redirected).await.unwrap();
    });
    let config = FilamentProviderConfig::new(&origin, "fixture", None)
        .unwrap()
        .with_limits(std::time::Duration::from_secs(1), 1024, 0)
        .unwrap();
    let server = Server::seeded_with_provider(config).await;
    let review = server.review().await;
    assert_eq!(
        review["body"]["part_groups"][0]["parts"][0]["filament_display"],
        ""
    );
    server.close().await;
    task.abort();
}

#[tokio::test]
async fn review_checks_artifact_digest_case_ambiguity_and_missing_files() {
    let server = Server::seeded().await;
    let artifact = server
        .directory
        .join("repos/1/revisions/fixture/bracket.stl");
    let current = server.review().await;
    assert_eq!(current["body"]["layers"][0]["synced"], true);
    assert_eq!(
        current["body"]["part_groups"][0]["parts"][0]["stl_missing"],
        false
    );

    std::fs::write(&artifact, b"changed bytes").unwrap();
    let changed = server.review().await;
    assert_eq!(
        changed["body"]["part_groups"][0]["parts"][0]["stl_missing"],
        true
    );

    std::fs::write(&artifact, b"solid bracket").unwrap();
    let duplicate = artifact.with_file_name("BRACKET.STL");
    std::fs::write(&duplicate, b"solid bracket").unwrap();
    let ambiguous = server.review().await;
    assert_eq!(
        ambiguous["body"]["part_groups"][0]["parts"][0]["stl_missing"],
        true
    );

    std::fs::remove_file(&duplicate).unwrap();
    std::fs::remove_file(&artifact).unwrap();
    let missing = server.review().await;
    assert_eq!(
        missing["body"]["part_groups"][0]["parts"][0]["stl_missing"],
        true
    );
    server.close().await;
}
