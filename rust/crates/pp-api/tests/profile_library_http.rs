use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    profiles::{ProfileLibraryHttpConfig, profile_library_router},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
use reqwest::{Client, Method, Response};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::PathBuf};

const NODE_FIXTURE: &str = include_str!("fixtures/profile-library-node.json");
const PRIVATE_PATH: &str = "/owned/private/dummy-secret-path";
const PRIVATE_CONFIG: &str = "{\"dummySecret\":\"never-public\"}";

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        first_user: FirstUserTenant::ClaimDefault,
        session_tenant: SessionTenantPolicy::AccountTenant,
    }
}

fn directory() -> PathBuf {
    let mut random = [0; 12];
    getrandom::fill(&mut random).unwrap();
    std::env::temp_dir().join(format!("pp-profile-library-http-{}", hex::encode(random)))
}

fn replace_profiles(directory: &std::path::Path) {
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    connection
        .execute_batch(
            "DELETE FROM printer_profiles;
             DELETE FROM process_profiles;
             DELETE FROM filament_profiles;",
        )
        .unwrap();
    for row in [
        (
            101,
            "Same",
            "orca",
            Some("1.9"),
            Some("2026-10-05T17:00:01.000Z"),
            "2026-10-05T16:00:01.000Z",
        ),
        (
            105,
            "10",
            "bambu",
            None,
            Some("2026-10-05T17:00:05.000Z"),
            "2026-10-05T16:00:05.000Z",
        ),
    ] {
        connection.execute(
            "INSERT INTO printer_profiles(id,tenant_id,name,slicer_format,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at) VALUES(?1,'default',?2,?3,?4,?5,?6,?7,?8)",
            params![row.0,row.1,row.2,PRIVATE_PATH,PRIVATE_CONFIG,row.3,row.4,row.5],
        ).unwrap();
    }
    for row in [
        (202, "Same", "prusa", "2026-10-05T16:00:02.000Z"),
        (204, "a", "orca", "2026-10-05T16:00:04.000Z"),
    ] {
        connection.execute(
            "INSERT INTO process_profiles(id,tenant_id,name,slicer_format,source_path,resolved_flat_config,imported_at) VALUES(?1,'default',?2,?3,?4,?5,?6)",
            params![row.0,row.1,row.2,PRIVATE_PATH,PRIVATE_CONFIG,row.3],
        ).unwrap();
    }
    for row in [
        (
            303,
            "Á",
            "PLA",
            Some("2.0"),
            Some("2026-10-05T17:00:03.000Z"),
            "2026-10-05T16:00:03.000Z",
        ),
        (
            306,
            "2",
            "PETG",
            Some("2.1"),
            None,
            "2026-10-05T16:00:06.000Z",
        ),
    ] {
        connection.execute(
            "INSERT INTO filament_profiles(id,tenant_id,name,material_type,source_path,resolved_flat_config,synced_from_slicer_version,last_synced_at,imported_at) VALUES(?1,'default',?2,?3,?4,?5,?6,?7,?8)",
            params![row.0,row.1,row.2,PRIVATE_PATH,PRIVATE_CONFIG,row.3,row.4,row.5],
        ).unwrap();
    }
}

fn database_image(directory: &std::path::Path) -> Vec<(String, String)> {
    ["print-partner.db", "print-partner.db-wal"]
        .into_iter()
        .filter_map(|name| {
            let path = directory.join(name);
            path.exists().then(|| {
                (
                    name.to_owned(),
                    hex::encode(Sha256::digest(std::fs::read(path).unwrap())),
                )
            })
        })
        .collect()
}

fn set_key_expiry(directory: &std::path::Path, id: &str, expires_at: Option<&str>) {
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id='default' AND key='api_keys_v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut keys: Value = serde_json::from_str(&raw).unwrap();
    let key = keys
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|key| key["id"] == id)
        .unwrap();
    key["expiresAt"] = expires_at.map_or(Value::Null, |value| json!(value));
    connection
        .execute(
            "UPDATE app_settings SET value=?1 WHERE tenant_id='default' AND key='api_keys_v1'",
            [keys.to_string()],
        )
        .unwrap();
}

fn corrupt_key_collection(directory: &std::path::Path) {
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    connection
        .execute(
            "UPDATE app_settings SET value='{invalid json' WHERE tenant_id='default' AND key='api_keys_v1'",
            [],
        )
        .unwrap();
}

struct Registration {
    cookie: String,
}

struct Server {
    origin: String,
    client: Client,
    owner: WriterOwner,
    task: tokio::task::JoinHandle<()>,
    stop: tokio::sync::oneshot::Sender<()>,
    directory: PathBuf,
}

impl Server {
    async fn start() -> Self {
        let directory = directory();
        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        replace_profiles(&directory);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            owner.auth_with_policy(policy()).unwrap(),
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        )
        .merge(profile_library_router(
            ProfileLibraryHttpConfig::new(&origin).unwrap(),
            owner.profile_library_access(policy()).unwrap(),
            Some(
                owner
                    .profile_library_key_access(policy(), "default".to_owned())
                    .unwrap(),
            ),
        ));
        let (stop, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
            .unwrap();
        });
        Self {
            origin,
            client: Client::builder().no_proxy().build().unwrap(),
            owner,
            task,
            stop,
            directory,
        }
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        bearer: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        request.send().await.unwrap()
    }

    async fn register(&self, email: &str) -> Registration {
        let response = self
            .request(
                Method::POST,
                "/auth/register",
                None,
                None,
                Some(json!({"email":email,"password":"profile-password-123"})),
            )
            .await;
        assert_eq!(response.status(), 200);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        Registration { cookie }
    }

    async fn stop(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.shutdown().unwrap();
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

#[tokio::test]
async fn session_get_and_head_match_node_for_both_aliases_and_tenants() {
    let server = Server::start().await;
    let owner = server.register("owner@example.test").await;
    let expected: Value = serde_json::from_str(NODE_FIXTURE).unwrap();
    let expected_text = serde_json::to_string(&expected).unwrap();
    for path in ["/profile-library", "/api/v1/profile-library"] {
        let response = server
            .request(Method::GET, path, Some(&owner.cookie), None, None)
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "application/json; charset=utf-8"
        );
        assert_eq!(
            response.headers()["content-length"],
            expected_text.len().to_string()
        );
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert_eq!(response.headers()["pragma"], "no-cache");
        let actual_text = response.text().await.unwrap();
        assert_eq!(actual_text, expected_text);
        let body: Value = serde_json::from_str(&actual_text).unwrap();
        assert!(!body.to_string().contains(PRIVATE_PATH));
        assert!(!body.to_string().contains(PRIVATE_CONFIG));
        let response = server
            .request(Method::HEAD, path, Some(&owner.cookie), None, None)
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "application/json; charset=utf-8"
        );
        assert_eq!(
            response.headers()["content-length"],
            expected_text.len().to_string()
        );
        assert!(response.bytes().await.unwrap().is_empty());
    }
    let foreign = server.register("foreign@example.test").await;
    let response = server
        .request(
            Method::GET,
            "/profile-library",
            Some(&foreign.cookie),
            None,
            None,
        )
        .await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"profiles":[]})
    );
    server.stop().await;
}

#[tokio::test]
async fn api_key_revocation_and_invalid_credentials_leave_database_bytes_unchanged() {
    let server = Server::start().await;
    let owner = server.register("keys@example.test").await;
    let created = server
        .request(
            Method::POST,
            "/settings/api-keys",
            Some(&owner.cookie),
            None,
            Some(json!({})),
        )
        .await;
    assert_eq!(created.status(), 201);
    let key: Value = created.json().await.unwrap();
    let raw = key["key"].as_str().unwrap();
    let id = key["id"].as_str().unwrap();
    let response = server
        .request(
            Method::GET,
            "/api/v1/profile-library",
            None,
            Some(raw),
            None,
        )
        .await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap()["profiles"]
            .as_array()
            .unwrap()
            .len(),
        6
    );

    let before_invalid = database_image(&server.directory);
    let invalid = server
        .request(
            Method::GET,
            "/profile-library",
            None,
            Some("invalid-profile-key"),
            None,
        )
        .await;
    assert_eq!(invalid.status(), 401);
    assert_eq!(
        invalid.json::<Value>().await.unwrap(),
        json!({"detail":"Authentication required"})
    );
    assert_eq!(database_image(&server.directory), before_invalid);

    set_key_expiry(&server.directory, id, Some("2000-01-01T00:00:00.000Z"));
    let before_expired = database_image(&server.directory);
    let expired = server
        .request(Method::GET, "/profile-library", None, Some(raw), None)
        .await;
    assert_eq!(expired.status(), 401);
    assert_eq!(
        expired.json::<Value>().await.unwrap(),
        json!({"detail":"Authentication required"})
    );
    assert_eq!(database_image(&server.directory), before_expired);
    set_key_expiry(&server.directory, id, None);

    let revoked = server
        .request(
            Method::DELETE,
            &format!("/settings/api-keys/{id}"),
            Some(&owner.cookie),
            None,
            None,
        )
        .await;
    assert_eq!(revoked.status(), 200);
    let before_revoked = database_image(&server.directory);
    let rejected = server
        .request(Method::GET, "/profile-library", None, Some(raw), None)
        .await;
    assert_eq!(rejected.status(), 401);
    assert_eq!(database_image(&server.directory), before_revoked);

    corrupt_key_collection(&server.directory);
    let storage_failure = server
        .request(Method::GET, "/profile-library", None, Some(raw), None)
        .await;
    assert_eq!(storage_failure.status(), 500);
    assert_eq!(
        storage_failure.json::<Value>().await.unwrap(),
        json!({"detail":"Profile library unavailable"})
    );
    server.stop().await;
}
