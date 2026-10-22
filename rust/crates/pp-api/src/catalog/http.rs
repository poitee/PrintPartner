use super::wire;
use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use pp_storage::{
    WriterOwner,
    auth::{AuthFailure, AuthPolicy, Secret},
    catalog::{CatalogFailure, Credentials, Outcome, Request as CatalogRequest},
};
use serde_json::json;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct CatalogHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    policy: AuthPolicy,
    enabled: bool,
}

impl CatalogHttpConfig {
    pub fn new(origin: &str, api_key_tenant: &str, policy: AuthPolicy) -> Result<Self> {
        Self::from_startup(
            origin,
            api_key_tenant,
            policy,
            std::env::var("PP_DESKTOP_REBUILD").ok().as_deref(),
        )
    }

    /// `flag` is the process `PP_DESKTOP_REBUILD` value captured at startup.
    pub fn from_startup(
        origin: &str,
        api_key_tenant: &str,
        policy: AuthPolicy,
        flag: Option<&str>,
    ) -> Result<Self> {
        let url = reqwest::Url::parse(origin)?;
        ensure!(
            url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty()
                && url.password().is_none(),
            "Listener must be an origin"
        );
        let ip: IpAddr = url
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .parse()?;
        ensure!(
            ip.is_loopback() && matches!(url.scheme(), "http" | "https"),
            "Listener must be loopback HTTP"
        );
        ensure!(
            !api_key_tenant.trim().is_empty() && api_key_tenant.len() <= 512,
            "Invalid API key tenant"
        );
        let origin = url.origin().ascii_serialization();
        let host = origin
            .split_once("://")
            .ok_or_else(|| anyhow::anyhow!("Listener must be an origin"))?
            .1
            .to_owned();
        Ok(Self {
            origin,
            host,
            api_key_tenant: api_key_tenant.into(),
            policy,
            enabled: matches!(flag, Some("1" | "true")),
        })
    }
}

#[derive(Clone)]
struct App {
    config: CatalogHttpConfig,
    owner: Arc<Mutex<WriterOwner>>,
}

/// Mounts Source list, detail, create, metadata patch, and delete at `/` and
/// `/api/v1` when `PP_DESKTOP_REBUILD` was exactly `1` or `true` at startup.
/// Otherwise nothing is mounted. Sync and upload stay unregistered.
pub fn admit_catalog_routes(config: CatalogHttpConfig, owner: Arc<Mutex<WriterOwner>>) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let routes = Router::new()
        .route("/sources", get(list).post(create))
        .route(
            "/sources/{id}",
            get(detail).patch(patch_source).delete(delete_source),
        );
    let app = App { config, owner };
    Router::new()
        .merge(routes.clone())
        .nest("/api/v1", routes)
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(
    State(app): State<App>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    if let Err((status, detail)) = admit(&app.config, &request) {
        return reject(status, detail);
    }
    let Some(principal) = principal(request.headers(), &app.config.api_key_tenant) else {
        return reject(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    request.extensions_mut().insert(principal);
    next.run(request).await
}

fn admit(
    config: &CatalogHttpConfig,
    request: &axum::extract::Request,
) -> std::result::Result<(), (StatusCode, &'static str)> {
    let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Transport identity unavailable",
        ));
    };
    if !peer.ip().is_loopback() {
        return Err((StatusCode::FORBIDDEN, "Loopback transport required"));
    }
    let headers = request.headers();
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    if headers.get_all("host").iter().count() != 1
        || host != Some(config.host.as_str())
        || request
            .uri()
            .authority()
            .is_some_and(|authority| authority.as_str() != config.host)
        || headers
            .keys()
            .any(|key| key == "forwarded" || key.as_str().starts_with("x-forwarded-"))
    {
        return Err((StatusCode::FORBIDDEN, "Invalid request host"));
    }
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    let reading = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if headers.get_all("origin").iter().count() > 1
        || (headers.contains_key("origin") && origin != Some(config.origin.as_str()))
        || (!reading && origin != Some(config.origin.as_str()) && !has_api_key(headers))
        || headers
            .get_all("sec-fetch-site")
            .iter()
            .any(|value| value == "cross-site")
    {
        return Err((StatusCode::FORBIDDEN, "Invalid request origin"));
    }
    Ok(())
}

#[derive(Clone)]
enum Principal {
    Session(String),
    ApiKey { tenant: String, secret: String },
}

fn principal(headers: &HeaderMap, tenant: &str) -> Option<Principal> {
    let mut session = None;
    for header in headers.get_all("cookie") {
        for item in header.to_str().ok()?.split(';') {
            if let Some(("pp_session", value)) = item.trim().split_once('=')
                && session.replace(value).is_some()
            {
                return None;
            }
        }
    }
    let auth = headers.get("authorization");
    let custom = headers.get("x-print-partner-api-key");
    if headers.get_all("authorization").iter().count() > 1
        || headers.get_all("x-print-partner-api-key").iter().count() > 1
        || usize::from(session.is_some())
            + usize::from(auth.is_some())
            + usize::from(custom.is_some())
            != 1
    {
        return None;
    }
    if let Some(value) = session {
        return (!value.is_empty() && value.len() <= 4096)
            .then(|| Principal::Session(value.into()));
    }
    let key = if let Some(value) = auth {
        value.to_str().ok()?.strip_prefix("Bearer ")?
    } else {
        custom?.to_str().ok()?
    }
    .trim();
    (!key.is_empty() && key.len() <= 4096).then(|| Principal::ApiKey {
        tenant: tenant.into(),
        secret: key.into(),
    })
}

fn has_api_key(headers: &HeaderMap) -> bool {
    matches!(principal(headers, ""), Some(Principal::ApiKey { .. }))
}

fn credentials(principal: Principal) -> Credentials {
    match principal {
        Principal::Session(token) => Credentials::Session(Secret::new(token)),
        Principal::ApiKey { tenant, secret } => Credentials::Key {
            tenant_id: tenant,
            key: Secret::new(secret),
        },
    }
}

async fn list(State(app): State<App>, Extension(principal): Extension<Principal>) -> Response {
    execute(&app, credentials(principal), CatalogRequest::List {}).await
}

async fn create(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    body: Bytes,
) -> Response {
    let Some(body) = object_body(&body) else {
        return reject(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    if let Some(response) = refused_local_path(&body) {
        return response;
    }
    execute(
        &app,
        credentials(principal),
        CatalogRequest::CreateCatalogSource {
            source: wire::source_create(&body),
        },
    )
    .await
}

async fn delete_source(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Response {
    let Some(id) = source_id(&id) else {
        return reject(StatusCode::NOT_FOUND, "Source not found");
    };
    execute(&app, credentials(principal), CatalogRequest::Delete { id }).await
}

async fn detail(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Response {
    let Some(id) = source_id(&id) else {
        return reject(StatusCode::NOT_FOUND, "Source not found");
    };
    execute(&app, credentials(principal), CatalogRequest::Get { id }).await
}

async fn patch_source(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(id) = source_id(&id) else {
        return reject(StatusCode::NOT_FOUND, "Source not found");
    };
    let Some(body) = object_body(&body) else {
        return reject(StatusCode::BAD_REQUEST, "Invalid JSON body");
    };
    if let Some(response) = refused_local_path(&body) {
        return response;
    }
    execute(
        &app,
        credentials(principal),
        CatalogRequest::UpdateCatalogSource {
            id,
            patch: wire::source_patch(&body),
        },
    )
    .await
}

fn object_body(bytes: &[u8]) -> Option<serde_json::Value> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .filter(serde_json::Value::is_object)
}

fn refused_local_path(body: &serde_json::Value) -> Option<Response> {
    body.get("local_path")
        .is_some_and(|value| !value.is_null())
        .then(|| {
            reject(
                StatusCode::BAD_REQUEST,
                "Raw local_path requires native Source selection",
            )
        })
}

fn source_id(raw: &str) -> Option<i64> {
    let id = raw.parse::<i64>().ok()?;
    (raw == id.to_string()).then_some(id)
}

async fn execute(app: &App, credentials: Credentials, request: CatalogRequest) -> Response {
    let policy = app.config.policy;
    let client = {
        let Ok(owner) = app.owner.lock() else {
            return reject(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable");
        };
        match owner.source_catalog_with_policy(credentials, policy) {
            Ok(client) => client,
            Err(_) => return reject(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
        }
    };
    let outcome = match tokio::task::spawn_blocking(move || client.execute(request)).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => return catalog_error(error),
        Err(_) => return reject(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    };
    match outcome {
        Outcome::Sources(rows) => Json(wire::sources(rows)).into_response(),
        Outcome::Source(Some(row)) => match wire::source(*row) {
            Ok(value) => Json(value).into_response(),
            Err(_) => reject(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
        },
        Outcome::Source(None) => reject(StatusCode::NOT_FOUND, "Source not found"),
        Outcome::Deletion(outcome) => deletion_response(wire::source_deletion(outcome)),
        _ => reject(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    }
}

fn deletion_response(mapped: wire::DeletionHttp) -> Response {
    match mapped {
        wire::DeletionHttp::Deleted => StatusCode::NO_CONTENT.into_response(),
        wire::DeletionHttp::Refused {
            status: 404,
            detail,
        } => reject(StatusCode::NOT_FOUND, detail),
        wire::DeletionHttp::Refused {
            status: 409,
            detail,
        } => reject(StatusCode::CONFLICT, detail),
        wire::DeletionHttp::Refused { detail, .. } => {
            reject(StatusCode::INTERNAL_SERVER_ERROR, detail)
        }
    }
}

fn catalog_error(error: anyhow::Error) -> Response {
    if let Some(failure) = error.downcast_ref::<AuthFailure>() {
        return match failure {
            AuthFailure::QueueFull | AuthFailure::Stopped => reject(
                StatusCode::SERVICE_UNAVAILABLE,
                "Catalog temporarily unavailable",
            ),
            AuthFailure::CredentialChanged => reject(
                StatusCode::UNAUTHORIZED,
                "Credential changed; sign in again",
            ),
            _ => reject(StatusCode::UNAUTHORIZED, "Authentication required"),
        };
    }
    if let Some(failure) = error.downcast_ref::<CatalogFailure>() {
        let (status, detail) = match failure {
            CatalogFailure::NotFound => (StatusCode::NOT_FOUND, "Source not found".to_owned()),
            CatalogFailure::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "Catalog request too large".to_owned(),
            ),
            CatalogFailure::Conflict => (
                StatusCode::CONFLICT,
                "Catalog metadata changed; retry from the current version".to_owned(),
            ),
            CatalogFailure::InvalidStoredNaming => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Catalog unavailable".to_owned(),
            ),
            CatalogFailure::Input(_)
            | CatalogFailure::DuplicateName(_)
            | CatalogFailure::Referenced => (StatusCode::BAD_REQUEST, error.to_string()),
            CatalogFailure::Conflict => {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "code": "catalog_metadata_conflict",
                        "detail": failure.to_string(),
                    })),
                )
                    .into_response();
            }
        };
        return reject(status, detail);
    }
    let (status, detail) = match error.to_string().as_str() {
        "Authentication required" | "Invalid session" => {
            (StatusCode::UNAUTHORIZED, "Authentication required")
        }
        "Writer queue full" | "Storage stopped" | "Cancelled before admission" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Catalog temporarily unavailable",
        ),
        "Source not found" => (StatusCode::NOT_FOUND, "Source not found"),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    };
    reject(status, detail)
}

fn reject(status: StatusCode, detail: impl AsRef<str>) -> Response {
    (status, Json(json!({ "detail": detail.as_ref() }))).into_response()
}
