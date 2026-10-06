use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    builds::{BuildHttpConfig, build_router},
    catalog::{CatalogHttpConfig, catalog_router},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{net::SocketAddr, path::PathBuf};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::ClaimDefault,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

struct Server {
    origin: String,
    client: Client,
    owner: WriterOwner,
    task: tokio::task::JoinHandle<()>,
    stop: tokio::sync::oneshot::Sender<()>,
    directory: PathBuf,
}

impl Server {
    async fn start() -> Self {
        Self::start_in(None, None).await
    }

    async fn from_database(database: &[u8], mutation: Option<&str>) -> Self {
        Self::start_in(Some(database), mutation).await
    }

    async fn start_in(database: Option<&[u8]>, mutation: Option<&str>) -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let directory = std::env::temp_dir().join(format!("pp-build-http-{}", hex::encode(random)));
        std::fs::create_dir_all(&directory).unwrap();
        if let Some(database) = database {
            std::fs::write(directory.join("print-partner.db"), database).unwrap();
            std::fs::create_dir_all(directory.join("repos/1/revisions/accepted")).unwrap();
        }
        if let Some(mutation) = mutation {
            let connection =
                rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
            connection
                .pragma_update(None, "foreign_keys", false)
                .unwrap();
            let triggers = connection
                .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            for trigger in triggers {
                connection
                    .execute_batch(&format!("DROP TRIGGER \"{trigger}\""))
                    .unwrap();
            }
            connection.execute_batch(mutation).unwrap();
        }
        let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            owner.auth_with_policy(policy()).unwrap(),
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        )
        .merge(catalog_router(
            CatalogHttpConfig::new(&origin).unwrap(),
            owner.catalog_access(policy()).unwrap(),
            Some(
                owner
                    .catalog_key_access(policy(), "default".into())
                    .unwrap(),
            ),
        ))
        .merge(build_router(
            BuildHttpConfig::new(&origin, "default").unwrap(),
            owner.build_graph_with_policy(policy()).unwrap(),
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
            client: Client::builder().no_proxy().build().unwrap(),
            owner,
            task,
            stop,
            directory,
        }
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

    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: &str,
        status: u16,
    ) -> Value {
        let response = self.request(method, path, body, Some(cookie)).await;
        let actual = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(actual.as_u16(), status, "{path}: {text}");
        serde_json::from_str(&text).unwrap()
    }

    async fn register_as(&self, email: &str) -> String {
        let response = self
            .request(
                Method::POST,
                "/auth/register",
                Some(json!({"email":email,"password":"build-password-123"})),
                None,
            )
            .await;
        assert_eq!(response.status(), 200);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into()
    }

    async fn register(&self) -> String {
        self.register_as("build@example.test").await
    }

    async fn source(&self, cookie: &str, name: &str) -> i64 {
        self.json(
            Method::POST,
            "/sources",
            Some(json!({"name":name,"source_kind":"local"})),
            cookie,
            200,
        )
        .await["id"]
            .as_i64()
            .unwrap()
    }

    async fn close(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

fn assert_summary(value: &Value) {
    let object = value.as_object().unwrap();
    for field in [
        "id",
        "name",
        "order_number",
        "special_request",
        "part_count",
        "accepted_progress",
        "build_stale",
        "freshness",
        "archived_at",
        "last_used_at",
    ] {
        assert!(object.contains_key(field), "missing {field}: {value}");
    }
    assert_eq!(value["accepted_progress"], json!({"kind":"empty"}));
    assert_eq!(
        value["freshness"],
        json!({
            "status":"untracked",
            "accepted_input_set_id":null,
            "accepted_at":null,
            "reasons":[{"kind":"no_accepted_inputs"}]
        })
    );
}

fn accepted_fixture() -> &'static [u8] {
    include_bytes!("../../pp-storage/tests/fixtures/accepted-plan-node.db")
}

async fn read_fixture_summary(mutation: Option<&str>) -> Value {
    let server = Server::from_database(accepted_fixture(), mutation).await;
    let expected = server
        .json(
            Method::GET,
            "/plans/1",
            None,
            "pp_session=read-fixture-secret",
            200,
        )
        .await;
    let alias = server
        .json(
            Method::GET,
            "/api/v2/plans/1",
            None,
            "pp_session=read-fixture-secret",
            200,
        )
        .await;
    assert_eq!(alias, expected);
    assert_eq!(expected.as_object().unwrap().len(), 10);
    server.close().await;
    expected
}

#[tokio::test]
async fn sqlite_progress_and_freshness_conditions_have_exact_http_presentations() {
    let current = read_fixture_summary(None).await;
    assert_eq!(
        current["accepted_progress"],
        json!({"kind":"ready","total_units":1,"remaining_units":1})
    );
    assert_eq!(
        current["freshness"],
        json!({
            "status":"current",
            "accepted_input_set_id":1,
            "accepted_at":"2026-10-02T21:06:51.938Z"
        })
    );
    assert_eq!(current["build_stale"], false);

    let stale = read_fixture_summary(Some(
        "UPDATE build_profiles SET config_modified_at='9999-01-01T00:00:00.000Z' WHERE id=1",
    ))
    .await;
    assert_eq!(stale["build_stale"], true);
    assert_eq!(
        stale["freshness"],
        json!({
            "status":"stale",
            "accepted_input_set_id":1,
            "accepted_at":"2026-10-02T21:06:51.938Z",
            "reasons":[{"kind":"plan_configuration_changed"}],
            "untracked_sources":[]
        })
    );

    for (mutation, reason) in [
        (
            "UPDATE build_profiles SET accepted_plan_revision_id=NULL WHERE id=1",
            "compatibility_dirty",
        ),
        (
            "DELETE FROM plan_revision_required_units; DELETE FROM required_units; DELETE FROM plan_revision_required_unit_sets WHERE revision_id=1",
            "uninitialized",
        ),
        (
            "UPDATE plan_revisions SET snapshot_digest='invalid' WHERE id=1",
            "integrity",
        ),
    ] {
        let summary = read_fixture_summary(Some(mutation)).await;
        assert_eq!(
            summary["accepted_progress"],
            json!({"kind":"unavailable","reason":reason})
        );
    }
}

#[tokio::test]
async fn all_twenty_six_current_aliases_return_exact_build_shapes() {
    let server = Server::start().await;
    let cookie = server.register().await;
    let mut aliases = 0;
    for (index, prefix) in ["", "/api/v2"].into_iter().enumerate() {
        let base = server.source(&cookie, &format!("Base {index}")).await;
        let replacement = server
            .source(&cookie, &format!("Replacement {index}"))
            .await;
        let addon = server.source(&cookie, &format!("Addon {index}")).await;
        let created = server
            .json(
                Method::POST,
                &format!("{prefix}/plans"),
                Some(json!({"name":format!("Build {index}"),"base_project_id":base})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_summary(&created);
        let build = created["id"].as_i64().unwrap();
        for path in [format!("{prefix}/plans"), format!("{prefix}/plans/{build}")] {
            let response = server
                .request(Method::GET, &path, None, Some(&cookie))
                .await;
            assert_eq!(response.status(), 200);
            aliases += 1;
            let response = server
                .request(Method::HEAD, &path, None, Some(&cookie))
                .await;
            assert_eq!(response.status(), 200);
            assert!(response.bytes().await.unwrap().is_empty());
            aliases += 1;
        }
        let read = server
            .json(
                Method::GET,
                &format!("{prefix}/plans/{build}"),
                None,
                &cookie,
                200,
            )
            .await;
        assert_summary(&read);
        let touched = server
            .json(
                Method::POST,
                &format!("{prefix}/plans/{build}/touch"),
                Some(json!({})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_summary(&touched);
        let set = server
            .json(
                Method::PUT,
                &format!("{prefix}/plans/{build}/layers/base"),
                Some(json!({"project_id":replacement})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(set["layers"][0]["id"], created["layers"][0]["id"]);
        let added = server
            .json(
                Method::POST,
                &format!("{prefix}/plans/{build}/layers"),
                Some(json!({"project_id":addon})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        let layer = added["layers"][1]["id"].as_i64().unwrap();
        let layers_path = format!("{prefix}/plans/{build}/layers");
        let listed = server
            .json(Method::GET, &layers_path, None, &cookie, 200)
            .await;
        aliases += 1;
        assert_eq!(listed["layers"][1]["layer_order"], 1);
        let head = server
            .request(Method::HEAD, &layers_path, None, Some(&cookie))
            .await;
        assert_eq!(head.status(), 200);
        assert!(head.bytes().await.unwrap().is_empty());
        aliases += 1;
        server
            .json(
                Method::PUT,
                &format!("{prefix}/plans/{build}/layers/{layer}"),
                Some(json!({"project_id":base})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(
            server
                .request(
                    Method::DELETE,
                    &format!("{prefix}/plans/{build}/layers/{layer}"),
                    None,
                    Some(&cookie),
                )
                .await
                .status(),
            204
        );
        aliases += 1;
        assert_eq!(
            server
                .request(
                    Method::DELETE,
                    &format!("{prefix}/plans/{build}"),
                    None,
                    Some(&cookie),
                )
                .await
                .status(),
            204
        );
        aliases += 1;
    }
    assert_eq!(aliases, 26);
    server.close().await;
}

#[tokio::test]
async fn atomic_create_and_wrong_build_layer_identity_are_enforced() {
    let server = Server::start().await;
    let cookie = server.register().await;
    let key_response = server
        .request(
            Method::POST,
            "/settings/api-keys",
            Some(json!({})),
            Some(&cookie),
        )
        .await;
    assert_eq!(key_response.status(), 201);
    let api_key = key_response.json::<Value>().await.unwrap()["key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        server
            .client
            .get(format!("{}/plans", server.origin))
            .header("Origin", &server.origin)
            .header("x-print-partner-api-key", &api_key)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let missing = server
        .json(
            Method::POST,
            "/plans",
            Some(json!({"name":"No partial Build","base_project_id":9007199254740991_i64})),
            &cookie,
            400,
        )
        .await;
    assert_eq!(missing, json!({"detail":"Project not found"}));
    assert_eq!(
        server.json(Method::GET, "/plans", None, &cookie, 200).await["profiles"],
        json!([])
    );
    let first_source = server.source(&cookie, "First").await;
    let second_source = server.source(&cookie, "Second").await;
    let first = server
        .json(
            Method::POST,
            "/plans",
            Some(json!({"name":"First Build","base_project_id":first_source})),
            &cookie,
            200,
        )
        .await;
    let second = server
        .json(
            Method::POST,
            "/plans",
            Some(json!({"name":"Second Build","base_project_id":second_source})),
            &cookie,
            200,
        )
        .await;
    let first_id = first["id"].as_i64().unwrap();
    let second_layer = second["layers"][0]["id"].as_i64().unwrap();
    for method in [Method::PUT, Method::DELETE] {
        let response = server
            .request(
                method.clone(),
                &format!("/plans/{first_id}/layers/{second_layer}"),
                (method == Method::PUT).then(|| json!({"project_id":first_source})),
                Some(&cookie),
            )
            .await;
        assert_eq!(response.status(), 404);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"detail":"Layer not found"})
        );
    }
    let second_id = second["id"].as_i64().unwrap();
    let unchanged = server
        .json(
            Method::GET,
            &format!("/plans/{second_id}/layers"),
            None,
            &cookie,
            200,
        )
        .await;
    assert_eq!(unchanged["layers"], second["layers"]);
    server.close().await;
}

#[tokio::test]
async fn two_tenants_and_routed_api_key_do_not_disclose_foreign_builds() {
    let server = Server::start().await;
    let cookie_a = server.register_as("tenant-a@example.test").await;
    let cookie_b = server.register_as("tenant-b@example.test").await;
    let source_a = server.source(&cookie_a, "Tenant A Source").await;
    let source_b = server.source(&cookie_b, "Tenant B Source").await;

    let mut builds_a = Vec::new();
    let mut builds_b = Vec::new();
    for index in 0..2 {
        builds_a.push(
            server
                .json(
                    Method::POST,
                    "/plans",
                    Some(json!({"name":format!("Tenant A Build {index}"),"base_project_id":source_a})),
                    &cookie_a,
                    200,
                )
                .await,
        );
        builds_b.push(
            server
                .json(
                    Method::POST,
                    "/plans",
                    Some(json!({"name":format!("Tenant B Build {index}"),"base_project_id":source_b})),
                    &cookie_b,
                    200,
                )
                .await,
        );
    }

    let a_list = server
        .json(Method::GET, "/plans", None, &cookie_a, 200)
        .await;
    let b_list = server
        .json(Method::GET, "/plans", None, &cookie_b, 200)
        .await;
    assert_eq!(a_list["profiles"].as_array().unwrap().len(), 2);
    assert_eq!(b_list["profiles"].as_array().unwrap().len(), 2);
    let a_id = builds_a[0]["id"].as_i64().unwrap();
    let b_id = builds_b[0]["id"].as_i64().unwrap();
    let b_layer = builds_b[0]["layers"][0]["id"].as_i64().unwrap();
    for (cookie, foreign, missing) in [
        (&cookie_a, b_id, 9_007_199_254_740_991_i64),
        (&cookie_b, a_id, 9_007_199_254_740_990_i64),
    ] {
        for id in [foreign, missing] {
            assert_eq!(
                server
                    .json(Method::GET, &format!("/plans/{id}"), None, cookie, 404,)
                    .await,
                json!({"detail":"Profile not found"})
            );
        }
    }
    assert_eq!(
        server
            .json(
                Method::DELETE,
                &format!("/plans/{a_id}/layers/{b_layer}"),
                None,
                &cookie_a,
                404,
            )
            .await,
        json!({"detail":"Layer not found"})
    );

    let key = server
        .json(
            Method::POST,
            "/settings/api-keys",
            Some(json!({"name":"Tenant A route"})),
            &cookie_a,
            201,
        )
        .await["key"]
        .as_str()
        .unwrap()
        .to_owned();
    for (id, status) in [(a_id, 200), (b_id, 404), (9_007_199_254_740_991_i64, 404)] {
        let response = server
            .client
            .get(format!("{}/plans/{id}", server.origin))
            .header("Origin", &server.origin)
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status, "Build {id}");
    }
    assert_eq!(
        server
            .json(Method::GET, "/plans", None, &cookie_a, 200)
            .await,
        a_list
    );
    assert_eq!(
        server
            .json(Method::GET, "/plans", None, &cookie_b, 200)
            .await,
        b_list
    );
    server.close().await;
}

#[tokio::test]
async fn guards_validation_duplicates_and_missing_attachments_are_exact() {
    let server = Server::start().await;
    let cookie = server.register().await;

    let unauthenticated = server.request(Method::GET, "/plans", None, None).await;
    assert_eq!(unauthenticated.status(), 401);
    assert_eq!(
        unauthenticated.json::<Value>().await.unwrap(),
        json!({"detail":"Authentication required"})
    );
    for request in [
        server
            .client
            .get(format!("{}/plans", server.origin))
            .header("Origin", "https://attacker.invalid"),
        server
            .client
            .get(format!("{}/plans", server.origin))
            .header("Origin", &server.origin)
            .header("Host", "attacker.invalid"),
        server
            .client
            .get(format!("{}/plans", server.origin))
            .header("Origin", &server.origin)
            .header("Forwarded", "for=127.0.0.1"),
    ] {
        assert_eq!(
            request
                .header("Cookie", &cookie)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    for path in ["/plans/0", "/plans/-1", "/plans/not-an-id"] {
        let response = server.request(Method::GET, path, None, Some(&cookie)).await;
        assert_eq!(response.status(), 400, "{path}");
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"detail":"Request is invalid"})
        );
    }
    for invalid in [
        json!({}),
        json!({"name":"   "}),
        json!({"name":"Valid","unexpected":true}),
        json!({"name":"Valid","base_project_id":0}),
    ] {
        let response = server
            .request(Method::POST, "/plans", Some(invalid), Some(&cookie))
            .await;
        assert_eq!(response.status(), 400);
    }

    let source = server.source(&cookie, "Duplicate source").await;
    let created = server
        .json(
            Method::POST,
            "/plans",
            Some(json!({"name":"Unique Build","base_project_id":source})),
            &cookie,
            200,
        )
        .await;
    let duplicate_name = server
        .json(
            Method::POST,
            "/plans",
            Some(json!({"name":"Unique Build"})),
            &cookie,
            400,
        )
        .await;
    assert_eq!(
        duplicate_name,
        json!({"detail":"Profile already exists: Unique Build"})
    );
    let build = created["id"].as_i64().unwrap();
    let duplicate_attachment = server
        .json(
            Method::POST,
            &format!("/plans/{build}/layers"),
            Some(json!({"project_id":source})),
            &cookie,
            409,
        )
        .await;
    assert_eq!(
        duplicate_attachment,
        json!({"detail":"Source \"Duplicate source\" is already attached to this build"})
    );
    let missing_source = server
        .json(
            Method::POST,
            &format!("/plans/{build}/layers"),
            Some(json!({"project_id":9007199254740991_i64})),
            &cookie,
            404,
        )
        .await;
    assert_eq!(missing_source, json!({"detail":"Project not found"}));
    let layers = server
        .json(
            Method::GET,
            &format!("/plans/{build}/layers"),
            None,
            &cookie,
            200,
        )
        .await;
    assert_eq!(layers["layers"], created["layers"]);
    server.close().await;
}
