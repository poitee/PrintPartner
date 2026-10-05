use anyhow::{Result, ensure};
use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    catalog::{CatalogHttpConfig, catalog_router},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 1,
        "Usage: catalog-http-fixture DISPOSABLE_DIRECTORY"
    );
    let (owner, _) = WriterOwner::open(std::path::Path::new(&args[0]), Limits::default())?;
    let policy = AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let router = auth_router(
        AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)?,
        owner.auth_with_policy(policy)?,
        ProviderClient::new(None, None)?,
        ResetMailer::disabled(),
    )
    .merge(catalog_router(
        CatalogHttpConfig::new(&origin)?,
        owner.catalog_access(policy)?,
        Some(owner.catalog_key_access(policy, "default".into())?),
    ));
    println!(
        "{}",
        serde_json::json!({"origin":origin,"writer_owners":1,"mode":"standalone-catalog-http"})
    );
    let (stop, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        let _ = stop.send(());
    });
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = rx.await;
    })
    .await?;
    owner.shutdown()?;
    Ok(())
}
