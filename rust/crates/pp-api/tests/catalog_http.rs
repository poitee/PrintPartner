use pp_api::{
    auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
    catalog::{CatalogHttpConfig, catalog_router},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog::{NamingProfile, Request as CatalogRequest},
};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{net::SocketAddr, path::PathBuf, sync::atomic::AtomicBool, time::Duration};
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::FirstAccountOnly,
        first_user: FirstUserTenant::NewUser,
        session_tenant: SessionTenantPolicy::SingleAccountDefault,
    }
}
fn directory() -> PathBuf {
    let mut b = [0; 12];
    getrandom::fill(&mut b).unwrap();
    std::env::temp_dir().join(format!("pp-catalog-http-{}", hex::encode(b)))
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
        Self::open(directory(), None).await
    }
    async fn open(directory: PathBuf, limits: Option<(usize, usize)>) -> Self {
        let owner = WriterOwner::open(&directory, Limits::default()).unwrap().0;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mut config = CatalogHttpConfig::new(&origin).unwrap();
        if let Some((a, b)) = limits {
            config = config.with_body_limits(a, b).unwrap()
        }
        let router = auth_router(
            AuthHttpConfig::new(&origin, CookieTransport::LoopbackHttp, false, None, false)
                .unwrap(),
            owner.auth_with_policy(policy()).unwrap(),
            ProviderClient::new(None, None).unwrap(),
            ResetMailer::disabled(),
        )
        .merge(catalog_router(
            config,
            owner.catalog_access(policy()).unwrap(),
            Some(
                owner
                    .catalog_key_access(policy(), "default".into())
                    .unwrap(),
            ),
        ))
        .layer(axum::middleware::from_fn(
            async |request: axum::extract::Request, next: axum::middleware::Next| {
                let method = request.method().to_string();
                let path = request.uri().path().to_owned();
                let response = next.run(request).await;
                println!(
                    "catalog_http_receipt={}",
                    json!({"method":method,"path":path,"status":response.status().as_u16()})
                );
                response
            },
        ));
        let (stop, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .unwrap();
        });
        Self {
            origin,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
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
        body: Option<Value>,
        cookie: Option<&str>,
    ) -> Response {
        let mut r = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .header("Origin", &self.origin);
        if let Some(b) = body {
            let bytes = serde_json::to_vec(&b).unwrap();
            assert!(bytes.len() < 65536);
            r = r.json(&b)
        }
        if let Some(c) = cookie {
            r = r.header("Cookie", c)
        }
        r.send().await.unwrap()
    }
    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: &str,
        status: u16,
    ) -> Value {
        let r = self.request(method, path, body, Some(cookie)).await;
        let actual = r.status();
        let text = r.text().await.unwrap();
        assert_eq!(actual.as_u16(), status, "{path}: {text}");
        serde_json::from_str(&text).unwrap()
    }
    async fn login(&self) -> String {
        let r = self
            .request(
                Method::POST,
                "/auth/login",
                Some(json!({"email":"catalog@example.test","password":"catalog-password-123"})),
                None,
            )
            .await;
        assert_eq!(r.status(), 200);
        r.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into()
    }
    async fn register(&self) -> String {
        let r = self
            .request(
                Method::POST,
                "/auth/register",
                Some(json!({"email":"catalog@example.test","password":"catalog-password-123"})),
                None,
            )
            .await;
        assert_eq!(r.status(), 200);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["user"]["user_id"].as_str().unwrap().len(), 36);
        self.login().await
    }
    async fn stop(self) -> PathBuf {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        self.owner.shutdown().unwrap();
        self.directory
    }
    async fn close(self) {
        std::fs::remove_dir_all(self.stop().await).unwrap()
    }
}
fn database_rows(directory: &std::path::Path) -> Value {
    let db = rusqlite::Connection::open_with_flags(
        directory.join("print-partner.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut tables = serde_json::Map::new();
    for name in names {
        let mut statement = db
            .prepare(&format!(
                "SELECT * FROM \"{}\" ORDER BY rowid",
                name.replace('"', "\"\"")
            ))
            .unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..columns)
                    .map(|i| {
                        Ok(match row.get_ref(i)? {
                            rusqlite::types::ValueRef::Null => Value::Null,
                            rusqlite::types::ValueRef::Integer(i) => json!(i),
                            rusqlite::types::ValueRef::Real(n) => json!(n),
                            rusqlite::types::ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                            rusqlite::types::ValueRef::Blob(v) => json!(hex::encode(v)),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        tables.insert(name, json!(rows));
    }
    Value::Object(tables)
}
#[tokio::test]
async fn catalog_http_all_contracts_and_aliases() {
    let s = Server::start().await;
    let cookie = s.register().await;
    let mut aliases = 0;
    assert_eq!(
        s.json(Method::GET, "/sources", None, &cookie, 200).await,
        json!({"sources":[]})
    );
    for prefix in ["", "/api/v1"] {
        let source = s
            .json(
                Method::POST,
                &format!("{prefix}/sources"),
                Some(json!({"name":format!("Source {prefix}"),"source_kind":"local"})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        let id = source["id"].as_i64().unwrap();
        for field in [
            "tag",
            "last_synced_at",
            "last_commit_sha",
            "current_source_revision_id",
            "docs_url",
            "manifest_community_slug",
            "metadata",
            "category",
            "update_status",
            "update_checked_at",
        ] {
            assert!(source[field].is_null(), "{field}")
        }
        assert_eq!(source["source_type"], "local");
        assert_eq!(source["doc_count"], 0);
        for path in [
            "/sources".into(),
            format!("/sources/{id}"),
            "/sources/activity".into(),
            "/settings/source-categories".into(),
            "/settings/stl-naming".into(),
            format!("/sources/{id}/import-rules"),
            format!("/sources/{id}/naming"),
        ] {
            let value = s
                .json(Method::GET, &format!("{prefix}{path}"), None, &cookie, 200)
                .await;
            aliases += 1;
            if path == "/sources" {
                assert!(value["sources"].as_array().unwrap().contains(&source))
            } else if path == format!("/sources/{id}") {
                assert_eq!(value, source)
            } else if path.ends_with("activity") {
                assert_eq!(value, json!({"events":[]}))
            } else if path.ends_with("source-categories") {
                assert!(value["categories"].is_array());
                assert!(value["tree"].is_array())
            } else if path.ends_with("stl-naming") {
                assert_eq!(value, json!({"profile":NamingProfile::default()}))
            } else if path.ends_with("import-rules") {
                assert_eq!(value, json!({"rules":[],"legacy_import_all":true}))
            } else {
                assert_eq!(value["use_defaults"], true);
                assert_eq!(value["override"], json!({}));
                assert_eq!(value["effective_digest"].as_str().unwrap().len(), 64)
            }
            let head = s
                .request(
                    Method::HEAD,
                    &format!("{prefix}{path}"),
                    None,
                    Some(&cookie),
                )
                .await;
            assert_eq!(head.status(), 200);
            assert!(
                head.headers()["content-type"]
                    .to_str()
                    .unwrap()
                    .starts_with("application/json")
            );
            assert!(head.bytes().await.unwrap().is_empty());
            aliases += 1;
        }
        let patched = s
            .json(
                Method::PATCH,
                &format!("{prefix}/sources/{id}"),
                Some(json!({"tag":" release ","metadata":{"category":" A / B "}})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(patched["tag"], "release");
        assert_eq!(patched["category"], "A/B");
        let cats = s
            .json(
                Method::PUT,
                &format!("{prefix}/settings/source-categories"),
                Some(json!({"categories":["A/B","C"]})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(cats["categories"], json!(["A", "A/B", "C"]));
        assert_eq!(cats["tree"][0]["children"][0]["path"], "A/B");
        let global = s
            .json(
                Method::PUT,
                &format!("{prefix}/settings/stl-naming"),
                Some(json!({"profile":NamingProfile::default()})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(global, json!({"profile":NamingProfile::default()}));
        let preview = s
            .json(
                Method::POST,
                &format!("{prefix}/settings/stl-naming/preview"),
                Some(json!({"relative_path":"[a]part_x3.stl"})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(
            preview,
            json!({"role":"accent","quantity":3.0,"part_slug":"part","filename":"[a]part_x3.stl"})
        );
        let rules = s
            .json(
                Method::PUT,
                &format!("{prefix}/sources/{id}/import-rules"),
                Some(json!({"rules":["Models","part.stl"]})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(rules, json!({"rules":["Models/","part.stl"]}));
        let naming = s
            .json(
                Method::PUT,
                &format!("{prefix}/sources/{id}/naming"),
                Some(json!({"use_defaults":false,"override":NamingProfile::default()})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(naming["use_defaults"], false);
        assert_eq!(naming["effective"], json!(NamingProfile::default()));
        let bulk = s
            .json(
                Method::POST,
                &format!("{prefix}/sources/bulk-category"),
                Some(json!({"source_ids":[id,id,999],"category":"C"})),
                &cookie,
                200,
            )
            .await;
        aliases += 1;
        assert_eq!(bulk["succeeded"], 1);
        assert_eq!(bulk["failed"], 1);
        assert_eq!(bulk["updated"][0]["category"], "C");
        let stored = s
            .json(
                Method::GET,
                &format!("{prefix}/sources/{id}"),
                None,
                &cookie,
                200,
            )
            .await;
        assert_eq!(stored, bulk["updated"][0]);
        let deleted = s
            .request(
                Method::DELETE,
                &format!("{prefix}/sources/{id}"),
                None,
                Some(&cookie),
            )
            .await;
        aliases += 1;
        assert_eq!(deleted.status(), 204);
        assert!(deleted.bytes().await.unwrap().is_empty());
        s.json(
            Method::GET,
            &format!("{prefix}/sources/{id}"),
            None,
            &cookie,
            404,
        )
        .await;
    }
    assert_eq!(aliases, 46);
    println!("catalog contracts=16 distinct_aliases={aliases}");
    s.close().await;
}
#[tokio::test]
async fn catalog_http_naming_preview_and_activity() {
    let s = Server::start().await;
    let cookie = s.register().await;
    for (body, expected) in [
        (
            json!({"relative_path":"[c]/[a]Part_x2.STL"}),
            json!({"role":"clear","quantity":2.0,"part_slug":"Part","filename":"[a]Part_x2.STL"}),
        ),
        (
            json!({"relative_path":"Folder/part.stl","profile":{"folder_rules":[{"path_contains":"folder","role_id":"opaque"},{"path_contains":"part","role_id":"accent"}]}}),
            json!({"role":"opaque","quantity":1.0,"part_slug":"part","filename":"part.stl"}),
        ),
        (
            json!({"relative_path":"abc.stl","profile":{"quantity":{"regex":"(abc)"}}}),
            json!({"role":"primary","quantity":null,"part_slug":"abc","filename":"abc.stl"}),
        ),
        (
            json!({"relative_path":"part_x9007199254740993.stl"}),
            json!({"role":"primary","quantity":9007199254740992.0,"part_slug":"part","filename":"part_x9007199254740993.stl"}),
        ),
        (
            json!({"relative_path":"abc.stl","profile":{"roles":[{"id":"accent","markers":["ab"]},{"id":"clear","markers":["abc"]}]}}),
            json!({"role":"clear","quantity":1.0,"part_slug":"c","filename":"abc.stl"}),
        ),
    ] {
        assert_eq!(
            s.json(
                Method::POST,
                "/settings/stl-naming/preview",
                Some(body),
                &cookie,
                200
            )
            .await,
            expected
        );
    }
    for profile in [
        json!({"unknown":true}),
        json!({"quantity":{"regex":"(a)(b)"}}),
    ] {
        s.json(
            Method::POST,
            "/settings/stl-naming/preview",
            Some(json!({"profile":profile})),
            &cookie,
            400,
        )
        .await;
    }
    assert_eq!(
        s.json(Method::GET, "/sources/activity", None, &cookie, 200)
            .await,
        json!({"events":[]})
    );
    let directory = s.stop().await;
    {
        let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
        for (tenant, kind, payload) in [
            (
                "default",
                "source.updated",
                r#"{"source_id":1.5,"source_name":"Fraction"}"#,
            ),
            ("default", "source.update_available", "[]"),
            (
                "default",
                "source.sync_failed",
                r#"{"source_id":2,"source_name":"Broken","error":"ordinary failure"}"#,
            ),
            ("other", "source.updated", r#"{"source_name":"Foreign"}"#),
            ("default", "unrelated", "{}"),
            ("default", "source.updated", "invalid"),
        ] {
            db.execute("INSERT INTO app_events(tenant_id,at,kind,payload_json) VALUES(?1,'2026-10-03T00:00:00Z',?2,?3)",rusqlite::params![tenant,kind,payload]).unwrap();
        }
    }
    let s = Server::open(directory, None).await;
    let all = s
        .json(Method::GET, "/sources/activity", None, &cookie, 200)
        .await;
    assert_eq!(all["events"].as_array().unwrap().len(), 4);
    assert_eq!(all["events"][0]["source_name"], "Source");
    assert!(all["events"][0]["source_id"].is_null());
    assert_eq!(all["events"][1]["detail"], "ordinary failure");
    assert_eq!(all["events"][3]["source_id"], 1.5);
    for query in ["bad", "Infinity", "1000"] {
        assert_eq!(
            s.json(
                Method::GET,
                &format!("/sources/activity?limit={query}"),
                None,
                &cookie,
                200
            )
            .await,
            all
        )
    }
    for query in ["0", "-3", "", "1.9"] {
        let value = s
            .json(
                Method::GET,
                &format!("/sources/activity?limit={query}"),
                None,
                &cookie,
                200,
            )
            .await;
        assert_eq!(value, json!({"events":[all["events"][0].clone()]}));
    }
    s.close().await;
}
#[tokio::test]
async fn catalog_http_patch_categories_and_import_rules() {
    let s = Server::start().await;
    let cookie = s.register().await;
    let source=s.json(Method::POST,"/sources",Some(json!({"name":"Git","url":"https://github.com/owner/project.git/tree/feature/new-ui/STL","branch":"feature/new-ui","tag":"tag"})),&cookie,200).await;
    let id = source["id"].as_i64().unwrap();
    let path = format!("/sources/{id}");
    assert_eq!(source["url"], "https://github.com/owner/project");
    assert_eq!(source["branch"], "feature/new-ui");
    let patch=s.json(Method::PATCH,&path,Some(json!({"url":"https://github.com/owner/next/blob/feature/new-ui/a.stl","role":"base","metadata":{"category":null}})),&cookie,200).await;
    assert_eq!(patch["url"], "https://github.com/owner/next");
    assert_eq!(patch["branch"], "feature/new-ui");
    assert_eq!(patch["tag"], "tag");
    assert!(patch["category"].is_null());
    assert_eq!(patch["metadata"]["sync_required"], true);
    for tag in [Value::Null, json!(" value "), json!("")] {
        let p = s
            .json(Method::PATCH, &path, Some(json!({"tag":tag})), &cookie, 200)
            .await;
        assert_eq!(
            p["tag"],
            if tag == json!(" value ") {
                json!("value")
            } else {
                Value::Null
            }
        );
    }
    let ssh = s
        .json(
            Method::PATCH,
            &path,
            Some(json!({"url":"git@github.com:owner/ssh.git"})),
            &cookie,
            200,
        )
        .await;
    assert_eq!(ssh["url"], "https://github.com/owner/ssh");
    assert_eq!(ssh["branch"], "feature/new-ui");
    for body in [
        json!({"name":"Path","local_path":"example"}),
        json!({"name":"Model","source_kind":"printables"}),
    ] {
        s.json(Method::POST, "/sources", Some(body), &cookie, 400)
            .await;
    }
    s.json(
        Method::PATCH,
        &path,
        Some(json!({"local_path":"example"})),
        &cookie,
        400,
    )
    .await;
    let bulk=s.json(Method::POST,"/sources/bulk-category",Some(json!({"source_ids":[id,id,id.to_string(),1.5,null,-2,999],"category":" Old / Child "})),&cookie,200).await;
    assert_eq!(bulk["succeeded"], 1);
    assert_eq!(bulk["failed"], 4);
    assert_eq!(bulk["results"][1]["source_id"], 1.5);
    assert_eq!(bulk["updated"][0]["category"], "Old/Child");
    s.json(
        Method::PUT,
        "/settings/source-categories",
        Some(json!({"categories":["Old/Child","Other"]})),
        &cookie,
        200,
    )
    .await;
    let cats = s
        .json(
            Method::PUT,
            "/settings/source-categories",
            Some(json!({"categories":["New/Child","Other"],"replacements":{"Old":"New"}})),
            &cookie,
            200,
        )
        .await;
    assert_eq!(cats["tree"][0]["children"][0]["path"], "New/Child");
    assert_eq!(
        s.json(Method::GET, &path, None, &cookie, 200).await["category"],
        "New/Child"
    );
    s.json(
        Method::PUT,
        "/settings/source-categories",
        Some(json!({"categories":[]})),
        &cookie,
        400,
    )
    .await;
    assert_eq!(
        s.json(
            Method::PUT,
            &format!("{path}/import-rules"),
            Some(json!({"rules":[" /STLs ","\\STLs","a.STL",""]})),
            &cookie,
            200
        )
        .await,
        json!({"rules":["STLs/","a.STL"]})
    );
    s.json(
        Method::PUT,
        &format!("{path}/import-rules"),
        Some(json!({})),
        &cookie,
        200,
    )
    .await;
    assert_eq!(
        s.json(
            Method::GET,
            &format!("{path}/import-rules"),
            None,
            &cookie,
            200
        )
        .await,
        json!({"rules":[],"legacy_import_all":false})
    );
    let directory = s.stop().await;
    let s = Server::open(directory, Some((128, 256))).await;
    s.json(
        Method::POST,
        "/sources",
        Some(json!({"name":"n".repeat(140)})),
        &cookie,
        413,
    )
    .await;
    s.json(
        Method::PUT,
        &format!("{path}/import-rules"),
        Some(json!({"rules":["r".repeat(260)]})),
        &cookie,
        413,
    )
    .await;
    s.json(
        Method::PUT,
        &format!("{path}/import-rules"),
        Some(json!({"rules":["r".repeat(140)]})),
        &cookie,
        200,
    )
    .await;
    assert_eq!(pp_storage::catalog::IMPORT_RULE_BODY_LIMIT, 8 * 1024 * 1024);
    s.close().await;
}
#[tokio::test]
async fn catalog_http_naming_errors_and_delete_refusals() {
    let s = Server::start().await;
    let cookie = s.register().await;
    for name in ["History", "Reference", "Invalid", "Active", "Free"] {
        s.json(
            Method::POST,
            "/sources",
            Some(json!({"name":name,"source_kind":"local"})),
            &cookie,
            200,
        )
        .await;
    }
    s.json(
        Method::POST,
        "/sources",
        Some(json!({"name":"Free"})),
        &cookie,
        400,
    )
    .await;
    for body in [
        json!({}),
        json!({"use_defaults":false,"override":{"quantity":{"default":2}}}),
        json!({"use_defaults":true,"override":{}}),
        json!({"use_defaults":false,"override":{}}),
    ] {
        let v = s
            .json(Method::PUT, "/sources/1/naming", Some(body), &cookie, 400)
            .await;
        assert_eq!(v["code"], "invalid_source_naming");
    }
    let missing = s
        .json(Method::GET, "/sources/999/naming", None, &cookie, 404)
        .await;
    assert_eq!(
        missing,
        json!({"code":"source_not_found","detail":"Source not found"})
    );
    let invalid = s
        .json(Method::GET, "/sources/1.5/naming", None, &cookie, 400)
        .await;
    assert_eq!(invalid["code"], "invalid_source_naming");
    let directory = s.stop().await;
    {
        let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
        db.execute_batch("INSERT INTO source_revisions(tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at) VALUES('default',1,'key','digest','1/revisions/key','2026-10-03'); INSERT INTO build_profiles(id,tenant_id,name) VALUES(1,'default','Build'); INSERT INTO profile_layers(tenant_id,profile_id,layer_type,project_id) VALUES('default',1,'base',2); UPDATE projects SET metadata_json='{\"naming\":{\"use_defaults\":false,\"override\":{\"quantity\":{\"regex\":\"(a)(b)\"}}}}' WHERE id=3;").unwrap();
    }
    let s = Server::open(directory, None).await;
    let invalid = s
        .json(Method::GET, "/sources/3/naming", None, &cookie, 500)
        .await;
    assert_eq!(
        invalid,
        json!({"code":"invalid_source_naming_state","detail":"Stored Source naming settings are invalid"})
    );
    let key = s
        .json(
            Method::POST,
            "/settings/api-keys",
            Some(json!({})),
            &cookie,
            201,
        )
        .await;
    let before_rows = database_rows(&s.directory);
    let before_bytes = ["print-partner.db", "print-partner.db-wal"]
        .map(|name| std::fs::read(s.directory.join(name)).ok());
    let refused = s
        .client
        .delete(format!("{}/sources/1", s.origin))
        .header("Origin", &s.origin)
        .header(
            "Authorization",
            format!("Bearer {}", key["key"].as_str().unwrap()),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 409);
    assert_eq!(database_rows(&s.directory), before_rows);
    assert_eq!(
        ["print-partner.db", "print-partner.db-wal"]
            .map(|name| std::fs::read(s.directory.join(name)).ok()),
        before_bytes
    );
    let before = s.json(Method::GET, "/sources", None, &cookie, 200).await;
    let mut lease = s
        .owner
        .local_source_catalog()
        .begin_work(4, &AtomicBool::new(false), Duration::from_secs(1))
        .unwrap();
    for id in [1, 2, 4] {
        s.json(
            Method::DELETE,
            &format!("/sources/{id}"),
            None,
            &cookie,
            409,
        )
        .await;
    }
    assert_eq!(
        s.json(Method::GET, "/sources", None, &cookie, 200).await,
        before
    );
    assert_eq!(database_rows(&s.directory), before_rows);
    lease.release().unwrap();
    assert_eq!(
        s.request(Method::DELETE, "/sources/5", None, Some(&cookie))
            .await
            .status(),
        204
    );
    s.json(Method::DELETE, "/sources/999", None, &cookie, 404)
        .await;
    let fixed = s
        .json(
            Method::PUT,
            "/sources/3/naming",
            Some(json!({"use_defaults":true})),
            &cookie,
            200,
        )
        .await;
    assert_eq!(fixed["use_defaults"], true);
    s.close().await;
    let directory = crate::directory();
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("print-partner.db"),
        include_bytes!("../../pp-storage/tests/fixtures/accepted-plan-node.db"),
    )
    .unwrap();
    {
        let db = rusqlite::Connection::open(directory.join("print-partner.db")).unwrap();
        db.execute_batch("DELETE FROM sessions; DELETE FROM users;")
            .unwrap();
    }
    let s = Server::open(directory, None).await;
    let cookie = s.register().await;
    let before = database_rows(&s.directory);
    s.json(Method::DELETE, "/sources/1", None, &cookie, 409)
        .await;
    assert_eq!(database_rows(&s.directory), before);
    let directory = s.stop().await;
    let s = Server::open(directory, None).await;
    let reopened = database_rows(&s.directory);
    let mut expected_reopened = before.clone();
    let sequences = expected_reopened["sqlite_sequence"].as_array_mut().unwrap();
    for (table, increment) in [
        ("printer_profiles", 2),
        ("process_profiles", 6),
        ("filament_profiles", 4),
    ] {
        let row = sequences.iter_mut().find(|row| row[0] == table).unwrap();
        row[1] = json!(row[1].as_i64().unwrap() + increment);
    }
    for (table, rows) in expected_reopened.as_object().unwrap() {
        assert_eq!(&reopened[table], rows, "startup table {table}");
    }
    assert_eq!(
        reopened.as_object().unwrap().len(),
        expected_reopened.as_object().unwrap().len()
    );
    s.json(Method::DELETE, "/sources/1", None, &cookie, 409)
        .await;
    assert_eq!(database_rows(&s.directory), reopened);
    println!(
        "startup sqlite_sequence accounted: printer_profiles +2, process_profiles +6, filament_profiles +4"
    );
    println!(
        "retained accepted graph tables={} rows={}",
        before.as_object().unwrap().len(),
        before
            .as_object()
            .unwrap()
            .values()
            .map(|v| v.as_array().unwrap().len())
            .sum::<usize>()
    );
    s.close().await;
}
#[tokio::test]
async fn catalog_http_auth_policy_revocation_and_restart() {
    let s = Server::start().await;
    let cookie = s.register().await;
    s.json(Method::GET, "/sources", None, "pp_session=invalid", 401)
        .await;
    let source = s
        .json(
            Method::POST,
            "/sources",
            Some(json!({"name":"Persisted","source_kind":"local"})),
            &cookie,
            200,
        )
        .await;
    let key = s
        .json(
            Method::POST,
            "/settings/api-keys",
            Some(json!({"name":"Catalog key"})),
            &cookie,
            201,
        )
        .await;
    let raw = key["key"].as_str().unwrap();
    for header in ["Authorization", "x-print-partner-api-key"] {
        let value = if header == "Authorization" {
            format!("Bearer {raw}")
        } else {
            raw.into()
        };
        let r = s
            .client
            .get(format!("{}/api/v1/sources", s.origin))
            .header(header, value)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(
            r.json::<Value>().await.unwrap(),
            json!({"sources":[source.clone()]})
        );
    }
    let ambiguous = s
        .client
        .get(format!("{}/sources", s.origin))
        .header("Cookie", &cookie)
        .header("Authorization", format!("Bearer {raw}"))
        .send()
        .await
        .unwrap();
    assert_eq!(ambiguous.status(), 401);
    let wrong = s
        .owner
        .catalog_key_access(policy(), "other".into())
        .unwrap()
        .key(pp_storage::auth::Secret::new(raw.into()));
    assert!(wrong.execute(CatalogRequest::List {}).is_err());
    let id = key["id"].as_str().unwrap();
    s.json(
        Method::DELETE,
        &format!("/settings/api-keys/{id}"),
        None,
        &cookie,
        200,
    )
    .await;
    let revoked = s
        .client
        .get(format!("{}/sources", s.origin))
        .header("Authorization", format!("Bearer {raw}"))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 401);
    s.json(Method::POST, "/auth/logout", Some(json!({})), &cookie, 200)
        .await;
    s.json(Method::GET, "/sources", None, &cookie, 401).await;
    let directory = s.stop().await;
    let s = Server::open(directory, None).await;
    let new_cookie = s.login().await;
    assert_eq!(
        s.json(Method::GET, "/sources", None, &new_cookie, 200)
            .await,
        json!({"sources":[source]})
    );
    s.json(Method::GET, "/sources", None, &cookie, 401).await;
    let owner_auth = s.owner.auth(FirstUserTenant::NewUser);
    owner_auth
        .submit(
            pp_storage::auth::Request::Register {
                email: "second@example.test".into(),
                display_name: "Second".into(),
                password: pp_storage::auth::Secret::new("password-1234".into()),
            },
            std::sync::Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    s.json(Method::GET, "/sources", None, &new_cookie, 403)
        .await;
    assert!(
        s.owner
            .local_source_catalog()
            .execute(CatalogRequest::List {})
            .is_ok()
    );
    s.close().await;
}
