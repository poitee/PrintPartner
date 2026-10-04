use axum::{
    Router,
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::Request,
};
use pp_api::drafts::{
    DraftHttpClients, DraftHttpConfig, FilamentFuture, ReviewObservationPort, draft_router,
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    read_model::{Snapshot, views::ReviewObservations},
    working_drafts::observation::{
        CheckoutManifestUse, DocumentRead, DraftReads, OwnedCatalogReadRequest,
        OwnedCheckoutReadRequest, OwnedStlReadRequest, PreparationBudget, PreparationLimits,
        ReadFailure, ReadResult, StlRootRead,
    },
};
use reqwest::Method;
use rusqlite::Connection;
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use tower::ServiceExt;

const SESSION: &str = "pp_session=read-fixture-secret";
const ALIASES: [&str; 3] = [
    "/plans/1/review",
    "/api/v2/plans/1/review",
    "/api/v1/plans/1/review",
];

#[derive(Clone, Copy)]
enum AcceptedState {
    CompatibilityDirty,
    Uninitialized,
    IntegrityFailure,
}

struct UnusedDraftReads;

impl DraftReads for UnusedDraftReads {
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        Err(ReadFailure::Unavailable)
    }

    fn read_checkout_manifest(
        &self,
        _: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        Err(ReadFailure::Unavailable)
    }

    fn read_catalog_document(
        &self,
        _: &OwnedCatalogReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        Err(ReadFailure::Unavailable)
    }
}

struct UnusedObserver;

impl ReviewObservationPort for UnusedObserver {
    fn review_observations(
        &self,
        _: &Snapshot,
        _: &AtomicBool,
    ) -> anyhow::Result<ReviewObservations> {
        Err(anyhow::anyhow!("review observation must not run"))
    }

    fn filament_lookup<'a>(&'a self, _: &'a Snapshot, _: Arc<AtomicBool>) -> FilamentFuture<'a> {
        Box::pin(async { Err(anyhow::anyhow!("filament lookup must not run")) })
    }
}

struct Server {
    router: Router,
    owner: WriterOwner,
    directory: PathBuf,
}

impl Server {
    async fn start(state: AcceptedState) -> Self {
        let directory = fixture_directory();
        std::fs::create_dir_all(directory.join("repos/1/revisions/accepted")).unwrap();
        std::fs::write(
            directory.join("print-partner.db"),
            include_bytes!("../../pp-storage/tests/fixtures/accepted-plan-node.db"),
        )
        .unwrap();
        prepare_state(&directory, state);

        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        let policy = policy();
        let drafts = owner
            .working_drafts_with_policy(
                policy,
                Arc::new(UnusedDraftReads),
                PreparationLimits::default(),
                directory.join("repos"),
            )
            .unwrap();
        let clients = DraftHttpClients {
            saves: drafts.plan_save(),
            publication: owner.publication_with_policy(policy).unwrap(),
            accepted: owner.accepted_reads_with_policy(policy).unwrap(),
            drafts,
        };
        let origin = "http://127.0.0.1:1";
        let router = draft_router(
            DraftHttpConfig::new(origin, "default").unwrap(),
            clients,
            Arc::new(UnusedObserver),
        );
        Self {
            router,
            owner,
            directory,
        }
    }

    async fn assert_aliases(self, detail: &str) {
        let expected = format!(r#"{{"detail":"{detail}"}}"#);
        for path in ALIASES {
            let get = self.request(Method::GET, path).await;
            assert_eq!(get.status(), 409, "GET {path}");
            assert_eq!(get.headers()["content-type"], "application/json");
            assert_eq!(get.headers()["content-length"], expected.len().to_string());
            assert_eq!(
                to_bytes(get.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .as_ref(),
                expected.as_bytes()
            );

            let head = self.request(Method::HEAD, path).await;
            assert_eq!(head.status(), 409, "HEAD {path}");
            assert_eq!(head.headers()["content-type"], "application/json");
            assert_eq!(head.headers()["content-length"], expected.len().to_string());
            assert!(
                to_bytes(head.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .is_empty(),
                "HEAD {path}"
            );
        }
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.directory).unwrap();
    }

    async fn request(&self, method: Method, path: &str) -> axum::response::Response {
        self.request_with_session(method, path, true).await
    }

    async fn request_with_session(
        &self,
        method: Method,
        path: &str,
        authenticated: bool,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("Host", "127.0.0.1:1")
            .header("Origin", "http://127.0.0.1:1");
        if authenticated {
            builder = builder.header("Cookie", SESSION);
        }
        let mut request = builder.body(Body::empty()).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 49152))));
        self.router.clone().oneshot(request).await.unwrap()
    }

    async fn close(self) {
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

fn fixture_directory() -> PathBuf {
    let mut bytes = [0; 12];
    getrandom::fill(&mut bytes).unwrap();
    std::env::temp_dir().join(format!("pp-review-refusal-{}", hex::encode(bytes)))
}

fn prepare_state(directory: &std::path::Path, state: AcceptedState) {
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    connection
        .pragma_update(None, "foreign_keys", false)
        .unwrap();
    let triggers = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for trigger in triggers {
        connection
            .execute_batch(&format!("DROP TRIGGER \"{trigger}\";"))
            .unwrap();
    }
    match state {
        AcceptedState::CompatibilityDirty => connection
            .execute(
                "UPDATE build_profiles SET accepted_plan_revision_id=NULL WHERE id=1",
                [],
            )
            .unwrap(),
        AcceptedState::Uninitialized => connection
            .execute_batch(
                "DELETE FROM plan_revision_required_units;
                 DELETE FROM required_units;
                 DELETE FROM plan_revision_required_unit_sets;",
            )
            .map(|_| 0)
            .unwrap(),
        AcceptedState::IntegrityFailure => connection
            .execute(
                "UPDATE plan_revisions SET snapshot_digest=replace(snapshot_digest,'a','b')",
                [],
            )
            .unwrap(),
    };
}

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

#[tokio::test]
async fn review_aliases_preserve_compatibility_dirty_detail() {
    Server::start(AcceptedState::CompatibilityDirty)
        .await
        .assert_aliases("Accepted Plan requires compatibility repair")
        .await;
}

#[tokio::test]
async fn review_aliases_preserve_uninitialized_detail() {
    Server::start(AcceptedState::Uninitialized)
        .await
        .assert_aliases("Accepted Plan operational state is not initialized")
        .await;
}

#[tokio::test]
async fn review_unrelated_missing_integrity_and_authentication_failures_are_unchanged() {
    let integrity = Server::start(AcceptedState::IntegrityFailure).await;
    assert_response(
        integrity.request(Method::GET, "/plans/1/review").await,
        500,
        r#"{"detail":"Accepted Plan data is inconsistent"}"#,
    )
    .await;
    integrity.close().await;

    let missing = Server::start(AcceptedState::CompatibilityDirty).await;
    assert_response(
        missing.request(Method::GET, "/plans/999/review").await,
        404,
        r#"{"detail":"Profile not found"}"#,
    )
    .await;
    assert_response(
        missing
            .request_with_session(Method::GET, "/plans/1/review", false)
            .await,
        401,
        r#"{"detail":"Authentication required"}"#,
    )
    .await;
    missing.close().await;
}

async fn assert_response(response: axum::response::Response, status: u16, expected: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(
        response.headers()["content-length"],
        expected.len().to_string()
    );
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        expected.as_bytes()
    );
}
