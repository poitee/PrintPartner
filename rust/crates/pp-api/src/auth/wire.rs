use super::CookieTransport;
use axum::{
    Json,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use pp_storage::auth::{AuthFailure, Secret, User};
use serde_json::{Value, json};

#[derive(Debug)]
pub(super) struct Failure(pub StatusCode, pub &'static str);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"detail": self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        use AuthFailure::*;
        let (status, detail) = match error.downcast_ref::<AuthFailure>() {
            Some(InvalidInput(pp_storage::auth::AuthInputFailure::PasswordTooShort)) => {
                (400, "Password must be at least 8 characters")
            }
            Some(InvalidInput(_)) => (400, "Invalid authentication input"),
            Some(InvalidCredentials) => (401, "Invalid email or password"),
            Some(SessionRequired) => (401, "Authentication required"),
            Some(CurrentPasswordIncorrect) => (401, "Current password is incorrect"),
            Some(OAuthOnlyAccount) => (400, "This account uses OAuth sign-in only"),
            Some(DuplicateEmail) => (409, "Email already registered"),
            Some(RegistrationClosed) => (403, "Registration is closed"),
            Some(SingleAccountExists) => (403, "The single-user administrator already exists"),
            Some(OwnerMappingRequired) => (403, "Explicit account owner mapping is required"),
            Some(CredentialChanged) => (401, "Credential changed; sign in again"),
            Some(QueueFull | Stopped) => (503, "Authentication temporarily unavailable"),
            _ => (500, "Authentication unavailable"),
        };
        Self(StatusCode::from_u16(status).expect("valid status"), detail)
    }
}
pub(super) fn public_user(user: User) -> Value {
    json!({"user_id":user.user_id,"login":user.login,"display_name":user.display_name,"email":user.email,"provider":user.provider,"is_admin":user.is_admin})
}
pub(super) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut result = None;
    for header in headers.get_all(header::COOKIE) {
        for item in header.to_str().ok()?.split(';') {
            let Some((key, value)) = item.trim().split_once('=') else {
                continue;
            };
            if key == name {
                if result.is_some() || value.len() > 4096 {
                    return None;
                }
                result = Some(value.to_owned());
            }
        }
    }
    result
}
pub(super) fn session(headers: &HeaderMap) -> Result<Secret, Failure> {
    cookie(headers, "pp_session")
        .filter(|v| !v.is_empty())
        .map(Secret::new)
        .ok_or(Failure(StatusCode::UNAUTHORIZED, "Authentication required"))
}
pub(super) fn set_cookie(
    response: &mut Response,
    name: &str,
    value: &str,
    age: u32,
    transport: CookieTransport,
) {
    let secure = if matches!(transport, CookieTransport::Secure) {
        "; Secure"
    } else {
        ""
    };
    let value = format!("{name}={value}; Max-Age={age}; Path=/; HttpOnly; SameSite=Lax{secure}");
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&value).expect("generated cookie"),
    );
}
pub(super) fn json_response(value: Value) -> Response {
    Json(value).into_response()
}
pub(super) fn redirect(target: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(target).expect("validated redirect"),
    );
    response
}
