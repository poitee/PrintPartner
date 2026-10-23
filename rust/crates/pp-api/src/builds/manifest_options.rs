use super::http::{App, bytes_response, execute, failure};
use axum::{
    extract::{Path, State},
    http::{Method, StatusCode},
    response::Response,
};
use pp_storage::build_graph::{
    BuildCommand, ManifestOptionsCommand, ManifestOptionsOutcome, PositiveId,
};

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

pub(super) fn present(method: &Method, outcome: ManifestOptionsOutcome) -> Response {
    let head = *method == Method::HEAD;
    match outcome {
        kit @ ManifestOptionsOutcome::Kit { .. } => match kit.into_success_body() {
            Ok(body) => bytes_response(StatusCode::OK, body.into_bytes(), head),
            Err(_) => failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Build service unavailable",
            ),
        },
        ManifestOptionsOutcome::MissingBuild => {
            failure(StatusCode::NOT_FOUND, "Profile not found")
        }
        // SaveKit / ReadBuilder stay unregistered (GRE-802 / GRE-803).
        _ => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Build service unavailable",
        ),
    }
}
