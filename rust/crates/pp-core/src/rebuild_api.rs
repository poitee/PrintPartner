use crate::DesktopRebuild;
use anyhow::Result;
use axum::Router;
use pp_api::auth::{AuthHttpConfig, ProviderClient, ResetMailer, auth_router};
use pp_storage::{
    WriterOwner,
    auth::{AuthPolicy, rebuild::AuthLifetimes, rebuild::RebuildAuthClient},
    build_graph::BuildGraphClient,
    catalog::SourceCatalogClient,
    working_drafts::WorkingDraftClient,
};

pub struct AuthRoutes {
    pub http: AuthHttpConfig,
    pub policy: AuthPolicy,
    pub lifetimes: AuthLifetimes,
    pub providers: ProviderClient,
    pub mail: ResetMailer,
}

/// Opted-in rebuild HTTP storage clients. Constructed only when the stored
/// `DesktopRebuild` setting is on. Does not mount routes (GRE-819).
pub struct RebuildHttpClients {
    pub auth: RebuildAuthClient,
    pub drafts: WorkingDraftClient,
    pub builds: BuildGraphClient,
    pub catalog: SourceCatalogClient,
}

impl RebuildHttpClients {
    /// Drop owned client handles. Storage shutdown stays with `WriterOwner`.
    pub fn close(self) {}
}

/// Compose draft, Build, and catalog clients (plus auth) without mounting.
/// Returns `None` before creating any client unless the stored setting is on.
pub fn clients(
    rebuild: DesktopRebuild,
    owner: &WriterOwner,
    policy: AuthPolicy,
    lifetimes: AuthLifetimes,
) -> Result<Option<RebuildHttpClients>> {
    if !rebuild.enabled() {
        return Ok(None);
    }
    Ok(Some(RebuildHttpClients {
        auth: owner.rebuild_auth_with_policy(policy, lifetimes)?,
        drafts: owner.working_drafts_with_policy(policy)?,
        builds: owner.build_graph_with_policy(policy)?,
        catalog: owner.local_source_catalog(),
    }))
}

/// Rust HTTP routes for the desktop rebuild, served by the rebuild auth client.
/// Returns `None` before creating any client unless the stored setting is on.
pub fn router(
    rebuild: DesktopRebuild,
    owner: &WriterOwner,
    auth: AuthRoutes,
) -> Result<Option<Router>> {
    if !rebuild.enabled() {
        return Ok(None);
    }
    let client = owner.rebuild_auth_with_policy(auth.policy, auth.lifetimes)?;
    Ok(Some(auth_router(
        auth.http,
        client,
        auth.providers,
        auth.mail,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pp_api::auth::CookieTransport;
    use pp_storage::{
        Limits,
        auth::{FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
        catalog::{Outcome, Request},
    };
    use serde_json::{Value, json};
    use std::time::Duration;

    fn policy() -> AuthPolicy {
        AuthPolicy {
            registration: RegistrationPolicy::FirstAccountOnly,
            first_user: FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::SingleAccountDefault,
        }
    }

    fn lifetimes() -> AuthLifetimes {
        AuthLifetimes::shorter(Duration::from_secs(3600), Some(Duration::from_secs(600))).unwrap()
    }

    fn routes(origin: &str) -> AuthRoutes {
        AuthRoutes {
            http: AuthHttpConfig::new(origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            policy: policy(),
            lifetimes: lifetimes(),
            providers: ProviderClient::new(None, None).unwrap(),
            mail: ResetMailer::disabled(),
        }
    }

    fn owner() -> (WriterOwner, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "pp-rebuild-api-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        (
            WriterOwner::open(&directory, Limits::default()).unwrap().0,
            directory,
        )
    }

    #[test]
    fn runtime_setting_off_registers_no_routes() {
        let (owner, directory) = owner();
        for value in [None, Some("0"), Some("false"), Some("TRUE")] {
            let rebuild = DesktopRebuild::from_value(value);
            assert!(
                router(rebuild, &owner, routes("http://127.0.0.1:9"))
                    .unwrap()
                    .is_none(),
                "{value:?}"
            );
        }
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn application_host_flag_off_constructs_no_rebuild_clients() {
        let (owner, directory) = owner();
        for value in [None, Some("0"), Some("false"), Some("TRUE")] {
            assert!(
                clients(
                    DesktopRebuild::from_value(value),
                    &owner,
                    policy(),
                    lifetimes(),
                )
                .unwrap()
                .is_none(),
                "{value:?}"
            );
        }
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn application_host_closes_owned_clients() {
        let (owner, directory) = owner();
        let bundle = clients(
            DesktopRebuild::from_value(Some("1")),
            &owner,
            policy(),
            lifetimes(),
        )
        .unwrap()
        .expect("flag on constructs clients");
        match bundle.catalog.execute(Request::List {}).unwrap() {
            Outcome::Sources(rows) => assert!(rows.is_empty()),
            other => panic!("unexpected catalog outcome: {other:?}"),
        }
        bundle.close();
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn runtime_setting_on_serves_auth_through_the_rebuild_client() {
        let (owner, directory) = owner();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = router(
            DesktopRebuild::from_value(Some("1")),
            &owner,
            routes(&origin),
        )
        .unwrap()
        .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let registered = client
            .post(format!("{origin}/auth/register"))
            .header("Origin", &origin)
            .json(&json!({"email":"rebuild@example.com","password":"password-1234"}))
            .send()
            .await
            .unwrap();
        assert_eq!(registered.status(), 200);
        let cookie = registered.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let me: Value = client
            .get(format!("{origin}/auth/me"))
            .header("Origin", &origin)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(me["user"]["email"], "rebuild@example.com");
        let key = client
            .post(format!("{origin}/settings/api-keys"))
            .header("Origin", &origin)
            .header("Cookie", &cookie)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(key.status(), 201);
        let key: Value = key.json().await.unwrap();
        // Only the rebuild client's lifetimes give API keys an expiry.
        assert!(key["expiresAt"].is_string(), "{key}");
        stop.send(()).unwrap();
        server.await.unwrap();
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
