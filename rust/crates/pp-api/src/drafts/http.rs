use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Extension, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use pp_storage::{
    auth::{self, AuthFailure, Secret, rebuild::RebuildAuthClient},
    read_model::Credential,
    required_units::AdmissionFailure,
    working_drafts::{
        DraftIdentity, DraftList, Failure, Outcome, PositiveId, Request, WorkingDraftClient,
    },
};
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const ADMISSION_PERMITS: usize = 64;
const READ_PERMITS: usize = 64;
const TARGET_LIMIT: usize = 16 * 1024;
const READ_BODY_LIMIT: usize = 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const READ_DETAIL: &str = "Plan draft data is inconsistent";

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
    let Some(presented) = principal(request.headers(), &config.api_key_tenant) else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    request.extensions_mut().insert(presented);
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
                Some(PresentedCredential::ApiKey { .. })
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
/// Storage accepts it before a read handler runs.
#[derive(Clone)]
enum PresentedCredential {
    Session(String),
    ApiKey { tenant: String, secret: String },
}

fn principal(headers: &HeaderMap, tenant: &str) -> Option<PresentedCredential> {
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
            .then(|| PresentedCredential::Session(value.into()));
    }
    let key = if let Some(value) = auth {
        value.to_str().ok()?.strip_prefix("Bearer ")?
    } else {
        custom?.to_str().ok()?
    }
    .trim();
    (!key.is_empty() && key.len() <= 4096).then(|| PresentedCredential::ApiKey {
        tenant: tenant.into(),
        secret: key.into(),
    })
}

fn failure(status: StatusCode, detail: &str) -> Response {
    (status, Json(json!({"detail":detail}))).into_response()
}

#[cfg(test)]
type WorkerHold = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
struct App {
    client: WorkingDraftClient,
    auth: RebuildAuthClient,
    wait: Duration,
    waiters: Arc<Semaphore>,
    #[cfg(test)]
    hold: Option<WorkerHold>,
}

/// Result of a storage read that has already accepted the credential.
#[derive(Clone)]
struct Authorized {
    profile: PositiveId,
    outcome: Arc<Outcome>,
}

struct CancelOnDrop {
    flag: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.flag.store(true, Ordering::Release);
        }
    }
}

enum ReadError {
    Busy,
    Worker,
    Storage(anyhow::Error),
}

/// Mounts list and workspace reads when the startup gate is on.
/// Storage accepts the presented credential before either handler runs.
/// API-key reads also resolve the key so `lastUsedAt` commits as Node does.
/// A disabled gate mounts nothing.
pub fn draft_router(
    config: DraftHttpConfig,
    client: WorkingDraftClient,
    auth: RebuildAuthClient,
) -> Router {
    mount(
        config,
        client,
        auth,
        #[cfg(test)]
        None,
    )
}

#[cfg(test)]
fn draft_router_with_hold(
    config: DraftHttpConfig,
    client: WorkingDraftClient,
    auth: RebuildAuthClient,
    hold: WorkerHold,
) -> Router {
    mount(config, client, auth, Some(hold))
}

fn mount(
    config: DraftHttpConfig,
    client: WorkingDraftClient,
    auth: RebuildAuthClient,
    #[cfg(test)] hold: Option<WorkerHold>,
) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let app = App {
        client,
        auth,
        wait: config.wait,
        waiters: Arc::new(Semaphore::new(READ_PERMITS)),
        #[cfg(test)]
        hold,
    };
    let routes = Router::new()
        .route("/plans/{id}/drafts", get(list))
        .route("/plans/{id}/drafts/{draft_id}", get(workspace))
        .route_layer(middleware::from_fn_with_state(app, authorize));
    admit_draft_routes(config, routes)
}

impl PresentedCredential {
    fn into_credential(self) -> Credential {
        match self {
            Self::Session(value) => Credential::Session(Secret::new(value)),
            Self::ApiKey { tenant, secret } => Credential::ApiKey {
                routed_tenant: tenant,
                secret: Secret::new(secret),
            },
        }
    }
}

async fn authorize(
    State(app): State<App>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let Some(presented) = request.extensions_mut().remove::<PresentedCredential>() else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return next.run(request).await;
    }
    let path = request.uri().path().to_owned();
    let Some((profile, operation)) = read_target(&path) else {
        return invalid_request();
    };
    let (operation_name, draft_id) = match &operation {
        Request::List => ("list", None),
        Request::Read { draft_id }
        | Request::Diff { draft_id }
        | Request::Workspace { draft_id } => ("read", Some(*draft_id)),
    };
    match load(&app, presented, profile, operation).await {
        Ok(outcome) => {
            request.extensions_mut().insert(Authorized {
                profile,
                outcome: Arc::new(outcome),
            });
            next.run(request).await
        }
        Err(error) => {
            let (class, response) = match error {
                ReadError::Worker => ("worker_failure", internal_error()),
                ReadError::Storage(error) => (error_class(&error), storage_failure(&error)),
                ReadError::Busy => (
                    "read_pool_exhausted",
                    failure(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Draft service temporarily unavailable",
                    ),
                ),
            };
            if response.status().is_server_error() {
                log::error!(
                    target: "pp_api::drafts",
                    "Draft HTTP failed; operation={operation_name} profile_id={profile:?} draft_id={draft_id:?} error_class={class}"
                );
            }
            response
        }
    }
}

async fn load(
    app: &App,
    presented: PresentedCredential,
    profile: PositiveId,
    operation: Request,
) -> std::result::Result<Outcome, ReadError> {
    let Ok(permit) = app.waiters.clone().try_acquire_owned() else {
        return Err(ReadError::Busy);
    };
    let flag = Arc::new(AtomicBool::new(false));
    let mut cancel = CancelOnDrop {
        flag: Arc::clone(&flag),
        armed: true,
    };
    let client = app.client.clone();
    let auth = app.auth.clone();
    let wait = app.wait;
    #[cfg(test)]
    let hold = app.hold.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        #[cfg(test)]
        if let Some(hold) = hold {
            hold();
        }
        if flag.load(Ordering::Acquire) {
            return Err(anyhow::Error::new(Failure::Cancelled));
        }
        if let PresentedCredential::ApiKey { tenant, secret } = &presented {
            let resolved = auth
                .submit(
                    auth::Request::ResolveKey {
                        tenant_id: tenant.clone(),
                        key: Secret::new(secret.clone()),
                    },
                    Arc::clone(&flag),
                    wait,
                )?
                .recv()
                .map_err(|_| AuthFailure::CommitUnknown)??;
            match resolved {
                auth::Outcome::KeyResolved { principal, .. } => {
                    ensure!(
                        principal.is_some_and(|key| key.tenant_id == *tenant),
                        AuthFailure::InvalidCredentials
                    );
                }
                _ => return Err(AuthFailure::Storage.into()),
            }
        }
        client.execute(presented.into_credential(), profile, operation, flag, wait)
    })
    .await;
    cancel.armed = false;
    match joined {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(error)) => Err(ReadError::Storage(error)),
        Err(_) => Err(ReadError::Worker),
    }
}

fn read_target(path: &str) -> Option<(PositiveId, Request)> {
    let path = path.strip_prefix("/api/v2").unwrap_or(path);
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    if parts.next()? != "plans" {
        return None;
    }
    let profile = path_id(parts.next()?)?;
    if parts.next()? != "drafts" {
        return None;
    }
    match parts.next() {
        None => parts.next().is_none().then_some((profile, Request::List)),
        Some(draft) => {
            let draft_id = path_id(draft)?;
            parts
                .next()
                .is_none()
                .then_some((profile, Request::Workspace { draft_id }))
        }
    }
}

fn path_id(value: &str) -> Option<PositiveId> {
    PositiveId::new(value.parse().ok()?).ok()
}

async fn list(Extension(read): Extension<Authorized>) -> Response {
    match read.outcome.as_ref() {
        Outcome::Listed { drafts } => json_response(StatusCode::OK, listed(read.profile, drafts)),
        Outcome::ProfileNotFound => profile_missing(),
        _ => internal_error(),
    }
}

async fn workspace(Extension(read): Extension<Authorized>) -> Response {
    match read.outcome.as_ref() {
        Outcome::Workspace { workspace } => json_response(StatusCode::OK, workspace),
        Outcome::ProfileNotFound => profile_missing(),
        Outcome::DraftNotFound => draft_missing(),
        _ => internal_error(),
    }
}

fn listed(profile: PositiveId, drafts: &DraftList) -> Value {
    json!({
        "profile_id": profile,
        "drafts": drafts.iter().map(identity).collect::<Vec<_>>()
    })
}

fn identity(draft: &DraftIdentity) -> Value {
    json!({
        "draft_id": draft.draft_id(),
        "state": draft.state().as_str(),
        "lifecycle_version": draft.lifecycle_version(),
        "snapshot_digest": draft.snapshot_digest(),
        "base": {
            "revision_id": draft.base_revision_id(),
            "plan_version": draft.base_plan_version(),
        }
    })
}

fn error_class(error: &anyhow::Error) -> &'static str {
    if matches!(
        error.downcast_ref::<Failure>(),
        Some(Failure::CorruptOrigin)
    ) {
        "draft_integrity"
    } else if error.is::<AuthFailure>() {
        "auth_storage"
    } else {
        "unexpected_storage"
    }
}

fn storage_failure(error: &anyhow::Error) -> Response {
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
            AuthFailure::QueueFull => unavailable("writer_queue_full"),
            AuthFailure::Stopped => unavailable("writer_stopped"),
            AuthFailure::CommitUnknown => unavailable("outcome_unknown"),
            _ => internal_error(),
        };
    }
    if let Some(draft) = error.downcast_ref::<Failure>() {
        return match draft {
            Failure::Cancelled => unavailable("request_cancelled"),
            Failure::QueueFull => unavailable("writer_queue_full"),
            Failure::Stopped => unavailable("writer_stopped"),
            Failure::OutcomeUnknown => unavailable("outcome_unknown"),
            Failure::CorruptOrigin => internal_error(),
        };
    }
    if let Some(admission) = error.downcast_ref::<AdmissionFailure>() {
        return unavailable(match admission {
            AdmissionFailure::Cancelled => "request_cancelled",
            AdmissionFailure::QueueFull => "writer_queue_full",
            AdmissionFailure::Stopped => "writer_stopped",
            AdmissionFailure::OutcomeUnknown => "outcome_unknown",
        });
    }
    match error.to_string().as_str() {
        "Authentication required" => failure(StatusCode::UNAUTHORIZED, "Authentication required"),
        "Cancelled before admission" => unavailable("request_cancelled"),
        "Writer queue full" => unavailable("writer_queue_full"),
        "Storage stopped" | "Storage stopped without read result" | "Writer admission poisoned" => {
            unavailable("writer_stopped")
        }
        "Writer transaction admission deadline expired" | "database is locked" => coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "Plan draft update is unavailable",
            "transaction_unavailable",
        ),
        _ => internal_error(),
    }
}

fn internal_error() -> Response {
    coded(
        StatusCode::INTERNAL_SERVER_ERROR,
        READ_DETAIL,
        "internal_error",
    )
}
fn profile_missing() -> Response {
    coded(StatusCode::NOT_FOUND, "Plan not found", "profile_not_found")
}
fn draft_missing() -> Response {
    coded(
        StatusCode::NOT_FOUND,
        "Plan draft not found",
        "draft_not_found",
    )
}
fn unavailable(code: &str) -> Response {
    coded(
        StatusCode::SERVICE_UNAVAILABLE,
        "Draft service temporarily unavailable",
        code,
    )
}
fn invalid_request() -> Response {
    coded(
        StatusCode::BAD_REQUEST,
        "Request is invalid",
        "invalid_request",
    )
}
fn coded(status: StatusCode, detail: &str, code: &str) -> Response {
    json_response(status, json!({"detail": detail, "code": code}))
}
fn json_response(status: StatusCode, value: impl serde::Serialize) -> Response {
    (status, Json(value)).into_response()
}

#[cfg(test)]
#[path = "http/tests.rs"]
mod tests;
