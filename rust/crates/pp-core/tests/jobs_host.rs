use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use pp_core::application_host::application_host;
use pp_storage::{Limits, WriterOwner};
use std::path::PathBuf;
use tower::ServiceExt;

fn directory(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "pp-jobs-host-{label}-{}",
        hex::encode(rand::random::<[u8; 12]>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[tokio::test]
async fn host_serves_assets_navigation_and_reserved_not_found() {
    let assets = directory("assets");
    std::fs::write(assets.join("index.html"), "<main>Print Partner</main>").unwrap();
    std::fs::write(assets.join("app.js"), "window.printPartner=true;").unwrap();
    let app = application_host(Router::new(), assets.clone()).unwrap();

    let asset = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(
        asset.headers()[header::CONTENT_TYPE],
        "text/javascript; charset=utf-8"
    );

    let navigation = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/builds/1")
                .header(header::ACCEPT, "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(navigation.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(navigation.into_body(), 1024).await.unwrap(),
        "<main>Print Partner</main>"
    );

    let reserved = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/missing")
                .header(header::ACCEPT, "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(reserved.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &to_bytes(reserved.into_body(), 1024).await.unwrap()
        )
        .unwrap(),
        serde_json::json!({"detail":"Not Found"})
    );

    let missing_asset = app
        .oneshot(
            Request::builder()
                .uri("/missing.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(assets).unwrap();
}

#[test]
fn one_owner_conflict_then_clean_shutdown_allows_reopen() {
    let data = directory("owner");
    let (owner, _) = WriterOwner::open(&data, Limits::default()).unwrap();
    assert!(WriterOwner::open(&data, Limits::default()).is_err());
    owner.shutdown().unwrap();
    let (reopened, _) = WriterOwner::open(&data, Limits::default()).unwrap();
    reopened.shutdown().unwrap();
    std::fs::remove_dir_all(data).unwrap();
}
