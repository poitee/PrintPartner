use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    builds::{BuildHttpConfig, build_router},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::net::SocketAddr;

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
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    directory: std::path::PathBuf,
}

impl Server {
    async fn start() -> Self {
        let mut random = [0; 16];
        getrandom::fill(&mut random).unwrap();
        let directory =
            std::env::temp_dir().join(format!("pp-manifest-http-{}", hex::encode(random)));
        std::fs::create_dir_all(&directory).unwrap();
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
            stop,
            task,
            directory,
        }
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: &str,
    ) -> reqwest::Response {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin)
            .header("Cookie", cookie);
        if let Some(body) = body {
            request = request.json(&body);
        }
        request.send().await.unwrap()
    }

    async fn close(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

#[tokio::test]
async fn all_fifteen_manifest_aliases_share_guarded_typed_owner_presentation() {
    let server = Server::start().await;
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email":"manifest-http@example.test","password":"manifest-password-123"}))
        .send()
        .await
        .unwrap();
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let created = server
        .request(
            Method::POST,
            "/plans",
            Some(json!({"name":"Manifest HTTP"})),
            &cookie,
        )
        .await;
    assert_eq!(created.status(), 200);
    let id = created.json::<Value>().await.unwrap()["id"]
        .as_i64()
        .unwrap();
    let unauthenticated = server
        .client
        .get(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);
    assert_eq!(
        unauthenticated.json::<Value>().await.unwrap(),
        json!({"detail":"Authentication required"})
    );
    let foreign = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({"email":"manifest-foreign@example.test","password":"manifest-password-456"}))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 200);
    let foreign_cookie = foreign.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let hidden = server
        .request(
            Method::GET,
            &format!("/plans/{id}/kit-manifest"),
            None,
            foreign_cookie,
        )
        .await;
    assert_eq!(hidden.status(), 404);
    assert_eq!(
        hidden.json::<Value>().await.unwrap(),
        json!({"detail":"Profile not found"})
    );
    let key = server
        .request(
            Method::POST,
            "/settings/api-keys",
            Some(json!({"name":"Manifest operations"})),
            &cookie,
        )
        .await;
    assert_eq!(key.status(), 201);
    let key = key.json::<Value>().await.unwrap()["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let keyed = server
        .client
        .get(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .unwrap();
    assert_eq!(keyed.status(), 200);
    let forwarded = server
        .client
        .get(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("X-Forwarded-For", "127.0.0.1")
        .send()
        .await
        .unwrap();
    assert_eq!(forwarded.status(), 403);
    let wrong_origin = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", "https://attacker.invalid")
        .header("Cookie", &cookie)
        .json(&json!({"kit":{"name":"blocked"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_origin.status(), 403);
    let mut expected = json!({"profile_id":id,"kit":{"name":null,"layers":[],"base_source_id":null,"addon_source_ids":[],"selections":{},"include":[],"exclude":[],"replacements":{},"choice_tree":[],"category_links":[]}});
    for prefix in ["", "/api/v2", "/api/v1"] {
        let kit = format!("{prefix}/plans/{id}/kit-manifest");
        let response = server.request(Method::GET, &kit, None, &cookie).await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let kit_body = response.bytes().await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&kit_body).unwrap(),
            expected
        );
        let response = server.request(Method::HEAD, &kit, None, &cookie).await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-length"],
            kit_body.len().to_string()
        );
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert!(response.bytes().await.unwrap().is_empty());
        let response = server
            .request(
                Method::PUT,
                &kit,
                Some(json!({"kit":{"name":"Saved"}})),
                &cookie,
            )
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<Value>().await.unwrap()["kit"]["name"],
            "Saved"
        );
        expected["kit"]["name"] = json!("Saved");
        let builder = format!("{prefix}/plans/{id}/plan-manifest-builder");
        let response = server.request(Method::GET, &builder, None, &cookie).await;
        assert_eq!(response.status(), 200);
        let builder_body = response.bytes().await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&builder_body).unwrap(),
            json!({"profile_id":id,"sources":[],"resolved_selections":{},"merged_option_groups":{}})
        );
        let response = server.request(Method::HEAD, &builder, None, &cookie).await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-length"],
            builder_body.len().to_string()
        );
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert!(response.bytes().await.unwrap().is_empty());
    }

    for (method, path) in [
        (Method::GET, "/api/v1/plans"),
        (Method::HEAD, "/api/v1/plans"),
        (Method::POST, "/api/v1/plans"),
        (Method::GET, &format!("/api/v1/plans/{id}")),
        (Method::HEAD, &format!("/api/v1/plans/{id}")),
        (Method::DELETE, &format!("/api/v1/plans/{id}")),
        (Method::POST, &format!("/api/v1/plans/{id}/touch")),
        (Method::GET, &format!("/api/v1/plans/{id}/layers")),
        (Method::HEAD, &format!("/api/v1/plans/{id}/layers")),
        (Method::POST, &format!("/api/v1/plans/{id}/layers")),
        (Method::PUT, &format!("/api/v1/plans/{id}/layers/base")),
        (Method::PUT, &format!("/api/v1/plans/{id}/layers/1")),
        (Method::DELETE, &format!("/api/v1/plans/{id}/layers/1")),
    ] {
        let response = server.request(method, path, None, &cookie).await;
        assert_eq!(response.status(), 404, "unexpected v1 route: {path}");
    }

    let numeric = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("content-type", "application/json")
        .body(r#"{"kit":{"choice_tree":[100000000000000000000,-100000000000000000000,-0]}}"#)
        .send()
        .await
        .unwrap();
    let mut representation_failures = Vec::new();
    if numeric.status() != 200 {
        representation_failures.push(format!("numeric status={}", numeric.status()));
    }
    let numeric = numeric.text().await.unwrap();
    if !numeric.contains(r#""choice_tree":[100000000000000000000,-100000000000000000000,0]"#) {
        representation_failures.push(format!("numeric body={numeric}"));
    }

    let scalar_selection = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("content-type", "application/json")
        .body(r#"{"kit":{"selections":{" group ":" \ufeffstock\ufeff "}}}"#)
        .send()
        .await
        .unwrap();
    if scalar_selection.status() != 200 {
        representation_failures.push(format!(
            "scalar selection status={}",
            scalar_selection.status()
        ));
    }
    let scalar_selection = scalar_selection.text().await.unwrap();
    if !scalar_selection.contains(r#""selections":{" group ":"stock"}"#) {
        representation_failures.push(format!("scalar selection body={scalar_selection}"));
    }

    let duplicate_selection = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("content-type", "application/json")
        .body(r#"{"kit":{"selections":{"toolhead":[" stock ","stock"]}}}"#)
        .send()
        .await
        .unwrap();
    if duplicate_selection.status() != 400 {
        representation_failures.push(format!(
            "normalized duplicate status={}",
            duplicate_selection.status()
        ));
    }

    let surrogate = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("content-type", "application/json")
        .body(
            r#"{"kit":{"name":"\ud800","replacements":{"\udc00":"\ud800"},"choice_tree":[{"\ud800":"\udc00"}]}}"#,
        )
        .send()
        .await
        .unwrap();
    if surrogate.status() != 200 {
        representation_failures.push(format!("surrogate status={}", surrogate.status()));
    }
    let surrogate = surrogate.text().await.unwrap();
    for expected_surrogate in [
        r#""name":"\ud800""#,
        r#""\udc00":"\ud800""#,
        r#""\ud800":"\udc00""#,
    ] {
        if !surrogate.contains(expected_surrogate) {
            representation_failures.push(format!("surrogate body={surrogate}"));
            break;
        }
    }
    assert!(
        representation_failures.is_empty(),
        "{}",
        representation_failures.join("\n")
    );

    let missing = server
        .request(
            Method::PUT,
            "/plans/999999/kit-manifest",
            Some(json!({"kit":{"name":7}})),
            &cookie,
        )
        .await;
    assert_eq!(missing.status(), 404);
    assert_eq!(
        missing.json::<Value>().await.unwrap(),
        json!({"detail":"Profile not found"})
    );
    let prefix = "{\"kit\":{\"ignored\":\"";
    let suffix = "\"}}";
    let body = format!(
        "{prefix}{}{}",
        "x".repeat(8 * 1024 * 1024 - prefix.len() - suffix.len()),
        suffix
    );
    assert_eq!(body.len(), 8 * 1024 * 1024);
    let accepted = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), 200);
    let refused = server
        .client
        .put(format!("{}/plans/{id}/kit-manifest", server.origin))
        .header("Origin", &server.origin)
        .header("Cookie", &cookie)
        .header("content-type", "application/json")
        .body("x".repeat(8 * 1024 * 1024 + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 413);
    println!(
        "manifest_api_observation={}",
        json!({
            "registrations":15,
            "prefixes":["current","v2","v1"],
            "kit_get_body":expected,
            "builder_get_body":{"profile_id":id,"sources":[],"resolved_selections":{},"merged_option_groups":{}},
            "head_body_bytes":[0,0,0,0,0,0],
            "session_status":200,
            "api_key_status":200,
            "foreign_and_missing_status":404,
            "unauthenticated_status":401,
            "forwarded_status":403,
            "wrong_origin_status":403,
            "kit_exact_8_mib_status":200,
            "kit_8_mib_plus_one_status":413,
        })
    );
    server.close().await;
}
