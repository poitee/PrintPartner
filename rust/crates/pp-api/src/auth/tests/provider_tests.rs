use super::*;
use crate::auth::{AuthHttpConfig, CookieTransport, ResetMailer, auth_router};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{Method, Uri},
    response::IntoResponse,
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
use std::{net::SocketAddr, path::PathBuf, sync::atomic::AtomicBool};

type ProviderCall = (String, Method, HeaderMap, Value);

#[derive(Clone)]
struct Fake {
    calls: Arc<Mutex<Vec<ProviderCall>>>,
}
async fn fake_request(
    State(fake): State<Fake>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let body: Value = if headers
        .get("content-type")
        .is_some_and(|v| v == "application/x-www-form-urlencoded")
    {
        let url = reqwest::Url::parse(&format!(
            "http://fixture/?{}",
            String::from_utf8_lossy(&bytes)
        ))
        .unwrap();
        Value::Object(
            url.query_pairs()
                .map(|(k, v)| (k.into_owned(), json!(v)))
                .collect(),
        )
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    fake.calls
        .lock()
        .unwrap()
        .push((uri.path().into(), method, headers.clone(), body.clone()));
    let code = body["code"]
        .as_str()
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer token:"))
        })
        .unwrap_or("default");
    if uri.path().ends_with("token") {
        match code {
            "status-token" => return StatusCode::BAD_REQUEST.into_response(),
            "redirect-token" => {
                return (
                    StatusCode::FOUND,
                    [("location", "http://127.0.0.1:1/never")],
                )
                    .into_response();
            }
            "malformed-token" => return "not-json".into_response(),
            "oversized-token" => return "x".repeat(256 * 1024 + 1).into_response(),
            "missing-token" => return axum::Json(json!({"token_type":"Bearer"})).into_response(),
            "timeout" => {
                tokio::time::sleep(Duration::from_secs(16)).await;
            }
            _ => (),
        }
        return axum::Json(json!({"access_token":format!("token:{code}")})).into_response();
    }
    if uri.path().ends_with("emails") {
        let emails = if code == "unverified" {
            json!([{"email":"victim@example.com","verified":false,"primary":true}])
        } else if code == "first-verified" {
            json!([{ "email":"secondary@example.com", "verified":true, "primary":false }])
        } else {
            json!([{"email":"secondary@example.com","verified":true,"primary":false},{"email":"  PRIMARY@example.com ","verified":true,"primary":true}])
        };
        return axum::Json(emails).into_response();
    }
    match code {
        "status-profile" => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "malformed-profile" => return "{".into_response(),
        "oversized-profile" => return "x".repeat(256 * 1024 + 1).into_response(),
        "invalid-profile" => {
            return axum::Json(json!({"id":0,"login":"","username":""})).into_response();
        }
        _ => (),
    }
    if uri.path().starts_with("/github") {
        axum::Json(json!({"id":if code=="second"{456}else{123},"login":"octocat","name":"Octo Cat","email":"unverified-profile@example.com"})).into_response()
    } else {
        axum::Json(json!({"id":if code=="second"{"456"}else{"123"},"username":"discord-user","global_name":"Discord User","email":"primary@example.com","verified":code!="unverified"})).into_response()
    }
}
struct TestServer {
    origin: String,
    client: reqwest::Client,
    providers: ProviderClient,
    fake: Fake,
    owner: WriterOwner,
    directory: PathBuf,
    app_task: tokio::task::JoinHandle<()>,
    app_stop: tokio::sync::oneshot::Sender<()>,
    fake_task: tokio::task::JoinHandle<()>,
}
impl TestServer {
    async fn start(registration: RegistrationPolicy, seed: bool) -> Self {
        let directory = std::env::temp_dir().join(format!("pp-provider-{}", random().unwrap()));
        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        if seed {
            let auth = owner.auth(FirstUserTenant::NewUser);
            tokio::task::spawn_blocking(move || {
                auth.submit(
                    Request::OAuthLogin {
                        provider: Provider::Github,
                        provider_user_id: "123".into(),
                        email: Some("primary@example.com".into()),
                        display_name: "Seed".into(),
                    },
                    Arc::new(AtomicBool::new(false)),
                    Duration::from_secs(1),
                )
                .unwrap()
                .recv()
                .unwrap()
                .unwrap()
            })
            .await
            .unwrap();
        }
        let auth = owner
            .auth_with_policy(AuthPolicy {
                registration,
                session_tenant: SessionTenantPolicy::AccountTenant,
                first_user: FirstUserTenant::NewUser,
            })
            .unwrap();
        let fake_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake_origin = format!("http://{}", fake_listener.local_addr().unwrap());
        let fake = Fake {
            calls: Arc::default(),
        };
        let router = Router::new()
            .fallback(fake_request)
            .with_state(fake.clone());
        let fake_task = tokio::spawn(async move {
            axum::serve(fake_listener, router).await.unwrap();
        });
        let creds = || {
            OAuthCredentials::new(
                "fixture-client".into(),
                Secret::new("fixture-secret".into()),
            )
            .unwrap()
        };
        let mut providers = ProviderClient::new(Some(creds()), Some(creds())).unwrap();
        let inner = Arc::get_mut(&mut providers.0).unwrap();
        for (name, config) in [
            ("github", inner.github.as_mut().unwrap()),
            ("discord", inner.discord.as_mut().unwrap()),
        ] {
            config.endpoints.token = format!("{fake_origin}/{name}/token");
            config.endpoints.profile = format!("{fake_origin}/{name}/user");
            if config.endpoints.email.is_some() {
                config.endpoints.email = Some(format!("{fake_origin}/{name}/emails"));
            }
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, true, None, false).unwrap(),
            auth.clone(),
            providers.clone(),
            ResetMailer::disabled(),
        );
        let (app_stop, rx) = tokio::sync::oneshot::channel();
        let app_task = tokio::spawn(async move {
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
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        Self {
            origin,
            client,
            providers,
            fake,
            owner,
            directory,
            app_task,
            app_stop,
            fake_task,
        }
    }
    async fn begin(&self, provider: Provider) -> (reqwest::Url, String) {
        let path = if provider == Provider::Github {
            "/auth/github"
        } else {
            "/auth/discord"
        };
        let response = self
            .client
            .get(format!("{}{path}", self.origin))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 302);
        let url = reqwest::Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        assert!(
            cookie.contains("HttpOnly")
                && cookie.contains("SameSite=Lax")
                && cookie.contains("Max-Age=600")
        );
        (url, cookie.split(';').next().unwrap().into())
    }
    async fn finish(
        &self,
        provider: Provider,
        url: &reqwest::Url,
        cookie: &str,
        code: &str,
    ) -> reqwest::Response {
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let path = if provider == Provider::Github {
            "/auth/callback"
        } else {
            "/auth/discord/callback"
        };
        let mut target = reqwest::Url::parse(&format!("{}{path}", self.origin)).unwrap();
        target
            .query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("code", code);
        self.client
            .get(target)
            .header("Cookie", cookie)
            .header("Sec-Fetch-Site", "cross-site")
            .send()
            .await
            .unwrap()
    }
    fn session_cookie(response: &reqwest::Response) -> String {
        response
            .headers()
            .get_all("set-cookie")
            .iter()
            .find_map(|header| {
                header
                    .to_str()
                    .ok()
                    .filter(|value| value.starts_with("pp_session="))
                    .map(|value| value.split(';').next().unwrap().to_owned())
            })
            .unwrap()
    }
    async fn me(&self, cookie: &str) -> Value {
        self.client
            .get(format!("{}/auth/me", self.origin))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn close(self, expected_users: i64, expected_identities: i64) {
        self.close_with_pairs(expected_users, expected_identities, &[])
            .await;
    }
    async fn close_with_pairs(
        self,
        expected_users: i64,
        expected_identities: i64,
        expected_pairs: &[(&str, &str)],
    ) {
        self.app_stop.send(()).unwrap();
        self.app_task.await.unwrap();
        self.fake_task.abort();
        let _ = self.fake_task.await;
        self.owner.shutdown().unwrap();
        let db = rusqlite::Connection::open(self.directory.join("print-partner.db")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM users", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            expected_users
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM auth_identities", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            expected_identities
        );
        if !expected_pairs.is_empty() {
            let mut statement = db
                .prepare(
                    "SELECT provider,provider_user_id FROM auth_identities ORDER BY provider,provider_user_id",
                )
                .unwrap();
            let pairs: Vec<(String, String)> = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(
                pairs,
                expected_pairs
                    .iter()
                    .map(|(provider, id)| ((*provider).to_owned(), (*id).to_owned()))
                    .collect::<Vec<_>>()
            );
        }
        drop(db);
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

#[tokio::test]
async fn linked_account_sessions_remember_their_sign_in_provider() {
    let server = TestServer::start(RegistrationPolicy::Open, false).await;
    let registered = server
        .client
        .post(format!("{}/auth/register", server.origin))
        .header("Origin", &server.origin)
        .json(&json!({
            "email": "primary@example.com",
            "password": "password-1234",
            "display_name": "Primary"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let email_session = TestServer::session_cookie(&registered);

    let (github_url, github_state) = server.begin(Provider::Github).await;
    let github = server
        .finish(Provider::Github, &github_url, &github_state, "first")
        .await;
    assert_eq!(github.status(), 302);
    let github_session = TestServer::session_cookie(&github);

    let (discord_url, discord_state) = server.begin(Provider::Discord).await;
    let discord = server
        .finish(Provider::Discord, &discord_url, &discord_state, "first")
        .await;
    assert_eq!(discord.status(), 302);
    let discord_session = TestServer::session_cookie(&discord);

    for (cookie, expected) in [
        (&email_session, "email"),
        (&github_session, "github"),
        (&discord_session, "discord"),
    ] {
        let me = server.me(cookie).await;
        assert_eq!(me["user"]["provider"], expected);
    }

    server
        .close_with_pairs(1, 2, &[("discord", "123"), ("github", "123")])
        .await;
}

#[tokio::test]
async fn github_pkce_verified_email_skip_enrichment_and_one_use_state() {
    let server = TestServer::start(RegistrationPolicy::Open, false).await;
    let (url, cookie) = server.begin(Provider::Github).await;
    assert_eq!(url.host_str(), Some("github.com"));
    let query: HashMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(query["scope"], "read:user user:email");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(
        query["redirect_uri"],
        format!("{}/auth/callback", server.origin)
    );
    assert_ne!(query["state"], cookie.strip_prefix("oauth_state=").unwrap());
    let response = server
        .finish(Provider::Github, &url, &cookie, "first")
        .await;
    assert_eq!(response.status(), 302);
    assert_eq!(response.headers()["location"], "/");
    let session = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .find_map(|h| {
            h.to_str()
                .ok()
                .filter(|v| v.starts_with("pp_session="))
                .map(|v| v.split(';').next().unwrap().to_owned())
        })
        .unwrap();
    let me: Value = server
        .client
        .get(format!("{}/auth/me", server.origin))
        .header("Cookie", session)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["user"]["email"], "primary@example.com");
    assert_eq!(
        server
            .finish(Provider::Github, &url, &cookie, "first")
            .await
            .status(),
        400
    );
    {
        let calls = server.fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "/github/token");
        assert_eq!(calls[0].1, Method::POST);
        assert_eq!(calls[0].2["content-type"], "application/json");
        assert_eq!(calls[0].3["client_id"], "fixture-client");
        assert_eq!(calls[0].3["client_secret"], "fixture-secret");
        assert_eq!(calls[0].3["code"], "first");
        assert_eq!(calls[0].3["redirect_uri"], query["redirect_uri"]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(digest(calls[0].3["code_verifier"].as_str().unwrap())),
            query["code_challenge"]
        );
        for call in &calls[1..] {
            assert_eq!(call.1, Method::GET);
            assert_eq!(call.2["authorization"], "Bearer token:first");
        }
    }
    let (url, cookie) = server.begin(Provider::Github).await;
    let (a, b) = tokio::join!(
        server.finish(Provider::Github, &url, &cookie, "again"),
        server.finish(Provider::Github, &url, &cookie, "again")
    );
    let mut statuses = vec![a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![302, 400]);
    assert_eq!(
        server
            .fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.0.ends_with("emails"))
            .count(),
        1
    );
    server.close(1, 1).await;
}

#[tokio::test]
async fn discord_form_and_trusted_verified_email_only() {
    for (code, expected_email) in [("first", Some("primary@example.com")), ("unverified", None)] {
        let server = TestServer::start(RegistrationPolicy::Open, false).await;
        let (url, cookie) = server.begin(Provider::Discord).await;
        let query: HashMap<_, _> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(url.host_str(), Some("discord.com"));
        assert_eq!(query["scope"], "identify email");
        assert_eq!(query["response_type"], "code");
        assert!(!query.contains_key("code_challenge"));
        let response = server.finish(Provider::Discord, &url, &cookie, code).await;
        assert_eq!(response.status(), 302);
        let session = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .find_map(|h| {
                h.to_str()
                    .ok()
                    .filter(|v| v.starts_with("pp_session="))
                    .map(|v| v.split(';').next().unwrap().to_owned())
            })
            .unwrap();
        let me: Value = server
            .client
            .get(format!("{}/auth/me", server.origin))
            .header("Cookie", session)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(me["user"]["email"].as_str(), expected_email);
        {
            let calls = server.fake.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            let token = &calls[0];
            assert_eq!(token.0, "/discord/token");
            assert_eq!(token.1, Method::POST);
            assert_eq!(token.2["content-type"], "application/x-www-form-urlencoded");
            assert_eq!(token.3["client_id"], "fixture-client");
            assert_eq!(token.3["client_secret"], "fixture-secret");
            assert_eq!(token.3["grant_type"], "authorization_code");
            assert_eq!(token.3["redirect_uri"], query["redirect_uri"]);
            assert_eq!(token.3["code"], code);
            assert!(token.3.get("code_verifier").is_none());
            assert_eq!(calls[1].0, "/discord/user");
            assert_eq!(calls[1].1, Method::GET);
            assert_eq!(calls[1].2["authorization"], format!("Bearer token:{code}"));
        }
        server.close(1, 1).await;
    }
}

#[tokio::test]
async fn manufactured_expired_cross_browser_cross_provider_states_never_exchange() {
    let server = TestServer::start(RegistrationPolicy::Open, false).await;
    assert_eq!(
        server
            .client
            .get(format!("{}/auth/callback", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let manufactured = reqwest::Url::parse("https://github.com/?state=client-chosen").unwrap();
    assert_eq!(
        server
            .finish(
                Provider::Github,
                &manufactured,
                "oauth_state=client-chosen",
                "first"
            )
            .await
            .status(),
        400
    );
    let (url, cookie) = server.begin(Provider::Github).await;
    assert_eq!(
        server
            .finish(Provider::Github, &url, "oauth_state=other-browser", "first")
            .await
            .status(),
        400
    );
    assert_eq!(
        server
            .finish(Provider::Discord, &url, &cookie, "first")
            .await
            .status(),
        400
    );
    for flow in server.providers.0.flows.lock().unwrap().values_mut() {
        flow.expires = Instant::now() - Duration::from_secs(1);
    }
    assert_eq!(
        server
            .finish(Provider::Github, &url, &cookie, "first")
            .await
            .status(),
        400
    );
    assert!(server.fake.calls.lock().unwrap().is_empty());
    for _ in 0..1024 {
        server
            .providers
            .start(Provider::Github, "http://127.0.0.1/auth/callback")
            .unwrap();
    }
    assert_eq!(
        server
            .client
            .get(format!("{}/auth/github", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    server.close(0, 0).await;
}

#[tokio::test]
async fn rejected_provider_responses_do_not_mutate_and_state_stays_consumed() {
    let server = TestServer::start(RegistrationPolicy::Open, false).await;
    for provider in [Provider::Github, Provider::Discord] {
        for (code, status) in [
            ("status-token", 401),
            ("redirect-token", 401),
            ("malformed-token", 401),
            ("oversized-token", 401),
            ("missing-token", 401),
            ("status-profile", 502),
            ("malformed-profile", 502),
            ("oversized-profile", 502),
            ("invalid-profile", 502),
        ] {
            let (url, cookie) = server.begin(provider).await;
            assert_eq!(
                server
                    .finish(provider, &url, &cookie, code)
                    .await
                    .status()
                    .as_u16(),
                status,
                "{code}"
            );
            assert_eq!(
                server.finish(provider, &url, &cookie, code).await.status(),
                400
            );
        }
    }
    let (url, cookie) = server.begin(Provider::Github).await;
    let started = Instant::now();
    assert_eq!(
        server
            .finish(Provider::Github, &url, &cookie, "timeout")
            .await
            .status(),
        504
    );
    assert!(
        started.elapsed() >= Duration::from_secs(14) && started.elapsed() < Duration::from_secs(17)
    );
    server.close(0, 0).await;
}

#[tokio::test]
async fn closed_and_single_account_provider_rules_are_transactional() {
    for policy in [
        RegistrationPolicy::Closed,
        RegistrationPolicy::FirstAccountOnly,
    ] {
        let server = TestServer::start(policy, true).await;
        let (url, cookie) = server.begin(Provider::Github).await;
        assert_eq!(
            server
                .finish(Provider::Github, &url, &cookie, "first")
                .await
                .status(),
            302
        );
        let (url, cookie) = server.begin(Provider::Github).await;
        assert_eq!(
            server
                .finish(Provider::Github, &url, &cookie, "second")
                .await
                .status(),
            403
        );
        let (url, cookie) = server.begin(Provider::Discord).await;
        assert_eq!(
            server
                .finish(Provider::Discord, &url, &cookie, "first")
                .await
                .status(),
            403
        );
        server.close(1, 1).await;
    }
    let server = TestServer::start(RegistrationPolicy::FirstAccountOnly, false).await;
    let (a, ac) = server.begin(Provider::Github).await;
    let (b, bc) = server.begin(Provider::Discord).await;
    let (a, b) = tokio::join!(
        server.finish(Provider::Github, &a, &ac, "first"),
        server.finish(Provider::Discord, &b, &bc, "first")
    );
    let mut statuses = vec![a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, vec![302, 403]);
    server.close(1, 1).await;
}

#[tokio::test]
async fn github_unverified_email_is_ignored_and_open_verified_email_links() {
    let server = TestServer::start(RegistrationPolicy::Open, false).await;
    let (url, cookie) = server.begin(Provider::Github).await;
    let response = server
        .finish(Provider::Github, &url, &cookie, "unverified")
        .await;
    assert_eq!(response.status(), 302);
    let session = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .find_map(|h| {
            h.to_str()
                .ok()
                .filter(|v| v.starts_with("pp_session="))
                .map(|v| v.split(';').next().unwrap().to_owned())
        })
        .unwrap();
    let me: Value = server
        .client
        .get(format!("{}/auth/me", server.origin))
        .header("Cookie", session)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(me["user"]["email"].is_null());
    server.close(1, 1).await;
    let server = TestServer::start(RegistrationPolicy::Open, true).await;
    let (url, cookie) = server.begin(Provider::Discord).await;
    assert_eq!(
        server
            .finish(Provider::Discord, &url, &cookie, "first")
            .await
            .status(),
        302
    );
    server.close(1, 2).await;
}
