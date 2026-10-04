use super::ReviewObservationPort;
use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use pp_contracts::{
    autosave::{PositiveId, SavePlanChoicesRequest, WireInteger},
    publication::{ApplyRequest, Outcome as PublicationOutcome},
    reconciliation::{Outcome as ReconciliationOutcome, ReconciliationRequest},
    working_drafts::{
        ExpectedDraft, Outcome as DraftOutcome, RebaseRequest, RecomputeOptions, Request,
        Transition,
    },
};
use pp_storage::{
    auth::AuthFailure,
    plan_publication::{PublicationClient, PublicationCommand},
    plan_save::{
        CommittedSaveCaptureFailure, Outcome as SaveOutcome, PlanSaveClient,
        Refusal as SaveRefusal, SaveCommand,
    },
    read_model::{AcceptedRead, Credential, ReadClient, views},
    required_units::AdmissionFailure,
    working_drafts::{Failure as DraftFailure, WorkingDraftClient},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone)]
pub struct DraftHttpConfig {
    origin: String,
    host: String,
    body_limit: usize,
    wait: Duration,
    api_key_tenant: String,
}

impl DraftHttpConfig {
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
            "Draft HTTP limits may only be reduced"
        );
        self.body_limit = body_limit;
        self.wait = wait;
        Ok(self)
    }
}

#[derive(Clone)]
pub struct DraftHttpClients {
    pub drafts: WorkingDraftClient,
    pub saves: PlanSaveClient,
    pub publication: PublicationClient,
    pub accepted: ReadClient,
}

#[derive(Clone)]
struct App {
    config: DraftHttpConfig,
    clients: DraftHttpClients,
    observer: Arc<dyn ReviewObservationPort>,
    admission: Arc<tokio::sync::Semaphore>,
    waiters: Arc<tokio::sync::Semaphore>,
}

#[derive(Clone)]
enum Principal {
    Session(String),
    ApiKey { tenant: String, secret: String },
}

impl Principal {
    fn credential(&self) -> Credential {
        match self {
            Self::Session(value) => {
                Credential::Session(pp_storage::auth::Secret::new(value.clone()))
            }
            Self::ApiKey { tenant, secret } => Credential::ApiKey {
                routed_tenant: tenant.clone(),
                secret: pp_storage::auth::Secret::new(secret.clone()),
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

#[derive(Clone, Copy)]
enum DraftPresentation {
    List,
    Workspace,
    MutationWorkspace,
    Transition,
}

#[derive(Clone, Copy)]
enum ReviewContract {
    Current,
    LegacyV1,
}

struct DispatchRequest {
    principal: Principal,
    method: Method,
    path: String,
    query: String,
    headers: HeaderMap,
    body: Value,
    contract: ReviewContract,
}

enum CallFailure {
    Busy,
    Unavailable,
    Domain(anyhow::Error),
}

struct AuthenticationDenied;

impl CallFailure {
    fn into_response(self) -> Response {
        match self {
            Self::Busy => failure(503, "Draft service temporarily unavailable"),
            Self::Unavailable => failure(500, "Draft service unavailable"),
            Self::Domain(error) => domain_error(error),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecomputeBody {
    apply_manifest: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransitionBody {
    expected_lifecycle_version: WireInteger<0, 2_147_483_646>,
}

pub fn draft_router(
    config: DraftHttpConfig,
    clients: DraftHttpClients,
    observer: Arc<dyn ReviewObservationPort>,
) -> Router {
    let app = App {
        config,
        clients,
        observer,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        waiters: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let current = Router::new()
        .route("/plans/{id}/drafts", get(handle))
        .route("/plans/{id}/drafts/recompute", post(handle))
        .route("/plans/{id}/drafts/{draft_id}", get(handle))
        .route("/plans/{id}/drafts/{draft_id}/parts", patch(handle))
        .route("/plans/{id}/drafts/{draft_id}/abandon", post(handle))
        .route("/plans/{id}/drafts/{draft_id}/rebase", post(handle))
        .route("/plans/{id}/drafts/{draft_id}/reconciliation", put(handle))
        .route("/plans/{id}/drafts/{draft_id}/apply", post(handle))
        .route("/plans/{id}/save", post(handle))
        .route("/plans/{id}/review", get(handle));
    let legacy_review = Router::new().route("/plans/{id}/review", get(handle));
    Router::new()
        .merge(current.clone())
        .nest("/api/v2", current)
        .nest("/api/v1", legacy_review)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(State(app): State<App>, request: axum::extract::Request, next: Next) -> Response {
    let Ok(_permit) = app.admission.try_acquire() else {
        return failure(503, "Draft service temporarily unavailable");
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
        Ok(value) => value,
        Err(AuthenticationDenied) => return failure(401, "Authentication required"),
    };
    let method = request.method().clone();
    let original_path = request.uri().path();
    let contract = if original_path.starts_with("/api/v1/") {
        ReviewContract::LegacyV1
    } else {
        ReviewContract::Current
    };
    let path = original_path
        .strip_prefix("/api/v2")
        .or_else(|| original_path.strip_prefix("/api/v1"))
        .unwrap_or(original_path)
        .to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let headers = request.headers().clone();
    let bytes = match to_bytes(request.into_body(), app.config.body_limit).await {
        Ok(bytes) => bytes,
        Err(_) => return failure(413, "Request body too large"),
    };
    let body = if matches!(method, Method::GET | Method::HEAD) {
        json!({})
    } else {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) if value.is_object() => value,
            _ => return failure(400, "Request is invalid"),
        }
    };
    dispatch(
        &app,
        DispatchRequest {
            principal,
            method,
            path,
            query,
            headers,
            body,
            contract,
        },
    )
    .await
}

async fn dispatch(app: &App, request: DispatchRequest) -> Response {
    let DispatchRequest {
        principal,
        method,
        path,
        query,
        headers,
        body,
        contract,
    } = request;
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let Some(profile) = parts.get(1).and_then(|value| positive(value)) else {
        return failure(400, "Request is invalid");
    };
    let key = |max| idempotency_key(&headers, max);
    if parts.len() == 3
        && parts[0] == "plans"
        && parts[2] == "drafts"
        && matches!(method, Method::GET | Method::HEAD)
    {
        return draft_call(
            app,
            principal,
            profile,
            Request::List,
            DraftPresentation::List,
        )
        .await;
    }
    if parts.len() == 4
        && parts[0] == "plans"
        && parts[2] == "drafts"
        && matches!(method, Method::GET | Method::HEAD)
    {
        let Some(draft) = positive(parts[3]) else {
            return failure(400, "Request is invalid");
        };
        return draft_call(
            app,
            principal,
            profile,
            Request::Workspace { draft_id: draft },
            DraftPresentation::Workspace,
        )
        .await;
    }
    if parts.len() == 4
        && parts[0] == "plans"
        && parts[2] == "drafts"
        && parts[3] == "recompute"
        && method == Method::POST
    {
        let Some(key) = key(160) else {
            return invalid_request();
        };
        let parsed = match serde_json::from_value::<RecomputeBody>(body) {
            Ok(value) => value,
            Err(_) => return invalid_request(),
        };
        let options = RecomputeOptions {
            apply_manifest: parsed.apply_manifest,
            ..Default::default()
        };
        return draft_call(
            app,
            principal,
            profile,
            Request::Recompute {
                idempotency_key: key,
                options,
            },
            DraftPresentation::MutationWorkspace,
        )
        .await;
    }
    if parts.len() >= 5 && parts[0] == "plans" && parts[2] == "drafts" {
        let Some(draft) = positive(parts[3]) else {
            return failure(400, "Request is invalid");
        };
        match (method.clone(), parts[4]) {
            (Method::PATCH, "parts") => {
                return draft_body_call(app, principal, profile, draft, "edit", body).await;
            }
            (Method::POST, "abandon") => {
                return transition_call(app, principal, profile, draft, body).await;
            }
            (Method::POST, "rebase") => {
                let Some(key) = key(160) else {
                    return invalid_request();
                };
                let Some(mut value) = body.as_object().cloned() else {
                    return invalid_request();
                };
                value.insert("source_draft_id".into(), json!(draft.get()));
                let request = match serde_json::from_value::<RebaseRequest>(Value::Object(value)) {
                    Ok(value) => value,
                    Err(_) => return invalid_request(),
                };
                return draft_call(
                    app,
                    principal,
                    profile,
                    Request::Rebase {
                        idempotency_key: key,
                        request,
                    },
                    DraftPresentation::MutationWorkspace,
                )
                .await;
            }
            (Method::PUT, "reconciliation") => {
                let Some(key) = key(160) else {
                    return invalid_request();
                };
                let request = match serde_json::from_value::<ReconciliationRequest>(body) {
                    Ok(value) => value,
                    Err(_) => return invalid_request(),
                };
                return draft_call(
                    app,
                    principal,
                    profile,
                    Request::Select {
                        draft_id: draft,
                        idempotency_key: key,
                        request,
                    },
                    DraftPresentation::MutationWorkspace,
                )
                .await;
            }
            (Method::POST, "apply") => {
                return apply_call(app, &principal, profile, draft, &headers, body).await;
            }
            _ => {}
        }
    }
    if parts.len() == 3 && parts[0] == "plans" && parts[2] == "save" && method == Method::POST {
        return save_call(app, principal.credential(), profile, &headers, body).await;
    }
    if parts.len() == 3
        && parts[0] == "plans"
        && parts[2] == "review"
        && matches!(method, Method::GET | Method::HEAD)
    {
        return review_call(app, principal.credential(), profile, &query, contract).await;
    }
    failure(404, "Route not found")
}

async fn draft_body_call(
    app: &App,
    principal: Principal,
    profile: PositiveId,
    draft: PositiveId,
    kind: &str,
    body: Value,
) -> Response {
    let Some(object) = body.as_object() else {
        return failure(400, "Request is invalid");
    };
    let mut value = object.clone();
    if let Some(decision) = value.remove("decision") {
        if value.contains_key("decisions") {
            return invalid_request();
        }
        value.insert("decisions".into(), Value::Array(vec![decision]));
    }
    value.insert("kind".into(), json!(kind));
    value.insert("draft_id".into(), json!(draft.get()));
    match serde_json::from_value::<Request>(Value::Object(value)) {
        Ok(request) => {
            draft_call(
                app,
                principal,
                profile,
                request,
                DraftPresentation::MutationWorkspace,
            )
            .await
        }
        Err(_) => invalid_request(),
    }
}

async fn transition_call(
    app: &App,
    principal: Principal,
    profile: PositiveId,
    draft: PositiveId,
    body: Value,
) -> Response {
    let expected = match serde_json::from_value::<TransitionBody>(body) {
        Ok(value) => value.expected_lifecycle_version.get() as u32,
        Err(_) => return invalid_request(),
    };
    draft_call(
        app,
        principal,
        profile,
        Request::Transition {
            draft_id: draft,
            transition: Transition::Abandon,
            expected_lifecycle_version: expected,
        },
        DraftPresentation::Transition,
    )
    .await
}

async fn draft_call(
    app: &App,
    principal: Principal,
    profile: PositiveId,
    request: Request,
    presentation: DraftPresentation,
) -> Response {
    let client = app.clients.drafts.clone();
    let target = request_target(&request);
    let credential = principal.credential();
    let cancelled = Cancellation::new();
    let flag = cancelled.flag();
    let wait = app.config.wait;
    let permit = match app.waiters.clone().try_acquire_owned() {
        Ok(value) => value,
        Err(_) => return failure(503, "Draft service temporarily unavailable"),
    };
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if matches!(presentation, DraftPresentation::MutationWorkspace) {
            client.service(credential, profile, request, flag, wait)
        } else {
            client.execute(credential, profile, request, flag, wait)
        }
    })
    .await
    {
        Ok(Ok(outcome)) => {
            present_draft_outcome(app, &principal, profile, target, outcome, presentation).await
        }
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(500, "Draft service unavailable"),
    }
}

async fn apply_call(
    app: &App,
    principal: &Principal,
    profile: PositiveId,
    draft: PositiveId,
    headers: &HeaderMap,
    body: Value,
) -> Response {
    let Some(key) = idempotency_key(headers, 160) else {
        return invalid_request();
    };
    let request = match serde_json::from_value::<ApplyRequest>(body) {
        Ok(value) => value,
        Err(_) => return invalid_request(),
    };
    let command = match PublicationCommand::new(
        profile,
        draft,
        request.clone(),
        key.clone(),
        principal.credential(),
    ) {
        Ok(command) => command,
        Err(_) => return invalid_request(),
    };
    let mut outcome = match publication_call(app, command).await {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if matches!(outcome, PublicationOutcome::ReconciliationRequired { .. }) {
        let expected = ExpectedDraft {
            snapshot_digest: request.expected_snapshot_digest.clone(),
            lifecycle_version: request.expected_lifecycle_version.get() as u32,
            base: request.expected_base.clone(),
        };
        let prepared = draft_call_result(
            app,
            principal.credential(),
            profile,
            Request::PrepareApply {
                draft_id: draft,
                expected: Some(expected),
            },
            true,
        )
        .await;
        let workspace = match prepared {
            Ok(DraftOutcome::Service {
                outcome: ReconciliationOutcome::Ready { workspace },
                ..
            }) => workspace,
            Ok(value) => {
                return draft_outcome(value, profile, DraftPresentation::MutationWorkspace);
            }
            Err(error) => return error.into_response(),
        };
        let retry = ApplyRequest {
            expected_snapshot_digest: workspace.draft.snapshot_digest().clone(),
            expected_lifecycle_version: WireInteger::new(workspace.draft.lifecycle_version().get())
                .expect("draft lifecycle contract"),
            expected_base: workspace.draft.base().clone(),
            remap_checkoff_links: request.remap_checkoff_links,
        };
        let command = match PublicationCommand::normalized_http(
            profile,
            draft,
            request,
            retry,
            key,
            principal.credential(),
        ) {
            Ok(command) => command,
            Err(_) => return invalid_request(),
        };
        outcome = match publication_call(app, command).await {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        };
    }
    publication_outcome(outcome)
}

async fn save_call(
    app: &App,
    credential: Credential,
    profile: PositiveId,
    headers: &HeaderMap,
    body: Value,
) -> Response {
    let Some(key) = idempotency_key(headers, 200) else {
        return invalid_request();
    };
    let request = match serde_json::from_value::<SavePlanChoicesRequest>(body) {
        Ok(value) => value,
        Err(_) => return invalid_request(),
    };
    let recovery_key = key.clone();
    let command = match SaveCommand::new(credential, profile, request, key) {
        Ok(value) => value,
        Err(_) => return invalid_request(),
    };
    let client = app.clients.saves.clone();
    let cancelled = Cancellation::new();
    let flag = cancelled.flag();
    let wait = app.config.wait;
    let saved = match tokio::task::spawn_blocking(move || client.save(command, flag, wait)).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            return match error.downcast::<CommittedSaveCaptureFailure>() {
                Ok(failure) => save_uncertain(
                    "accepted_capture",
                    &recovery_key,
                    &failure.receipt,
                    &failure.closed_draft_ids,
                ),
                Err(error) => domain_error(error),
            };
        }
        Err(_) => return failure(500, "Draft service unavailable"),
    };
    let SaveOutcome::Saved {
        receipt,
        closed_draft_ids,
        authority,
    } = saved
    else {
        let SaveOutcome::Refused { reason } = saved else {
            unreachable!()
        };
        return save_refusal(reason);
    };
    if receipt.profile_id().get() != authority.snapshot.profile.id as u64 {
        return save_uncertain(
            "authority_snapshot",
            &recovery_key,
            &receipt,
            &closed_draft_ids,
        );
    }
    let snapshot = authority.snapshot;
    let profile_summary = authority.context.profile_summary_v2;
    let observer = app.observer.clone();
    let observer_for_scan = observer.clone();
    let observation_flag = cancelled.flag();
    let (snapshot, observations) = match tokio::task::spawn_blocking(move || {
        observer_for_scan
            .review_observations(&snapshot, &observation_flag)
            .map(|observations| (snapshot, observations))
    })
    .await
    {
        Ok(Ok(value)) => value,
        _ => {
            return save_uncertain(
                "review_observation",
                &recovery_key,
                &receipt,
                &closed_draft_ids,
            );
        }
    };
    let filament = match observer.filament_lookup(&snapshot, cancelled.flag()).await {
        Ok(value) => value,
        Err(_) => {
            return save_uncertain(
                "filament_observation",
                &recovery_key,
                &receipt,
                &closed_draft_ids,
            );
        }
    };
    let read = AcceptedRead::Ready { snapshot };
    let review = match views::review(&read, true, &observations, filament.as_ref()) {
        Ok(value) => present_review(ReviewContract::Current, value),
        Err(_) => {
            return save_uncertain(
                "review_projection",
                &recovery_key,
                &receipt,
                &closed_draft_ids,
            );
        }
    };
    json_response(
        200,
        &json!({"receipt":receipt,"review":review,"profile":profile_summary,"closed_draft_ids":closed_draft_ids}),
    )
}

fn save_uncertain(
    stage: &str,
    key: &str,
    receipt: &impl serde::Serialize,
    closed_draft_ids: &[PositiveId],
) -> Response {
    json_response(
        500,
        &json!({
            "detail":"Plan save committed, but its response could not be completed. Retry with the same idempotency key.",
            "code":"save_response_uncertain",
            "stage":stage,
            "idempotency_key":key,
            "receipt":receipt,
            "closed_draft_ids":closed_draft_ids,
        }),
    )
}

fn save_refusal(reason: SaveRefusal) -> Response {
    let detail = "Plan choices could not be saved. Your pending choices have been kept.";
    match reason {
        SaveRefusal::NotFound => coded_failure(404, detail, "not_found", json!({})),
        SaveRefusal::BuildArchived => coded_failure(422, detail, "build_archived", json!({})),
        SaveRefusal::AcceptedBaselineRequired => {
            coded_failure(409, detail, "accepted_baseline_required", json!({}))
        }
        SaveRefusal::BaseChanged => coded_failure(409, detail, "base_changed", json!({})),
        SaveRefusal::DraftChanged => coded_failure(409, detail, "draft_changed", json!({})),
        SaveRefusal::InputsChanged => coded_failure(409, detail, "inputs_changed", json!({})),
        SaveRefusal::IdempotencyConflict => {
            coded_failure(409, detail, "idempotency_conflict", json!({}))
        }
        SaveRefusal::PartNotFound => coded_failure(422, detail, "part_not_found", json!({})),
        SaveRefusal::PartAmbiguous => coded_failure(422, detail, "part_ambiguous", json!({})),
        SaveRefusal::NoLayers => coded_failure(422, detail, "no_layers", json!({})),
        SaveRefusal::NoStls => coded_failure(422, detail, "no_stls", json!({})),
        SaveRefusal::WouldWipe => coded_failure(422, detail, "would_wipe", json!({})),
        SaveRefusal::Reconciliation { outcome } => reconciliation_failure(outcome, Some(detail)),
        SaveRefusal::Publication { outcome } => publication_failure(outcome, Some(detail)),
    }
}

async fn review_call(
    app: &App,
    credential: Credential,
    profile: PositiveId,
    query: &str,
    contract: ReviewContract,
) -> Response {
    let include_excluded = query
        .split('&')
        .any(|pair| matches!(pair, "include_excluded=1" | "include_excluded=true"));
    let client = app.clients.accepted.clone();
    let cancelled = Cancellation::new();
    let flag = cancelled.flag();
    let wait = app.config.wait;
    let read = match tokio::task::spawn_blocking(move || -> Result<AcceptedRead> {
        let mut batch = client.read(credential, &[profile.get() as i64], &flag, wait)?;
        Ok(batch
            .builds
            .pop()
            .ok_or_else(|| anyhow::anyhow!("Accepted read missing result"))?
            .accepted)
    })
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return domain_error(error),
        Err(_) => return failure(500, "Review unavailable"),
    };
    match read {
        AcceptedRead::Missing => failure(404, "Profile not found"),
        AcceptedRead::CompatibilityDirty => {
            failure(409, "Accepted Plan requires compatibility repair")
        }
        AcceptedRead::Uninitialized => {
            failure(409, "Accepted Plan operational state is not initialized")
        }
        AcceptedRead::IntegrityFailure { .. } => failure(500, "Accepted Plan data is inconsistent"),
        AcceptedRead::Empty { .. } => {
            let observations = views::ReviewObservations {
                available_input_roots: Default::default(),
                media_by_part_id: Default::default(),
            };
            match views::review(&read, include_excluded, &observations, &views::CatalogOnly) {
                Ok(value) => json_response(200, &present_review(contract, value)),
                Err(_) => failure(500, "Accepted Plan data is inconsistent"),
            }
        }
        AcceptedRead::Ready { snapshot } => {
            let observer = app.observer.clone();
            let scan_observer = observer.clone();
            let scan_flag = cancelled.flag();
            let (snapshot, observations) = match tokio::task::spawn_blocking(move || {
                scan_observer
                    .review_observations(&snapshot, &scan_flag)
                    .map(|observations| (snapshot, observations))
            })
            .await
            {
                Ok(Ok(value)) => value,
                _ => return failure(500, "Accepted Plan review observation failed"),
            };
            let filament = match observer.filament_lookup(&snapshot, cancelled.flag()).await {
                Ok(value) => value,
                Err(_) => return failure(500, "Accepted Plan review observation failed"),
            };
            let read = AcceptedRead::Ready { snapshot };
            match views::review(&read, include_excluded, &observations, filament.as_ref()) {
                Ok(value) => json_response(200, &present_review(contract, value)),
                Err(_) => failure(500, "Accepted Plan data is inconsistent"),
            }
        }
    }
}

fn present_review(contract: ReviewContract, value: Value) -> Value {
    match contract {
        ReviewContract::Current | ReviewContract::LegacyV1 => value,
    }
}

fn principal(
    headers: &HeaderMap,
    tenant: &str,
) -> std::result::Result<Principal, AuthenticationDenied> {
    let denied = || AuthenticationDenied;
    let mut session = None;
    for header in headers.get_all("cookie") {
        for item in header.to_str().map_err(|_| denied())?.split(';') {
            if let Some(("pp_session", value)) = item.trim().split_once('=')
                && session.replace(value).is_some()
            {
                return Err(denied());
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
        return Err(denied());
    }
    if let Some(value) = session {
        if value.is_empty() || value.len() > 4096 {
            return Err(denied());
        }
        return Ok(Principal::Session(value.into()));
    }
    let key = if let Some(value) = auth {
        value
            .to_str()
            .map_err(|_| denied())?
            .strip_prefix("Bearer ")
            .ok_or_else(denied)?
    } else {
        custom.ok_or_else(denied)?.to_str().map_err(|_| denied())?
    }
    .trim();
    if key.is_empty() || key.len() > 4096 {
        return Err(denied());
    }
    Ok(Principal::ApiKey {
        tenant: tenant.into(),
        secret: key.into(),
    })
}

fn positive(value: &str) -> Option<PositiveId> {
    value
        .parse::<u64>()
        .ok()
        .and_then(|value| PositiveId::new(value).ok())
}
fn idempotency_key(headers: &HeaderMap, max: usize) -> Option<String> {
    if headers.get_all("idempotency-key").iter().count() != 1 {
        return None;
    }
    let value = headers
        .get("idempotency-key")?
        .to_str()
        .ok()?
        .trim()
        .to_owned();
    (!value.is_empty() && value.encode_utf16().count() <= max).then_some(value)
}

async fn draft_call_result(
    app: &App,
    credential: Credential,
    profile: PositiveId,
    request: Request,
    service: bool,
) -> std::result::Result<DraftOutcome, CallFailure> {
    let client = app.clients.drafts.clone();
    let cancelled = Cancellation::new();
    let flag = cancelled.flag();
    let wait = app.config.wait;
    let permit = app
        .waiters
        .clone()
        .try_acquire_owned()
        .map_err(|_| CallFailure::Busy)?;
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if service {
            client.service(credential, profile, request, flag, wait)
        } else {
            client.execute(credential, profile, request, flag, wait)
        }
    })
    .await
    {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(error)) => Err(CallFailure::Domain(error)),
        Err(_) => Err(CallFailure::Unavailable),
    }
}

async fn publication_call(
    app: &App,
    command: PublicationCommand,
) -> std::result::Result<PublicationOutcome, CallFailure> {
    let client = app.clients.publication.clone();
    let cancelled = Cancellation::new();
    let flag = cancelled.flag();
    let wait = app.config.wait;
    match tokio::task::spawn_blocking(move || client.apply(command, &flag, wait)).await {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(error)) => Err(CallFailure::Domain(error)),
        Err(_) => Err(CallFailure::Unavailable),
    }
}

fn request_target(request: &Request) -> Option<PositiveId> {
    match request {
        Request::Edit { draft_id, .. }
        | Request::PrepareApply { draft_id, .. }
        | Request::Select { draft_id, .. }
        | Request::Read { draft_id }
        | Request::Workspace { draft_id }
        | Request::Diff { draft_id }
        | Request::Transition { draft_id, .. } => Some(*draft_id),
        Request::Rebase { request, .. } => Some(request.source_draft_id),
        Request::List | Request::Recompute { .. } => None,
    }
}

async fn present_draft_outcome(
    app: &App,
    principal: &Principal,
    profile: PositiveId,
    target: Option<PositiveId>,
    outcome: DraftOutcome,
    presentation: DraftPresentation,
) -> Response {
    let code = match &outcome {
        DraftOutcome::Conflict { .. } | DraftOutcome::SourceConflict { .. } => {
            Some("draft_changed")
        }
        DraftOutcome::BaseChanged { .. } => Some("base_changed"),
        DraftOutcome::NotAbandoned { .. } | DraftOutcome::NotAllowed { .. } => Some("not_open"),
        _ => None,
    };
    let Some(code) = code else {
        return draft_outcome(outcome, profile, presentation);
    };
    let workspace = match target {
        Some(draft_id) => match draft_call_result(
            app,
            principal.credential(),
            profile,
            Request::Workspace { draft_id },
            false,
        )
        .await
        {
            Ok(DraftOutcome::Workspace { workspace }) => Some(workspace),
            _ => None,
        },
        None => None,
    };
    coded_failure(
        409,
        "Plan draft update failed",
        code,
        workspace.map_or_else(|| json!({}), |workspace| json!({"workspace":workspace})),
    )
}

fn draft_outcome(
    outcome: DraftOutcome,
    profile: PositiveId,
    presentation: DraftPresentation,
) -> Response {
    match outcome {
        DraftOutcome::Service { outcome, .. } => reconciliation_failure(outcome, None),
        DraftOutcome::Listed { drafts } if matches!(presentation, DraftPresentation::List) => {
            let Some(drafts) = drafts
                .iter()
                .map(draft_identity)
                .collect::<Option<Vec<_>>>()
            else {
                return failure(500, "Plan draft data is inconsistent");
            };
            json_response(200, &json!({"profile_id":profile,"drafts":drafts}))
        }
        DraftOutcome::Workspace { workspace }
            if matches!(presentation, DraftPresentation::Workspace) =>
        {
            json_response(200, &workspace)
        }
        DraftOutcome::Transitioned { draft }
            if matches!(presentation, DraftPresentation::Transition) =>
        {
            match draft_identity(&draft) {
                Some(value) => json_response(200, &value),
                None => failure(500, "Plan draft data is inconsistent"),
            }
        }
        DraftOutcome::NotFound => match presentation {
            DraftPresentation::List => {
                coded_failure(404, "Plan not found", "profile_not_found", json!({}))
            }
            _ => coded_failure(404, "Plan draft not found", "draft_not_found", json!({})),
        },
        DraftOutcome::AcceptedBaselineRequired => coded_failure(
            409,
            "Plan draft update failed",
            "accepted_baseline_required",
            json!({}),
        ),
        DraftOutcome::InputsChanged => {
            coded_failure(409, "Plan draft update failed", "inputs_changed", json!({}))
        }
        DraftOutcome::AcceptedBaseChanged => {
            coded_failure(409, "Plan draft update failed", "base_changed", json!({}))
        }
        DraftOutcome::IdempotencyConflict => coded_failure(
            409,
            "Plan draft update failed",
            "idempotency_conflict",
            json!({}),
        ),
        DraftOutcome::BaseUnchanged => {
            coded_failure(409, "Plan draft update failed", "base_unchanged", json!({}))
        }
        DraftOutcome::MergeConflicts { conflicts } => coded_failure(
            422,
            "Plan draft update failed",
            "merge_conflicts",
            json!({"conflicts":conflicts}),
        ),
        DraftOutcome::NotAbandoned { .. } | DraftOutcome::NotAllowed { .. } => {
            coded_failure(409, "Plan draft update failed", "not_open", json!({}))
        }
        DraftOutcome::NoLayers => {
            coded_failure(422, "Plan draft update failed", "no_layers", json!({}))
        }
        DraftOutcome::NoStls => {
            coded_failure(422, "Plan draft update failed", "no_stls", json!({}))
        }
        DraftOutcome::WouldWipe => {
            coded_failure(422, "Plan draft update failed", "would_wipe", json!({}))
        }
        _ => failure(500, "Plan draft data is inconsistent"),
    }
}

fn draft_identity(draft: &Value) -> Option<Value> {
    let id = draft.get("id")?.as_u64()?;
    let state = draft.get("state")?.as_str()?;
    let lifecycle = draft.get("lifecycleVersion")?.as_u64()?;
    let digest = draft.get("snapshotDigest")?.as_str()?;
    let base_revision = draft.get("baseRevisionId")?;
    let base_version = draft.get("basePlanVersion")?.as_u64()?;
    if id == 0
        || !matches!(state, "open" | "abandoned" | "consumed")
        || digest.len() != 64
        || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !(base_revision.is_null() || base_revision.as_u64().is_some_and(|value| value > 0))
    {
        return None;
    }
    Some(json!({
        "draft_id":id,
        "state":state,
        "lifecycle_version":lifecycle,
        "snapshot_digest":digest,
        "base":{"revision_id":base_revision,"plan_version":base_version},
    }))
}

fn reconciliation_failure(outcome: ReconciliationOutcome, save_detail: Option<&str>) -> Response {
    match outcome {
        ReconciliationOutcome::Ready { workspace } => json_response(200, &workspace),
        ReconciliationOutcome::ProfileNotFound => coded_failure(
            404,
            save_detail.unwrap_or("Plan not found"),
            if save_detail.is_some() {
                "not_found"
            } else {
                "profile_not_found"
            },
            json!({}),
        ),
        ReconciliationOutcome::DraftNotFound => coded_failure(
            404,
            save_detail.unwrap_or("Plan draft not found"),
            if save_detail.is_some() {
                "not_found"
            } else {
                "draft_not_found"
            },
            json!({}),
        ),
        ReconciliationOutcome::DraftChanged { workspace } => coded_failure(
            409,
            save_detail.unwrap_or("Plan draft update failed"),
            "draft_changed",
            workspace.map_or_else(|| json!({}), |workspace| json!({"workspace":workspace})),
        ),
        ReconciliationOutcome::BaseChanged { workspace } => coded_failure(
            409,
            save_detail.unwrap_or("Plan draft update failed"),
            "base_changed",
            json!({"workspace":workspace}),
        ),
        ReconciliationOutcome::NotOpen { workspace } => coded_failure(
            409,
            save_detail.unwrap_or("Plan draft update failed"),
            "not_open",
            json!({"workspace":workspace}),
        ),
        ReconciliationOutcome::AcceptedBaselineRequired => coded_failure(
            409,
            save_detail.unwrap_or("Plan draft update failed"),
            "accepted_baseline_required",
            json!({}),
        ),
        ReconciliationOutcome::IdempotencyConflict => coded_failure(
            409,
            save_detail.unwrap_or("Plan draft update failed"),
            "idempotency_conflict",
            json!({}),
        ),
        ReconciliationOutcome::DomainError { code } => coded_failure(
            422,
            save_detail.unwrap_or("Plan draft update failed"),
            &code,
            json!({}),
        ),
        ReconciliationOutcome::TransactionUnavailable => coded_failure(
            503,
            save_detail.unwrap_or("Plan draft update is unavailable"),
            "transaction_unavailable",
            json!({}),
        ),
    }
}

fn publication_outcome(outcome: PublicationOutcome) -> Response {
    match outcome {
        PublicationOutcome::Applied { receipt }
        | PublicationOutcome::Existing { receipt }
        | PublicationOutcome::AlreadyApplied { receipt } => json_response(200, &receipt),
        outcome => publication_failure(outcome, None),
    }
}

fn publication_failure(outcome: PublicationOutcome, save_detail: Option<&str>) -> Response {
    let detail = save_detail.unwrap_or("Plan draft update failed");
    match outcome {
        PublicationOutcome::Applied { receipt }
        | PublicationOutcome::Existing { receipt }
        | PublicationOutcome::AlreadyApplied { receipt } => json_response(200, &receipt),
        PublicationOutcome::NotFound => coded_failure(
            404,
            save_detail.unwrap_or("Plan draft not found"),
            if save_detail.is_some() {
                "not_found"
            } else {
                "draft_not_found"
            },
            json!({}),
        ),
        PublicationOutcome::BuildArchived => {
            coded_failure(422, detail, "build_archived", json!({}))
        }
        PublicationOutcome::NotOpen { .. } => coded_failure(409, detail, "not_open", json!({})),
        PublicationOutcome::DraftChanged => coded_failure(409, detail, "draft_changed", json!({})),
        PublicationOutcome::AcceptedBaselineRequired => {
            coded_failure(409, detail, "accepted_baseline_required", json!({}))
        }
        PublicationOutcome::BaseChanged => coded_failure(409, detail, "base_changed", json!({})),
        PublicationOutcome::InputsChanged => {
            coded_failure(409, detail, "inputs_changed", json!({}))
        }
        PublicationOutcome::ReconciliationRequired { reason } => coded_failure(
            422,
            detail,
            "reconciliation_required",
            json!({"reason":reason}),
        ),
        PublicationOutcome::ProductionActive {
            checkoff_link_count,
            send_queue_item_count,
        } => coded_failure(
            423,
            detail,
            "production_active",
            json!({"checkoff_link_count":checkoff_link_count,"send_queue_item_count":send_queue_item_count}),
        ),
        PublicationOutcome::CheckoffRemapUnsafe { unmappable } => coded_failure(
            422,
            detail,
            "checkoff_remap_unsafe",
            json!({"unmappable":unmappable}),
        ),
        PublicationOutcome::ExecutionConflict { operations } => coded_failure(
            422,
            detail,
            "execution_conflict",
            json!({"operations":operations}),
        ),
        PublicationOutcome::TokenAllocationFailed => {
            coded_failure(422, detail, "token_allocation_failed", json!({}))
        }
        PublicationOutcome::IdempotencyConflict => {
            coded_failure(409, detail, "idempotency_conflict", json!({}))
        }
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
            AuthFailure::QueueFull | AuthFailure::Stopped => coded_failure(
                503,
                "Draft service temporarily unavailable",
                "writer_stopped",
                json!({}),
            ),
            _ => failure(500, "Draft service unavailable"),
        };
    }
    if let Some(draft_failure) = error.downcast_ref::<DraftFailure>() {
        let code = match draft_failure {
            DraftFailure::Cancelled => "request_cancelled",
            DraftFailure::QueueFull => "writer_queue_full",
            DraftFailure::Stopped => "writer_stopped",
            DraftFailure::OutcomeUnknown => "outcome_unknown",
            _ => return failure(500, "Draft service unavailable"),
        };
        return coded_failure(
            503,
            "Draft service temporarily unavailable",
            code,
            json!({}),
        );
    }
    if let Some(failure) = error.downcast_ref::<AdmissionFailure>() {
        let code = match failure {
            AdmissionFailure::Cancelled => "request_cancelled",
            AdmissionFailure::QueueFull => "writer_queue_full",
            AdmissionFailure::Stopped => "writer_stopped",
            AdmissionFailure::OutcomeUnknown => "outcome_unknown",
        };
        return coded_failure(
            503,
            "Draft service temporarily unavailable",
            code,
            json!({}),
        );
    }
    let message = error.to_string();
    let code = match message.as_str() {
        "Cancelled before admission" => Some("request_cancelled"),
        "Writer queue full" => Some("writer_queue_full"),
        "Storage stopped" | "Storage stopped without read result" | "Writer admission poisoned" => {
            Some("writer_stopped")
        }
        _ => None,
    };
    match code {
        Some(code) => coded_failure(
            503,
            "Draft service temporarily unavailable",
            code,
            json!({}),
        ),
        None => failure(500, "Draft service unavailable"),
    }
}

fn invalid_request() -> Response {
    coded_failure(400, "Request is invalid", "invalid_request", json!({}))
}

fn coded_failure(status: u16, detail: &str, code: &str, extra: Value) -> Response {
    let mut body = extra.as_object().cloned().unwrap_or_default();
    body.insert("detail".into(), json!(detail));
    body.insert("code".into(), json!(code));
    json_response(status, &Value::Object(body))
}
fn json_response(status: u16, value: &impl serde::Serialize) -> Response {
    (StatusCode::from_u16(status).expect("status"), Json(value)).into_response()
}
fn failure(status: u16, detail: &str) -> Response {
    (
        StatusCode::from_u16(status).expect("status"),
        Json(json!({"detail":detail})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pp_storage::{
        Limits, WriterOwner,
        auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
        read_model::views::{CatalogOnly, ReviewObservations},
        working_drafts::observation::{
            ArtifactRead, CheckoutManifestUse, DocumentRead, DraftReads, InventoryPath,
            OwnedCatalogReadRequest, OwnedCheckoutReadRequest, OwnedStlReadRequest,
            PreparationBudget, PreparationLimits, ReadFailure, ReadResult, StlInventory,
            StlRootRead,
        },
    };
    use sha2::{Digest, Sha256};
    use std::sync::{
        Mutex,
        atomic::AtomicUsize,
        mpsc::{Receiver, SyncSender, sync_channel},
    };
    use tower::ServiceExt;

    struct FixtureDraftReads {
        repos: std::path::PathBuf,
    }

    struct FixtureStlRoot {
        path: std::path::PathBuf,
        logical_path: String,
    }

    struct FixtureStlInventory {
        root: std::path::PathBuf,
        entries: Vec<InventoryPath>,
    }

    impl StlRootRead for FixtureStlRoot {
        fn logical_resolved_path(&self) -> Option<&str> {
            Some(&self.logical_path)
        }

        fn scan_stls(
            &mut self,
            budget: &mut PreparationBudget<'_>,
        ) -> ReadResult<Box<dyn StlInventory>> {
            let mut paths = Vec::new();
            for entry in
                std::fs::read_dir(&self.path).map_err(|error| ReadFailure::Io(error.kind()))?
            {
                let entry = entry.map_err(|error| ReadFailure::Io(error.kind()))?;
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("stl") {
                    continue;
                }
                let relative = entry.file_name().to_string_lossy().into_owned();
                budget.entry(1, relative.len())?;
                paths.push(relative);
            }
            paths.sort();
            Ok(Box::new(FixtureStlInventory {
                root: self.path.clone(),
                entries: paths
                    .into_iter()
                    .enumerate()
                    .map(
                        |(traversal_ordinal, physical_relative_path)| InventoryPath {
                            physical_relative_path,
                            traversal_ordinal,
                        },
                    )
                    .collect(),
            }))
        }
    }

    impl StlInventory for FixtureStlInventory {
        fn entries(&self) -> &[InventoryPath] {
            &self.entries
        }

        fn hash_tracked_winner(
            &mut self,
            index: usize,
            budget: &mut PreparationBudget<'_>,
        ) -> ReadResult<ArtifactRead> {
            let entry = self.entries.get(index).ok_or(ReadFailure::Unavailable)?;
            let bytes = std::fs::read(self.root.join(&entry.physical_relative_path))
                .map_err(|error| ReadFailure::Io(error.kind()))?;
            budget.artifact(bytes.len() as u64, bytes.len())?;
            Ok(ArtifactRead {
                byte_count: bytes.len() as u64,
                byte_sha256: hex::encode(Sha256::digest(bytes)),
            })
        }
    }

    impl DraftReads for FixtureDraftReads {
        fn resolve_stl_root(
            &self,
            request: &OwnedStlReadRequest,
            budget: &mut PreparationBudget<'_>,
        ) -> ReadResult<Box<dyn StlRootRead>> {
            budget.check()?;
            let path = request
                .stored_path()
                .map(|stored| self.repos.join(stored))
                .ok_or(ReadFailure::UnsafeLocator)?;
            let logical_path = path.to_string_lossy().into_owned();
            Ok(Box::new(FixtureStlRoot { path, logical_path }))
        }

        fn read_checkout_manifest(
            &self,
            _: &OwnedCheckoutReadRequest,
            _: CheckoutManifestUse,
            budget: &mut PreparationBudget<'_>,
        ) -> ReadResult<DocumentRead> {
            budget.check()?;
            Ok(DocumentRead::Missing)
        }

        fn read_catalog_document(
            &self,
            _: &OwnedCatalogReadRequest,
            budget: &mut PreparationBudget<'_>,
        ) -> ReadResult<DocumentRead> {
            budget.check()?;
            Ok(DocumentRead::Missing)
        }
    }

    #[derive(Clone, Copy)]
    enum FakeMode {
        ScanFailure,
        FilamentFailure,
        BlockingScan,
    }

    struct FakePort {
        mode: FakeMode,
        scans: AtomicUsize,
        filaments: AtomicUsize,
        entered: Mutex<Option<SyncSender<()>>>,
        cancelled: Arc<AtomicBool>,
    }

    impl FakePort {
        fn new(mode: FakeMode) -> (Arc<Self>, Option<Receiver<()>>) {
            let (entered, receiver) = if matches!(mode, FakeMode::BlockingScan) {
                let (sender, receiver) = sync_channel(1);
                (Some(sender), Some(receiver))
            } else {
                (None, None)
            };
            (
                Arc::new(Self {
                    mode,
                    scans: AtomicUsize::new(0),
                    filaments: AtomicUsize::new(0),
                    entered: Mutex::new(entered),
                    cancelled: Arc::new(AtomicBool::new(false)),
                }),
                receiver,
            )
        }
    }

    impl ReviewObservationPort for FakePort {
        fn review_observations(
            &self,
            _: &pp_storage::read_model::Snapshot,
            cancelled: &AtomicBool,
        ) -> Result<ReviewObservations> {
            self.scans.fetch_add(1, Ordering::Relaxed);
            match self.mode {
                FakeMode::ScanFailure => Err(anyhow::anyhow!("scan failed")),
                FakeMode::FilamentFailure => Ok(ReviewObservations {
                    available_input_roots: Default::default(),
                    media_by_part_id: Default::default(),
                }),
                FakeMode::BlockingScan => {
                    if let Some(sender) = self.entered.lock().unwrap().take() {
                        sender.send(()).unwrap();
                    }
                    let deadline = std::time::Instant::now() + Duration::from_secs(3);
                    while !cancelled.load(Ordering::Acquire) && std::time::Instant::now() < deadline
                    {
                        std::thread::park_timeout(Duration::from_millis(1));
                    }
                    if !cancelled.load(Ordering::Acquire) {
                        return Err(anyhow::anyhow!("cancellation deadline elapsed"));
                    }
                    self.cancelled.store(true, Ordering::Release);
                    Err(anyhow::anyhow!("scan cancelled"))
                }
            }
        }

        fn filament_lookup<'a>(
            &'a self,
            _: &'a pp_storage::read_model::Snapshot,
            _: Arc<AtomicBool>,
        ) -> super::super::FilamentFuture<'a> {
            self.filaments.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move {
                if matches!(self.mode, FakeMode::FilamentFailure) {
                    Err(anyhow::anyhow!("filament failed"))
                } else {
                    Ok(Box::new(CatalogOnly)
                        as Box<
                            dyn pp_storage::read_model::views::FilamentLookup + Send + Sync,
                        >)
                }
            })
        }
    }

    fn test_policy() -> AuthPolicy {
        AuthPolicy {
            registration: RegistrationPolicy::FirstAccountOnly,
            first_user: FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::SingleAccountDefault,
        }
    }

    fn test_directory() -> std::path::PathBuf {
        let mut bytes = [0; 12];
        getrandom::fill(&mut bytes).unwrap();
        std::env::temp_dir().join(format!("pp-api-draft-port-{}", hex::encode(bytes)))
    }

    fn test_app(
        observer: Arc<dyn ReviewObservationPort>,
    ) -> (App, WriterOwner, std::path::PathBuf) {
        let directory = test_directory();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("print-partner.db"),
            include_bytes!("../../../pp-storage/tests/fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        let revision = directory.join("repos/1/revisions/fixture");
        std::fs::create_dir_all(&revision).unwrap();
        std::fs::write(revision.join("bracket.stl"), b"solid bracket").unwrap();
        std::fs::write(revision.join("excluded.stl"), b"solid excluded").unwrap();
        std::fs::write(revision.join("gear.stl"), b"solid gear").unwrap();
        let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
        let policy = test_policy();
        let drafts = owner
            .working_drafts_with_policy(
                policy,
                Arc::new(FixtureDraftReads {
                    repos: directory.join("repos"),
                }),
                PreparationLimits::default(),
                directory.join("repos"),
            )
            .unwrap();
        let app = App {
            config: DraftHttpConfig::new("http://127.0.0.1:1", "default").unwrap(),
            clients: DraftHttpClients {
                saves: drafts.plan_save(),
                publication: owner.publication_with_policy(policy).unwrap(),
                accepted: owner.accepted_reads_with_policy(policy).unwrap(),
                drafts,
            },
            observer,
            admission: Arc::new(tokio::sync::Semaphore::new(64)),
            waiters: Arc::new(tokio::sync::Semaphore::new(64)),
        };
        (app, owner, directory)
    }

    fn save_request() -> Value {
        json!({
            "expected_base":{"revision_id":1,"plan_version":1},
            "expected_draft":{
                "draft_id":2,
                "state":"open",
                "lifecycle_version":0,
                "snapshot_digest":"ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3",
                "base":{"revision_id":1,"plan_version":1}
            },
            "remap_checkoff_links":false,
            "decisions":[{
                "kind":"set_quantity_override",
                "target":{
                    "part_key":"bracket.stl",
                    "relative_path":"bracket.stl",
                    "source_layer":"base:Fixture Source"
                },
                "value":4
            }]
        })
    }

    async fn send_save(client: &reqwest::Client, origin: &str, key: &str) -> (u16, Value) {
        let response = client
            .post(format!("{origin}/plans/1/save"))
            .header("Origin", origin)
            .header("Cookie", "pp_session=required-unit-fixture-secret")
            .header("Idempotency-Key", key)
            .json(&save_request())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let body = response.json().await.unwrap();
        (status, body)
    }

    async fn router_saves(
        mode: FakeMode,
        key: &str,
    ) -> ((u16, Value), (u16, Value), Arc<FakePort>) {
        let (observer, _) = FakePort::new(mode);
        let (app, owner, directory) = test_app(observer.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = draft_router(
            DraftHttpConfig::new(&origin, "default").unwrap(),
            app.clients,
            app.observer,
        );
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let first = send_save(&client, &origin, key).await;
        let replay = send_save(&client, &origin, key).await;
        stop.send(()).unwrap();
        server.await.unwrap();
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        (first, replay, observer)
    }

    fn assert_uncertain_save(response: &(u16, Value), stage: &str, key: &str) {
        assert_eq!(response.0, 500, "{}", response.1);
        assert_eq!(
            response.1["code"], "save_response_uncertain",
            "{}",
            response.1
        );
        assert_eq!(response.1["stage"], stage, "{}", response.1);
        assert_eq!(response.1["idempotency_key"], key, "{}", response.1);
        assert_eq!(response.1["receipt"]["profile_id"], 1, "{}", response.1);
        assert_eq!(response.1["receipt"]["draft_id"], 3, "{}", response.1);
        assert_eq!(response.1["receipt"]["plan_version"], 2, "{}", response.1);
        assert_eq!(response.1["closed_draft_ids"], json!([2]), "{}", response.1);
    }

    #[tokio::test]
    async fn api_only_port_keeps_scan_and_filament_failures_distinct_through_router() {
        let scan_key = "api-port-scan-uncertain";
        let (scan, scan_replay, scan_failure) = router_saves(FakeMode::ScanFailure, scan_key).await;
        assert_uncertain_save(&scan, "review_observation", scan_key);
        assert_uncertain_save(&scan_replay, "review_observation", scan_key);
        assert_eq!(scan_replay.1["receipt"], scan.1["receipt"]);
        assert_eq!(
            scan_replay.1["closed_draft_ids"],
            scan.1["closed_draft_ids"]
        );
        assert_eq!(scan_failure.scans.load(Ordering::Relaxed), 2);
        assert_eq!(scan_failure.filaments.load(Ordering::Relaxed), 0);

        let filament_key = "api-port-filament-uncertain";
        let (filament, filament_replay, filament_failure) =
            router_saves(FakeMode::FilamentFailure, filament_key).await;
        assert_uncertain_save(&filament, "filament_observation", filament_key);
        assert_uncertain_save(&filament_replay, "filament_observation", filament_key);
        assert_eq!(filament_replay.1["receipt"], filament.1["receipt"]);
        assert_eq!(
            filament_replay.1["closed_draft_ids"],
            filament.1["closed_draft_ids"]
        );
        assert_eq!(filament_failure.scans.load(Ordering::Relaxed), 2);
        assert_eq!(filament_failure.filaments.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn dropped_review_request_releases_observation_cancellation() {
        let (observer, entered) = FakePort::new(FakeMode::BlockingScan);
        let entered = entered.unwrap();
        let cancelled = observer.cancelled.clone();
        let (app, owner, directory) = test_app(observer);
        let router = draft_router(app.config, app.clients, app.observer);
        let mut request = axum::http::Request::builder()
            .method(Method::GET)
            .uri("/plans/1/review")
            .header("Host", "127.0.0.1:1")
            .header("Origin", "http://127.0.0.1:1")
            .header("Cookie", "pp_session=required-unit-fixture-secret")
            .body(axum::body::Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 49152))));
        let task = tokio::spawn(router.oneshot(request));
        tokio::task::spawn_blocking(move || entered.recv_timeout(Duration::from_secs(2)).unwrap())
            .await
            .unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while !cancelled.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
