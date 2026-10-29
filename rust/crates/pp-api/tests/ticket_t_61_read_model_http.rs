//! GRE-415: Accepted Plan Checkoff over HTTP, read from the Node-produced
//! `accepted-plan-node.db` fixture copied into a scratch store.
#![cfg(feature = "desktop_rebuild")]

use pp_api::accepted::{AcceptedHttpConfig, accepted_router};
use pp_storage::{
    Limits, WriterOwner,
    auth::Secret,
    read_model::{
        Credential,
        views::{self, CatalogOnly},
    },
};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{os::unix::fs::DirBuilderExt, sync::atomic::AtomicBool, time::Duration};

#[path = "../../pp-storage/tests/common/scratch.rs"]
mod scratch;
use scratch::Scratch;

const SESSION: &str = "pp_session=read-fixture-secret";
const ALIASES: &[&str] = &["", "/api/v1", "/api/v2"];

struct Fixture {
    owner: Option<WriterOwner>,
    origin: String,
    client: Client,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
    // Dropped last so storage closes before the directory is removed.
    directory: Scratch,
}

impl Fixture {
    async fn new(mutation: Option<&str>, flag: Option<&str>) -> Self {
        let directory = Scratch::new("pp-accepted-http-");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory.join("repos/1/revisions/accepted"))
            .unwrap();
        std::fs::write(
            directory.join("print-partner.db"),
            include_bytes!("../../pp-storage/tests/fixtures/accepted-plan-node.db"),
        )
        .unwrap();
        if let Some(sql) = mutation {
            mutate(&directory, sql);
        }
        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = accepted_router(
            AcceptedHttpConfig::from_startup(&origin, "default", flag).unwrap(),
            owner.accepted_reads().unwrap(),
        );
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
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
        Self {
            owner: Some(owner),
            origin,
            client: Client::builder().no_proxy().build().unwrap(),
            shutdown: Some(shutdown),
            task: Some(task),
            directory,
        }
    }

    async fn get(&self, path: &str, headers: &[(&str, &str)]) -> (u16, Value) {
        let (status, bytes) = self.send(Method::GET, path, headers).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn send(&self, method: Method, path: &str, headers: &[(&str, &str)]) -> (u16, Vec<u8>) {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        (
            response.status().as_u16(),
            response.bytes().await.unwrap().to_vec(),
        )
    }

    /// The same projection read straight from storage, for comparison.
    fn direct(&self) -> Value {
        let batch = self
            .owner
            .as_ref()
            .unwrap()
            .accepted_reads()
            .unwrap()
            .read(
                Credential::Session(Secret::new("read-fixture-secret".into())),
                &[1],
                &AtomicBool::new(false),
                Duration::from_secs(1),
            )
            .unwrap();
        let build = &batch.builds[0];
        views::checkoff(build.profile_id, &build.accepted, &CatalogOnly).unwrap()
    }

    fn dump(&self) -> String {
        let db = rusqlite::Connection::open(self.directory.join("print-partner.db")).unwrap();
        db.busy_timeout(Duration::from_secs(3)).unwrap();
        let tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut out = String::new();
        for table in tables {
            let mut statement = db
                .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
                .unwrap();
            let count = statement.column_count();
            let mut rows = statement.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                for i in 0..count {
                    out.push_str(&format!("{:?}|", row.get_ref(i).unwrap()));
                }
            }
        }
        out
    }

    async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
        self.owner.take().unwrap().shutdown().unwrap();
    }
}

fn mutate(directory: &std::path::Path, sql: &str) {
    let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
    db.pragma_update(None, "foreign_keys", false).unwrap();
    let triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for trigger in triggers {
        db.execute_batch(&format!("DROP TRIGGER \"{trigger}\";"))
            .unwrap();
    }
    db.execute_batch(sql).unwrap();
}

#[tokio::test]
async fn ticket_t_61_read_model_http_checkoff_matches_storage_on_every_alias() {
    let f = Fixture::new(None, Some("1")).await;
    let before = f.dump();
    let direct = f.direct();
    assert_eq!(direct["kind"], "ready");
    let expected = direct["body"].clone();
    // Node's `toAcceptedCheckoffView` body: excluded Parts are omitted and
    // catalog-less filament is an empty label with a null swatch.
    assert_eq!(
        expected,
        json!({
            "profile_id": 1,
            "summary": "0/1 parts fully printed · 0/1 units",
            "parts": [{
                "id": 2,
                "filename": "included.stl",
                "match_key": "included.stl",
                "relative_path": "included.stl",
                "source_layer": "base:Tracked operational source",
                "role": "primary",
                "quantity_effective": 1,
                "printed_count": 0,
                "print_units": [false],
                "missing": true,
                "filament_display": "",
                "filament_hex": null,
            }],
        })
    );
    for alias in ALIASES {
        let path = format!("{alias}/plans/1/checkoff");
        assert_eq!(
            f.get(&path, &[("Cookie", SESSION)]).await,
            (200, expected.clone()),
            "{path}"
        );
        let (status, body) = f.send(Method::HEAD, &path, &[("Cookie", SESSION)]).await;
        assert_eq!((status, body.len()), (200, 0), "HEAD {path}");
    }
    assert_eq!(before, f.dump(), "Checkoff reads write nothing");
    f.stop().await;
}

#[tokio::test]
async fn ticket_t_61_read_model_http_checkoff_requires_a_valid_credential() {
    let f = Fixture::new(None, Some("1")).await;
    let refused = json!({"detail":"Authentication required"});
    for alias in ALIASES {
        let path = format!("{alias}/plans/1/checkoff");
        assert_eq!(f.get(&path, &[]).await, (401, refused.clone()), "{path}");
        assert_eq!(
            f.get(&path, &[("Cookie", "pp_session=wrong")]).await,
            (401, refused.clone()),
            "{path}"
        );
        assert_eq!(
            f.get(&path, &[("Authorization", "Bearer wrong")]).await,
            (401, refused.clone()),
            "{path}"
        );
        // An unusable id still proves the credential before answering.
        assert_eq!(
            f.get(
                &format!("{alias}/plans/abc/checkoff"),
                &[("Cookie", "pp_session=wrong")]
            )
            .await,
            (401, refused.clone()),
            "{path}"
        );
    }
    f.stop().await;
}

#[tokio::test]
async fn ticket_t_61_read_model_http_checkoff_missing_and_foreign_are_not_found() {
    let f = Fixture::new(
        Some("UPDATE build_profiles SET tenant_id='foreign' WHERE id=1"),
        Some("1"),
    )
    .await;
    let missing = (404, json!({"detail":"Profile not found"}));
    for alias in ALIASES {
        for id in ["1", "999", "0", "abc", "9007199254740992"] {
            let path = format!("{alias}/plans/{id}/checkoff");
            assert_eq!(
                f.get(&path, &[("Cookie", SESSION)]).await,
                missing,
                "{path}"
            );
        }
    }
    f.stop().await;
}

#[tokio::test]
async fn ticket_t_61_read_model_http_checkoff_unavailable_and_corrupt_states() {
    let dirty = Fixture::new(
        Some("UPDATE build_profiles SET accepted_plan_revision_id=NULL WHERE id=1"),
        Some("1"),
    )
    .await;
    assert_eq!(
        dirty.get("/plans/1/checkoff", &[("Cookie", SESSION)]).await,
        (
            409,
            json!({"detail":"Accepted Plan requires compatibility repair"})
        )
    );
    dirty.stop().await;
    let corrupt = Fixture::new(
        Some("UPDATE plan_revisions SET snapshot_digest=replace(snapshot_digest,'a','b')"),
        Some("1"),
    )
    .await;
    let before = corrupt.dump();
    assert_eq!(
        corrupt
            .get("/api/v2/plans/1/checkoff", &[("Cookie", SESSION)])
            .await,
        (500, json!({"detail":"Accepted Plan data is inconsistent"}))
    );
    assert_eq!(
        before,
        corrupt.dump(),
        "Corrupt graphs fail closed without repair"
    );
    corrupt.stop().await;
}

#[tokio::test]
async fn ticket_t_61_read_model_http_flag_off_mounts_nothing() {
    for flag in [None, Some("0"), Some("TRUE")] {
        let f = Fixture::new(None, flag).await;
        for alias in ALIASES {
            let (status, _) = f
                .send(
                    Method::GET,
                    &format!("{alias}/plans/1/checkoff"),
                    &[("Cookie", SESSION)],
                )
                .await;
            assert_eq!(status, 404, "{flag:?} {alias}");
        }
        f.stop().await;
    }
}
