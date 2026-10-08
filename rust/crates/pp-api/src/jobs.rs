use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::ws::{Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method, StatusCode, header::CONTENT_TYPE},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{Sink, SinkExt, future::poll_fn, stream};
use pp_storage::{
    auth::{AuthFailure, AuthPolicy, Secret},
    jobs::{
        AtomicJobClient, CompletedResult, Credential, FrameAdmission, JobAccessFailure,
        JobSnapshot, JobSubscription, LegacyListFilter, LegacyProfileFilter, LegacyStatusFilter,
        NonblockingSend, PreparedEvent, RetainedJobs, StreamClose,
    },
};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone)]
pub struct JobsHttpConfig {
    origin: String,
    host: String,
    api_key_tenant: String,
    wait: Duration,
}

impl JobsHttpConfig {
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
            api_key_tenant: api_key_tenant.to_owned(),
            wait: Duration::from_millis(100),
        })
    }

    pub fn with_wait(mut self, wait: Duration) -> Result<Self> {
        ensure!(wait <= self.wait, "Jobs HTTP wait may only be reduced");
        self.wait = wait;
        Ok(self)
    }
}

#[derive(Clone)]
struct App {
    config: JobsHttpConfig,
    client: AtomicJobClient,
    admission: Arc<tokio::sync::Semaphore>,
    serializers: Arc<tokio::sync::Semaphore>,
}

enum Principal {
    Session(String),
    ApiKey { tenant: String, secret: String },
}

impl Principal {
    fn credential(self) -> Credential {
        match self {
            Self::Session(value) => Credential::Session(Secret::new(value)),
            Self::ApiKey { tenant, secret } => Credential::RoutedKey {
                tenant,
                key: Secret::new(secret),
            },
        }
    }
}

struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[derive(Serialize)]
struct WireJob<'a> {
    job_id: &'a str,
    kind: &'a pp_storage::jobs::JobKind,
    status: &'static str,
    message: &'static str,
    progress: Option<u8>,
    result: &'a Option<CompletedResult>,
    error: Option<&'static str>,
    created_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<&'a str>,
}

impl<'a> WireJob<'a> {
    fn from_snapshot(snapshot: &'a JobSnapshot, include_updated: bool) -> Self {
        Self {
            job_id: &snapshot.job_id,
            kind: &snapshot.kind,
            status: snapshot.status,
            message: snapshot.message,
            progress: snapshot.progress,
            result: &snapshot.result,
            error: snapshot.error,
            created_at: &snapshot.created_at,
            finished_at: snapshot.finished_at.as_deref(),
            updated_at: include_updated.then_some(snapshot.updated_at.as_str()),
        }
    }
}

const JSON_CHUNK_BYTES: usize = 16 * 1024;

struct JsonChunkWriter {
    sender: tokio::sync::mpsc::Sender<io::Result<Bytes>>,
    buffer: Vec<u8>,
}

impl JsonChunkWriter {
    fn new(sender: tokio::sync::mpsc::Sender<io::Result<Bytes>>) -> Self {
        Self {
            sender,
            buffer: Vec::with_capacity(JSON_CHUNK_BYTES),
        }
    }

    fn send_buffer(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let bytes = Bytes::from(std::mem::replace(
            &mut self.buffer,
            Vec::with_capacity(JSON_CHUNK_BYTES),
        ));
        self.sender
            .blocking_send(Ok(bytes))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response body dropped"))
    }
}

impl Write for JsonChunkWriter {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let written = bytes.len();
        while !bytes.is_empty() {
            let available = JSON_CHUNK_BYTES - self.buffer.len();
            let count = available.min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.buffer.len() == JSON_CHUNK_BYTES {
                self.send_buffer()?;
            }
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.send_buffer()
    }
}

fn serialize_retained(
    jobs: RetainedJobs,
    _permit: tokio::sync::OwnedSemaphorePermit,
    sender: tokio::sync::mpsc::Sender<io::Result<Bytes>>,
) {
    let mut writer = JsonChunkWriter::new(sender.clone());
    let result = (|| -> io::Result<()> {
        writer.write_all(b"{\"jobs\":[")?;
        for (index, job) in jobs.iter().enumerate() {
            if index != 0 {
                writer.write_all(b",")?;
            }
            serde_json::to_writer(&mut writer, &WireJob::from_snapshot(job, true))
                .map_err(io::Error::other)?;
        }
        writer.write_all(b"]}")?;
        writer.flush()
    })();
    if let Err(error) = result
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        let _ = sender.blocking_send(Err(error));
    }
}

fn retained_response(jobs: RetainedJobs, permit: tokio::sync::OwnedSemaphorePermit) -> Response {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    tokio::task::spawn_blocking(move || serialize_retained(jobs, permit, sender));
    let body_stream = stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|chunk| (chunk, receiver))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from_stream(body_stream))
        .expect("valid retained response")
}

pub fn jobs_router(config: JobsHttpConfig, client: AtomicJobClient) -> Router {
    let app = App {
        config,
        client,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        serializers: Arc::new(tokio::sync::Semaphore::new(2)),
    };
    Router::new()
        .route("/api/v1/jobs", get(list).head(list))
        .route("/api/v1/jobs/{id}", get(read).head(read))
        .route("/jobs/{id}", get(read).head(read))
        .route("/ws/jobs/{job_id}", get(stream).head(stream_head))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(State(app): State<App>, request: axum::extract::Request, next: Next) -> Response {
    let Ok(_permit) = app.admission.try_acquire() else {
        return failure(503, "Jobs service temporarily unavailable");
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
        || headers
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site")
    {
        return failure(403, "Invalid request origin");
    }
    next.run(request).await
}

async fn list(State(app): State<App>, request: axum::extract::Request) -> Response {
    let principal = match principal(request.headers(), &app.config.api_key_tenant) {
        Some(value) => value,
        None => return failure(401, "Authentication required"),
    };
    let filter = legacy_filter(request.uri().query());
    let head = request.method() == Method::HEAD;
    let permit = match app.serializers.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return failure(503, "Jobs service temporarily unavailable"),
    };
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancellation = Cancellation::new();
    let cancelled = cancellation.0.clone();
    match tokio::task::spawn_blocking(move || {
        (
            client.list_retained(principal.credential(), filter, &cancelled, wait),
            permit,
        )
    })
    .await
    {
        Ok((Ok(jobs), permit)) => {
            if head {
                StatusCode::OK.into_response()
            } else {
                retained_response(jobs, permit)
            }
        }
        Ok((Err(error), _permit)) => domain_error(error),
        Err(_) => failure(500, "Jobs service unavailable"),
    }
}

async fn read(
    State(app): State<App>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let principal = match principal(request.headers(), &app.config.api_key_tenant) {
        Some(value) => value,
        None => return failure(401, "Authentication required"),
    };
    let head = request.method() == Method::HEAD;
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancellation = Cancellation::new();
    let cancelled = cancellation.0.clone();
    match tokio::task::spawn_blocking(move || {
        client.read_public(principal.credential(), id, &cancelled, wait)
    })
    .await
    {
        Ok(Ok(job)) => {
            if head {
                StatusCode::OK.into_response()
            } else {
                Json(WireJob::from_snapshot(&job, false)).into_response()
            }
        }
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(500, "Jobs service unavailable"),
    }
}

async fn stream_head(State(app): State<App>, request: axum::extract::Request) -> Response {
    if authenticate_only(&app, request.headers()).await.is_err() {
        return failure(401, "Authentication required");
    }
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

async fn stream(
    State(app): State<App>,
    Path(job_id): Path<String>,
    headers: HeaderMap,
    websocket: std::result::Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Some(principal) = principal(&headers, &app.config.api_key_tenant) else {
        return failure(401, "Authentication required");
    };
    let Ok(websocket) = websocket else {
        return match authenticate_principal(&app, principal).await {
            Ok(()) => StatusCode::NOT_FOUND.into_response(),
            Err(error) => domain_error(error),
        };
    };
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancelled = AtomicBool::new(false);
    match tokio::task::spawn_blocking(move || {
        client.subscribe(principal.credential(), job_id, &cancelled, wait)
    })
    .await
    {
        Ok(Ok(subscription)) => websocket.on_upgrade(move |socket| pump(socket, subscription)),
        Ok(Err(error))
            if matches!(
                error.downcast_ref::<JobAccessFailure>(),
                Some(JobAccessFailure::NotFound | JobAccessFailure::InternalOnly)
            ) =>
        {
            websocket.on_upgrade(|mut socket| async move {
                close(&mut socket, 1008, "Job not found").await;
            })
        }
        Ok(Err(error)) => domain_error(error),
        Err(_) => failure(500, "Jobs service unavailable"),
    }
}

async fn authenticate_only(app: &App, headers: &HeaderMap) -> Result<()> {
    let principal = principal(headers, &app.config.api_key_tenant)
        .ok_or_else(|| anyhow::anyhow!(AuthFailure::SessionRequired))?;
    authenticate_principal(app, principal).await
}

async fn authenticate_principal(app: &App, principal: Principal) -> Result<()> {
    let client = app.client.clone();
    let wait = app.config.wait;
    let cancelled = AtomicBool::new(false);
    tokio::task::spawn_blocking(move || {
        client
            .list_retained(
                principal.credential(),
                LegacyListFilter {
                    status: LegacyStatusFilter::NoMatch,
                    since_millis: None,
                    profile: LegacyProfileFilter::Any,
                },
                &cancelled,
                wait,
            )
            .map(drop)
    })
    .await
    .map_err(|_| anyhow::anyhow!("Jobs service unavailable"))?
}

async fn pump(mut socket: WebSocket, subscription: JobSubscription) {
    loop {
        let preparing = subscription.clone();
        let event = tokio::task::spawn_blocking(move || {
            preparing.prepare(Duration::from_millis(500), |snapshot| {
                serde_json::to_string(&WireJob::from_snapshot(snapshot, false))
                    .map(|text| Message::Text(text.into()))
            })
        })
        .await;
        match event {
            Ok(Ok(PreparedEvent::Frame(frame))) => {
                if !matches!(
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        poll_fn(|context| Pin::new(&mut socket).poll_ready(context)),
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    return;
                }
                match subscription.admit(frame, |message| {
                    if socket.start_send_unpin(message).is_ok() {
                        NonblockingSend::Accepted
                    } else {
                        NonblockingSend::Disconnected
                    }
                }) {
                    FrameAdmission::Admitted => {}
                    FrameAdmission::Closed(reason) => {
                        close_for_reason(&mut socket, reason).await;
                        return;
                    }
                    FrameAdmission::Disconnected => return,
                    FrameAdmission::Superseded => continue,
                }
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(5), socket.flush()).await,
                    Ok(Ok(()))
                ) {
                    return;
                }
            }
            Ok(Err(_)) => {
                close(&mut socket, 1011, "Jobs service unavailable").await;
                return;
            }
            Ok(Ok(PreparedEvent::Pending)) => {}
            Ok(Ok(PreparedEvent::Closed(reason))) => {
                close_for_reason(&mut socket, reason).await;
                return;
            }
            Err(_) => {
                close(&mut socket, 1011, "Jobs service unavailable").await;
                return;
            }
        }
    }
}

async fn close_for_reason(socket: &mut WebSocket, reason: StreamClose) {
    let (code, message) = match reason {
        StreamClose::Finished => (1000, "Complete"),
        StreamClose::Revoked | StreamClose::Expired => (1008, "Authentication required"),
        StreamClose::Lagged => (1013, "Reconnect for current job state"),
        StreamClose::OwnerStopped => (1001, "Server shutting down"),
    };
    close(socket, code, message).await;
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}

fn legacy_filter(query: Option<&str>) -> LegacyListFilter {
    let mut values: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(query) = query
        && let Ok(url) = reqwest::Url::parse(&format!("http://localhost/?{query}"))
    {
        for (key, value) in url.query_pairs() {
            values
                .entry(key.into_owned())
                .or_default()
                .push(value.into_owned());
        }
    }
    let status = match values.get("status").map(Vec::as_slice) {
        None | Some([]) => LegacyStatusFilter::Any,
        Some([value]) if value.is_empty() => LegacyStatusFilter::Any,
        Some([value])
            if ["pending", "running", "done", "error", "cancelled"].contains(&value.as_str()) =>
        {
            LegacyStatusFilter::Exact(value.clone())
        }
        _ => LegacyStatusFilter::NoMatch,
    };
    let profile = match values.get("profile_id").map(Vec::as_slice) {
        None | Some([]) => LegacyProfileFilter::Any,
        Some([value]) if value.is_empty() => LegacyProfileFilter::Any,
        Some([value]) => parse_node_profile_id(value)
            .map(LegacyProfileFilter::Exact)
            .unwrap_or(LegacyProfileFilter::NoMatch),
        _ => LegacyProfileFilter::NoMatch,
    };
    let since_millis = match values.get("since").map(Vec::as_slice) {
        Some([value]) => {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .ok()
                .and_then(|value| i64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok())
        }
        _ => None,
    };
    LegacyListFilter {
        status,
        since_millis,
        profile,
    }
}

fn parse_node_profile_id(value: &str) -> Option<u64> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    let value = value.trim_matches(is_ecmascript_whitespace);
    let parsed = [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| {
        value
            .strip_prefix(prefix)
            .map(|digits| parse_safe_radix_integer(digits, radix, MAX_SAFE_INTEGER))
    });
    if let Some(parsed) = parsed {
        return parsed;
    }

    let parsed = value.parse::<f64>().ok()?;
    (parsed.is_finite()
        && parsed > 0.0
        && parsed.fract() == 0.0
        && parsed <= MAX_SAFE_INTEGER as f64)
        .then_some(parsed as u64)
}

fn parse_safe_radix_integer(digits: &str, radix: u32, maximum: u64) -> Option<u64> {
    if digits.is_empty() {
        return None;
    }
    digits.chars().try_fold(0_u64, |value, digit| {
        let digit = u64::from(digit.to_digit(radix)?);
        value
            .checked_mul(u64::from(radix))?
            .checked_add(digit)
            .filter(|value| *value <= maximum)
    })
}

fn is_ecmascript_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
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
    let auth = headers.get("authorization");
    let custom = headers.get("x-print-partner-api-key");
    if headers.get_all("authorization").iter().count() > 1
        || headers.get_all("x-print-partner-api-key").iter().count() > 1
        || usize::from(session.is_some())
            + usize::from(auth.is_some())
            + usize::from(custom.is_some())
            != 1
    {
        return None;
    }
    if let Some(value) = session {
        return (!value.is_empty() && value.len() <= 4096)
            .then(|| Principal::Session(value.to_owned()));
    }
    let key = if let Some(value) = auth {
        value.to_str().ok()?.strip_prefix("Bearer ")?
    } else {
        custom?.to_str().ok()?
    }
    .trim();
    (!key.is_empty() && key.len() <= 4096).then(|| Principal::ApiKey {
        tenant: tenant.to_owned(),
        secret: key.to_owned(),
    })
}

fn domain_error(error: anyhow::Error) -> Response {
    if let Some(access) = error.downcast_ref::<JobAccessFailure>() {
        return match access {
            JobAccessFailure::NotFound | JobAccessFailure::InternalOnly => {
                failure(404, "Job not found")
            }
            JobAccessFailure::Capacity | JobAccessFailure::Stopped => {
                failure(503, "Jobs service temporarily unavailable")
            }
        };
    }
    if let Some(auth) = error.downcast_ref::<AuthFailure>() {
        return match auth {
            AuthFailure::SessionRequired
            | AuthFailure::InvalidCredentials
            | AuthFailure::CredentialChanged => failure(401, "Authentication required"),
            AuthFailure::OwnerMappingRequired => {
                failure(403, "Explicit account owner mapping is required")
            }
            AuthFailure::QueueFull | AuthFailure::Stopped => {
                failure(503, "Jobs service temporarily unavailable")
            }
            _ => failure(500, "Jobs service unavailable"),
        };
    }
    failure(500, "Jobs service unavailable")
}

fn failure(status: u16, detail: &'static str) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({ "detail": detail })),
    )
        .into_response()
}

pub fn desktop_jobs_policy() -> AuthPolicy {
    AuthPolicy {
        registration: pp_storage::auth::RegistrationPolicy::FirstAccountOnly,
        session_tenant: pp_storage::auth::SessionTenantPolicy::SingleAccountDefault,
        first_user: pp_storage::auth::FirstUserTenant::NewUser,
    }
}

#[cfg(test)]
mod local_regression_tests {
    use super::*;
    use pp_storage::{
        Limits, WriterOwner,
        jobs::{Outcome, Payload, UserOperation},
    };

    #[tokio::test]
    async fn stopped_job_access_maps_to_service_unavailable() {
        let response = domain_error(anyhow::anyhow!(JobAccessFailure::Stopped));
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({ "detail": "Jobs service temporarily unavailable" })
        );
    }

    #[test]
    fn legacy_profile_filter_matches_node_number_compatible_scalars() {
        for whitespace in [
            '\u{0009}', '\u{000a}', '\u{000b}', '\u{000c}', '\u{000d}', '\u{0020}', '\u{00a0}',
            '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
            '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}',
            '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            assert_eq!(
                parse_node_profile_id(&format!("{whitespace}1{whitespace}")),
                Some(1)
            );
        }
        for value in [
            "9007199254740990.6",
            "9007199254740991.1",
            "9.007199254740991e15",
        ] {
            assert_eq!(parse_node_profile_id(value), Some(9_007_199_254_740_991));
        }
        for value in [
            "0",
            "-0",
            "-1",
            "1.5",
            "1e-324",
            "5e-324",
            "1e309",
            "NaN",
            "Infinity",
            "inf",
            "+0x1",
            "-0x1",
            "0x",
            "0xg",
            "9007199254740992",
            "18446744073709551615",
            "1_0",
        ] {
            assert_eq!(parse_node_profile_id(value), None, "{value}");
        }
        for query in [
            "profile_id=1",
            "profile_id=1.0",
            "profile_id=1e0",
            "profile_id=1E%2B0",
            "profile_id=01",
            "profile_id=%2B1",
            "profile_id=%201%20",
            "profile_id=%C2%A01%C2%A0",
            "profile_id=%EF%BB%BF1%EF%BB%BF",
            "profile_id=0x1",
            "profile_id=0X1",
            "profile_id=0b1",
            "profile_id=0B1",
            "profile_id=0o1",
            "profile_id=0O1",
            "profile_id=1.",
            "profile_id=.1e1",
        ] {
            assert!(matches!(
                legacy_filter(Some(query)).profile,
                LegacyProfileFilter::Exact(1)
            ));
        }
        assert!(matches!(
            legacy_filter(Some("profile_id=9007199254740991")).profile,
            LegacyProfileFilter::Exact(9_007_199_254_740_991)
        ));
        for query in [
            "profile_id=0",
            "profile_id=-1",
            "profile_id=1.5",
            "profile_id=NaN",
            "profile_id=Infinity",
            "profile_id=0xg",
            "profile_id=9007199254740992",
            "profile_id=18446744073709551615",
            "profile_id=1&profile_id=1",
        ] {
            assert!(matches!(
                legacy_filter(Some(query)).profile,
                LegacyProfileFilter::NoMatch
            ));
        }
        assert!(matches!(
            legacy_filter(Some("profile_id=")).profile,
            LegacyProfileFilter::Any
        ));

        let mut random = [0; 8];
        getrandom::fill(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!(
            "pp-api-profile-filter-selection-{}",
            hex::encode(random)
        ));
        std::fs::create_dir_all(&path).unwrap();
        let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
        let jobs = owner.jobs(desktop_jobs_policy()).unwrap();
        let mut ids = Vec::new();
        for profile_id in [1, 2] {
            let outcome = jobs
                .submit(
                    Credential::PhysicalOwner(owner.job_physical_owner()),
                    UserOperation::Enqueue {
                        key: format!("profile-{profile_id}"),
                        payload_version: 1,
                        payload: Payload::ExportChecklistHtml { profile_id },
                    },
                    &AtomicBool::new(false),
                    Duration::from_secs(5),
                )
                .unwrap()
                .receive()
                .unwrap();
            let Outcome::Job(job, _) = outcome else {
                panic!("enqueued job expected")
            };
            ids.push(job.job_id);
        }
        for query in [
            "profile_id=1",
            "profile_id=1.0",
            "profile_id=1e0",
            "profile_id=0x1",
        ] {
            let outcome = jobs
                .submit(
                    Credential::PhysicalOwner(owner.job_physical_owner()),
                    UserOperation::ListRetained(legacy_filter(Some(query))),
                    &AtomicBool::new(false),
                    Duration::from_secs(5),
                )
                .unwrap()
                .receive()
                .unwrap();
            let Outcome::PublicList(selected) = outcome else {
                panic!("retained jobs expected")
            };
            assert_eq!(selected.len(), 1, "{query}");
            assert_eq!(selected[0].job_id, ids[0], "{query}");
        }
        owner.shutdown().unwrap();
    }

    #[test]
    fn pending_projection_serializes_zero_progress() {
        let mut random = [0; 8];
        getrandom::fill(&mut random).unwrap();
        let path =
            std::env::temp_dir().join(format!("pp-api-pending-projection-{}", hex::encode(random)));
        std::fs::create_dir_all(&path).unwrap();
        let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
        let outcome = owner
            .jobs(desktop_jobs_policy())
            .unwrap()
            .submit(
                Credential::PhysicalOwner(owner.job_physical_owner()),
                UserOperation::Enqueue {
                    key: "pending-projection".into(),
                    payload_version: 1,
                    payload: Payload::CheckSourceUpdates {},
                },
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap()
            .receive()
            .unwrap();
        let Outcome::Job(job, _) = outcome else {
            panic!("enqueued job expected")
        };
        let snapshot = job.snapshot();
        let wire = serde_json::to_value(WireJob::from_snapshot(&snapshot, true)).unwrap();
        eprintln!("pending_projection={wire}");

        assert_eq!(snapshot.status, "pending");
        assert_eq!(snapshot.progress, Some(0));
        assert_eq!(wire["progress"], 0);
        owner.shutdown().unwrap();
    }
}
