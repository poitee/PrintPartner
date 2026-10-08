use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::Body,
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
struct Assets {
    root: Arc<PathBuf>,
}

pub fn application_host(api: Router, assets: PathBuf) -> Result<Router> {
    let root = assets.canonicalize().context("React assets unavailable")?;
    ensure!(root.is_dir(), "React assets must be a directory");
    ensure!(root.join("index.html").is_file(), "React index unavailable");
    let assets = Assets {
        root: Arc::new(root),
    };
    Ok(api.fallback(move |request| {
        let assets = assets.clone();
        async move { asset(assets, request).await }
    }))
}

async fn asset(assets: Assets, request: axum::extract::Request) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return api_failure(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
    }
    let path = request.uri().path();
    if reserved(path) {
        return api_failure(StatusCode::NOT_FOUND, "Not Found");
    }
    let relative = path.trim_start_matches('/');
    let candidate = assets.root.join(relative);
    if let Ok(canonical) = candidate.canonicalize()
        && canonical.starts_with(assets.root.as_ref())
        && canonical.is_file()
    {
        return file_response(&canonical, request.method() == Method::HEAD).await;
    }
    let accepts_html = request
        .headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|item| item.trim().starts_with("text/html"))
        });
    if (relative.is_empty() || !relative.rsplit('/').next().unwrap_or("").contains('.'))
        && accepts_html
    {
        return file_response(
            &assets.root.join("index.html"),
            request.method() == Method::HEAD,
        )
        .await;
    }
    StatusCode::NOT_FOUND.into_response()
}

fn reserved(path: &str) -> bool {
    [
        "/api/",
        "/auth/",
        "/settings/",
        "/sources/",
        "/plans/",
        "/jobs/",
        "/ws/",
        "/exports/",
        "/internal/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

async fn file_response(path: &std::path::Path, head: bool) -> Response {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    let length = bytes.len().to_string();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length)
        .body(if head {
            Body::empty()
        } else {
            Body::from(bytes)
        })
        .expect("valid asset response")
}

fn api_failure(status: StatusCode, detail: &'static str) -> Response {
    (status, axum::Json(json!({ "detail": detail }))).into_response()
}
