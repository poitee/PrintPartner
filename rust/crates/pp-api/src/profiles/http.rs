use super::wire::{self, Failure};
use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::Method,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use pp_storage::profiles::{
    ProfileLibraryAccess, ProfileLibraryClient, ProfileLibraryKeyAccess, ProfileLibraryRequest,
    ProfileLibraryResult,
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone)]
pub struct ProfileLibraryHttpConfig {
    origin: String,
    host: String,
}

impl ProfileLibraryHttpConfig {
    pub fn new(origin: &str) -> Result<Self> {
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
        let origin = url.origin().ascii_serialization();
        let host = origin.split_once("://").expect("URL scheme").1.to_owned();
        Ok(Self { origin, host })
    }
}

#[derive(Clone)]
struct App {
    config: ProfileLibraryHttpConfig,
    access: ProfileLibraryAccess,
    keys: Option<ProfileLibraryKeyAccess>,
    admission: Arc<tokio::sync::Semaphore>,
    waiters: Arc<tokio::sync::Semaphore>,
}

pub fn profile_library_router(
    config: ProfileLibraryHttpConfig,
    access: ProfileLibraryAccess,
    keys: Option<ProfileLibraryKeyAccess>,
) -> Router {
    let app = App {
        config,
        access,
        keys,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        waiters: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let routes = Router::new().route("/profile-library", get(handle));
    Router::new()
        .merge(routes.clone())
        .nest("/api/v1", routes)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

async fn guard(State(app): State<App>, request: axum::extract::Request, next: Next) -> Response {
    let Ok(_permit) = app.admission.try_acquire() else {
        return Failure::new(503, "Profile library temporarily unavailable").into_response();
    };
    if request.uri().to_string().len() > 16384 {
        return Failure::new(414, "Request target too long").into_response();
    }
    let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() else {
        return Failure::new(500, "Transport identity unavailable").into_response();
    };
    if !peer.ip().is_loopback() {
        return Failure::new(403, "Loopback transport required").into_response();
    }
    let headers = request.headers();
    if headers.get_all("host").iter().count() != 1
        || headers.get("host").and_then(|value| value.to_str().ok()) != Some(&app.config.host)
        || headers
            .keys()
            .any(|key| key.as_str() == "forwarded" || key.as_str().starts_with("x-forwarded-"))
    {
        return Failure::new(403, "Invalid request host").into_response();
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
        return Failure::new(403, "Invalid request origin").into_response();
    }
    next.run(request).await
}

async fn handle(
    State(app): State<App>,
    request: axum::extract::Request,
) -> Result<Response, Failure> {
    let client = wire::credential(request.headers(), &app.access, app.keys.as_ref())?;
    let result = invoke(&app, client).await?;
    Ok(wire::private_response(Json(result).into_response()))
}

async fn invoke(app: &App, client: ProfileLibraryClient) -> Result<ProfileLibraryResult, Failure> {
    let permit = app
        .waiters
        .clone()
        .try_acquire_owned()
        .map_err(|_| Failure::new(503, "Profile library temporarily unavailable"))?;
    struct Cancellation(Arc<AtomicBool>);
    impl Drop for Cancellation {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancellation = Cancellation(cancelled.clone());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        client.read(
            ProfileLibraryRequest,
            &cancelled,
            Duration::from_millis(100),
        )
    })
    .await
    .map_err(|_| Failure::new(500, "Profile library unavailable"))?
    .map_err(Failure::from)
}
