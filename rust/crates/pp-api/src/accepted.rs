//! Accepted Plan read routes (GRE-415): one consistent `ReadClient` snapshot
//! per request, projected by `read_model::views` as Node's `plans.ts` does.

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
    read_model::{
        ReadClient,
        views::{self, CatalogOnly},
    },
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct AcceptedHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    enabled: bool,
    wait: Duration,
}

impl AcceptedHttpConfig {
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
}

#[derive(Clone)]
struct App {
    config: AcceptedHttpConfig,
    client: ReadClient,
    admission: Arc<tokio::sync::Semaphore>,
}

/// Mounts Accepted Plan Checkoff GET+HEAD at `/`, `/api/v1`, and `/api/v2`
/// when `PP_DESKTOP_REBUILD` was exactly `1` or `true`; otherwise nothing.
/// Filament labels come from the colour catalog only; configured Spoolman
/// enrichment is not part of this surface yet.
pub fn accepted_router(config: AcceptedHttpConfig, client: ReadClient) -> Router {
    if !config.enabled {
        return Router::new();
    }
    let app = App {
        config,
        client,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let routes = Router::new().route("/plans/{id}/checkoff", get(checkoff));
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
            "Service temporarily unavailable",
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

struct Cancellation(Arc<AtomicBool>);
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

async fn checkoff(
    State(app): State<App>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let Some(presented) = request.extensions().get::<PresentedCredential>().cloned() else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let head = *request.method() == Method::HEAD;
    // Node reads the id with `Number()`; an id that cannot name a Plan is
    // "Profile not found" once the credential is proven (an empty batch).
    let profile = id
        .parse::<u64>()
        .ok()
        .filter(|id| (1..=MAX_SAFE_ID).contains(id))
        .map(|id| id as i64);
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Cancellation(cancelled.clone());
    let read = tokio::task::spawn_blocking(move || {
        let ids = profile.as_slice();
        let batch = client.read(presented.into_credential(), ids, &cancelled, wait)?;
        Ok::<_, anyhow::Error>(match batch.builds.first() {
            Some(build) => Some(views::checkoff(
                build.profile_id,
                &build.accepted,
                &CatalogOnly,
            )?),
            None => None,
        })
    })
    .await;
    drop(flag);
    match read {
        Ok(Ok(Some(view))) => present(view, head),
        Ok(Ok(None)) => failure(StatusCode::NOT_FOUND, "Profile not found"),
        Ok(Err(error)) => read_error(&error),
        Err(_) => failure(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

/// Maps a `views::checkoff` result to Node's `/plans/:id/checkoff` responses.
fn present(view: Value, head: bool) -> Response {
    match view["kind"].as_str() {
        Some("ready" | "empty") => json_response(StatusCode::OK, &view["body"], head),
        Some("not_found") => failure(StatusCode::NOT_FOUND, "Profile not found"),
        Some("accepted_state_unavailable") => failure(
            StatusCode::CONFLICT,
            if view["reason"] == "compatibility_dirty" {
                "Accepted Plan requires compatibility repair"
            } else {
                "Accepted Plan operational state is not initialized"
            },
        ),
        Some("integrity_failure") => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Accepted Plan data is inconsistent",
        ),
        _ => failure(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

/// `ReadClient` refuses credentials with `AuthFailure` (sessions) or the plain
/// "Authentication required" message (API keys); admission refusals are plain
/// messages too. Anything else is Node's opaque 500.
fn read_error(error: &anyhow::Error) -> Response {
    match error.downcast_ref::<AuthFailure>() {
        Some(
            AuthFailure::SessionRequired
            | AuthFailure::InvalidCredentials
            | AuthFailure::CredentialChanged,
        ) => return failure(StatusCode::UNAUTHORIZED, "Authentication required"),
        Some(AuthFailure::OwnerMappingRequired) => {
            return failure(
                StatusCode::FORBIDDEN,
                "Explicit account owner mapping is required",
            );
        }
        _ => {}
    }
    match error.to_string().as_str() {
        "Authentication required" => failure(StatusCode::UNAUTHORIZED, "Authentication required"),
        "Writer queue full" | "Storage stopped" | "Cancelled before admission" => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        ),
        _ => failure(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"),
    }
}

fn json_response(status: StatusCode, value: &Value, head: bool) -> Response {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len())
        .body(axum::body::Body::from(if head { Vec::new() } else { body }))
        .unwrap_or_else(|_| Response::new(axum::body::Body::empty()))
}

fn failure(status: StatusCode, detail: &str) -> Response {
    json_response(status, &json!({"detail": detail}), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn ticket_t_61_read_model_http_checkoff_maps_every_view_kind() {
        for (view, status, expected) in [
            (
                json!({"kind":"ready","body":{"profile_id":1,"parts":[]}}),
                200,
                json!({"profile_id":1,"parts":[]}),
            ),
            (
                json!({"kind":"empty","body":{"profile_id":2,"parts":[]}}),
                200,
                json!({"profile_id":2,"parts":[]}),
            ),
            (
                json!({"kind":"not_found"}),
                404,
                json!({"detail":"Profile not found"}),
            ),
            (
                json!({"kind":"accepted_state_unavailable","reason":"compatibility_dirty"}),
                409,
                json!({"detail":"Accepted Plan requires compatibility repair"}),
            ),
            (
                json!({"kind":"accepted_state_unavailable","reason":"uninitialized"}),
                409,
                json!({"detail":"Accepted Plan operational state is not initialized"}),
            ),
            (
                json!({"kind":"integrity_failure","code":"pointer","message":"private"}),
                500,
                json!({"detail":"Accepted Plan data is inconsistent"}),
            ),
        ] {
            assert_eq!(body(present(view, false)).await, (status, expected));
        }
    }

    #[tokio::test]
    async fn ticket_t_61_read_model_http_read_errors_hide_details() {
        for (error, status, detail) in [
            (
                anyhow::anyhow!(AuthFailure::SessionRequired),
                401,
                "Authentication required",
            ),
            (
                anyhow::anyhow!("Authentication required"),
                401,
                "Authentication required",
            ),
            (
                anyhow::anyhow!(AuthFailure::OwnerMappingRequired),
                403,
                "Explicit account owner mapping is required",
            ),
            (
                anyhow::anyhow!("Writer queue full"),
                503,
                "Service temporarily unavailable",
            ),
            (
                anyhow::anyhow!("private failure detail /tmp/secret"),
                500,
                "Internal Server Error",
            ),
        ] {
            assert_eq!(
                body(read_error(&error)).await,
                (status, json!({ "detail": detail }))
            );
        }
    }
}
