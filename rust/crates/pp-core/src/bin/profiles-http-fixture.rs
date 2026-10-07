use anyhow::{Result, anyhow};
use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    profiles::{ProfileLibraryHttpConfig, profile_library_router},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
use serde_json::json;
use std::{net::SocketAddr, path::PathBuf};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::ClaimDefault,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let directory = std::env::var_os("PP_PROFILE_FIXTURE_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("PP_PROFILE_FIXTURE_DATA_DIR is required"))?;
    let listen = std::env::var("PP_PROFILE_FIXTURE_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:0".to_owned())
        .parse::<SocketAddr>()?;
    if !listen.ip().is_loopback() {
        return Err(anyhow!("Fixture listener must be loopback"));
    }
    let (owner, _) = WriterOwner::open(&directory, Limits::default())?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let router = auth_router(
        AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)?,
        owner.auth_with_policy(policy())?,
        ProviderClient::new(None, None)?,
        ResetMailer::disabled(),
    )
    .merge(profile_library_router(
        ProfileLibraryHttpConfig::new(&origin)?,
        owner.profile_library_access(policy())?,
        Some(owner.profile_library_key_access(policy(), "default".to_owned())?),
    ));
    println!(
        "{}",
        json!({
            "origin": origin,
            "registration": "POST /auth/register",
            "profilePaths": ["/profile-library", "/api/v1/profile-library"]
        })
    );
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    owner.shutdown()?;
    Ok(())
}
