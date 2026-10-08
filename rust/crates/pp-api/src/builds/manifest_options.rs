use pp_storage::build_graph::manifest_options::{ManifestOptionsFailure, ManifestOptionsOutcome};
use serde_json::json;

pub(super) fn present(outcome: ManifestOptionsOutcome) -> (u16, Vec<u8>) {
    match outcome.into_success_body() {
        Ok(body) => (200, body.into_bytes()),
        Err(ManifestOptionsFailure::MissingBuild) => {
            (404, serde_json::to_vec(&json!({"detail":"Profile not found"})).unwrap())
        }
        Err(ManifestOptionsFailure::InvalidInput { detail }) => {
            (400, detail.into_body().into_bytes())
        }
        Err(ManifestOptionsFailure::StaleObservation) => (
            409,
            serde_json::to_vec(&json!({"detail":"Build inputs changed during manifest observation","code":"stale_observation"})).unwrap(),
        ),
        Err(ManifestOptionsFailure::ObservationFailed { detail }) => (
            503,
            serde_json::to_vec(&json!({"detail":"Manifest source observation failed","code":"source_observation_failed","reason":detail})).unwrap(),
        ),
    }
}
