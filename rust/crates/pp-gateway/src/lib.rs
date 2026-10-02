mod target;
use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
};
use pp_compat::CompatHandle;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct LaunchTarget(String);
impl LaunchTarget {
    pub fn into_url(self) -> String {
        self.0
    }
}

struct Sessions {
    draining: bool,
    active: usize,
    bootstrap: Option<([u8; 32], tokio::time::Instant)>,
    sessions: HashSet<[u8; 32]>,
}

#[derive(Deserialize)]
struct Manifest {
    routes: Vec<Operation>,
    denied: Vec<DeniedOperation>,
}
#[derive(Deserialize)]
struct DeniedOperation {
    method: String,
    path: String,
    reason: String,
}
#[derive(Deserialize)]
struct Operation {
    method: String,
    path: String,
    owner: String,
    effect: EffectClass,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum EffectClass {
    Observation,
    LocalCommit,
    ExternalEffect,
}

struct GatewayState {
    origin: String,
    host: String,
    cookie_name: String,
    assets: PathBuf,
    compat: CompatHandle,
    access: Arc<Mutex<Sessions>>,
    routes: Vec<Operation>,
    denied: Vec<DeniedOperation>,
    relays: TaskTracker,
    cancelled: CancellationToken,
}

pub struct Gateway {
    state: Arc<GatewayState>,
    stop: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
    connections: TaskTracker,
    launch: Option<LaunchTarget>,
}

impl Gateway {
    pub fn start(listener: TcpListener, assets: PathBuf, compat: CompatHandle) -> Result<Self> {
        let address = listener.local_addr()?;
        let host = address.to_string();
        let origin = format!("http://{host}");
        let token = hex::encode(rand::random::<[u8; 32]>());
        let mut manifest: Manifest = serde_json::from_str(include_str!("../operations.json"))?;
        let mut seen = HashSet::new();
        for route in &manifest.routes {
            anyhow::ensure!(
                route.owner == "compat"
                    && route.path.starts_with('/')
                    && seen.insert((&route.method, &route.path)),
                "Invalid operation ownership manifest"
            );
        }
        manifest.routes.sort_by(|a, b| {
            fn rank(path: &str) -> impl Iterator<Item = u8> + '_ {
                path.split('/').map(|part| {
                    if part == "*" {
                        0
                    } else if part.starts_with(':') {
                        1
                    } else {
                        2
                    }
                })
            }
            rank(&b.path).cmp(rank(&a.path))
        });
        let launch = Some(LaunchTarget(format!(
            "{origin}/__desktop/bootstrap?token={token}"
        )));
        let state = Arc::new(GatewayState {
            origin,
            host,
            cookie_name: format!("pp_desktop_{}", address.port()),
            assets,
            compat,
            access: Arc::new(Mutex::new(Sessions {
                draining: false,
                active: 0,
                bootstrap: Some((
                    digest(&token),
                    tokio::time::Instant::now() + Duration::from_secs(60),
                )),
                sessions: HashSet::new(),
            })),
            routes: manifest.routes,
            denied: manifest.denied,
            relays: TaskTracker::new(),
            cancelled: CancellationToken::new(),
        });
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let connections = TaskTracker::new();
        let accepted = connections.clone();
        let gateway = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = tokio::select! {
                    biased;
                    _ = stopping.cancelled() => break,
                    next = listener.accept() => next?,
                };
                let state = gateway.clone();
                let cancelled = stopping.clone();
                accepted.spawn(async move {
                    let service = hyper::service::service_fn(move |request| {
                        let state = state.clone();
                        async move {
                            Ok::<_, std::convert::Infallible>(
                                handle(State(state), request.map(Body::new)).await,
                            )
                        }
                    });
                    let mut http = hyper::server::conn::http1::Builder::new();
                    http.max_buf_size(32 * 1024);
                    let connection = http
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                        .with_upgrades();
                    tokio::select! {
                        biased;
                        _ = cancelled.cancelled() => {},
                        _ = connection => {},
                    }
                });
            }
            Ok(())
        });
        Ok(Self {
            state,
            stop,
            task,
            connections,
            launch,
        })
    }
    pub fn origin(&self) -> &str {
        &self.state.origin
    }
    pub fn take_launch_target(&mut self) -> Result<LaunchTarget> {
        self.launch
            .take()
            .context("Launch target already transferred")
    }
    pub async fn drain(&self) {
        {
            let mut access = self.state.access.lock().expect("Session mutex poisoned");
            access.draining = true;
            access.bootstrap = None;
            access.sessions.clear();
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while self
                .state
                .access
                .lock()
                .expect("Session mutex poisoned")
                .active
                > 0
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        self.state.cancelled.cancel();
        self.state.relays.close();
    }
    pub async fn stop(self) -> Result<()> {
        self.stop.cancel();
        let mut task = self.task;
        let listener = match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
            Ok(result) => result
                .context("Gateway join failed")?
                .context("Gateway stop failed"),
            Err(_) => {
                task.abort();
                match task.await {
                    Err(error) if error.is_cancelled() => Ok(()),
                    Ok(Ok(())) => Ok(()),
                    _ => anyhow::bail!("Gateway abort failed"),
                }
            }
        };
        self.state.cancelled.cancel();
        self.state.relays.close();
        listener?;
        self.connections.close();
        tokio::time::timeout(Duration::from_secs(1), self.connections.wait())
            .await
            .context("HTTP connection join timed out")?;
        tokio::time::timeout(Duration::from_secs(1), self.state.relays.wait())
            .await
            .context("Upgrade relay join timed out")?;
        anyhow::ensure!(
            self.state
                .access
                .lock()
                .expect("Session mutex poisoned")
                .active
                == 0,
            "Requests remain after gateway shutdown"
        );
        Ok(())
    }
}

struct Admission {
    access: Arc<Mutex<Sessions>>,
}
impl Admission {
    fn acquire(access: &Arc<Mutex<Sessions>>, cookie: Option<&str>) -> Result<Self, StatusCode> {
        let mut state = access.lock().expect("Session mutex poisoned");
        if state.draining {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        if !cookie.is_some_and(|value| state.sessions.contains(&digest(value))) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        state.active += 1;
        Ok(Self {
            access: access.clone(),
        })
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        let mut state = self.access.lock().expect("Session mutex poisoned");
        state.active -= 1;
    }
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
fn error(status: StatusCode, detail: &'static str) -> Response<Body> {
    (status, axum::Json(serde_json::json!({"detail":detail}))).into_response()
}
fn header<'a>(request: &'a Request<Body>, name: &str) -> Option<&'a str> {
    request.headers().get(name)?.to_str().ok()
}
fn matches_path(pattern: &str, path: &str) -> bool {
    let mut actual = path.split('/');
    for segment in pattern.split('/') {
        if segment == "*" {
            return true;
        }
        let Some(value) = actual.next() else {
            return false;
        };
        if segment.starts_with(':') {
            if value.is_empty() {
                return false;
            }
        } else if segment != value {
            return false;
        }
    }
    actual.next().is_none()
}

async fn handle(
    State(state): State<Arc<GatewayState>>,
    mut request: Request<Body>,
) -> Response<Body> {
    if header(&request, "host") != Some(state.host.as_str()) {
        return error(StatusCode::BAD_REQUEST, "Invalid Host");
    }
    let target = match target::CanonicalTarget::parse(request.uri()) {
        Ok(target) => target,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid request target"),
    };
    *request.uri_mut() = target.uri;
    let path = target.path;
    let origin = header(&request, "origin");
    let upgrade = header(&request, "upgrade").is_some();
    let unsafe_method = !matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS");
    if origin.is_some_and(|value| value != state.origin)
        || ((unsafe_method || upgrade) && origin != Some(state.origin.as_str()))
    {
        return error(StatusCode::FORBIDDEN, "Invalid Origin");
    }
    if path == "/__desktop/bootstrap" && request.method() == "GET" {
        let token = request
            .uri()
            .query()
            .and_then(|query| query.strip_prefix("token="));
        let mut access = state.access.lock().expect("Session mutex poisoned");
        if access.draining {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Runtime is stopping");
        }
        let valid = token.is_some_and(|token| {
            access.bootstrap.as_ref().is_some_and(|(hash, deadline)| {
                *hash == digest(token) && tokio::time::Instant::now() < *deadline
            })
        });
        if !valid {
            return error(StatusCode::UNAUTHORIZED, "Bootstrap expired or consumed");
        }
        access.bootstrap.take();
        let session = hex::encode(rand::random::<[u8; 32]>());
        access.sessions.insert(digest(&session));
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header("location", "/")
            .header("cache-control", "no-store")
            .header("referrer-policy", "no-referrer")
            .header(
                "set-cookie",
                format!(
                    "{}={session}; HttpOnly; SameSite=Strict; Path=/",
                    state.cookie_name
                ),
            )
            .body(Body::empty())
            .expect("Static response");
    }
    let cookie = header(&request, "cookie").and_then(|cookies| {
        cookies.split(';').find_map(|cookie| {
            let (name, value) = cookie.trim().split_once('=')?;
            (name == state.cookie_name).then_some(value)
        })
    });
    let admission = match Admission::acquire(&state.access, cookie) {
        Ok(admission) => admission,
        Err(StatusCode::SERVICE_UNAVAILABLE) => {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Runtime is stopping");
        }
        Err(_) => return error(StatusCode::UNAUTHORIZED, "Desktop session required"),
    };
    if path == "/__runtime" && request.method() == "GET" {
        return axum::Json(serde_json::json!({"proof_class":"headless_unsigned","compat":*state.compat.status.borrow(),"gateway":{"active_requests":state.access.lock().expect("Session mutex poisoned").active.saturating_sub(1),"active_upgrades":state.relays.len()}})).into_response();
    }
    if path == "/auth/logout" && request.method() == "POST" {
        state
            .access
            .lock()
            .expect("Session mutex poisoned")
            .sessions
            .clear();
        state.cancelled.cancel();
        return axum::Json(serde_json::json!({"ok":true})).into_response();
    }
    if path == "/mcp" || path == "/api/v1/mcp" {
        return error(
            StatusCode::FORBIDDEN,
            "MCP is disabled in this foundation; API-key authorization is required before enabling it",
        );
    }
    let document = request.method() == "GET"
        && (header(&request, "sec-fetch-mode") == Some("navigate")
            || header(&request, "accept").is_some_and(|v| v.contains("text/html")));
    let spa = matches!(
        path.as_str(),
        "/" | "/builds"
            | "/library"
            | "/sources"
            | "/plan"
            | "/production"
            | "/progress"
            | "/settings"
            | "/printers"
            | "/help"
            | "/parts"
            | "/plans"
            | "/export"
            | "/login"
            | "/setup"
    );
    if (document && spa)
        || path.starts_with("/assets/")
        || matches!(path.as_str(), "/favicon.ico" | "/logo.png")
    {
        let relative = if document && spa {
            "index.html"
        } else {
            path.trim_start_matches('/')
        };
        let file = state.assets.join(relative);
        let canonical = match tokio::fs::canonicalize(file).await {
            Ok(file) if file.starts_with(&state.assets) => file,
            _ => return error(StatusCode::NOT_FOUND, "Asset not found"),
        };
        return match tokio::fs::read(&canonical).await {
            Ok(bytes) => Response::builder()
                .header(
                    "content-type",
                    match canonical.extension().and_then(|e| e.to_str()) {
                        Some("js") => "text/javascript",
                        Some("css") => "text/css",
                        Some("html") => "text/html; charset=utf-8",
                        Some("svg") => "image/svg+xml",
                        Some("png") => "image/png",
                        _ => "application/octet-stream",
                    },
                )
                .header("cache-control", "no-store")
                .header("referrer-policy", "no-referrer")
                .header("x-content-type-options", "nosniff")
                .header(
                    "content-security-policy",
                    "frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
                )
                .body(Body::from(bytes))
                .expect("Asset response"),
            Err(_) => error(StatusCode::NOT_FOUND, "Asset not found"),
        };
    }
    if let Some(denied) = state
        .denied
        .iter()
        .find(|route| route.method == request.method().as_str() && matches_path(&route.path, &path))
    {
        return (
            StatusCode::NOT_IMPLEMENTED,
            axum::Json(
                serde_json::json!({"detail":denied.reason,"code":"desktop_feature_unavailable"}),
            ),
        )
            .into_response();
    }
    let operation = state.routes.iter().find(|route| {
        route.method == request.method().as_str() && matches_path(&route.path, &path)
    });
    let Some(operation) = operation else {
        return error(StatusCode::NOT_FOUND, "Operation not registered");
    };
    let same_origin_browser_get = request.method() == "GET"
        && origin.is_none()
        && header(&request, "sec-fetch-site") == Some("same-origin");
    if operation.effect != EffectClass::Observation
        && origin != Some(state.origin.as_str())
        && !same_origin_browser_get
    {
        return error(
            StatusCode::FORBIDDEN,
            "Origin required for operation with effects",
        );
    }
    let Some(endpoint) = state.compat.endpoint() else {
        let mut response = error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Compatibility backend unavailable",
        );
        response
            .headers_mut()
            .insert("retry-after", HeaderValue::from_static("1"));
        return response;
    };
    let untrusted: Vec<_> = request
        .headers()
        .keys()
        .filter(|name| {
            let name = name.as_str();
            name.starts_with("x-pp-")
                || name.starts_with("x-forwarded-")
                || matches!(
                    name,
                    "forwarded" | "authorization" | "cookie" | "x-print-partner-api-key"
                )
        })
        .cloned()
        .collect();
    for name in untrusted {
        request.headers_mut().remove(name);
    }
    let inbound_upgrade = if upgrade {
        Some(hyper::upgrade::on(&mut request))
    } else {
        None
    };
    let result = tokio::select! {
        biased;
        _ = state.cancelled.cancelled() => return error(StatusCode::SERVICE_UNAVAILABLE, "Runtime stopped; operation outcome may be unknown"),
        result = endpoint.forward(request) => result,
    };
    match result {
        Ok(mut response) => {
            if response.status() == StatusCode::SWITCHING_PROTOCOLS
                && let Some(inbound) = inbound_upgrade
            {
                let outbound = hyper::upgrade::on(&mut response);
                if state.cancelled.is_cancelled() {
                    return error(StatusCode::SERVICE_UNAVAILABLE, "Runtime is stopping");
                }
                let cancelled = state.cancelled.clone();
                state.relays.spawn(async move {
                    let _admission = admission;
                    tokio::select! {
                        _ = cancelled.cancelled() => {},
                        _ = async {
                            if let (Ok(a), Ok(b)) = tokio::join!(inbound, outbound) {
                                let _ = tokio::io::copy_bidirectional(
                                    &mut hyper_util::rt::TokioIo::new(a),
                                    &mut hyper_util::rt::TokioIo::new(b),
                                ).await;
                            }
                        } => {},
                    }
                });
                return response;
            }

            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
            response.map(|body| {
                Body::new(TrackedBody {
                    body,
                    _admission: admission,
                    cancelled: Box::pin(state.cancelled.clone().cancelled_owned()),
                })
            })
        }
        Err(_) => error(
            StatusCode::BAD_GATEWAY,
            "Compatibility response unavailable; operation outcome may be unknown",
        ),
    }
}

struct TrackedBody {
    body: Body,
    _admission: Admission,
    cancelled: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
}
impl http_body::Body for TrackedBody {
    type Data = axum::body::Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        if self.cancelled.as_mut().poll(cx).is_ready() {
            return std::task::Poll::Ready(Some(Err(axum::Error::new(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Runtime stopped during response",
            )))));
        }
        std::pin::Pin::new(&mut self.body).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn admission_and_drain_share_one_barrier() {
        use super::*;
        for _ in 0..16 {
            let access = Arc::new(Mutex::new(Sessions {
                draining: false,
                active: 0,
                bootstrap: None,
                sessions: HashSet::from([digest("session")]),
            }));
            let start = Arc::new(std::sync::Barrier::new(17));
            let release = Arc::new(std::sync::Barrier::new(17));
            let workers: Vec<_> = (0..16)
                .map(|_| {
                    let access = access.clone();
                    let start = start.clone();
                    let release = release.clone();
                    std::thread::spawn(move || {
                        start.wait();
                        let admitted = Admission::acquire(&access, Some("session")).ok();
                        release.wait();
                        admitted.is_some()
                    })
                })
                .collect();
            start.wait();
            let admitted_before_drain = {
                let mut state = access.lock().unwrap();
                state.draining = true;
                state.sessions.clear();
                state.active
            };
            assert!(matches!(
                Admission::acquire(&access, Some("session")),
                Err(StatusCode::SERVICE_UNAVAILABLE)
            ));
            release.wait();
            let admitted = workers
                .into_iter()
                .map(|worker| usize::from(worker.join().unwrap()))
                .sum::<usize>();
            assert_eq!(admitted, admitted_before_drain);
            assert_eq!(access.lock().unwrap().active, 0);
        }
    }
    #[test]
    fn effectful_get_is_explicit() {
        let manifest: super::Manifest =
            serde_json::from_str(include_str!("../operations.json")).unwrap();
        assert!(manifest.routes.iter().any(|r| r.method == "GET"
            && r.path == "/printer-checkoff"
            && r.effect == super::EffectClass::LocalCommit));
    }
}
