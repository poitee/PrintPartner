use axum::{
    Json,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use pp_storage::{
    auth::{AuthFailure, Secret},
    profiles::{
        ProfileLibraryAccess, ProfileLibraryClient, ProfileLibraryFailure, ProfileLibraryKeyAccess,
    },
};
use serde_json::json;

#[derive(Debug)]
pub(super) struct Failure {
    status: StatusCode,
    detail: &'static str,
}

impl Failure {
    pub(super) fn new(status: u16, detail: &'static str) -> Self {
        Self {
            status: StatusCode::from_u16(status).expect("status"),
            detail,
        }
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        private_response((self.status, Json(json!({"detail": self.detail}))).into_response())
    }
}

impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        if let Some(failure) = error.downcast_ref::<AuthFailure>() {
            return match failure {
                AuthFailure::SessionRequired
                | AuthFailure::InvalidCredentials
                | AuthFailure::CredentialChanged => Self::new(401, "Authentication required"),
                AuthFailure::OwnerMappingRequired => {
                    Self::new(403, "Explicit account owner mapping is required")
                }
                AuthFailure::QueueFull | AuthFailure::Stopped => {
                    Self::new(503, "Profile library temporarily unavailable")
                }
                AuthFailure::InvalidInput(_)
                | AuthFailure::CurrentPasswordIncorrect
                | AuthFailure::OAuthOnlyAccount
                | AuthFailure::DuplicateEmail
                | AuthFailure::RegistrationClosed
                | AuthFailure::SingleAccountExists
                | AuthFailure::CommitUnknown
                | AuthFailure::Storage => Self::new(500, "Profile library unavailable"),
            };
        }
        match error.downcast_ref::<ProfileLibraryFailure>() {
            Some(
                ProfileLibraryFailure::ReaderBusy
                | ProfileLibraryFailure::Stopped
                | ProfileLibraryFailure::Cancelled,
            ) => Self::new(503, "Profile library temporarily unavailable"),
            Some(ProfileLibraryFailure::Storage) | None => {
                Self::new(500, "Profile library unavailable")
            }
        }
    }
}

pub(super) fn credential(
    headers: &HeaderMap,
    access: &ProfileLibraryAccess,
    keys: Option<&ProfileLibraryKeyAccess>,
) -> Result<ProfileLibraryClient, Failure> {
    let denied = || Failure::new(401, "Authentication required");
    let mut session = None;
    for header in headers.get_all(header::COOKIE) {
        for item in header.to_str().map_err(|_| denied())?.split(';') {
            if let Some(("pp_session", value)) = item.trim().split_once('=')
                && session.replace(value).is_some()
            {
                return Err(denied());
            }
        }
    }
    let authorization = headers.get(header::AUTHORIZATION);
    let custom = headers.get("x-print-partner-api-key");
    if headers.get_all(header::AUTHORIZATION).iter().count() > 1
        || headers.get_all("x-print-partner-api-key").iter().count() > 1
        || usize::from(session.is_some())
            + usize::from(authorization.is_some())
            + usize::from(custom.is_some())
            != 1
    {
        return Err(denied());
    }
    if let Some(value) = session {
        if value.is_empty() || value.len() > 4096 {
            return Err(denied());
        }
        return Ok(access.session(Secret::new(value.to_owned())));
    }
    let key = if let Some(value) = authorization {
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
    Ok(keys.ok_or_else(denied)?.key(Secret::new(key.to_owned())))
}

pub(super) fn private_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}
