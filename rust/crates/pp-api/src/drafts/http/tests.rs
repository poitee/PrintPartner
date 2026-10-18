use super::{DraftHttpConfig, draft_router};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
};
use reqwest::{Client, Method, RequestBuilder};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const DIGEST: &str = "ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3";
const COOKIE: &str = "pp_session=required-unit-fixture-secret";

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}

struct Server {
    origin: String,
    client: Client,
    owner: WriterOwner,
    task: tokio::task::JoinHandle<()>,
    directory: PathBuf,
}
impl Server {
    async fn start(body_limit: usize, tenant: &str, setup: &str) -> Self {
        Self::start_with_gate(body_limit, tenant, setup, Some("true")).await
    }

    async fn start_with_gate(
        body_limit: usize,
        tenant: &str,
        setup: &str,
        flag: Option<&str>,
    ) -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        let directory =
            std::env::temp_dir().join(format!("pp-drafts-http-{}", hex::encode(random)));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("print-partner.db"),
            include_bytes!("../../../../pp-storage/tests/fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        Connection::open(directory.join("print-partner.db"))
            .unwrap()
            .execute_batch(setup)
            .unwrap();
        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let config = DraftHttpConfig::from_startup(&origin, tenant, flag)
            .unwrap()
            .with_limits(body_limit, Duration::from_millis(100))
            .unwrap();
        let auth = owner
            .rebuild_auth_with_policy(policy(), Default::default())
            .unwrap();
        let router = draft_router(
            config,
            owner.working_drafts_with_policy(policy()).unwrap(),
            auth,
        );
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            origin,
            owner,
            task,
            directory,
            client: Client::builder().no_proxy().build().unwrap(),
        }
    }
    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin)
            .header("Cookie", COOKIE)
    }
    fn sql(&self) -> Connection {
        Connection::open(self.directory.join("print-partner.db")).unwrap()
    }
    fn included(&self, part_id: i64) -> i64 {
        self.sql()
            .query_row(
                "SELECT included FROM plan_draft_parts WHERE id=?1",
                [part_id],
                |row| row.get(0),
            )
            .unwrap()
    }
    async fn close(self) {
        self.task.abort();
        let _ = self.task.await;
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.directory).unwrap();
    }
    async fn raw(&self, request: &str) -> String {
        let address = self.origin.strip_prefix("http://").unwrap();
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8(response).unwrap()
    }
    async fn auth(&self, request: auth::Request) -> auth::Outcome {
        let auth = self
            .owner
            .rebuild_auth_with_policy(policy(), Default::default())
            .unwrap();
        tokio::task::spawn_blocking(move || {
            auth.submit(
                request,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
        })
        .await
        .unwrap()
    }
}
async fn response(request: RequestBuilder, status: u16) -> Value {
    let response = request.send().await.unwrap();
    assert_eq!(response.status().as_u16(), status);
    assert_eq!(response.headers()["content-type"], "application/json");
    response.json().await.unwrap()
}
fn edit(digest: &str) -> Value {
    json!({"expected_snapshot_digest":digest,"decisions":[
        {"kind":"set_included","draft_part_ids":[5],"value":true},
        {"kind":"set_quantity_override","draft_part_ids":[4],"value":null}
    ]})
}
fn identity() -> Value {
    json!({"draft_id":2,"state":"open","lifecycle_version":0,"snapshot_digest":DIGEST,"base":{"revision_id":1,"plan_version":1}})
}

#[tokio::test]
async fn listing_and_workspace_have_literal_wire_contracts() {
    let s = Server::start(1024 * 1024, "default", "").await;
    let expected = json!({"profile_id":1,"drafts":[
        {"draft_id":1,"state":"consumed","lifecycle_version":1,
         "snapshot_digest":"3912383330ef528d51a15c351d69eaffd856d7e8dc582ddfc66bf0bf5053b2b0",
         "base":{"revision_id":null,"plan_version":0}},
        {"draft_id":2,"state":"open","lifecycle_version":0,"snapshot_digest":DIGEST,
         "base":{"revision_id":1,"plan_version":1}}
    ]});
    for prefix in ["", "/api/v2"] {
        assert_eq!(
            response(
                s.request(Method::GET, &format!("{prefix}/plans/1/drafts")),
                200
            )
            .await,
            expected
        );
        let workspace = response(
            s.request(Method::GET, &format!("{prefix}/plans/1/drafts/2")),
            200,
        )
        .await;
        assert_eq!(
            workspace,
            json!({
                "profile_id":1,"draft":identity(),"parts":[
                    {"draft_part_id":4,"base_revision_part_id":1,"part_key":"bracket.stl","filename":"bracket.stl","relative_path":"bracket.stl","source_layer":"base:Fixture Source","role":"primary","quantity_inferred":1,"quantity_override":3,"quantity_effective":3,"included":true},
                    {"draft_part_id":5,"base_revision_part_id":2,"part_key":"excluded.stl","filename":"excluded.stl","relative_path":"excluded.stl","source_layer":"base:Fixture Source","role":"primary","quantity_inferred":1,"quantity_override":1,"quantity_effective":1,"included":false},
                    {"draft_part_id":6,"base_revision_part_id":3,"part_key":"gear.stl","filename":"gear.stl","relative_path":"gear.stl","source_layer":"base:Fixture Source","role":"primary","quantity_inferred":1,"quantity_override":2,"quantity_effective":2,"included":true}
                ],"diff":{"base_is_current":true,"added":[],"removed":[],"changed":[{
                    "before":{"revision_part_id":2,"filename":"excluded.stl","relative_path":"excluded.stl","source_layer":"base:Fixture Source"},
                    "after":{"draft_part_id":5,"base_revision_part_id":2,"part_key":"excluded.stl","filename":"excluded.stl","relative_path":"excluded.stl","source_layer":"base:Fixture Source","role":"primary","quantity_inferred":1,"quantity_override":1,"quantity_effective":1,"included":false},"fields":["status"]
                }]},"reconciliation":{"kind":"unresolved","conflicts":[]}
            })
        );
    }
    for path in [
        "/plans/1/drafts/recompute",
        "/plans/1/drafts/2/abandon",
        "/api/v2/plans/1/drafts/2/abandon",
        "/plans/1/drafts/2/rebase",
        "/plans/1/drafts/2/reconciliation",
        "/plans/1/drafts/2/apply",
        "/plans/1/save",
        "/plans/1/review",
        "/api/v1/plans/1/review",
    ] {
        let result = s
            .request(Method::POST, path)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert!(matches!(result.status().as_u16(), 404 | 405), "{path}");
    }
    s.close().await;
}

#[tokio::test]
async fn edits_persist_and_preserve_conflict_workspaces() {
    let s = Server::start(1024 * 1024, "default", "").await;
    let before = response(s.request(Method::GET, "/plans/1/drafts/2"), 200).await;
    let mut expected =
        json!({"detail":"Plan draft update failed","code":"draft_changed","workspace":before});
    assert_eq!(
        response(
            s.request(Method::PATCH, "/plans/1/drafts/2/parts")
                .json(&edit(&"0".repeat(64))),
            409
        )
        .await,
        expected
    );
    let changed = response(
        s.request(Method::PATCH, "/api/v2/plans/1/drafts/2/parts")
            .json(&edit(DIGEST)),
        200,
    )
    .await;
    assert_eq!(
        changed["draft"],
        json!({"draft_id":2,"state":"open","lifecycle_version":0,"snapshot_digest":"9a9bc08be4b343d523a2915b4f9c4288edfc35103d24886bf731859a9128f035","base":{"revision_id":1,"plan_version":1}})
    );
    assert_eq!(changed["parts"][0]["quantity_override"], Value::Null);
    assert_eq!(changed["parts"][0]["quantity_effective"], 1);
    assert_eq!(changed["parts"][1]["included"], true);
    assert_eq!(
        changed["reconciliation"],
        json!({"kind":"ready","reused_units":4,"new_units":0,"surplus_units":2})
    );
    assert_eq!(s.included(5), 1);
    assert_eq!(
        s.sql()
            .query_row(
                "SELECT quantity_override,quantity_effective FROM plan_draft_parts WHERE id=4",
                [],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, i64>(1)?))
            )
            .unwrap(),
        (None, 1)
    );
    assert_eq!(
        response(s.request(Method::GET, "/plans/1/drafts/2"), 200).await,
        changed
    );
    s.sql()
        .execute_batch("UPDATE plan_drafts SET state='abandoned', lifecycle_version=1 WHERE id=2")
        .unwrap();
    let current = response(s.request(Method::GET, "/plans/1/drafts/2"), 200).await;
    expected["workspace"] = current;
    expected["code"] = json!("not_open");
    assert_eq!(
        response(
            s.request(Method::PATCH, "/plans/1/drafts/2/parts")
                .json(&edit(DIGEST)),
            409
        )
        .await,
        expected
    );
    s.close().await;
}

#[tokio::test]
async fn missing_resources_and_cross_tenant_reads_are_hidden() {
    let s = Server::start(1024 * 1024, "default", "").await;
    for profile in [2, 999] {
        for (method, suffix, body) in [
            (Method::GET, "", json!({})),
            (Method::GET, "/2", json!({})),
            (Method::PATCH, "/2/parts", edit(DIGEST)),
        ] {
            assert_eq!(
                response(
                    s.request(method, &format!("/plans/{profile}/drafts{suffix}"))
                        .json(&body),
                    404
                )
                .await,
                json!({"detail":"Plan not found","code":"profile_not_found"})
            );
        }
    }
    for (method, suffix, body) in [
        (Method::GET, "", json!({})),
        (Method::PATCH, "/parts", edit(DIGEST)),
    ] {
        assert_eq!(
            response(
                s.request(method, &format!("/plans/1/drafts/999{suffix}"))
                    .json(&body),
                404
            )
            .await,
            json!({"detail":"Plan draft not found","code":"draft_not_found"})
        );
    }
    for value in [
        "0",
        "-1",
        "9007199254740992",
        "18446744073709551616",
        "text",
    ] {
        for path in [
            format!("/plans/{value}/drafts"),
            format!("/plans/1/drafts/{value}"),
        ] {
            assert_eq!(
                response(s.request(Method::GET, &path), 400).await,
                json!({"detail":"Request is invalid","code":"invalid_request"})
            );
        }
    }
    s.close().await;
}

#[tokio::test]
async fn api_keys_use_fixed_tenant_routing_and_revocation() {
    let s = Server::start(1024 * 1024, "default", "").await;
    let auth::Outcome::KeyCreated { info, key } = s
        .auth(auth::Request::CreateKey {
            session: Secret::new("required-unit-fixture-secret".into()),
        })
        .await
    else {
        panic!("API key creation");
    };
    assert_eq!(info.last_used_at, None);
    let last_used = || {
        s.sql().query_row(
        "SELECT json_extract(value,'$[0].lastUsedAt') FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'",
        [], |row| row.get::<_, Option<String>>(0),
    ).unwrap()
    };
    let request = |method: Method, path: &str, secret: &str| {
        s.client
            .request(method, format!("{}{path}", s.origin))
            .header("Authorization", format!("Bearer {secret}"))
    };
    for (request, pointer) in [
        (
            request(Method::GET, "/plans/1/drafts", key.expose()),
            "/drafts/1",
        ),
        (
            s.client
                .get(format!("{}/api/v2/plans/1/drafts/2", s.origin))
                .header("x-print-partner-api-key", key.expose()),
            "/draft",
        ),
    ] {
        assert_eq!(last_used(), None);
        let body = response(request, 200).await;
        assert_eq!(body.pointer(pointer), Some(&identity()));
        assert!(last_used().is_some());
        s.sql().execute("UPDATE app_settings SET value=json_set(value,'$[0].lastUsedAt',NULL) WHERE tenant_id='default' AND key='api_keys_v1'", []).unwrap();
    }
    assert_eq!(
        response(
            request(Method::GET, "/plans/2/drafts", key.expose()).header("x-tenant-id", "foreign"),
            404
        )
        .await,
        json!({"detail":"Plan not found","code":"profile_not_found"})
    );
    assert_eq!(
        response(
            request(Method::PATCH, "/plans/1/drafts/2/parts", key.expose()).json(&edit(DIGEST)),
            200
        )
        .await["parts"][1]["included"],
        true
    );
    for origin in ["http://evil.test", "null"] {
        assert_eq!(
            response(
                request(Method::PATCH, "/plans/1/drafts/2/parts", key.expose())
                    .header("Origin", origin)
                    .json(&edit(DIGEST)),
                403
            )
            .await,
            json!({"detail":"Invalid request origin"})
        );
    }
    assert_eq!(
        response(
            request(Method::PATCH, "/plans/1/drafts/2/parts", key.expose())
                .header("Cookie", COOKIE)
                .json(&edit(DIGEST)),
            403
        )
        .await,
        json!({"detail":"Invalid request origin"})
    );
    let auth::Outcome::KeyChanged { changed: true, .. } = s
        .auth(auth::Request::RevokeKey {
            session: Secret::new("required-unit-fixture-secret".into()),
            key_id: info.id,
        })
        .await
    else {
        panic!("API key revocation");
    };
    for secret in [key.expose(), "invalid"] {
        for (method, path) in [
            (Method::GET, "/plans/1/drafts"),
            (Method::PATCH, "/plans/1/drafts/2/parts"),
        ] {
            assert_eq!(
                response(request(method, path, secret).json(&edit(DIGEST)), 401).await,
                json!({"detail":"Authentication required"})
            );
        }
    }
    s.close().await;
    let foreign = Server::start(1024 * 1024, "foreign", "").await;
    let auth::Outcome::KeyCreated { key, .. } = foreign
        .auth(auth::Request::CreateKey {
            session: Secret::new("required-unit-fixture-secret".into()),
        })
        .await
    else {
        panic!("API key creation");
    };
    assert_eq!(
        response(
            foreign
                .client
                .get(format!("{}/plans/1/drafts", foreign.origin))
                .header("Authorization", format!("Bearer {}", key.expose())),
            401
        )
        .await,
        json!({"detail":"Authentication required"})
    );
    foreign.close().await;
}

#[tokio::test]
async fn admission_rejects_ambiguous_credentials_hosts_and_origins() {
    let s = Server::start(1024 * 1024, "default", "").await;
    for header in [
        "forwarded",
        "x-forwarded-host",
        "x-forwarded-for",
        "x-forwarded-proto",
    ] {
        assert_eq!(
            response(
                s.request(Method::GET, "/plans/1/drafts")
                    .header(header, "ignored"),
                403
            )
            .await,
            json!({"detail":"Invalid request host"})
        );
    }
    assert_eq!(
        response(
            s.request(Method::GET, "/plans/1/drafts")
                .header("Host", "evil.test"),
            403
        )
        .await,
        json!({"detail":"Invalid request host"})
    );
    for request in [
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("Origin", "https://evil.test"),
        s.request(Method::GET, "/plans/1/drafts")
            .header("sec-fetch-site", "cross-site"),
        s.client
            .patch(format!("{}/plans/1/drafts/2/parts", s.origin))
            .header("Cookie", COOKIE)
            .json(&edit(DIGEST)),
    ] {
        assert_eq!(
            response(request, 403).await,
            json!({"detail":"Invalid request origin"})
        );
    }
    for request in [
        s.client
            .patch(format!("{}/plans/1/drafts/2/parts", s.origin))
            .header("Authorization", "Bearer invalid")
            .json(&edit(DIGEST)),
        s.client.get(format!("{}/plans/1/drafts", s.origin)),
        s.request(Method::GET, "/plans/1/drafts")
            .header("Authorization", "Bearer key"),
        s.request(Method::GET, "/plans/1/drafts")
            .header("Cookie", COOKIE),
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("Authorization", "Bearer one")
            .header("Authorization", "Bearer two"),
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("Authorization", "Bearer one")
            .header("x-print-partner-api-key", "two"),
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("x-print-partner-api-key", "one")
            .header("x-print-partner-api-key", "two"),
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("Cookie", "pp_session=one; pp_session=two"),
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("Cookie", "pp_session="),
        s.client
            .get(format!("{}/plans/1/drafts", s.origin))
            .header("Cookie", "pp_session=invalid"),
    ] {
        assert_eq!(
            response(request, 401).await,
            json!({"detail":"Authentication required"})
        );
    }
    let host = s.origin.strip_prefix("http://").unwrap();
    let raw=s.raw(&format!("GET /plans/1/drafts HTTP/1.1\r\nHost: {host}\r\nHost: {host}\r\nCookie: {COOKIE}\r\nConnection: close\r\n\r\n")).await;
    assert!(
        raw.starts_with("HTTP/1.1 400") || raw.starts_with("HTTP/1.1 403"),
        "{raw}"
    );
    let raw=s.raw(&format!("GET /plans/1/drafts HTTP/1.1\r\nHost: {host}\r\nOrigin: {}\r\nOrigin: {}\r\nCookie: {COOKIE}\r\nConnection: close\r\n\r\n",s.origin,s.origin)).await;
    assert!(raw.starts_with("HTTP/1.1 403"), "{raw}");
    assert!(raw.contains("Invalid request origin"), "{raw}");
    s.close().await;
}

#[tokio::test]
async fn bounds_and_typed_bodies_reject_before_mutation() {
    let s = Server::start(256, "default", "").await;
    for body in [
        "{",
        "null",
        "[]",
        "{}",
        "{\"expected_snapshot_digest\":-1}",
        "{\"expected_snapshot_digest\":null,\"extra\":true}",
    ] {
        assert_eq!(
            response(
                s.request(Method::PATCH, "/plans/1/drafts/2/parts")
                    .body(body.to_owned()),
                400
            )
            .await,
            json!({"detail":"Request is invalid","code":"invalid_request"})
        );
    }
    for body in [
        json!({"expected_snapshot_digest":DIGEST,"decisions":[]}),
        json!({"expected_snapshot_digest":DIGEST,"decision":{"kind":"set_included","draft_part_ids":[0],"value":true}}),
        json!({"expected_snapshot_digest":DIGEST,"decision":{"kind":"set_quantity_override","draft_part_ids":[4],"value":10001}}),
    ] {
        assert_eq!(
            response(
                s.request(Method::PATCH, "/plans/1/drafts/2/parts")
                    .json(&body),
                400
            )
            .await,
            json!({"detail":"Request is invalid","code":"invalid_request"})
        );
    }
    for method in [Method::GET, Method::PATCH] {
        let path = if method == Method::GET {
            "/plans/1/drafts"
        } else {
            "/plans/1/drafts/2/parts"
        };
        assert_eq!(
            response(s.request(method, path).body("x".repeat(257)), 413).await,
            json!({"detail":"Request body too large"})
        );
    }
    let body = "x".repeat(257);
    let host = s.origin.strip_prefix("http://").unwrap();
    let raw=s.raw(&format!("PATCH /plans/1/drafts/2/parts HTTP/1.1\r\nHost: {host}\r\nOrigin: {}\r\nCookie: {COOKIE}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n101\r\n{body}\r\n0\r\n\r\n",s.origin)).await;
    assert!(raw.starts_with("HTTP/1.1 413"), "{raw}");
    assert_eq!(
        response(
            s.request(
                Method::GET,
                &format!("/plans/1/drafts?q={}", "x".repeat(16384))
            ),
            414
        )
        .await,
        json!({"detail":"Request target too long"})
    );
    assert_eq!(
        s.sql()
            .query_row(
                "SELECT state,lifecycle_version FROM plan_drafts WHERE id=2",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
        ("open".into(), 0)
    );
    assert_eq!(s.included(5), 0);
    s.close().await;
    let s = Server::start(8 * 1024 * 1024, "default", "").await;
    let mut bulk = edit(DIGEST).to_string();
    bulk.extend(std::iter::repeat_n(' ', 3 * 1024 * 1024));
    let edited = response(
        s.request(Method::PATCH, "/plans/1/drafts/2/parts")
            .body(bulk.clone()),
        200,
    )
    .await;
    assert_eq!(edited["parts"][1]["included"], true);
    assert_eq!(s.included(5), 1);
    response(s.request(Method::GET, "/plans/1/drafts").body(bulk), 413).await;
    response(
        s.request(Method::PATCH, "/plans/1/drafts/2/parts")
            .body(" ".repeat(8 * 1024 * 1024 + 1)),
        413,
    )
    .await;
    s.close().await;
}

#[tokio::test]
async fn failed_selection_keeps_committed_edit_and_sanitizes_errors() {
    let s=Server::start(1024*1024,"default","CREATE TRIGGER injected_failure BEFORE INSERT ON plan_draft_required_unit_reconciliations BEGIN SELECT RAISE(ABORT,'private fixture detail'); END").await;
    assert_eq!(
        response(
            s.request(Method::PATCH, "/plans/1/drafts/2/parts")
                .json(&edit(DIGEST)),
            500
        )
        .await,
        json!({"detail":"Plan draft update failed","code":"internal_error"})
    );
    assert_eq!(s.included(5), 1);
    assert_eq!(
        response(s.request(Method::GET, "/plans/1/drafts/2"), 200).await["parts"][1]["included"],
        true
    );
    s.sql()
        .execute(
            "UPDATE plan_drafts SET snapshot_digest='private fixture detail' WHERE id=2",
            [],
        )
        .unwrap();
    for path in ["/plans/1/drafts", "/api/v2/plans/1/drafts/2"] {
        assert_eq!(
            response(s.request(Method::GET, path), 500).await,
            json!({"detail":"Plan draft data is inconsistent","code":"internal_error"})
        );
    }
    s.close().await;
}

#[tokio::test]
async fn runtime_gate_is_exact_and_isolated() {
    for value in [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("TRUE"),
        Some(" true "),
        Some("yes"),
        Some("1"),
        Some("true"),
    ] {
        let s = Server::start_with_gate(1024 * 1024, "default", "", value).await;
        let enabled = matches!(value, Some("1" | "true"));
        for prefix in ["", "/api/v2"] {
            for (method, suffix) in [
                (Method::GET, ""),
                (Method::GET, "/2"),
                (Method::PATCH, "/2/parts"),
            ] {
                let status = if !enabled {
                    404
                } else if method == Method::GET {
                    200
                } else {
                    400
                };
                let result = s
                    .request(method, &format!("{prefix}/plans/1/drafts{suffix}"))
                    .json(&json!({}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(result.status().as_u16(), status);
            }
        }
        if !enabled {
            assert_eq!(
                s.client
                    .get(format!("{}/plans/1/drafts", s.origin))
                    .header("Host", "wrong.test")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        assert_eq!(
            s.sql()
                .query_row("SELECT state FROM plan_drafts WHERE id=2", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "open"
        );
        s.close().await;
    }
}

#[tokio::test]
async fn active_requests_are_bounded_and_recover_after_timeout_or_disconnect() {
    let s = Server::start(1024 * 1024, "default", "").await;
    let host = s.origin.strip_prefix("http://").unwrap();
    let wait_for_status = |status| {
        let server = &s;
        async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let result = server
                        .request(Method::GET, "/plans/1/drafts")
                        .send()
                        .await
                        .unwrap();
                    if result.status() == status {
                        break result.json::<Value>().await.unwrap();
                    }
                    assert_eq!(
                        result.status().as_u16(),
                        if status == 503 { 200 } else { 503 }
                    );
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap()
        }
    };
    for disconnect in [false, true] {
        let mut sockets = Vec::new();
        for _ in 0..64 {
            let mut socket = tokio::net::TcpStream::connect(host).await.unwrap();
            socket.write_all(format!("GET /plans/1/drafts HTTP/1.1\r\nHost: {host}\r\nCookie: pp_session=not-a-real-session\r\nContent-Length: 1\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            sockets.push(socket);
        }
        let busy = wait_for_status(503).await;
        assert_eq!(
            busy,
            json!({"detail":"Draft service temporarily unavailable"})
        );
        if disconnect {
            sockets.clear();
        } else {
            tokio::time::timeout(Duration::from_secs(8), async {
                for socket in &mut sockets {
                    let mut bytes = Vec::new();
                    socket.read_to_end(&mut bytes).await.unwrap();
                    let reply = String::from_utf8(bytes).unwrap();
                    assert!(reply.starts_with("HTTP/1.1 408"), "{reply}");
                    assert_eq!(
                        serde_json::from_str::<Value>(reply.split_once("\r\n\r\n").unwrap().1)
                            .unwrap(),
                        json!({"detail":"Request body timed out"})
                    );
                }
            })
            .await
            .unwrap();
        }
        let recovered = wait_for_status(200).await;
        assert_eq!(recovered["drafts"][1], identity());
    }
    s.close().await;
}
