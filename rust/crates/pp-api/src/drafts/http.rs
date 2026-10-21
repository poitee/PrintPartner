use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const ADMISSION_PERMITS: usize = 64;
const TARGET_LIMIT: usize = 16 * 1024;
const READ_BODY_LIMIT: usize = 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct DraftHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    enabled: bool,
    body_limit: usize,
    /// Storage wait; GRE-940 read handlers consume it.
    wait: Duration,
}

impl DraftHttpConfig {
    pub fn new(origin: &str, api_key_tenant: &str) -> Result<Self> {
        Self::from_startup(
            origin,
            api_key_tenant,
            std::env::var("PP_DESKTOP_REBUILD").ok().as_deref(),
        )
    }

    fn from_startup(origin: &str, api_key_tenant: &str, flag: Option<&str>) -> Result<Self> {
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
            enabled: matches!(flag, Some("1" | "true")),
            body_limit: 8 * 1024 * 1024,
            wait: Duration::from_millis(100),
        })
    }

    /// Lowers the PATCH body limit and storage wait; raising either fails.
    pub fn with_limits(mut self, body_limit: usize, wait: Duration) -> Result<Self> {
        ensure!(
            (1..=self.body_limit).contains(&body_limit) && wait <= self.wait,
            "Draft limits can only be lowered"
        );
        self.body_limit = body_limit;
        self.wait = wait;
        Ok(self)
    }
}

#[derive(Clone)]
struct Guard {
    config: DraftHttpConfig,
    admission: Arc<Semaphore>,
}

/// Mounts `routes` at the root and `/api/v2` behind loopback admission when
/// `PP_DESKTOP_REBUILD` was exactly `1` or `true` at startup. Otherwise
/// nothing is mounted and every request falls through to 404.
///
/// The guard buffers each body before routing, so Axum's 2 MiB extractor
/// default is disabled and the guard's limits are authoritative.
pub fn admit_draft_routes(config: DraftHttpConfig, routes: Router) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let guard_state = Guard {
        config,
        admission: Arc::new(Semaphore::new(ADMISSION_PERMITS)),
    };
    Router::new()
        .merge(routes.clone())
        .nest("/api/v2", routes)
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(guard_state, guard))
}

async fn guard(
    State(Guard { config, admission }): State<Guard>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let Ok(permit) = admission.try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Draft service temporarily unavailable",
        );
    };
    if request.uri().to_string().len() > TARGET_LIMIT {
        return failure(StatusCode::URI_TOO_LONG, "Request target too long");
    }
    if let Err((status, detail)) = admit(&config, &request) {
        return failure(status, detail);
    }
    let Some(principal) = principal(request.headers(), &config.api_key_tenant) else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    request.extensions_mut().insert(principal);
    let limit = match *request.method() {
        Method::PATCH => config.body_limit,
        _ => config.body_limit.min(READ_BODY_LIMIT),
    };
    let (parts, body) = request.into_parts();
    let bytes = match tokio::time::timeout(BODY_TIMEOUT, to_bytes(body, limit)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return failure(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        Err(_) => return failure(StatusCode::REQUEST_TIMEOUT, "Request body timed out"),
    };
    let response = next
        .run(axum::extract::Request::from_parts(parts, Body::from(bytes)))
        .await;
    response.map(|body| {
        Body::new(AdmittedBody {
            body,
            _permit: permit,
        })
    })
}

/// Holds an admission permit until the response body is consumed or dropped.
struct AdmittedBody {
    body: Body,
    _permit: OwnedSemaphorePermit,
}

impl http_body::Body for AdmittedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<http_body::Frame<Bytes>, Self::Error>>> {
        Pin::new(&mut self.body).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

fn admit(
    config: &DraftHttpConfig,
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
    let authority = request.uri().authority().map(|value| value.as_str());
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    if headers.get_all("host").iter().count() > 1
        || (headers.contains_key("host") && host != Some(&config.host))
        || authority.or(host) != Some(&config.host)
        || headers
            .keys()
            .any(|key| key == "forwarded" || key.as_str().starts_with("x-forwarded-"))
    {
        return Err((StatusCode::FORBIDDEN, "Invalid request host"));
    }
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    if headers.get_all("origin").iter().count() > 1
        || (headers.contains_key("origin") && origin != Some(&config.origin))
        || (!matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        ) && origin != Some(&config.origin)
            && !matches!(
                principal(headers, &config.api_key_tenant),
                Some(Principal::ApiKey { .. })
            ))
        || headers
            .get_all("sec-fetch-site")
            .iter()
            .any(|value| value == "cross-site")
    {
        return Err((StatusCode::FORBIDDEN, "Invalid request origin"));
    }
    Ok(())
}

/// The one credential a draft request presented. API keys route to the
/// configured tenant; request headers cannot select another tenant.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "GRE-940 read handlers convert it to a storage credential"
    )
)]
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

fn failure(status: StatusCode, detail: &str) -> Response {
    (status, Json(json!({"detail":detail}))).into_response()
}

#[cfg(test)]
#[path = "http/tests.rs"]
mod tests;
