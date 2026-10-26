//! Gated HTTP list and read-one for retained jobs (`GET`/`HEAD`).
use crate::loopback::{
    LoopbackOrigin, PresentedCredential, admit, principal, rebuild_flag_enabled,
    require_api_key_tenant,
};
use anyhow::Result;
use axum::{
    Router,
    extract::{Path, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use pp_storage::{
    auth::{AuthFailure, Secret},
    jobs::{
        AtomicJobClient, Credential, JobAccessFailure, JobSnapshot, LegacyListFilter,
        LegacyProfileFilter, LegacyStatusFilter, RetainedJobs,
    },
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const SERIALIZERS: usize = 2;

#[derive(Clone)]
pub struct JobsHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    enabled: bool,
    wait: Duration,
}

impl JobsHttpConfig {
    pub fn new(origin: &str, api_key_tenant: &str) -> Result<Self> {
        Self::from_startup(
            origin,
            api_key_tenant,
            std::env::var("PP_DESKTOP_REBUILD").ok().as_deref(),
        )
    }

    /// `flag` is the process `PP_DESKTOP_REBUILD` value captured at startup.
    pub fn from_startup(origin: &str, api_key_tenant: &str, flag: Option<&str>) -> Result<Self> {
        let listener = LoopbackOrigin::parse(origin)?;
        require_api_key_tenant(api_key_tenant)?;
        Ok(Self {
            origin: listener.origin,
            host: listener.host,
            api_key_tenant: api_key_tenant.into(),
            enabled: rebuild_flag_enabled(flag),
            wait: Duration::from_millis(100),
        })
    }

    pub fn with_wait(mut self, wait: Duration) -> Result<Self> {
        anyhow::ensure!(wait <= self.wait, "Jobs HTTP wait may only be reduced");
        self.wait = wait;
        Ok(self)
    }
}

#[derive(Clone)]
struct App {
    config: JobsHttpConfig,
    client: AtomicJobClient,
    admission: Arc<tokio::sync::Semaphore>,
    serializers: Arc<tokio::sync::Semaphore>,
}

struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Mounts `GET`/`HEAD` `/api/v1/jobs` plus read-one aliases `/jobs/{id}` and
/// `/api/v1/jobs/{id}` when `PP_DESKTOP_REBUILD` was exactly `1` or `true`.
/// Otherwise mounts nothing. Mutation routes and WS stay unregistered.
pub fn jobs_router(config: JobsHttpConfig, client: AtomicJobClient) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let app = App {
        config,
        client,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        serializers: Arc::new(tokio::sync::Semaphore::new(SERIALIZERS)),
    };
    Router::new()
        .route("/api/v1/jobs", get(list))
        .route("/jobs/{id}", get(detail))
        .route("/api/v1/jobs/{id}", get(detail))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(
    State(app): State<App>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let Ok(_permit) = app.admission.try_acquire() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Jobs service temporarily unavailable",
        );
    };
    if request.uri().to_string().len() > 16_384 {
        return failure(StatusCode::URI_TOO_LONG, "Request target too long");
    }
    if let Err((status, detail)) = admit(
        &app.config.origin,
        &app.config.host,
        &app.config.api_key_tenant,
        &request,
    ) {
        return failure(status, detail);
    }
    let Some(presented) = principal(request.headers(), &app.config.api_key_tenant) else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    request.extensions_mut().insert(presented);
    next.run(request).await
}

async fn list(State(app): State<App>, request: axum::extract::Request) -> Response {
    let Some(presented) = request.extensions().get::<PresentedCredential>().cloned() else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let filter = legacy_filter(request.uri().query());
    let head = *request.method() == Method::HEAD;
    let Ok(permit) = app.serializers.clone().try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Jobs service temporarily unavailable",
        );
    };
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancellation = Cancellation::new();
    let cancelled = cancellation.0.clone();
    match tokio::task::spawn_blocking(move || {
        let jobs = client.list_retained(job_credential(presented), filter, &cancelled, wait)?;
        let body = encode_jobs(&jobs)?;
        Ok::<_, anyhow::Error>((body, permit))
    })
    .await
    {
        Ok(Ok((body, _permit))) => json_bytes(StatusCode::OK, body, head),
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Jobs service unavailable",
        ),
    }
}

async fn detail(
    State(app): State<App>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let Some(presented) = request.extensions().get::<PresentedCredential>().cloned() else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let head = *request.method() == Method::HEAD;
    let Ok(permit) = app.serializers.clone().try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Jobs service temporarily unavailable",
        );
    };
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancellation = Cancellation::new();
    let cancelled = cancellation.0.clone();
    match tokio::task::spawn_blocking(move || {
        let job = client.read_public(job_credential(presented), id, &cancelled, wait)?;
        let body = encode_job(&job)?;
        Ok::<_, anyhow::Error>((body, permit))
    })
    .await
    {
        Ok(Ok((body, _permit))) => json_bytes(StatusCode::OK, body, head),
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Jobs service unavailable",
        ),
    }
}

fn encode_jobs(jobs: &RetainedJobs) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&json!({ "jobs": &**jobs }))?)
}

/// Node's read-one returns the stored snapshot; only its list adds `updated_at`.
fn encode_job(job: &JobSnapshot) -> Result<Vec<u8>> {
    let mut body = serde_json::to_value(job)?;
    if let Some(fields) = body.as_object_mut() {
        fields.remove("updated_at");
    }
    Ok(serde_json::to_vec(&body)?)
}

fn job_credential(presented: PresentedCredential) -> Credential {
    match presented {
        PresentedCredential::Session(value) => Credential::Session(Secret::new(value)),
        PresentedCredential::ApiKey { tenant, secret } => Credential::RoutedKey {
            tenant,
            key: Secret::new(secret),
        },
    }
}

/// Node's `/api/v1/jobs` query: `status`, `since` (RFC3339 → millis), `profile_id`.
fn legacy_filter(query: Option<&str>) -> LegacyListFilter {
    let mut values: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(query) = query
        && let Ok(url) = reqwest::Url::parse(&format!("http://localhost/?{query}"))
    {
        for (key, value) in url.query_pairs() {
            values
                .entry(key.into_owned())
                .or_default()
                .push(value.into_owned());
        }
    }
    let status = match values.get("status").map(Vec::as_slice) {
        None | Some([]) => LegacyStatusFilter::Any,
        Some([value]) if value.is_empty() => LegacyStatusFilter::Any,
        Some([value])
            if ["pending", "running", "done", "error", "cancelled"].contains(&value.as_str()) =>
        {
            LegacyStatusFilter::Exact(value.clone())
        }
        _ => LegacyStatusFilter::NoMatch,
    };
    let profile = match values.get("profile_id").map(Vec::as_slice) {
        None | Some([]) => LegacyProfileFilter::Any,
        Some([value]) if value.is_empty() => LegacyProfileFilter::Any,
        Some([value]) => parse_node_profile_id(value)
            .map(LegacyProfileFilter::Exact)
            .unwrap_or(LegacyProfileFilter::NoMatch),
        _ => LegacyProfileFilter::NoMatch,
    };
    let since_millis = match values.get("since").map(Vec::as_slice) {
        Some([value]) => {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .ok()
                .and_then(|value| i64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok())
        }
        _ => None,
    };
    LegacyListFilter {
        status,
        since_millis,
        profile,
    }
}

/// Node `Number(profile_id)` for the literal query fixtures (positive safe ints).
fn parse_node_profile_id(value: &str) -> Option<u64> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let parsed = value.trim().parse::<f64>().ok()?;
    (parsed.is_finite()
        && parsed > 0.0
        && parsed.fract() == 0.0
        && parsed <= MAX_SAFE_INTEGER as f64)
        .then_some(parsed as u64)
}

fn domain_error(error: anyhow::Error) -> Response {
    if let Some(access) = error.downcast_ref::<JobAccessFailure>() {
        return match access {
            JobAccessFailure::NotFound | JobAccessFailure::InternalOnly => {
                failure(StatusCode::NOT_FOUND, "Job not found")
            }
            JobAccessFailure::Capacity | JobAccessFailure::Stopped => failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Jobs service temporarily unavailable",
            ),
        };
    }
    if let Some(auth) = error.downcast_ref::<AuthFailure>() {
        return match auth {
            AuthFailure::SessionRequired
            | AuthFailure::InvalidCredentials
            | AuthFailure::CredentialChanged => {
                failure(StatusCode::UNAUTHORIZED, "Authentication required")
            }
            AuthFailure::OwnerMappingRequired => failure(
                StatusCode::FORBIDDEN,
                "Explicit account owner mapping is required",
            ),
            AuthFailure::QueueFull | AuthFailure::Stopped => failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Jobs service temporarily unavailable",
            ),
            _ => failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Jobs service unavailable",
            ),
        };
    }
    failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Jobs service unavailable",
    )
}

fn json_bytes(status: StatusCode, body: Vec<u8>, head: bool) -> Response {
    let length = body.len();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, length)
        .body(axum::body::Body::from(if head { Vec::new() } else { body }))
        .unwrap_or_else(|_| {
            failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Jobs service unavailable",
            )
        })
}

fn failure(status: StatusCode, detail: &str) -> Response {
    let body = serde_json::to_vec(&json!({ "detail": detail }))
        .unwrap_or_else(|_| br#"{"detail":"Jobs service unavailable"}"#.to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len())
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
