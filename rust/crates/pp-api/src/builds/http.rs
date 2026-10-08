use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use pp_contracts::{
    PositiveId,
    build_identity::{
        AcceptedProgressSummary, AcceptedProgressUnavailableReason, CreateBuildRequest,
        PlanFreshness, PlanStaleReason, PlanUntrackedReason, ProfileLayer, ProfileSummary,
        SourceAttachmentRequest,
    },
};
use pp_storage::{
    auth::{AuthFailure, Secret},
    build_graph::{
        AcceptedProgress as DomainProgress,
        AcceptedProgressUnavailable as DomainProgressUnavailable, BuildCommand, BuildGraphClient,
        BuildOutcome, Failure as BuildFailure, ManifestOptionsCommand,
        PlanFreshness as DomainFreshness, PlanStaleReason as DomainStaleReason,
        PlanUntrackedReason as DomainUntrackedReason, ProfileLayer as DomainLayer,
        ProfileSummary as DomainSummary,
    },
    read_model::Credential,
};
use serde_json::json;
use std::{
    net::{IpAddr, SocketAddr},
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
    body_limit: usize,
    wait: Duration,
    api_key_tenant: String,
}

impl BuildHttpConfig {
    pub fn new(origin: &str, api_key_tenant: &str) -> Result<Self> {
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
            !api_key_tenant.trim().is_empty() && api_key_tenant.len() <= 4096,
            "Invalid API key tenant"
        );
        let origin = url.origin().ascii_serialization();
        let host = origin.split_once("://").expect("URL scheme").1.to_owned();
        Ok(Self {
            origin,
            host,
            body_limit: 1024 * 1024,
            wait: Duration::from_millis(100),
            api_key_tenant: api_key_tenant.into(),
        })
    }

    pub fn with_limits(mut self, body_limit: usize, wait: Duration) -> Result<Self> {
        ensure!(
            (1..=self.body_limit).contains(&body_limit) && wait <= self.wait,
            "Build HTTP limits may only be reduced"
        );
        self.body_limit = body_limit;
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

#[derive(Clone)]
enum Principal {
    Session(String),
    ApiKey { tenant: String, secret: String },
}

impl Principal {
    fn credential(self) -> Credential {
        match self {
            Self::Session(secret) => Credential::Session(Secret::new(secret)),
            Self::ApiKey { tenant, secret } => Credential::ApiKey {
                routed_tenant: tenant,
                secret: Secret::new(secret),
            },
        }
    }
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

pub fn build_router(config: BuildHttpConfig, client: BuildGraphClient) -> Router {
    let app = App {
        config,
        client,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        waiters: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let manifest_routes = Router::new()
        .route(
            "/plans/{id}/kit-manifest",
            get(handle).head(handle).put(handle),
        )
        .route(
            "/plans/{id}/plan-manifest-builder",
            get(handle).head(handle),
        );
    let routes = Router::new()
        .route("/plans", get(handle).head(handle).post(handle))
        .route("/plans/{id}", get(handle).head(handle).delete(handle))
        .route("/plans/{id}/touch", post(handle))
        .route("/plans/{id}/layers", get(handle).head(handle).post(handle))
        .route("/plans/{id}/layers/base", put(handle))
        .route("/plans/{id}/layers/{layer_id}", put(handle).delete(handle))
        .merge(manifest_routes.clone());
    Router::new()
        .merge(routes.clone())
        .nest("/api/v2", routes)
        .nest("/api/v1", manifest_routes)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(State(app): State<App>, request: axum::extract::Request, next: Next) -> Response {
    let Ok(_permit) = app.admission.try_acquire() else {
        return failure(503, "Build service temporarily unavailable");
    };
    if request.uri().to_string().len() > 16_384 {
        return failure(414, "Request target too long");
    }
    let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() else {
        return failure(500, "Transport identity unavailable");
    };
    if !peer.ip().is_loopback() {
        return failure(403, "Loopback transport required");
    }
    let headers = request.headers();
    if headers.get_all("host").iter().count() != 1
        || headers.get("host").and_then(|value| value.to_str().ok()) != Some(&app.config.host)
        || headers
            .keys()
            .any(|key| key.as_str() == "forwarded" || key.as_str().starts_with("x-forwarded-"))
    {
        return failure(403, "Invalid request host");
    }
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    if headers.get_all("origin").iter().count() > 1
        || (headers.contains_key("origin") && origin != Some(&app.config.origin))
        || (!matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        ) && origin != Some(&app.config.origin))
        || headers
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site")
    {
        return failure(403, "Invalid request origin");
    }
    next.run(request).await
}

async fn handle(State(app): State<App>, request: axum::extract::Request) -> Response {
    let principal = match principal(request.headers(), &app.config.api_key_tenant) {
        Some(principal) => principal,
        None => return failure(401, "Authentication required"),
    };
    let method = request.method().clone();
    let path = request
        .uri()
        .path()
        .strip_prefix("/api/v2")
        .or_else(|| request.uri().path().strip_prefix("/api/v1"))
        .unwrap_or(request.uri().path())
        .to_owned();
    let body_limit = if path.ends_with("/kit-manifest") {
        8 * 1024 * 1024
    } else {
        app.config.body_limit
    };
    let bytes = match to_bytes(request.into_body(), body_limit).await {
        Ok(bytes) => bytes,
        Err(_) => return failure(413, "Request body too large"),
    };
    let command = match command(&method, &path, &bytes) {
        Ok(command) => command,
        Err(response) => return *response,
    };
    let permit = match app.waiters.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return coded_failure(
                503,
                "Build service temporarily unavailable",
                "writer_queue_full",
            );
        }
    };
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancellation = Cancellation::new();
    let cancelled = cancellation.flag();
    let outcome = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        client.execute(principal.credential(), command, cancelled, wait)
    })
    .await;
    match outcome {
        Ok(Ok(outcome)) => present(&method, &path, outcome),
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(500, "Build service unavailable"),
    }
}

fn command(
    method: &Method,
    path: &str,
    bytes: &[u8],
) -> std::result::Result<BuildCommand, Box<Response>> {
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if parts == ["plans"] {
        return match *method {
            Method::GET | Method::HEAD => Ok(BuildCommand::List),
            Method::POST => {
                let body: CreateBuildRequest = body(bytes)?;
                let name = pp_contracts::build_identity::BuildName::parse(body.name)
                    .map_err(|detail| Box::new(failure(400, detail)))?;
                Ok(BuildCommand::Create {
                    name,
                    base_source: body.base_project_id,
                })
            }
            _ => Err(Box::new(failure(405, "Method Not Allowed"))),
        };
    }
    if parts.first() != Some(&"plans") {
        return Err(Box::new(failure(404, "Not Found")));
    }
    let Some(build) = parts.get(1).and_then(|value| positive(value)) else {
        return Err(Box::new(failure(400, "Request is invalid")));
    };
    match (method, parts.as_slice()) {
        (&Method::GET | &Method::HEAD, ["plans", _, "kit-manifest"]) => {
            Ok(BuildCommand::Manifest(ManifestOptionsCommand::ReadKit {
                build,
            }))
        }
        (&Method::PUT, ["plans", _, "kit-manifest"]) => {
            Ok(BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                build,
                request: bytes.to_vec(),
            }))
        }
        (&Method::GET | &Method::HEAD, ["plans", _, "plan-manifest-builder"]) => Ok(
            BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder { build }),
        ),
        (&Method::GET | &Method::HEAD, ["plans", _]) => Ok(BuildCommand::Read { build }),
        (&Method::DELETE, ["plans", _]) => Ok(BuildCommand::Delete { build }),
        (&Method::POST, ["plans", _, "touch"]) => Ok(BuildCommand::Touch { build }),
        (&Method::GET | &Method::HEAD, ["plans", _, "layers"]) => {
            Ok(BuildCommand::ListLayers { build })
        }
        (&Method::PUT, ["plans", _, "layers", "base"]) => {
            let body: SourceAttachmentRequest = body(bytes)?;
            Ok(BuildCommand::SetBase {
                build,
                source: body.project_id,
            })
        }
        (&Method::POST, ["plans", _, "layers"]) => {
            let body: SourceAttachmentRequest = body(bytes)?;
            Ok(BuildCommand::AttachAddon {
                build,
                source: body.project_id,
            })
        }
        (&Method::PUT, ["plans", _, "layers", layer]) => {
            let Some(layer) = positive(layer) else {
                return Err(Box::new(failure(400, "Request is invalid")));
            };
            let body: SourceAttachmentRequest = body(bytes)?;
            Ok(BuildCommand::ReplaceAttachment {
                build,
                layer,
                source: body.project_id,
            })
        }
        (&Method::DELETE, ["plans", _, "layers", layer]) => {
            let Some(layer) = positive(layer) else {
                return Err(Box::new(failure(400, "Request is invalid")));
            };
            Ok(BuildCommand::Detach { build, layer })
        }
        _ => Err(Box::new(failure(404, "Not Found"))),
    }
}

fn body<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> std::result::Result<T, Box<Response>> {
    serde_json::from_slice(bytes).map_err(|_| Box::new(failure(400, "Request is invalid")))
}

fn positive(value: &str) -> Option<PositiveId> {
    value
        .parse::<u64>()
        .ok()
        .and_then(|value| PositiveId::new(value).ok())
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
    let authorization = headers.get("authorization");
    let custom = headers.get("x-print-partner-api-key");
    if headers.get_all("authorization").iter().count() > 1
        || headers.get_all("x-print-partner-api-key").iter().count() > 1
        || usize::from(session.is_some())
            + usize::from(authorization.is_some())
            + usize::from(custom.is_some())
            != 1
    {
        return None;
    }
    if let Some(value) = session {
        return (!value.is_empty() && value.len() <= 4096)
            .then(|| Principal::Session(value.into()));
    }
    let key = if let Some(value) = authorization {
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

fn present(method: &Method, path: &str, outcome: BuildOutcome) -> Response {
    match outcome {
        BuildOutcome::Manifest(outcome) => {
            let (status, body) = super::manifest_options::present(outcome);
            manifest_json_response(status, body, *method == Method::HEAD)
        }
        BuildOutcome::Listed { profiles } => json_response(
            200,
            &json!({"profiles":profiles.into_iter().map(profile).collect::<Vec<_>>() }),
        ),
        BuildOutcome::Read { profile: value } | BuildOutcome::Touched { profile: value } => {
            json_response(200, &profile(value))
        }
        BuildOutcome::Created {
            profile: value,
            layers,
        } => {
            let mut value = serde_json::to_value(profile(value)).expect("Profile summary");
            value["layers"] = json!(layers.into_iter().map(layer).collect::<Vec<_>>());
            json_response(200, &value)
        }
        BuildOutcome::Layers { profile_id, layers } => json_response(
            200,
            &json!({"profile_id":profile_id,"layers":layers.into_iter().map(layer).collect::<Vec<_>>() }),
        ),
        BuildOutcome::Deleted if *method == Method::DELETE => {
            StatusCode::NO_CONTENT.into_response()
        }
        BuildOutcome::MissingBuild => failure(404, "Profile not found"),
        BuildOutcome::InvalidBaseSource => failure(400, "Project not found"),
        BuildOutcome::MissingSource => failure(404, "Project not found"),
        BuildOutcome::MissingLayer => failure(404, "Layer not found"),
        BuildOutcome::DuplicateName { name } => {
            failure(400, &format!("Profile already exists: {name}"))
        }
        BuildOutcome::DuplicateAttachment { source_name } => {
            let detail = format!("Source \"{source_name}\" is already attached to this build");
            if path.ends_with("/layers") && *method == Method::POST {
                failure(409, &detail)
            } else if path.ends_with("/layers/base") || *method == Method::PUT {
                failure(404, &detail)
            } else {
                failure(400, &detail)
            }
        }
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
                    DomainProgressUnavailable::ConcurrentUpdate => {
                        AcceptedProgressUnavailableReason::ConcurrentUpdate
                    }
                },
            },
        },
        build_stale: value.build_stale,
        freshness: match value.freshness {
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
                reasons: reasons.into_iter().map(stale_reason).collect(),
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
                reasons: reasons.into_iter().map(untracked_reason).collect(),
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

fn layer(value: DomainLayer) -> ProfileLayer {
    ProfileLayer {
        id: value.id,
        layer_order: value.layer_order,
        layer_type: value.layer_type,
        project_id: value.project_id,
        project_name: value.project_name,
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
    if let Some(failure) = error.downcast_ref::<BuildFailure>() {
        let code = match failure {
            BuildFailure::Cancelled => "request_cancelled",
            BuildFailure::QueueFull => "writer_queue_full",
            BuildFailure::Stopped => "writer_stopped",
            BuildFailure::OutcomeUnknown => "outcome_unknown",
        };
        return coded_failure(503, "Build service temporarily unavailable", code);
    }
    failure(500, "Build service unavailable")
}

fn coded_failure(status: u16, detail: &str, code: &str) -> Response {
    json_response(status, &json!({"detail":detail,"code":code}))
}

fn json_response(status: u16, value: &impl serde::Serialize) -> Response {
    (StatusCode::from_u16(status).expect("status"), Json(value)).into_response()
}

fn manifest_json_response(status: u16, body: Vec<u8>, head: bool) -> Response {
    let length = body.len();
    Response::builder()
        .status(StatusCode::from_u16(status).expect("status"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(if head { Vec::new() } else { body }))
        .expect("manifest response")
}

fn failure(status: u16, detail: &str) -> Response {
    json_response(status, &json!({"detail":detail}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(accepted_progress: DomainProgress, freshness: DomainFreshness) -> DomainSummary {
        DomainSummary {
            id: 7,
            name: "Build".into(),
            order_number: None,
            special_request: None,
            part_count: 2,
            accepted_progress,
            build_stale: matches!(freshness, DomainFreshness::Stale { .. }),
            freshness,
            archived_at: None,
            last_used_at: Some("2026-10-04T00:00:00.000Z".into()),
        }
    }

    #[test]
    fn every_progress_and_freshness_variant_has_exact_wire_presentation() {
        let progress = [
            (
                DomainProgress::Ready {
                    total_units: 3,
                    remaining_units: 1,
                },
                json!({"kind":"ready","total_units":3,"remaining_units":1}),
            ),
            (DomainProgress::Empty, json!({"kind":"empty"})),
            (
                DomainProgress::Unavailable(DomainProgressUnavailable::CompatibilityDirty),
                json!({"kind":"unavailable","reason":"compatibility_dirty"}),
            ),
            (
                DomainProgress::Unavailable(DomainProgressUnavailable::Uninitialized),
                json!({"kind":"unavailable","reason":"uninitialized"}),
            ),
            (
                DomainProgress::Unavailable(DomainProgressUnavailable::Integrity),
                json!({"kind":"unavailable","reason":"integrity"}),
            ),
            (
                DomainProgress::Unavailable(DomainProgressUnavailable::ConcurrentUpdate),
                json!({"kind":"unavailable","reason":"concurrent_update"}),
            ),
        ];
        for (progress, expected) in progress {
            let value = serde_json::to_value(profile(summary(
                progress,
                DomainFreshness::Current {
                    accepted_input_set_id: 11,
                    accepted_at: "2026-10-04T00:00:00.000Z".into(),
                },
            )))
            .unwrap();
            assert_eq!(value["accepted_progress"], expected);
        }

        let current = serde_json::to_value(profile(summary(
            DomainProgress::Empty,
            DomainFreshness::Current {
                accepted_input_set_id: 11,
                accepted_at: "accepted".into(),
            },
        )))
        .unwrap();
        assert_eq!(
            current["freshness"],
            json!({"status":"current","accepted_input_set_id":11,"accepted_at":"accepted"})
        );
        let stale = serde_json::to_value(profile(summary(
            DomainProgress::Empty,
            DomainFreshness::Stale {
                accepted_input_set_id: 11,
                accepted_at: "accepted".into(),
                reasons: vec![
                    DomainStaleReason::SourceRevisionChanged {
                        source_id: 1,
                        source_name: "Source".into(),
                        accepted_revision_id: 2,
                        current_revision_id: 3,
                    },
                    DomainStaleReason::SourceRevisionUnavailable {
                        source_id: 4,
                        source_name: "Missing".into(),
                        accepted_revision_id: 5,
                    },
                    DomainStaleReason::NamingRulesChanged {
                        source_id: 6,
                        source_name: "Named".into(),
                        accepted_digest: "before".into(),
                        current_digest: "after".into(),
                    },
                    DomainStaleReason::PlanInputsInvalid,
                    DomainStaleReason::PlanConfigurationChanged,
                ],
                untracked_sources: vec![DomainUntrackedReason::SourceRevisionUntracked {
                    source_id: 7,
                    source_name: "Untracked".into(),
                }],
            },
        )))
        .unwrap();
        assert_eq!(
            stale,
            json!({
                "id": 7,
                "name": "Build",
                "order_number": null,
                "special_request": null,
                "part_count": 2,
                "accepted_progress": {"kind":"empty"},
                "build_stale": true,
                "freshness": {
                    "status": "stale",
                    "accepted_input_set_id": 11,
                    "accepted_at": "accepted",
                    "reasons": [
                        {
                            "kind": "source_revision_changed",
                            "source_id": 1,
                            "source_name": "Source",
                            "accepted_revision_id": 2,
                            "current_revision_id": 3
                        },
                        {
                            "kind": "source_revision_unavailable",
                            "source_id": 4,
                            "source_name": "Missing",
                            "accepted_revision_id": 5
                        },
                        {
                            "kind": "naming_rules_changed",
                            "source_id": 6,
                            "source_name": "Named",
                            "accepted_digest": "before",
                            "current_digest": "after"
                        },
                        {"kind": "plan_inputs_invalid"},
                        {"kind": "plan_configuration_changed"}
                    ],
                    "untracked_sources": [
                        {
                            "kind": "source_revision_untracked",
                            "source_id": 7,
                            "source_name": "Untracked"
                        }
                    ]
                },
                "archived_at": null,
                "last_used_at": "2026-10-04T00:00:00.000Z"
            })
        );
        let untracked = serde_json::to_value(profile(summary(
            DomainProgress::Empty,
            DomainFreshness::Untracked {
                accepted_input_set_id: None,
                accepted_at: None,
                reasons: vec![DomainUntrackedReason::NoAcceptedInputs],
            },
        )))
        .unwrap();
        assert_eq!(
            untracked["freshness"],
            json!({"status":"untracked","accepted_input_set_id":null,"accepted_at":null,"reasons":[{"kind":"no_accepted_inputs"}]})
        );
        assert_eq!(untracked["build_stale"], false);
        let accepted_untracked = serde_json::to_value(profile(summary(
            DomainProgress::Empty,
            DomainFreshness::Untracked {
                accepted_input_set_id: Some(12),
                accepted_at: Some("accepted".into()),
                reasons: vec![DomainUntrackedReason::SourceRevisionUntracked {
                    source_id: 8,
                    source_name: "Local".into(),
                }],
            },
        )))
        .unwrap();
        assert_eq!(accepted_untracked["build_stale"], false);
        assert_eq!(
            accepted_untracked["freshness"],
            json!({"status":"untracked","accepted_input_set_id":12,"accepted_at":"accepted","reasons":[{"kind":"source_revision_untracked","source_id":8,"source_name":"Local"}]})
        );
    }

    #[tokio::test]
    async fn outcome_unknown_is_a_coded_service_unavailable() {
        let response = domain_error(anyhow::anyhow!(BuildFailure::OutcomeUnknown));
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({"detail":"Build service temporarily unavailable","code":"outcome_unknown"})
        );
    }
}
