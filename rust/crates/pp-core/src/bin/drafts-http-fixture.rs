use anyhow::{Result, ensure};
use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    builds::{BuildHttpConfig, build_router},
    catalog::{CatalogHttpConfig, catalog_router},
    drafts::{DraftHttpClients, DraftHttpConfig, draft_router},
};
use pp_core::{
    draft_observations::{
        DraftReadConfiguration, FilesystemPolicy, issue_build_graph, issue_working_drafts,
    },
    review_observations::SnapshotReviewObserver,
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    working_drafts::observation::PreparationLimits,
};
use std::{collections::BTreeMap, path::PathBuf};

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
    }
}

fn draft_configuration(root: PathBuf) -> DraftReadConfiguration {
    DraftReadConfiguration {
        repos: root.clone(),
        limits: PreparationLimits::default(),
        relative_base: root.clone(),
        policy: FilesystemPolicy::Isolated,
        shipped_hints: [
            root.join("missing-shipped-hints-1.yaml"),
            root.join("missing-shipped-hints-2.yaml"),
        ],
        custom_hints: None,
        community_manifests: BTreeMap::new(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 1,
        "Usage: drafts-http-fixture DISPOSABLE_DIRECTORY"
    );
    let data = PathBuf::from(&args[0]);
    let (owner, _) = WriterOwner::open(&data, Limits::default())?;
    let repos = data.join("repos");
    std::fs::create_dir_all(&repos)?;
    let policy = policy();
    let drafts = issue_working_drafts(&owner, policy, draft_configuration(repos.clone()))?;
    let builds = issue_build_graph(&owner, policy, draft_configuration(repos.clone()))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
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
    ))
    .merge(build_router(
        BuildHttpConfig::new(&origin, "default")?,
        builds,
    ))
    .merge(draft_router(
        DraftHttpConfig::new(&origin, "default")?,
        DraftHttpClients {
            saves: drafts.plan_save(),
            publication: owner.publication_with_policy(policy)?,
            accepted: owner.accepted_reads_with_policy(policy)?,
            drafts,
        },
        std::sync::Arc::new(SnapshotReviewObserver::new(
            repos,
            Some(data.join("thumbs")),
        )?),
    ));
    println!(
        "{}",
        serde_json::json!({"origin":origin,"writer_owners":1,"mode":"standalone-drafts-http"})
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
