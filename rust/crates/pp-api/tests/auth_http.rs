use pp_api::auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router};
use pp_storage::{
    Limits, WriterOwner,
    auth::{
        AuthClient, AuthFailure, AuthPolicy, FirstUserTenant, Outcome, Provider,
        RegistrationPolicy, Request, Secret, SessionTenantPolicy,
    },
};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

struct Server {
    origin: String,
    client: Client,
    owner: WriterOwner,
    auth: AuthClient,
    task: tokio::task::JoinHandle<()>,
    shutdown: tokio::sync::oneshot::Sender<()>,
    directory: PathBuf,
}
impl Server {
    async fn start(
        registration: RegistrationPolicy,
        single: bool,
        dev: bool,
        public: Option<&str>,
    ) -> Self {
        let directory = std::env::temp_dir().join(format!("pp-http-test-{}", random()));
        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        Self::from_owner(owner, directory, registration, single, dev, public).await
    }
    async fn from_owner(
        owner: WriterOwner,
        directory: PathBuf,
        registration: RegistrationPolicy,
        single: bool,
        dev: bool,
        public: Option<&str>,
    ) -> Self {
        let auth = owner
            .auth_with_policy(AuthPolicy {
                registration,
                first_user: FirstUserTenant::NewUser,
                session_tenant: if single {
                    SessionTenantPolicy::SingleAccountDefault
                } else {
                    SessionTenantPolicy::AccountTenant
                },
            })
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, !single, public, dev)
                .unwrap(),
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
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        Self {
            origin,
            client,
            owner,
            auth,
            task,
            shutdown,
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
    async fn register(&self, email: &str) -> Response {
        self.request(Method::POST,"/auth/register",Some(json!({"email":email,"password":"password-1234","tenant_id":"forged","is_admin":false})),None).await
    }
    async fn stop(self) -> PathBuf {
        self.shutdown.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.shutdown().unwrap();
        self.directory
    }
    async fn close(self) {
        std::fs::remove_dir_all(self.stop().await).unwrap();
    }
}
fn random() -> String {
    let mut bytes = [0; 12];
    getrandom::fill(&mut bytes).unwrap();
    hex::encode(bytes)
}
fn cookie(response: &Response) -> String {
    response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}
async fn call(auth: &AuthClient, request: Request) -> anyhow::Result<Outcome> {
    let auth = auth.clone();
    tokio::task::spawn_blocking(move || {
        auth.submit(
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(1),
        )?
        .recv()
        .unwrap()
    })
    .await
    .unwrap()
}
fn secret(value: &str) -> Secret {
    Secret::new(value.into())
}

#[tokio::test]
async fn registration_race_and_owner_policy_are_transactional() {
    let server = Server::start(RegistrationPolicy::FirstAccountOnly, true, false, None).await;
    let (a, b) = tokio::join!(
        server.register("first@example.com"),
        server.register("second@example.com")
    );
    let mut statuses = vec![a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![200, 403]);
    let success = if a.status().is_success() { a } else { b };
    let cookie = cookie(&success);
    let user: Value = success.json().await.unwrap();
    assert_eq!(user["user"]["is_admin"], true);
    assert_eq!(user["user"]["user_id"].as_str().unwrap().len(), 36);
    assert!(user["user"].get("tenant_id").is_none());
    let Outcome::User(Some(user)) = call(
        &server.auth,
        Request::ResolveSession {
            token: secret(cookie.strip_prefix("pp_session=").unwrap()),
            provider: Provider::Email,
        },
    )
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(user.tenant_id, "default");
    let health: Value = server
        .request(Method::GET, "/health", None, Some(&cookie))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(health["authentication_required"], true);
    assert_eq!(health["authenticated"], true);
    assert_eq!(health["registration_open"], false);
    let closed = server
        .owner
        .auth_with_policy(AuthPolicy {
            registration: RegistrationPolicy::Closed,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        })
        .unwrap();
    let error = call(
        &closed,
        Request::Register {
            email: "third@example.com".into(),
            display_name: "Third".into(),
            password: secret("password-1234"),
        },
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(
        error.downcast_ref(),
        Some(AuthFailure::RegistrationClosed)
    ));
    let neutral = server.owner.auth(FirstUserTenant::NewUser);
    call(
        &neutral,
        Request::Register {
            email: "third@example.com".into(),
            display_name: "Third".into(),
            password: secret("password-1234"),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        server
            .request(Method::GET, "/auth/me", None, Some(&cookie))
            .await
            .status(),
        403
    );
    assert_eq!(
        server
            .request(Method::GET, "/settings/api-keys", None, Some(&cookie))
            .await
            .status(),
        403
    );
    server.close().await;
}

#[tokio::test]
async fn guards_missing_routes_and_declared_rate_limits() {
    let server = Server::start(RegistrationPolicy::Open, false, false, None).await;
    for header in [
        "Forwarded",
        "X-Forwarded-Host",
        "X-Forwarded-For",
        "X-Forwarded-Proto",
    ] {
        assert_eq!(
            server
                .client
                .get(format!("{}/auth/me", server.origin))
                .header(header, "evil")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    for (header, value) in [
        ("Host", "evil.example"),
        ("Origin", "http://evil.example"),
        ("Origin", "null"),
        ("Sec-Fetch-Site", "cross-site"),
    ] {
        assert_eq!(
            server
                .client
                .get(format!("{}/auth/me", server.origin))
                .header(header, value)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    assert_eq!(
        server
            .client
            .post(format!("{}/auth/login", server.origin))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for path in [
        "/auth/dev-login",
        "/api/v1/auth/me",
        "/api/v2/auth/me",
        "/auth/logout-all",
        "/auth/link-identity",
        "/api/v1/mcp",
        "/auth/discord/callback",
    ] {
        assert_eq!(
            server.request(Method::GET, path, None, None).await.status(),
            404
        );
    }
    assert_eq!(
        server
            .request(Method::HEAD, "/auth/github", None, None)
            .await
            .status(),
        501
    );
    assert_eq!(
        server
            .request(Method::HEAD, "/auth/discord", None, None)
            .await
            .status(),
        501
    );
    for attempt in 1..=21 {
        assert_eq!(
            server
                .request(Method::POST, "/auth/login", Some(json!({})), None)
                .await
                .status()
                .as_u16(),
            if attempt <= 20 { 400 } else { 429 },
            "attempt {attempt}"
        );
    }
    server.close().await;
    let server = Server::start(RegistrationPolicy::Open, false, false, None).await;
    let cookie = cookie(&server.register("keys@example.com").await);
    for attempt in 1..=11 {
        assert_eq!(
            server
                .request(
                    Method::POST,
                    "/settings/api-keys",
                    Some(json!({})),
                    Some(&cookie)
                )
                .await
                .status()
                .as_u16(),
            if attempt <= 10 { 201 } else { 429 },
            "attempt {attempt}"
        );
    }
    server.close().await;
}

#[tokio::test]
async fn keys_are_flattened_one_time_and_rotate_revoke_persist() {
    let server = Server::start(RegistrationPolicy::FirstAccountOnly, true, false, None).await;
    let cookie = cookie(&server.register("keys@example.com").await);
    assert_eq!(
        server
            .request(Method::POST, "/settings/api-keys", Some(json!({})), None)
            .await
            .status(),
        401
    );
    let created = server
        .request(
            Method::POST,
            "/settings/api-keys",
            Some(json!({})),
            Some(&cookie),
        )
        .await;
    assert_eq!(created.status(), 201);
    let key: Value = created.json().await.unwrap();
    let raw = key["key"].as_str().unwrap();
    let id = key["id"].as_str().unwrap();
    assert!(key.get("info").is_none());
    assert!(key.get("createdAt").is_some());
    assert!(key.get("keyHash").is_none());
    let Outcome::KeyResolved {
        principal: Some(principal),
        ..
    } = call(
        &server.auth,
        Request::ResolveKey {
            tenant_id: "default".into(),
            key: secret(raw),
        },
    )
    .await
    .unwrap()
    else {
        panic!()
    };
    assert_eq!(principal.tenant_id, "default");
    let rotated = server
        .request(
            Method::POST,
            &format!("/settings/api-keys/{id}/regenerate"),
            Some(json!({})),
            Some(&cookie),
        )
        .await;
    assert_eq!(rotated.status(), 201);
    let rotated: Value = rotated.json().await.unwrap();
    assert!(matches!(
        call(
            &server.auth,
            Request::ResolveKey {
                tenant_id: "default".into(),
                key: secret(raw)
            }
        )
        .await
        .unwrap(),
        Outcome::KeyResolved {
            principal: None,
            ..
        }
    ));
    let list: Value = server
        .request(Method::GET, "/settings/api-keys", None, Some(&cookie))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list["total"], 2);
    assert!(!list.to_string().contains(raw));
    assert!(!list.to_string().contains("keyHash"));
    assert_eq!(
        server
            .request(Method::HEAD, "/settings/api-keys", None, Some(&cookie))
            .await
            .status(),
        200
    );
    assert_eq!(
        server
            .request(
                Method::DELETE,
                "/settings/api-keys/missing",
                None,
                Some(&cookie)
            )
            .await
            .status(),
        404
    );
    let response = server
        .request(
            Method::DELETE,
            &format!("/settings/api-keys/{}", rotated["id"].as_str().unwrap()),
            None,
            Some(&cookie),
        )
        .await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"success":true})
    );
    let directory = server.stop().await;
    let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
    let server = Server::from_owner(
        owner,
        directory,
        RegistrationPolicy::FirstAccountOnly,
        true,
        false,
        None,
    )
    .await;
    assert_eq!(
        server
            .request(Method::GET, "/settings/api-keys", None, Some(&cookie))
            .await
            .status(),
        200
    );
    assert!(matches!(
        call(
            &server.auth,
            Request::ResolveKey {
                tenant_id: "default".into(),
                key: secret(rotated["key"].as_str().unwrap())
            }
        )
        .await
        .unwrap(),
        Outcome::KeyResolved {
            principal: None,
            ..
        }
    ));
    assert_eq!(
        server
            .request(Method::POST, "/auth/logout", Some(json!({})), Some(&cookie))
            .await
            .status(),
        200
    );
    assert_eq!(
        server
            .request(Method::GET, "/settings/api-keys", None, Some(&cookie))
            .await
            .status(),
        401
    );
    server.close().await;
}

#[tokio::test]
async fn oauth_only_reset_preserves_identity_and_ordinary_no_enumeration() {
    let server = Server::start(RegistrationPolicy::Open, false, true, None).await;
    let Outcome::Session { user, token } = call(
        &server.auth,
        Request::OAuthLogin {
            provider: Provider::Github,
            provider_user_id: "123".into(),
            email: Some("oauth@example.com".into()),
            display_name: "OAuth".into(),
        },
    )
    .await
    .unwrap() else {
        panic!()
    };
    let old = format!("pp_session={}", token.expose());
    let change = server
        .request(
            Method::POST,
            "/auth/change-password",
            Some(json!({"current_password":"irrelevant","new_password":"password-new"})),
            Some(&old),
        )
        .await;
    assert_eq!(change.status(), 400);
    assert_eq!(
        change.json::<Value>().await.unwrap()["detail"],
        "This account uses OAuth sign-in only"
    );
    let forgot: Value = server
        .request(
            Method::POST,
            "/auth/forgot-password",
            Some(json!({"email":"  OAUTH@example.com  "})),
            None,
        )
        .await
        .json()
        .await
        .unwrap();
    let url = reqwest::Url::parse(forgot["dev_reset_url"].as_str().unwrap()).unwrap();
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "token")
        .unwrap()
        .1
        .into_owned();
    let reset = server
        .request(
            Method::POST,
            "/auth/reset-password",
            Some(json!({"token":token,"password":"password-new"})),
            None,
        )
        .await;
    assert_eq!(reset.status(), 200);
    assert_eq!(
        reset.json::<Value>().await.unwrap()["user"]["user_id"],
        user.user_id
    );
    assert_eq!(
        server
            .request(Method::GET, "/auth/me", None, Some(&old))
            .await
            .status(),
        401
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/reset-password",
                Some(json!({"token":token,"password":"password-new"})),
                None
            )
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/login",
                Some(json!({"email":"oauth@example.com","password":"password-new"})),
                None
            )
            .await
            .status(),
        200
    );
    server.close().await;
    for public in [None, Some("https://canonical.example")] {
        let server = Server::start(RegistrationPolicy::Open, false, false, public).await;
        server.register("known@example.com").await;
        let a: Value = server
            .request(
                Method::POST,
                "/auth/forgot-password",
                Some(json!({"email":"known@example.com"})),
                None,
            )
            .await
            .json()
            .await
            .unwrap();
        let b: Value = server
            .request(
                Method::POST,
                "/auth/forgot-password",
                Some(json!({"email":"unknown@example.com"})),
                None,
            )
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(a, b);
        assert!(a.get("dev_reset_url").is_none());
        let directory = server.stop().await;
        let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
        let count: i64 = db
            .query_row("SELECT count(*) FROM password_reset_tokens", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, if public.is_some() { 1 } else { 0 });
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn old_default_keys_expiry_session_expiry_and_storage_errors_are_safe() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let server = Server::start(RegistrationPolicy::FirstAccountOnly, true, false, None).await;
    let cookie = cookie(&server.register("imported@example.com").await);
    let directory = server.stop().await;
    let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
    let keys = json!([
        {"id":"legacy","keyHash":STANDARD.encode("legacy-token"),"createdAt":"2020-01-01T00:00:00.000Z","lastUsedAt":null,"expiresAt":null,"isActive":true},
        {"id":"expired","keyHash":STANDARD.encode("expired-token"),"createdAt":"2020-01-01T00:00:00.000Z","lastUsedAt":null,"expiresAt":"2000-01-01T00:00:00.000Z","isActive":true}
    ]);
    db.execute(
        "INSERT INTO app_settings(tenant_id,key,value) VALUES('default','api_keys_v1',?1)",
        [keys.to_string()],
    )
    .unwrap();
    db.execute("INSERT INTO app_settings(tenant_id,key,value) VALUES('default','fixture_domain_row','preserved')",[]).unwrap();
    drop(db);
    let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
    let server = Server::from_owner(
        owner,
        directory,
        RegistrationPolicy::FirstAccountOnly,
        true,
        false,
        None,
    )
    .await;
    let list = server
        .request(Method::GET, "/settings/api-keys", None, Some(&cookie))
        .await;
    assert_eq!(list.status(), 200);
    let list: Value = list.json().await.unwrap();
    assert_eq!(list["total"], 2);
    assert!(!list.to_string().contains("token"));
    for (tenant, key, valid) in [
        ("default", "legacy-token", true),
        ("default", "expired-token", false),
        ("forged", "legacy-token", false),
    ] {
        let result = call(
            &server.auth,
            Request::ResolveKey {
                tenant_id: tenant.into(),
                key: secret(key),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            matches!(
                result,
                Outcome::KeyResolved {
                    principal: Some(_),
                    ..
                }
            ),
            valid
        );
    }
    let directory = server.stop().await;
    let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
    let keys: String = db
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!keys.contains("token"));
    let keys: Value = serde_json::from_str(&keys).unwrap();
    assert_eq!(keys[0]["keyHash"].as_str().unwrap().len(), 64);
    assert_eq!(
        db.query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='fixture_domain_row'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "preserved"
    );
    db.execute_batch("CREATE TRIGGER fail_key_write BEFORE UPDATE ON app_settings WHEN NEW.key='api_keys_v1' BEGIN SELECT RAISE(ABORT,'secret-sql-fixture'); END;").unwrap();
    drop(db);
    let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
    let server = Server::from_owner(
        owner,
        directory,
        RegistrationPolicy::FirstAccountOnly,
        true,
        false,
        None,
    )
    .await;
    let response = server
        .request(
            Method::POST,
            "/settings/api-keys",
            Some(json!({})),
            Some(&cookie),
        )
        .await;
    assert_eq!(response.status(), 500);
    let body = response.text().await.unwrap();
    assert!(!body.contains("secret-sql-fixture"));
    assert!(!body.contains("SQL"));
    let directory = server.stop().await;
    let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
    db.execute(
        "UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'",
        [],
    )
    .unwrap();
    drop(db);
    let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
    let server = Server::from_owner(
        owner,
        directory,
        RegistrationPolicy::FirstAccountOnly,
        true,
        false,
        None,
    )
    .await;
    assert_eq!(
        server
            .request(Method::GET, "/auth/me", None, Some(&cookie))
            .await
            .status(),
        401
    );
    assert_eq!(
        server
            .request(Method::GET, "/settings/api-keys", None, Some(&cookie))
            .await
            .status(),
        401
    );
    server.close().await;
}

#[tokio::test]
async fn credential_error_codes_and_config_validation() {
    assert!(
        AuthHttpConfig::new(
            "http://0.0.0.0:9000",
            CookieTransport::LoopbackHttp,
            false,
            None,
            false
        )
        .is_err()
    );
    assert!(
        AuthHttpConfig::new(
            "http://127.0.0.1:9000",
            CookieTransport::Secure,
            false,
            None,
            false
        )
        .is_err()
    );
    assert!(
        AuthHttpConfig::new(
            "http://user@127.0.0.1:9000",
            CookieTransport::LoopbackHttp,
            false,
            None,
            false
        )
        .is_err()
    );
    assert!(
        AuthHttpConfig::new(
            "http://127.0.0.1:9000",
            CookieTransport::LoopbackHttp,
            false,
            Some("javascript:alert(1)"),
            false
        )
        .is_err()
    );
    let server = Server::start(RegistrationPolicy::Open, false, false, None).await;
    let cookie = cookie(&server.register("duplicate@example.com").await);
    assert_eq!(server.register("duplicate@example.com").await.status(), 409);
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/login",
                Some(json!({"email":"duplicate@example.com","password":"wrong-password"})),
                None
            )
            .await
            .status(),
        401
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/change-password",
                Some(
                    json!({"current_password":"wrong-password","new_password":"replacement-good"})
                ),
                Some(&cookie)
            )
            .await
            .status(),
        401
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/change-password",
                Some(json!({"current_password":"password-1234","new_password":"short"})),
                Some(&cookie)
            )
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .request(Method::GET, "/auth/me", None, Some(&cookie))
            .await
            .status(),
        200
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/register",
                Some(json!({"email":"invalid","password":"valid-password"})),
                None
            )
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .request(
                Method::POST,
                "/auth/register",
                Some(json!({"email":"valid@example.com","password":"x".repeat(4097)})),
                None
            )
            .await
            .status(),
        400
    );
    server.close().await;
}

#[tokio::test]
async fn stopped_writer_is_service_unavailable() {
    let server = Server::start(RegistrationPolicy::Open, false, false, None).await;
    let Server {
        origin,
        client,
        owner,
        task,
        shutdown,
        directory,
        ..
    } = server;
    owner.shutdown().unwrap();
    let response = client
        .post(format!("{origin}/auth/login"))
        .header("Origin", &origin)
        .json(&json!({"email":"fixture@example.com","password":"password-good"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    assert_eq!(
        response.json::<Value>().await.unwrap()["detail"],
        "Authentication temporarily unavailable"
    );
    shutdown.send(()).unwrap();
    task.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
