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
use pp_contracts::build_identity::{
    AcceptedProgressSummary, AcceptedProgressUnavailableReason, FreshnessReasons, PlanFreshness,
    PlanStaleReason, PlanUntrackedReason, ProfileSummary,
};
use pp_domain::PositiveId;
use pp_storage::{
    auth::AuthFailure,
    build_graph::{
        AcceptedProgress as DomainProgress,
        AcceptedProgressUnavailable as DomainProgressUnavailable, BuildCommand, BuildGraphClient,
        BuildOutcome, Failure as BuildFailure, PlanFreshness as DomainFreshness,
        PlanStaleReason as DomainStaleReason, PlanUntrackedReason as DomainUntrackedReason,
        ProfileSummary as DomainSummary,
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
        return failure(503, "Build service temporarily unavailable");
    };
    if request.uri().to_string().len() > 16_384 {
        return failure(414, "Request target too long");
    }
    if let Err((status, detail)) = admit(
        &app.config.origin,
        &app.config.host,
        &app.config.api_key_tenant,
        &request,
    ) {
        return failure(status.as_u16(), detail);
    }
    let Some(presented) = principal(request.headers(), &app.config.api_key_tenant) else {
        return failure(401, "Authentication required");
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
        return failure(400, "Request is invalid");
    };
    execute(app, request, BuildCommand::Read { build }).await
}

async fn execute(app: App, request: axum::extract::Request, command: BuildCommand) -> Response {
    let Some(presented) = request.extensions().get::<PresentedCredential>().cloned() else {
        return failure(401, "Authentication required");
    };
    let method = request.method().clone();
    let Ok(permit) = app.waiters.clone().try_acquire_owned() else {
        return json_response(
            503,
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
        Err(_) => failure(500, "Build service unavailable"),
    }
}

fn present(method: &Method, outcome: BuildOutcome) -> Response {
    let head = *method == Method::HEAD;
    match outcome {
        BuildOutcome::Listed { profiles } => json_response(
            200,
            &json!({"profiles": profiles.into_iter().map(profile).collect::<Vec<_>>()}),
            head,
        ),
        BuildOutcome::Read { profile: value } => json_response(200, &profile(*value), head),
        BuildOutcome::MissingBuild => failure(404, "Profile not found"),
        _ => failure(500, "Build service unavailable"),
    }
}

fn profile(value: DomainSummary) -> ProfileSummary {
    ProfileSummary {
        id: value.id,
        name: value.name,
        order_number: value.order_number,
        special_request: value.special_request,
        part_count: value.part_count,
        accepted_progress: match value.accepted_progress {
            DomainProgress::Ready {
                total_units,
                remaining_units,
            } => AcceptedProgressSummary::Ready {
                total_units,
                remaining_units,
            },
            DomainProgress::Empty => AcceptedProgressSummary::Empty,
            DomainProgress::Unavailable(reason) => AcceptedProgressSummary::Unavailable {
                reason: match reason {
                    DomainProgressUnavailable::CompatibilityDirty => {
                        AcceptedProgressUnavailableReason::CompatibilityDirty
                    }
                    DomainProgressUnavailable::Uninitialized => {
                        AcceptedProgressUnavailableReason::Uninitialized
                    }
                    DomainProgressUnavailable::Integrity => {
                        AcceptedProgressUnavailableReason::Integrity
                    }
                },
            },
        },
        build_stale: value.build_stale,
        freshness: match value.freshness {
            DomainFreshness::Unavailable { code } => PlanFreshness::Unavailable { code },
            DomainFreshness::Current {
                accepted_input_set_id,
                accepted_at,
            } => PlanFreshness::Current {
                accepted_input_set_id,
                accepted_at,
            },
            DomainFreshness::Stale {
                accepted_input_set_id,
                accepted_at,
                reasons,
                untracked_sources,
            } => PlanFreshness::Stale {
                accepted_input_set_id,
                accepted_at,
                reasons: FreshnessReasons::try_from(
                    reasons.into_iter().map(stale_reason).collect::<Vec<_>>(),
                )
                .unwrap_or_else(|_| {
                    FreshnessReasons::new(PlanStaleReason::PlanInputsInvalid, vec![])
                }),
                untracked_sources: untracked_sources
                    .into_iter()
                    .map(untracked_reason)
                    .collect(),
            },
            DomainFreshness::Untracked {
                accepted_input_set_id,
                accepted_at,
                reasons,
            } => PlanFreshness::Untracked {
                accepted_input_set_id,
                accepted_at,
                reasons: FreshnessReasons::try_from(
                    reasons
                        .into_iter()
                        .map(untracked_reason)
                        .collect::<Vec<_>>(),
                )
                .unwrap_or_else(|_| {
                    FreshnessReasons::new(PlanUntrackedReason::NoAcceptedInputs, vec![])
                }),
            },
        },
        archived_at: value.archived_at,
        last_used_at: value.last_used_at,
    }
}

fn stale_reason(value: DomainStaleReason) -> PlanStaleReason {
    match value {
        DomainStaleReason::SourceRevisionChanged {
            source_id,
            source_name,
            accepted_revision_id,
            current_revision_id,
        } => PlanStaleReason::SourceRevisionChanged {
            source_id,
            source_name,
            accepted_revision_id,
            current_revision_id,
        },
        DomainStaleReason::SourceRevisionUnavailable {
            source_id,
            source_name,
            accepted_revision_id,
        } => PlanStaleReason::SourceRevisionUnavailable {
            source_id,
            source_name,
            accepted_revision_id,
        },
        DomainStaleReason::NamingRulesChanged {
            source_id,
            source_name,
            accepted_digest,
            current_digest,
        } => PlanStaleReason::NamingRulesChanged {
            source_id,
            source_name,
            accepted_digest,
            current_digest,
        },
        DomainStaleReason::PlanInputsInvalid => PlanStaleReason::PlanInputsInvalid,
        DomainStaleReason::PlanConfigurationChanged => PlanStaleReason::PlanConfigurationChanged,
    }
}

fn untracked_reason(value: DomainUntrackedReason) -> PlanUntrackedReason {
    match value {
        DomainUntrackedReason::NoAcceptedInputs => PlanUntrackedReason::NoAcceptedInputs,
        DomainUntrackedReason::SourceRevisionUntracked {
            source_id,
            source_name,
        } => PlanUntrackedReason::SourceRevisionUntracked {
            source_id,
            source_name,
        },
    }
}

fn domain_error(error: anyhow::Error) -> Response {
    if let Some(auth) = error.downcast_ref::<AuthFailure>() {
        return match auth {
            AuthFailure::SessionRequired
            | AuthFailure::InvalidCredentials
            | AuthFailure::CredentialChanged => failure(401, "Authentication required"),
            AuthFailure::OwnerMappingRequired => {
                failure(403, "Explicit account owner mapping is required")
            }
            _ => failure(500, "Build service unavailable"),
        };
    }
    if let Some(kind) = error.downcast_ref::<BuildFailure>() {
        let code = match kind {
            BuildFailure::Cancelled => "request_cancelled",
            BuildFailure::QueueFull => "writer_queue_full",
            BuildFailure::Stopped => "writer_stopped",
            BuildFailure::OutcomeUnknown => "outcome_unknown",
            _ => return failure(500, "Build service unavailable"),
        };
        return json_response(
            503,
            &json!({"detail":"Build service temporarily unavailable","code":code}),
            false,
        );
    }
    failure(500, "Build service unavailable")
}

fn json_response(status: u16, value: &impl serde::Serialize, head: bool) -> Response {
    let body = serde_json::to_vec(value).expect("build JSON");
    let length = body.len();
    Response::builder()
        .status(StatusCode::from_u16(status).expect("status"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, length)
        .body(axum::body::Body::from(if head { Vec::new() } else { body }))
        .expect("build response")
}

fn failure(status: u16, detail: &str) -> Response {
    json_response(status, &json!({"detail": detail}), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pp_storage::build_graph::{AcceptedProgress, PlanFreshness as DomainFreshness};

    #[test]
    fn unavailable_freshness_preserves_integrity_code() {
        let summary = profile(DomainSummary {
            id: 7,
            name: "Broken".into(),
            order_number: None,
            special_request: None,
            part_count: 0,
            accepted_progress: AcceptedProgress::Unavailable(DomainProgressUnavailable::Integrity),
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
