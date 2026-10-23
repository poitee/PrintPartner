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
    response::Response,
    routing::get,
};
use pp_storage::{
    auth::AuthFailure,
    build_graph::{
        BuildCommand, BuildGraphClient, BuildOutcome, Failure as BuildFailure, PositiveId,
        wire::profile_summary,
    },
};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone)]
pub struct BuildHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    enabled: bool,
    wait: Duration,
}

impl BuildHttpConfig {
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
        anyhow::ensure!(wait <= self.wait, "Build HTTP wait may only be reduced");
        self.wait = wait;
        Ok(self)
    }
}

#[derive(Clone)]
struct App {
    config: BuildHttpConfig,
    client: BuildGraphClient,
    admission: Arc<tokio::sync::Semaphore>,
    waiters: Arc<tokio::sync::Semaphore>,
}

struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    fn flag(&self) -> Arc<AtomicBool> {
        self.0.clone()
    }
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Mounts Plan list/detail GET+HEAD at `/`, `/api/v1`, and `/api/v2` when
/// `PP_DESKTOP_REBUILD` was exactly `1` or `true`. Otherwise mounts nothing.
pub fn build_router(config: BuildHttpConfig, client: BuildGraphClient) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let app = App {
        config,
        client,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        waiters: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let routes = Router::new()
        .route("/plans", get(list))
        .route("/plans/{id}", get(detail));
    Router::new()
        .merge(routes.clone())
        .nest("/api/v1", routes.clone())
        .nest("/api/v2", routes)
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
            "Build service temporarily unavailable",
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
    execute(app, request, BuildCommand::List).await
}

async fn detail(
    State(app): State<App>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let Some(build) = id
        .parse::<u64>()
        .ok()
        .and_then(|value| PositiveId::new(value).ok())
    else {
        return failure(StatusCode::BAD_REQUEST, "Request is invalid");
    };
    execute(app, request, BuildCommand::Read { build }).await
}

async fn execute(app: App, request: axum::extract::Request, command: BuildCommand) -> Response {
    let Some(presented) = request.extensions().get::<PresentedCredential>().cloned() else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let method = request.method().clone();
    let Ok(permit) = app.waiters.clone().try_acquire_owned() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &json!({"detail":"Build service temporarily unavailable","code":"writer_queue_full"}),
            false,
        );
    };
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancellation = Cancellation::new();
    let cancelled = cancellation.flag();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        client.execute(presented.into_credential(), command, cancelled, wait)
    })
    .await
    {
        Ok(Ok(outcome)) => present(&method, outcome),
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Build service unavailable",
        ),
    }
}

fn present(method: &Method, outcome: BuildOutcome) -> Response {
    let head = *method == Method::HEAD;
    match outcome {
        BuildOutcome::Listed { profiles } => json_response(
            StatusCode::OK,
            &json!({"profiles": profiles.into_iter().map(profile_summary).collect::<Vec<_>>()}),
            head,
        ),
        BuildOutcome::Read { profile: value } => {
            json_response(StatusCode::OK, &profile_summary(*value), head)
        }
        BuildOutcome::MissingBuild => failure(StatusCode::NOT_FOUND, "Profile not found"),
        _ => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Build service unavailable",
        ),
    }
}

fn domain_error(error: anyhow::Error) -> Response {
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
            _ => failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Build service unavailable",
            ),
        };
    }
    if let Some(kind) = error.downcast_ref::<BuildFailure>() {
        let code = match kind {
            BuildFailure::Cancelled => "request_cancelled",
            BuildFailure::QueueFull => "writer_queue_full",
            BuildFailure::Stopped => "writer_stopped",
            BuildFailure::OutcomeUnknown => "outcome_unknown",
            _ => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Build service unavailable",
                );
            }
        };
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &json!({"detail":"Build service temporarily unavailable","code":code}),
            false,
        );
    }
    failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Build service unavailable",
    )
}

fn json_response(status: StatusCode, value: &impl serde::Serialize, head: bool) -> Response {
    match encode_json_response(status, value, head) {
        Ok(response) => response,
        Err(()) => encode_unavailable(),
    }
}

fn encode_json_response(
    status: StatusCode,
    value: &impl serde::Serialize,
    head: bool,
) -> std::result::Result<Response, ()> {
    let body = serde_json::to_vec(value).map_err(|_| ())?;
    let length = body.len();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, length)
        .body(axum::body::Body::from(if head { Vec::new() } else { body }))
        .map_err(|_| ())
}

fn encode_unavailable() -> Response {
    const BODY: &[u8] = br#"{"detail":"Build service unavailable"}"#;
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, BODY.len())
        .body(axum::body::Body::from(BODY))
        .unwrap_or_else(|_| Response::new(axum::body::Body::from(BODY)))
}

fn failure(status: StatusCode, detail: &str) -> Response {
    json_response(status, &json!({"detail": detail}), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pp_storage::build_graph::{
        AcceptedProgress, AcceptedProgressUnavailable, PlanFreshness as DomainFreshness,
        ProfileSummary as DomainSummary, wire::AcceptedProgressSummary,
        wire::AcceptedProgressUnavailableReason,
    };

    #[test]
    fn unavailable_freshness_preserves_integrity_code() {
        let summary = profile_summary(DomainSummary {
            id: 7,
            name: "Broken".into(),
            order_number: None,
            special_request: None,
            part_count: 0,
            accepted_progress: AcceptedProgress::Unavailable(
                AcceptedProgressUnavailable::Integrity,
            ),
            build_stale: false,
            freshness: DomainFreshness::Unavailable {
                code: "accepted_inputs".into(),
            },
            archived_at: None,
            last_used_at: None,
        });
        assert_eq!(summary.id, 7);
        assert!(matches!(
            summary.accepted_progress,
            AcceptedProgressSummary::Unavailable {
                reason: AcceptedProgressUnavailableReason::Integrity
            }
        ));
        let wire = serde_json::to_value(&summary.freshness).unwrap();
        assert_eq!(
            wire,
            json!({"status":"unavailable","code":"accepted_inputs"})
        );
    }
}
