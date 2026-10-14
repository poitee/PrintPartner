use axum::{
    body::Body,
    http::{Method, Response, StatusCode},
};
use std::path::Path;
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

pub(super) async fn serve(root: &Path, relative: &str, method: &Method) -> Response<Body> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        let mut response =
            super::error(StatusCode::METHOD_NOT_ALLOWED, "Assets require GET or HEAD");
        response
            .headers_mut()
            .insert("allow", axum::http::HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let path = match tokio::fs::canonicalize(root.join(relative)).await {
        Ok(path) if path.starts_with(root) => path,
        _ => return super::error(StatusCode::NOT_FOUND, "Asset not found"),
    };
    if !tokio::fs::metadata(&path)
        .await
        .is_ok_and(|metadata| metadata.is_file())
    {
        return super::error(StatusCode::NOT_FOUND, "Asset not found");
    }
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return super::error(StatusCode::NOT_FOUND, "Asset not found"),
    };
    let metadata = match file.metadata().await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return super::error(StatusCode::NOT_FOUND, "Asset not found"),
    };
    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::with_capacity(
            file.take(metadata.len()),
            64 * 1024,
        ))
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        "content-type",
        axum::http::HeaderValue::from_static(content_type(&path, relative)),
    );
    headers.insert("content-length", metadata.len().into());
    headers.insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        "referrer-policy",
        axum::http::HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        "x-content-type-options",
        axum::http::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "content-security-policy",
        axum::http::HeaderValue::from_static(
            "frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        ),
    );
    response
}

fn content_type(path: &Path, relative: &str) -> &'static str {
    if relative == "manifest.json" {
        return "application/manifest+json";
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json" | "map") => "application/json",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}
