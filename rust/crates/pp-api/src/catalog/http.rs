use super::wire::{self, Failure};
use anyhow::{Result, ensure};
use axum::{
    Router,
    body::to_bytes,
    extract::{ConnectInfo, State},
    http::Method,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use pp_storage::catalog::{CatalogAccess, CatalogKeyAccess, Outcome, SourceCatalogClient};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use pp_storage::catalog::IMPORT_RULE_BODY_LIMIT;
#[derive(Clone)]
pub struct CatalogHttpConfig {
    origin: String,
    host: String,
    body_limit: usize,
    import_rule_limit: usize,
}
impl CatalogHttpConfig {
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
        Ok(Self {
            origin,
            host,
            body_limit: 1024 * 1024,
            import_rule_limit: IMPORT_RULE_BODY_LIMIT,
        })
    }
    pub fn with_body_limits(mut self, ordinary: usize, import_rules: usize) -> Result<Self> {
        ensure!(
            ordinary > 0
                && ordinary <= self.body_limit
                && import_rules > 0
                && import_rules <= self.import_rule_limit,
            "Body limits may only be reduced"
        );
        self.body_limit = ordinary;
        self.import_rule_limit = import_rules;
        Ok(self)
    }
}
#[derive(Clone)]
struct App {
    config: CatalogHttpConfig,
    access: CatalogAccess,
    keys: Option<CatalogKeyAccess>,
    admission: Arc<tokio::sync::Semaphore>,
    waiters: Arc<tokio::sync::Semaphore>,
}
pub fn catalog_router(
    config: CatalogHttpConfig,
    access: CatalogAccess,
    keys: Option<CatalogKeyAccess>,
) -> Router {
    let app = App {
        config,
        access,
        keys,
        admission: Arc::new(tokio::sync::Semaphore::new(64)),
        waiters: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let routes = Router::new()
        .route("/sources", get(handle).post(handle))
        .route("/sources/activity", get(handle))
        .route("/sources/bulk-category", post(handle))
        .route("/sources/{id}", get(handle).patch(handle).delete(handle))
        .route("/sources/{id}/naming", get(handle).put(handle))
        .route("/sources/{id}/import-rules", get(handle).put(handle))
        .route("/settings/source-categories", get(handle).put(handle))
        .route("/settings/stl-naming", get(handle).put(handle))
        .route("/settings/stl-naming/preview", post(handle));
    Router::new()
        .merge(routes.clone())
        .nest("/api/v1", routes)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}
async fn guard(State(app): State<App>, request: axum::extract::Request, next: Next) -> Response {
    let Ok(_permit) = app.admission.try_acquire() else {
        return Failure::new(503, "Catalog temporarily unavailable").into_response();
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
        || headers.get("host").and_then(|v| v.to_str().ok()) != Some(&app.config.host)
        || headers
            .keys()
            .any(|k| k.as_str() == "forwarded" || k.as_str().starts_with("x-forwarded-"))
    {
        return Failure::new(403, "Invalid request host").into_response();
    }
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    if headers.get_all("origin").iter().count() > 1
        || (headers.contains_key("origin") && origin != Some(&app.config.origin))
        || (!matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        ) && origin != Some(&app.config.origin))
        || headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
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
    let method = request.method().clone();
    let path = request
        .uri()
        .path()
        .strip_prefix("/api/v1")
        .unwrap_or(request.uri().path())
        .to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let naming = path.starts_with("/sources/") && path.ends_with("/naming");
    let limit = if method == Method::PUT && path.ends_with("/import-rules") {
        app.config.import_rule_limit
    } else {
        app.config.body_limit
    };
    let bytes = to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| Failure::new(413, "Request body too large"))?;
    let body = if matches!(method, Method::GET | Method::HEAD | Method::DELETE) {
        serde_json::json!({})
    } else {
        serde_json::from_slice(&bytes).map_err(|_| Failure::input("Invalid JSON body", naming))?
    };
    let (command, wrapper) =
        wire::command(&method, &path, &query, body).map_err(|f| f.for_naming(naming))?;
    let outcome = invoke(&app, client, command)
        .await
        .map_err(|f| f.for_naming(naming))?;
    wire::response(outcome, wrapper).map_err(|f| f.for_naming(naming))
}
async fn invoke(
    app: &App,
    client: SourceCatalogClient,
    request: pp_storage::catalog::Request,
) -> Result<Outcome, Failure> {
    let permit = app
        .waiters
        .clone()
        .try_acquire_owned()
        .map_err(|_| Failure::new(503, "Catalog temporarily unavailable"))?;
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
        client
            .submit(request, &cancelled, Duration::from_millis(100))?
            .recv()
            .map_err(|_| anyhow::anyhow!(pp_storage::catalog::CatalogFailure::CommitUnknown))?
    })
    .await
    .map_err(|_| Failure::new(500, "Catalog unavailable"))?
    .map_err(Failure::from)
}
