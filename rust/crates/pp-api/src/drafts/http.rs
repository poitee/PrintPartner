use anyhow::{Result, ensure};
use axum::{
    Extension, Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch},
};
use pp_storage::{
    auth::{self, AuthFailure, Secret, rebuild::RebuildAuthClient},
    read_model::Credential,
    required_units::{AdmissionFailure, Outcome as WorkspaceOutcome},
    working_drafts::{
        DraftIdentity, EditRequest, Failure, Outcome, PositiveId, Request, WorkingDraftClient,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

#[derive(Clone)]
pub struct DraftHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    enabled: bool,
    body_limit: usize,
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

    pub fn with_limits(mut self, body_limit: usize, wait: Duration) -> Result<Self> {
        ensure!(
            (1..=self.body_limit).contains(&body_limit) && wait <= self.wait,
            "Draft HTTP limits may only be reduced"
        );
        self.body_limit = body_limit;
        self.wait = wait;
        Ok(self)
    }
}

#[derive(Clone)]
struct App {
    config: DraftHttpConfig,
    client: WorkingDraftClient,
    auth: RebuildAuthClient,
    admission: Arc<tokio::sync::Semaphore>,
    waiters: Arc<tokio::sync::Semaphore>,
}

pub fn draft_router(
    config: DraftHttpConfig,
    client: WorkingDraftClient,
    auth: RebuildAuthClient,
) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let app = App {
        config,
        client,
        auth,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        waiters: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let routes = Router::new()
        .route("/plans/{id}/drafts", get(list))
        .route("/plans/{id}/drafts/{draft_id}", get(workspace))
        .route(
            "/plans/{id}/drafts/{draft_id}/parts",
            patch(edit).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        );
    Router::new()
        .merge(routes.clone())
        .nest("/api/v2", routes)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(
    State(app): State<App>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let Ok(permit) = app.admission.clone().try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Draft service temporarily unavailable",
        );
    };
    if request.uri().to_string().len() > 16_384 {
        return failure(StatusCode::URI_TOO_LONG, "Request target too long");
    }
    if let Err((status, detail)) = admit(&app.config, &request) {
        return failure(status, detail);
    }
    let principal = match principal(request.headers(), &app.config.api_key_tenant) {
        Some(value) => value,
        None => return failure(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    request.extensions_mut().insert(principal);
    let limit = if request.method() == Method::PATCH {
        app.config.body_limit
    } else {
        app.config.body_limit.min(1024 * 1024)
    };
    let (parts, body) = request.into_parts();
    let bytes = match tokio::time::timeout(Duration::from_secs(5), to_bytes(body, limit)).await {
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

struct AdmittedBody {
    body: Body,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl http_body::Body for AdmittedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
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
        ) && origin != Some(&config.origin))
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
impl Principal {
    fn credential(self) -> Credential {
        match self {
            Self::Session(value) => Credential::Session(Secret::new(value)),
            Self::ApiKey { tenant, secret } => Credential::ApiKey {
                routed_tenant: tenant,
                secret: Secret::new(secret),
            },
        }
    }
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

#[derive(Deserialize)]
struct PlanPath {
    #[serde(deserialize_with = "path_id")]
    id: PositiveId,
}
#[derive(Deserialize)]
struct DraftPath {
    #[serde(deserialize_with = "path_id")]
    id: PositiveId,
    #[serde(deserialize_with = "path_id")]
    draft_id: PositiveId,
}

fn path_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<PositiveId, D::Error> {
    let value = String::deserialize(deserializer)?;
    let number = value.parse::<u64>().map_err(serde::de::Error::custom)?;
    PositiveId::new(number).map_err(serde::de::Error::custom)
}

type ExtractedPath<T> = std::result::Result<Path<T>, axum::extract::rejection::PathRejection>;

async fn list(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    path: ExtractedPath<PlanPath>,
) -> Response {
    let Ok(Path(path)) = path else {
        return invalid_request();
    };
    call(app, principal, path.id, Operation::Read(Request::List)).await
}
async fn workspace(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    path: ExtractedPath<DraftPath>,
) -> Response {
    let Ok(Path(path)) = path else {
        return invalid_request();
    };
    call(
        app,
        principal,
        path.id,
        Operation::Read(Request::Workspace {
            draft_id: path.draft_id,
        }),
    )
    .await
}
async fn edit(
    State(app): State<App>,
    Extension(principal): Extension<Principal>,
    path: ExtractedPath<DraftPath>,
    body: Bytes,
) -> Response {
    let (Ok(Path(path)), Ok(request)) = (path, serde_json::from_slice::<EditRequest>(&body)) else {
        return invalid_request();
    };
    call(
        app,
        principal,
        path.id,
        Operation::Edit(path.draft_id, request),
    )
    .await
}

enum Operation {
    Read(Request),
    Edit(PositiveId, EditRequest),
}
enum Reply {
    Read(Outcome),
    Edited(WorkspaceOutcome),
}
struct Cancellation(Arc<AtomicBool>);
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

async fn call(
    app: App,
    principal: Principal,
    profile: PositiveId,
    operation: Operation,
) -> Response {
    let Ok(permit) = app.waiters.clone().try_acquire_owned() else {
        return failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Draft service temporarily unavailable",
        );
    };
    let cancellation = Cancellation(Arc::new(AtomicBool::new(false)));
    let flag = cancellation.0.clone();
    let internal_detail = match &operation {
        Operation::Read(_) => "Plan draft data is inconsistent",
        Operation::Edit(..) => "Plan draft update failed",
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if matches!(&operation, Operation::Read(_))
            && let Principal::ApiKey { tenant, secret } = &principal
        {
            let resolved = app
                .auth
                .submit(
                    auth::Request::ResolveKey {
                        tenant_id: tenant.clone(),
                        key: Secret::new(secret.clone()),
                    },
                    flag.clone(),
                    app.config.wait,
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
        let credential = principal.credential();
        match operation {
            Operation::Read(request) => app
                .client
                .execute(credential, profile, request, flag, app.config.wait)
                .map(Reply::Read),
            Operation::Edit(draft, request) => app
                .client
                .edit(credential, profile, draft, request, flag, app.config.wait)
                .map(Reply::Edited),
        }
    })
    .await;
    match result {
        Ok(Ok(reply)) => present(reply, profile),
        Ok(Err(error)) => domain_error(error, internal_detail),
        Err(_) => internal_error(internal_detail),
    }
}

fn identity(draft: &DraftIdentity) -> Value {
    json!({"draft_id":draft.draft_id(),"state":draft.state().as_str(),
        "lifecycle_version":draft.lifecycle_version(),"snapshot_digest":draft.snapshot_digest(),
        "base":{"revision_id":draft.base_revision_id(),"plan_version":draft.base_plan_version()}})
}
fn present(reply: Reply, profile: PositiveId) -> Response {
    match reply {
        Reply::Read(Outcome::Listed { drafts }) => json_response(
            StatusCode::OK,
            json!({"profile_id":profile,"drafts":drafts.iter().map(identity).collect::<Vec<_>>()}),
        ),
        Reply::Read(Outcome::Workspace { workspace })
        | Reply::Edited(WorkspaceOutcome::Ready { workspace }) => {
            json_response(StatusCode::OK, workspace)
        }
        Reply::Read(Outcome::ProfileNotFound)
        | Reply::Edited(WorkspaceOutcome::ProfileNotFound) => profile_missing(),
        Reply::Read(Outcome::DraftNotFound) | Reply::Edited(WorkspaceOutcome::DraftNotFound) => {
            draft_missing()
        }
        Reply::Edited(WorkspaceOutcome::DraftChanged { workspace }) => conflict(
            "draft_changed",
            workspace.map_or_else(|| json!({}), |workspace| json!({"workspace":workspace})),
        ),
        Reply::Edited(WorkspaceOutcome::BaseChanged { workspace }) => {
            conflict("base_changed", json!({"workspace":workspace}))
        }
        Reply::Edited(WorkspaceOutcome::NotOpen { workspace }) => {
            conflict("not_open", json!({"workspace":workspace}))
        }
        Reply::Edited(WorkspaceOutcome::AcceptedBaselineRequired) => {
            conflict("accepted_baseline_required", json!({}))
        }
        Reply::Edited(WorkspaceOutcome::IdempotencyConflict) => {
            conflict("idempotency_conflict", json!({}))
        }
        Reply::Edited(WorkspaceOutcome::DomainError { code }) => coded_failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Plan draft update failed",
            code,
            json!({}),
        ),
        Reply::Read(Outcome::Read { .. } | Outcome::Diff { .. }) => {
            internal_error("Plan draft data is inconsistent")
        }
    }
}

fn domain_error(error: anyhow::Error, internal_detail: &str) -> Response {
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
            _ => internal_error(internal_detail),
        };
    }
    if let Some(draft) = error.downcast_ref::<Failure>() {
        return match draft {
            Failure::Cancelled => unavailable("request_cancelled"),
            Failure::QueueFull => unavailable("writer_queue_full"),
            Failure::Stopped => unavailable("writer_stopped"),
            Failure::OutcomeUnknown => unavailable("outcome_unknown"),
            Failure::CorruptOrigin => internal_error(internal_detail),
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
        "Writer transaction admission deadline expired" | "database is locked" => {
            unavailable("transaction_unavailable")
        }
        _ => internal_error(internal_detail),
    }
}
fn internal_error(detail: &str) -> Response {
    coded_failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        detail,
        "internal_error",
        json!({}),
    )
}
fn profile_missing() -> Response {
    coded_failure(
        StatusCode::NOT_FOUND,
        "Plan not found",
        "profile_not_found",
        json!({}),
    )
}
fn draft_missing() -> Response {
    coded_failure(
        StatusCode::NOT_FOUND,
        "Plan draft not found",
        "draft_not_found",
        json!({}),
    )
}
fn conflict(code: &str, extra: Value) -> Response {
    coded_failure(
        StatusCode::CONFLICT,
        "Plan draft update failed",
        code,
        extra,
    )
}
fn unavailable(code: &str) -> Response {
    coded_failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "Draft service temporarily unavailable",
        code,
        json!({}),
    )
}
fn invalid_request() -> Response {
    coded_failure(
        StatusCode::BAD_REQUEST,
        "Request is invalid",
        "invalid_request",
        json!({}),
    )
}
fn coded_failure(
    status: StatusCode,
    detail: &str,
    code: impl serde::Serialize,
    extra: Value,
) -> Response {
    let mut body = extra.as_object().cloned().unwrap_or_default();
    body.insert("detail".into(), json!(detail));
    body.insert("code".into(), json!(code));
    json_response(status, body)
}
fn json_response(status: StatusCode, value: impl serde::Serialize) -> Response {
    (status, Json(value)).into_response()
}
fn failure(status: StatusCode, detail: &str) -> Response {
    json_response(status, json!({"detail":detail}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_admission_requires_real_loopback_and_unique_host() {
        let config = DraftHttpConfig::new("http://127.0.0.1:1234", "default").unwrap();
        let mut request = axum::extract::Request::builder()
            .header("Host", "127.0.0.1:1234")
            .body(Body::empty())
            .unwrap();
        assert_eq!(admit(&config, &request).unwrap_err().0, 500);
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, 1], 9000))));
        assert_eq!(admit(&config, &request).unwrap_err().0, 403);
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 9000))));
        assert!(admit(&config, &request).is_ok());
        request
            .headers_mut()
            .append("Host", "127.0.0.1:1234".parse().unwrap());
        assert_eq!(admit(&config, &request).unwrap_err().0, 403);
    }

    #[test]
    fn authority_is_accepted_only_when_it_matches_the_configured_host() {
        let config = DraftHttpConfig::new("https://127.0.0.1:1234", "default").unwrap();
        for (uri, host, accepted) in [
            ("https://127.0.0.1:1234/plans/1/drafts", None, true),
            (
                "https://127.0.0.1:1234/plans/1/drafts",
                Some("127.0.0.1:1234"),
                true,
            ),
            (
                "https://127.0.0.1:1234/plans/1/drafts",
                Some("evil.test"),
                false,
            ),
            (
                "https://evil.test/plans/1/drafts",
                Some("127.0.0.1:1234"),
                false,
            ),
            ("/plans/1/drafts", Some("127.0.0.1:1234"), true),
            ("/plans/1/drafts", None, false),
        ] {
            let mut builder = axum::extract::Request::builder().uri(uri);
            if let Some(host) = host {
                builder = builder.header("host", host);
            }
            let mut request = builder.body(Body::empty()).unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 9000))));
            assert_eq!(admit(&config, &request).is_ok(), accepted, "{uri} {host:?}");
        }
    }

    #[tokio::test]
    async fn response_body_reserves_admission_until_consumed_or_dropped() {
        let admission = Arc::new(tokio::sync::Semaphore::new(1));
        for consume in [true, false] {
            let body = Body::new(AdmittedBody {
                body: Body::from("workspace response"),
                _permit: admission.clone().try_acquire_owned().unwrap(),
            });
            assert!(admission.clone().try_acquire_owned().is_err());
            if consume {
                assert_eq!(to_bytes(body, 1024).await.unwrap(), "workspace response");
            } else {
                drop(body);
            }
            assert_eq!(admission.available_permits(), 1);
        }
    }

    #[tokio::test]
    async fn storage_failures_keep_compatible_codes_and_hide_internal_details() {
        for (error, code) in [
            (
                anyhow::Error::new(AuthFailure::QueueFull),
                "writer_queue_full",
            ),
            (anyhow::Error::new(AuthFailure::Stopped), "writer_stopped"),
            (anyhow::Error::new(Failure::Cancelled), "request_cancelled"),
            (anyhow::Error::new(Failure::QueueFull), "writer_queue_full"),
            (anyhow::Error::new(Failure::Stopped), "writer_stopped"),
            (
                anyhow::Error::new(Failure::OutcomeUnknown),
                "outcome_unknown",
            ),
            (
                anyhow::Error::new(AuthFailure::CommitUnknown),
                "outcome_unknown",
            ),
            (
                anyhow::Error::new(AdmissionFailure::Cancelled),
                "request_cancelled",
            ),
            (
                anyhow::anyhow!("database is locked"),
                "transaction_unavailable",
            ),
        ] {
            let response = domain_error(error, "Plan draft data is inconsistent");
            assert_eq!(response.status(), 503);
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({"detail":"Draft service temporarily unavailable","code":code})
            );
        }
        assert!(DraftHttpConfig::new("http://example.test", "default").is_err());
        assert!(DraftHttpConfig::new("http://[::1]:1234", "default").is_ok());
        assert!(DraftHttpConfig::new("http://127.0.0.1", " ").is_err());
        assert!(DraftHttpConfig::new("http://127.0.0.1", &"t".repeat(512)).is_ok());
        assert!(DraftHttpConfig::new("http://127.0.0.1", &"t".repeat(513)).is_err());
    }
    #[test]
    fn dropped_handlers_keep_blocking_capacity_reserved_until_the_worker_exits() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut random = [0; 12];
            getrandom::fill(&mut random).unwrap();
            let directory = std::env::temp_dir().join(format!("pp-draft-cancel-{}", hex::encode(random)));
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("print-partner.db"), include_bytes!("../../../pp-storage/tests/fixtures/required-units/unchanged.db")).unwrap();
            let owner = pp_storage::WriterOwner::open(&directory, pp_storage::Limits::default()).unwrap().0;
            let policy = pp_storage::auth::AuthPolicy {
                registration: pp_storage::auth::RegistrationPolicy::Open,
                session_tenant: pp_storage::auth::SessionTenantPolicy::AccountTenant,
                first_user: pp_storage::auth::FirstUserTenant::NewUser,
            };
            let app = App {
                config: DraftHttpConfig::new("http://127.0.0.1:1234", "default").unwrap(),
                client: owner.working_drafts_with_policy(policy).unwrap(),
                auth: owner.rebuild_auth_with_policy(policy, Default::default()).unwrap(),
                admission: Arc::new(tokio::sync::Semaphore::new(1)),
                waiters: Arc::new(tokio::sync::Semaphore::new(1)),
            };
            let (release, held) = std::sync::mpsc::channel();
            let (entered, started) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(10)).unwrap();
            });
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            let principal = || Principal::Session("required-unit-fixture-secret".into());
            let profile = PositiveId::new(1).unwrap();
            let request = serde_json::from_value(json!({"expected_snapshot_digest":"ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3","decision":{"kind":"set_included","draft_part_ids":[5],"value":true}})).unwrap();
            let handler = tokio::spawn(call(app.clone(), principal(), profile, Operation::Edit(PositiveId::new(2).unwrap(), request)));
            tokio::time::timeout(Duration::from_secs(2), async {
                while app.waiters.available_permits() != 0 { tokio::task::yield_now().await; }
            }).await.unwrap();
            handler.abort();
            assert!(handler.await.unwrap_err().is_cancelled());
            let busy = call(app.clone(), principal(), profile, Operation::Read(Request::List)).await;
            assert_eq!(busy.status(), 503);
            release.send(()).unwrap();
            blocker.await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while app.waiters.available_permits() != 1 { tokio::task::yield_now().await; }
            }).await.unwrap();
            let recovered = call(app, principal(), profile, Operation::Read(Request::List)).await;
            assert_eq!(recovered.status(), 200);
            let connection = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
            assert_eq!(connection.query_row("SELECT included FROM plan_draft_parts WHERE id=5", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            drop(connection);
            owner.shutdown().unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        });
    }
}

#[cfg(test)]
#[path = "http/tests.rs"]
mod http_tests;
