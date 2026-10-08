use anyhow::{Context, Result, ensure};
use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    builds::{BuildHttpConfig, build_router},
    catalog::{CatalogHttpConfig, catalog_router},
    drafts::{DraftHttpClients, DraftHttpConfig, draft_router},
    jobs::{JobsHttpConfig, jobs_router},
};
use pp_core::{
    application_host::application_host,
    draft_observations::{DraftReadConfiguration, FilesystemPolicy, issue_working_drafts},
    review_observations::SnapshotReviewObserver,
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    working_drafts::observation::PreparationLimits,
};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

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
        args.len() == 2,
        "Usage: jobs-http-fixture DISPOSABLE_DIRECTORY REACT_ASSETS"
    );
    let data = PathBuf::from(&args[0]);
    let assets = PathBuf::from(&args[1]);
    let (owner, _) = WriterOwner::open(&data, Limits::default())?;
    let repos = data.join("repos");
    std::fs::create_dir_all(&repos)?;
    let policy = policy();
    let drafts = issue_working_drafts(&owner, policy, draft_configuration(repos.clone()))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let origin = format!("http://{address}");
    let api = auth_router(
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
        owner.build_graph_with_policy(policy)?,
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
    ))
    .merge(jobs_router(
        JobsHttpConfig::new(&origin, "default")?,
        owner.jobs(policy)?,
    ));
    let router = application_host(api, assets)?;
    println!(
        "{}",
        serde_json::json!({
            "origin": origin,
            "port": address.port(),
            "pid": std::process::id(),
            "writer_owners": 1,
            "mode": "standalone-jobs-http"
        })
    );
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .await
    });
    tokio::task::spawn_blocking(move || {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        let _ = stop.send(());
    })
    .await?;
    owner.shutdown()?;
    tokio::time::timeout(Duration::from_secs(7), server)
        .await
        .context("Jobs HTTP shutdown deadline elapsed")???;
    Ok(())
}
