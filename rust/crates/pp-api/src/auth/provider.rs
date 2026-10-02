use super::{
    http::{App, invoke},
    wire::{self, Failure},
};
use anyhow::{Result, ensure};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pp_storage::auth::{Outcome, Provider, Request, Secret};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub struct OAuthCredentials {
    client_id: String,
    client_secret: Secret,
}
impl OAuthCredentials {
    pub fn new(client_id: String, client_secret: Secret) -> Result<Self> {
        ensure!(
            !client_id.is_empty() && client_id.len() <= 1024 && !client_secret.expose().is_empty(),
            "Invalid provider credentials"
        );
        Ok(Self {
            client_id,
            client_secret,
        })
    }
}
struct Endpoints {
    authorize: &'static str,
    token: String,
    profile: String,
    email: Option<String>,
}
struct ProviderConfig {
    credentials: OAuthCredentials,
    endpoints: Endpoints,
}
struct Flow {
    provider: Provider,
    browser: [u8; 32],
    expires: Instant,
    verifier: String,
}
struct Inner {
    github: Option<ProviderConfig>,
    discord: Option<ProviderConfig>,
    client: reqwest::Client,
    flows: Mutex<HashMap<[u8; 32], Flow>>,
}
#[derive(Clone)]
pub struct ProviderClient(Arc<Inner>);
impl ProviderClient {
    pub fn new(
        github: Option<OAuthCredentials>,
        discord: Option<OAuthCredentials>,
    ) -> Result<Self> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .user_agent("PrintPartner-Auth/0.1")
            .build()?;
        Ok(Self(Arc::new(Inner {
            github: github.map(|credentials| ProviderConfig {
                credentials,
                endpoints: Endpoints {
                    authorize: "https://github.com/login/oauth/authorize",
                    token: "https://github.com/login/oauth/access_token".into(),
                    profile: "https://api.github.com/user".into(),
                    email: Some("https://api.github.com/user/emails".into()),
                },
            }),
            discord: discord.map(|credentials| ProviderConfig {
                credentials,
                endpoints: Endpoints {
                    authorize: "https://discord.com/api/oauth2/authorize",
                    token: "https://discord.com/api/oauth2/token".into(),
                    profile: "https://discord.com/api/users/@me".into(),
                    email: None,
                },
            }),
            client,
            flows: Mutex::default(),
        })))
    }
    fn config(&self, provider: Provider) -> Option<&ProviderConfig> {
        match provider {
            Provider::Github => self.0.github.as_ref(),
            Provider::Discord => self.0.discord.as_ref(),
            Provider::Email => None,
        }
    }
    pub(super) fn configured(&self, provider: Provider) -> bool {
        self.config(provider).is_some()
    }
    fn start(&self, provider: Provider, callback: &str) -> Result<(String, String), Failure> {
        let config = self
            .config(provider)
            .ok_or(Failure(StatusCode::NOT_IMPLEMENTED, "OAuth not configured"))?;
        let state = random()?;
        let browser = random()?;
        let verifier = random()?;
        let now = Instant::now();
        let mut flows = self.0.flows.lock().expect("OAuth flow lock");
        flows.retain(|_, flow| flow.expires > now);
        if flows.len() >= 1024 {
            return Err(Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "OAuth flow capacity exceeded",
            ));
        }
        flows.insert(
            digest(&state),
            Flow {
                provider,
                browser: digest(&browser),
                expires: now + Duration::from_secs(600),
                verifier: verifier.clone(),
            },
        );
        let mut url = reqwest::Url::parse(config.endpoints.authorize).expect("fixed provider URL");
        url.query_pairs_mut()
            .append_pair("client_id", &config.credentials.client_id)
            .append_pair("redirect_uri", callback)
            .append_pair("state", &state);
        match provider {
            Provider::Github => {
                url.query_pairs_mut()
                    .append_pair("scope", "read:user user:email")
                    .append_pair("code_challenge", &URL_SAFE_NO_PAD.encode(digest(&verifier)))
                    .append_pair("code_challenge_method", "S256");
            }
            Provider::Discord => {
                url.query_pairs_mut()
                    .append_pair("response_type", "code")
                    .append_pair("scope", "identify email");
            }
            Provider::Email => unreachable!(),
        }
        Ok((url.into(), browser))
    }
    fn consume(&self, provider: Provider, state: &str, browser: &str) -> Result<Flow, Failure> {
        let now = Instant::now();
        let mut flows = self.0.flows.lock().expect("OAuth flow lock");
        flows.retain(|_, flow| flow.expires > now);
        let key = digest(state);
        if !flows
            .get(&key)
            .is_some_and(|flow| flow.provider == provider && flow.browser == digest(browser))
        {
            return Err(Failure(StatusCode::BAD_REQUEST, "Invalid OAuth state"));
        }
        Ok(flows.remove(&key).expect("checked flow"))
    }
    async fn exchange(
        &self,
        app: &App,
        provider: Provider,
        code: &str,
        callback: &str,
        flow: Flow,
    ) -> Result<Outcome, Failure> {
        let config = self.config(provider).expect("configured provider");
        let work = async {
            let credentials = &config.credentials;
            let request = self
                .0
                .client
                .post(&config.endpoints.token)
                .header("Accept", "application/json");
            let request = match provider {
                Provider::Github => request.json(&json!({"client_id":credentials.client_id,"client_secret":credentials.client_secret.expose(),"code":code,"redirect_uri":callback,"code_verifier":flow.verifier})),
                Provider::Discord => request.form(&[("client_id",credentials.client_id.as_str()),("client_secret",credentials.client_secret.expose()),("grant_type","authorization_code"),("code",code),("redirect_uri",callback)]),
                Provider::Email => unreachable!(),
            };
            let token_response = request.send().await.map_err(network)?;
            if !token_response.status().is_success() {
                return Err(Failure(StatusCode::UNAUTHORIZED, "OAuth failed"));
            }
            let token_json = bounded_json(token_response, StatusCode::UNAUTHORIZED).await?;
            let token = string(&token_json, "access_token")
                .ok_or(Failure(StatusCode::UNAUTHORIZED, "OAuth failed"))?;
            let profile_response = self
                .0
                .client
                .get(&config.endpoints.profile)
                .bearer_auth(token)
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(network)?;
            if !profile_response.status().is_success() {
                return Err(Failure(
                    StatusCode::BAD_GATEWAY,
                    "OAuth provider returned an invalid user profile",
                ));
            }
            let profile = bounded_json(profile_response, StatusCode::BAD_GATEWAY).await?;
            let (id, display, mut email) = parse_profile(provider, &profile)?;
            if provider == Provider::Github {
                let linked = matches!(
                    invoke(
                        &app.auth,
                        Request::IdentityExists {
                            provider,
                            provider_user_id: id.clone()
                        }
                    )
                    .await?,
                    Outcome::IdentityExists(true)
                );
                if !linked {
                    let response = self
                        .0
                        .client
                        .get(config.endpoints.email.as_ref().expect("GitHub email URL"))
                        .bearer_auth(token)
                        .header("Accept", "application/json")
                        .send()
                        .await
                        .map_err(network)?;
                    if response.status().is_success() {
                        let emails = bounded_json(response, StatusCode::BAD_GATEWAY).await?;
                        if let Some(items) = emails.as_array() {
                            let verified: Vec<_> = items
                                .iter()
                                .filter(|v| v["verified"] == true)
                                .filter_map(|v| {
                                    normalize_email(v["email"].as_str())
                                        .map(|email| (email, v["primary"] == true))
                                })
                                .collect();
                            email = verified
                                .iter()
                                .find(|(_, primary)| *primary)
                                .or(verified.first())
                                .map(|(email, _)| email.clone());
                        }
                    }
                }
            }
            Ok(Request::OAuthLogin {
                provider,
                provider_user_id: id,
                display_name: display,
                email,
            })
        };
        let request = tokio::time::timeout(Duration::from_secs(15), work)
            .await
            .map_err(|_| Failure(StatusCode::GATEWAY_TIMEOUT, "OAuth provider timed out"))??;
        invoke(&app.auth, request).await
    }
}
fn random() -> Result<String, Failure> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| Failure(StatusCode::INTERNAL_SERVER_ERROR, "OAuth unavailable"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn network(error: reqwest::Error) -> Failure {
    if error.is_timeout() {
        Failure(StatusCode::GATEWAY_TIMEOUT, "OAuth provider timed out")
    } else {
        Failure(StatusCode::BAD_GATEWAY, "OAuth provider unavailable")
    }
}
async fn bounded_json(
    mut response: reqwest::Response,
    status: StatusCode,
) -> Result<Value, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err(Failure(status, "Invalid OAuth response"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure(status, "Invalid OAuth response"))
}
fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 4096)
}
fn normalize_email(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| v.contains('@') && v.len() <= 320)
        .map(str::to_lowercase)
}
fn parse_profile(
    provider: Provider,
    profile: &Value,
) -> Result<(String, String, Option<String>), Failure> {
    let invalid = || {
        Failure(
            StatusCode::BAD_GATEWAY,
            "OAuth provider returned an invalid user profile",
        )
    };
    match provider {
        Provider::Github => {
            let id = profile["id"]
                .as_u64()
                .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
                .ok_or_else(invalid)?;
            let login = string(profile, "login").ok_or_else(invalid)?;
            Ok((
                id.to_string(),
                string(profile, "name").unwrap_or(login).to_owned(),
                None,
            ))
        }
        Provider::Discord => {
            let id = string(profile, "id")
                .filter(|v| v.bytes().all(|b| b.is_ascii_digit()))
                .ok_or_else(invalid)?;
            let username = string(profile, "username").ok_or_else(invalid)?;
            let email = if profile["verified"] == true {
                normalize_email(profile["email"].as_str())
            } else {
                None
            };
            Ok((
                id.into(),
                string(profile, "global_name").unwrap_or(username).into(),
                email,
            ))
        }
        Provider::Email => Err(invalid()),
    }
}
fn callback_url(app: &App, provider: Provider) -> String {
    format!(
        "{}{}",
        app.config.origin,
        if provider == Provider::Github {
            "/auth/callback"
        } else {
            "/auth/discord/callback"
        }
    )
}
fn start(app: App, provider: Provider) -> Result<Response, Failure> {
    let (url, browser) = app
        .providers
        .start(provider, &callback_url(&app, provider))?;
    let mut response = wire::redirect(&url);
    wire::set_cookie(
        &mut response,
        "oauth_state",
        &browser,
        600,
        app.config.transport,
    );
    Ok(response)
}
#[derive(Deserialize)]
pub(super) struct Callback {
    code: Option<String>,
    state: Option<String>,
}
async fn callback(
    app: App,
    provider: Provider,
    headers: HeaderMap,
    query: Callback,
) -> Result<Response, Failure> {
    if !app.providers.configured(provider) {
        return Err(Failure(StatusCode::NOT_IMPLEMENTED, "OAuth not configured"));
    }
    let code = query
        .code
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Invalid OAuth state"))?;
    let state = query
        .state
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Invalid OAuth state"))?;
    let browser = wire::cookie(&headers, "oauth_state")
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Invalid OAuth state"))?;
    let flow = app.providers.consume(provider, &state, &browser)?;
    let outcome = app
        .providers
        .exchange(&app, provider, &code, &callback_url(&app, provider), flow)
        .await?;
    let Outcome::Session { token, .. } = outcome else {
        unreachable!()
    };
    let mut response = wire::redirect("/");
    wire::set_cookie(
        &mut response,
        "pp_session",
        token.expose(),
        1209600,
        app.config.transport,
    );
    wire::set_cookie(&mut response, "oauth_state", "", 0, app.config.transport);
    Ok(response)
}
pub(super) async fn github_start(State(app): State<App>) -> Result<Response, Failure> {
    start(app, Provider::Github)
}
pub(super) async fn discord_start(State(app): State<App>) -> Result<Response, Failure> {
    start(app, Provider::Discord)
}
pub(super) async fn github_callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Result<Response, Failure> {
    callback(app, Provider::Github, headers, query).await
}
pub(super) async fn discord_callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Result<Response, Failure> {
    callback(app, Provider::Discord, headers, query).await
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
