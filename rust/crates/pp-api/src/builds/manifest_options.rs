use super::http::{App, bytes_response, execute, failure, run};
use crate::loopback::PresentedCredential;
use axum::{
    body::to_bytes,
    extract::{Path, State},
    http::{Method, StatusCode},
    response::Response,
};
use pp_storage::build_graph::{
    BuildCommand, ManifestOptionsCommand, ManifestOptionsOutcome, PositiveId,
};
use serde_json::json;

/// Node / docs allow 8 MiB for kit-manifest PUT; Build create stays at the
/// lower shared default.
const KIT_BODY_LIMIT: usize = 8 * 1024 * 1024;

/// `GET`/`HEAD` `/plans/{id}/kit-manifest` — storage `ReadKit` through the Build router.
pub(super) async fn read_kit(
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
    execute(
        app,
        request,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
    )
    .await
}

/// `PUT` `/plans/{id}/kit-manifest` — storage `SaveKit` through the Build router.
pub(super) async fn save_kit(
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
    let Some(presented) = request.extensions().get::<PresentedCredential>().cloned() else {
        return failure(StatusCode::UNAUTHORIZED, "Authentication required");
    };
    let path = request.uri().path().to_owned();
    let bytes = match to_bytes(request.into_body(), KIT_BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => return failure(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
    };
    run(
        app,
        presented,
        Method::PUT,
        path,
        super::http::SummaryContract::Accepted,
        BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
            build,
            request: bytes.to_vec(),
        }),
    )
    .await
}

/// `GET`/`HEAD` `/plans/{id}/plan-manifest-builder` — storage `ReadBuilder`.
pub(super) async fn read_builder(
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
    execute(
        app,
        request,
        BuildCommand::Manifest(ManifestOptionsCommand::ReadBuilder { build }),
    )
    .await
}

pub(super) fn present(method: &Method, outcome: ManifestOptionsOutcome) -> Response {
    let head = *method == Method::HEAD;
    match outcome {
        success @ (ManifestOptionsOutcome::Kit { .. }
        | ManifestOptionsOutcome::Saved { .. }
        | ManifestOptionsOutcome::Builder(_)) => match success.into_success_body() {
            Ok(body) => bytes_response(StatusCode::OK, body.into_bytes(), head),
            Err(_) => failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Build service unavailable",
            ),
        },
        ManifestOptionsOutcome::MissingBuild => failure(StatusCode::NOT_FOUND, "Profile not found"),
        ManifestOptionsOutcome::InvalidInput { detail } => bytes_response(
            StatusCode::BAD_REQUEST,
            detail.into_body().into_bytes(),
            false,
        ),
        ManifestOptionsOutcome::StaleObservation => bytes_response(
            StatusCode::CONFLICT,
            serde_json::to_vec(&json!({
                "detail": "Build inputs changed during manifest observation",
                "code": "stale_observation",
            }))
            .unwrap_or_else(|_| br#"{"detail":"Build service unavailable"}"#.to_vec()),
            false,
        ),
        ManifestOptionsOutcome::ObservationFailed { detail } => bytes_response(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::to_vec(&json!({
                "detail": "Manifest source observation failed",
                "code": "source_observation_failed",
                "reason": detail,
            }))
            .unwrap_or_else(|_| br#"{"detail":"Build service unavailable"}"#.to_vec()),
            false,
        ),
    }
}
