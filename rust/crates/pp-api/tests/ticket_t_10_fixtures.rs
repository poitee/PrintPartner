#![cfg(feature = "desktop_rebuild")]
//! T-10-fixtures: copied Node auth fixtures replayed through the isolated
//! parity runner in `pp_api::fixtures`, comparing responses and state graphs.
mod ticket_t_10_fixtures {
    use pp_api::{
        auth::{AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, auth_router},
        fixtures::{
            Correction, CorrectionKind, Exchange, Ledger, ParityError, Report, Sandbox, Served,
            StateGraph,
        },
    };
    use pp_storage::{
        Limits, WriterOwner,
        auth::{
            AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy,
            rebuild::AuthLifetimes,
        },
    };
    use reqwest::Method;
    use rusqlite::params;
    use serde::Deserialize;
    use serde_json::{Value, json};

    const SESSIONS: &str = "print-partner.db/sessions";

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LoginFixture {
        generated: String,
        source: String,
        configuration: Value,
        account: Value,
        cases: Vec<LoginCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct LoginCase {
        id: String,
        registration_open: bool,
        seed_account: bool,
        request: LoginRequest,
        node: Exchange,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LoginRequest {
        path: String,
        body: String,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SessionFixture {
        generated: String,
        sources: Vec<String>,
        seed: Value,
        cases: Vec<Transition>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Transition {
        name: String,
        method: String,
        path: String,
        credential: String,
        storage: String,
        expected: SessionExpected,
        node_set_cookie: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SessionExpected {
        status: u16,
        body: Value,
        clearing_cookies: Vec<Value>,
        session_rows: usize,
    }

    fn login_fixture() -> LoginFixture {
        let fixture: LoginFixture = serde_json::from_str(include_str!(
            "../../../../fixtures/parity/auth-login/node.json"
        ))
        .unwrap();
        assert!(fixture.generated.contains("auth-login/generate.mjs"));
        assert_eq!(fixture.source, "web/apps/server/src/routes/auth.ts");
        assert_eq!(fixture.configuration["singleUserAuth"], json!(true));
        // Node and Rust both send a same-origin `Origin` header.
        assert_eq!(fixture.configuration["sameOriginRequests"], json!(true));
        assert_eq!(fixture.cases.len(), 14);
        fixture
    }

    fn session_fixture() -> SessionFixture {
        let fixture: SessionFixture = serde_json::from_str(include_str!(
            "../../../../fixtures/parity/auth-session/node.json"
        ))
        .unwrap();
        assert!(fixture.generated.contains("auth-session/generate.mjs"));
        assert_eq!(fixture.sources.len(), 2);
        assert_eq!(fixture.cases.len(), 7);
        fixture
    }

    fn invalid_json(case: &'static str, reason: &'static str) -> Correction {
        Correction {
            case,
            kind: CorrectionKind::Security,
            reason,
            rust: Exchange {
                status: 400,
                body: json!({"detail": "Invalid JSON body"}),
                set_cookie: vec![],
            },
        }
    }

    /// Rust's strict JSON-object boundary, documented in auth-login/README.md.
    fn login_corrections() -> Vec<Correction> {
        vec![
            invalid_json(
                "array-body",
                "arrays are not JSON objects; Rust refuses them before credential checks",
            ),
            invalid_json(
                "null-body",
                "Node answers 500 with an internal TypeError message; Rust does not expose it",
            ),
            invalid_json(
                "malformed-json",
                "Rust does not expose Fastify parser codes or messages",
            ),
        ]
    }

    fn cleared(case: &'static str) -> Correction {
        Correction {
            case,
            kind: CorrectionKind::Security,
            reason: "Rust marks the clearing cookie HttpOnly and expires it with Max-Age=0 only",
            rust: Exchange {
                status: 200,
                body: json!({"ok": true}),
                set_cookie: vec!["pp_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax".into()],
            },
        }
    }

    /// Logout clearing-cookie headers, documented in auth-session/README.md.
    fn session_corrections() -> Vec<Correction> {
        vec![
            cleared("absent_logout"),
            cleared("logout"),
            cleared("repeated_logout"),
        ]
    }

    /// Decodes a recorded Node `Set-Cookie` header into the fields that
    /// `clearing_cookies` records; any other attribute fails the test.
    fn clearing_cookie(header: &str) -> Value {
        let mut parts = header.split(';').map(str::trim);
        let (name, value) = parts.next().unwrap().split_once('=').unwrap();
        let mut cookie = json!({
            "name": name,
            "value": value,
            "path": null,
            "domain": null,
            "same_site": null,
            "secure": false,
            "expires_immediately": false,
        });
        for attribute in parts {
            let (key, value) = attribute.split_once('=').unwrap_or((attribute, ""));
            match key.to_ascii_lowercase().as_str() {
                "path" => cookie["path"] = json!(value),
                "domain" => cookie["domain"] = json!(value),
                "samesite" => cookie["same_site"] = json!(value.to_ascii_lowercase()),
                "secure" => cookie["secure"] = json!(true),
                "max-age" if value == "0" => cookie["expires_immediately"] = json!(true),
                "expires" if value == "Thu, 01 Jan 1970 00:00:00 GMT" => {
                    cookie["expires_immediately"] = json!(true)
                }
                _ => panic!("{header}: unexpected attribute {attribute}"),
            }
        }
        cookie
    }

    fn print_report(corpus: &str, report: &Report) {
        println!(
            "{corpus}: {} exact, {} corrected",
            report.matched,
            report.corrected.len()
        );
        for (case, kind) in &report.corrected {
            println!("{corpus}: {case} corrected ({kind:?})");
        }
    }

    async fn login_case(case: &LoginCase, account: &Value) -> (Exchange, Vec<String>) {
        let sandbox = Sandbox::new("t10-login").unwrap();
        let owner = WriterOwner::open(sandbox.path(), Limits::default())
            .unwrap()
            .0;
        let auth = owner
            .auth_with_policy(AuthPolicy {
                registration: if case.registration_open {
                    RegistrationPolicy::FirstAccountOnly
                } else {
                    RegistrationPolicy::Closed
                },
                first_user: FirstUserTenant::NewUser,
                session_tenant: SessionTenantPolicy::SingleAccountDefault,
            })
            .unwrap();
        // No OAuth provider and no mailer: the router has no outbound effects.
        let served = Served::start(|origin| {
            auth_router(
                AuthHttpConfig::new(origin, CookieTransport::LoopbackHttp, false, None, false)
                    .unwrap(),
                auth,
                ProviderClient::new(None, None).unwrap(),
                ResetMailer::disabled(),
            )
        })
        .await
        .unwrap();
        let post = |path: &str, body: String| {
            served
                .client
                .post(format!("{}{path}", served.origin))
                .header("Origin", &served.origin)
                .header("Content-Type", "application/json")
                .body(body)
                .send()
        };
        if case.seed_account {
            for path in ["/auth/register", "/auth/login"] {
                let setup = Exchange::observe(post(path, account.to_string()).await.unwrap())
                    .await
                    .unwrap();
                assert_eq!(setup.status, 200, "{} setup {path}", case.id);
            }
        }
        let before = StateGraph::capture(sandbox.path()).unwrap();
        let actual = Exchange::observe(
            post(&case.request.path, case.request.body.clone())
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        let after = StateGraph::capture(sandbox.path()).unwrap();
        served.stop().await.unwrap();
        owner.shutdown().unwrap();
        (actual, before.changed(&after))
    }

    #[tokio::test]
    async fn login_refusals_match_node_with_declared_corrections_and_write_nothing() {
        let fixture = login_fixture();
        let mut ledger = Ledger::new(login_corrections()).unwrap();
        for case in &fixture.cases {
            let (actual, changed) = login_case(case, &fixture.account).await;
            ledger
                .compare(&case.id, &case.node, &actual)
                .unwrap_or_else(|error| panic!("{error}"));
            assert_eq!(changed, Vec::<String>::new(), "{} wrote state", case.id);
        }
        let report = ledger.finish().unwrap();
        print_report("auth-login", &report);
        assert_eq!(report.matched, 11);
        assert_eq!(report.corrected.len(), 3);
    }

    struct Rust {
        served: Served,
        owner: WriterOwner,
    }

    impl Rust {
        async fn start(sandbox: &Sandbox) -> Self {
            let owner = WriterOwner::open(sandbox.path(), Limits::default())
                .unwrap()
                .0;
            let auth = owner
                .rebuild_auth_with_policy(
                    AuthPolicy {
                        registration: RegistrationPolicy::Open,
                        first_user: FirstUserTenant::NewUser,
                        session_tenant: SessionTenantPolicy::AccountTenant,
                    },
                    AuthLifetimes::default(),
                )
                .unwrap();
            let served = Served::start(|origin| {
                auth_router(
                    AuthHttpConfig::new(origin, CookieTransport::LoopbackHttp, true, None, false)
                        .unwrap(),
                    auth,
                    ProviderClient::new(None, None).unwrap(),
                    ResetMailer::disabled(),
                )
            })
            .await
            .unwrap();
            Self { served, owner }
        }

        async fn stop(self) {
            self.served.stop().await.unwrap();
            self.owner.shutdown().unwrap();
        }
    }

    fn seed_session(sandbox: &Sandbox, seed: &Value) -> String {
        let (user, session) = (&seed["user"], &seed["session"]);
        let text = |value: &Value| value.as_str().map(str::to_owned);
        let mut db = rusqlite::Connection::open(sandbox.path().join("print-partner.db")).unwrap();
        let tx = db.transaction().unwrap();
        tx.execute(
            "INSERT INTO users(id,email,display_name,password_hash,is_admin,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                text(&user["id"]),
                text(&user["email"]),
                text(&user["display_name"]),
                text(&user["password_hash"]),
                user["is_admin"].as_i64(),
                text(&user["created_at"]),
            ],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO sessions(id,user_id,expires_at,provider) VALUES(?1,?2,?3,?4)",
            params![
                text(&session["id"]),
                text(&session["user_id"]),
                text(&session["expires_at"]),
                text(&session["provider"]),
            ],
        )
        .unwrap();
        tx.commit().unwrap();
        session["token"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn session_transitions_match_node_responses_and_session_rows() {
        let fixture = session_fixture();
        let mut ledger = Ledger::new(session_corrections()).unwrap();
        let sandbox = Sandbox::new("t10-session").unwrap();
        let mut rust = Rust::start(&sandbox).await;
        let token = seed_session(&sandbox, &fixture.seed);
        let mut node_rows = StateGraph::capture(sandbox.path())
            .unwrap()
            .rows(SESSIONS)
            .unwrap();
        assert_eq!(node_rows, 1);
        for transition in &fixture.cases {
            if transition.storage == "reopen" {
                rust.stop().await;
                rust = Rust::start(&sandbox).await;
            }
            let served = &rust.served;
            let mut request = served
                .client
                .request(
                    Method::from_bytes(transition.method.as_bytes()).unwrap(),
                    format!("{}{}", served.origin, transition.path),
                )
                .header("Origin", &served.origin);
            if transition.credential == "original" {
                request = request.header("Cookie", format!("pp_session={token}"));
            }
            let before = StateGraph::capture(sandbox.path()).unwrap();
            let actual = Exchange::observe(request.send().await.unwrap())
                .await
                .unwrap();
            let after = StateGraph::capture(sandbox.path()).unwrap();
            let expected = &transition.expected;
            assert_eq!(
                expected.clearing_cookies,
                transition
                    .node_set_cookie
                    .iter()
                    .map(|header| clearing_cookie(header))
                    .collect::<Vec<_>>(),
                "{} clearing cookies",
                transition.name
            );
            let node = Exchange {
                status: expected.status,
                body: expected.body.clone(),
                set_cookie: transition.node_set_cookie.clone(),
            };
            ledger
                .compare(&transition.name, &node, &actual)
                .unwrap_or_else(|error| panic!("{error}"));
            assert_eq!(
                after.rows(SESSIONS),
                Some(expected.session_rows),
                "{} session rows",
                transition.name
            );
            // Node's only recorded state is the session row count; Rust may
            // change the sessions table when, and only when, that count moves.
            let moved: Vec<String> = if expected.session_rows == node_rows {
                vec![]
            } else {
                vec![SESSIONS.into()]
            };
            assert_eq!(before.changed(&after), moved, "{} state", transition.name);
            node_rows = expected.session_rows;
        }
        rust.stop().await;
        let report = ledger.finish().unwrap();
        print_report("auth-session", &report);
        assert_eq!(report.matched, 4);
        assert_eq!(report.corrected.len(), 3);
    }

    #[test]
    fn ledger_rejects_drift_stale_unused_and_duplicate_corrections() {
        let fixture = login_fixture();
        let node = |id: &str| {
            fixture
                .cases
                .iter()
                .find(|case| case.id == id)
                .unwrap()
                .node
                .clone()
        };
        let corrected = login_corrections().remove(0).rust;
        let unknown = node("unknown-account");

        let mut changed = unknown.clone();
        changed.status += 1;
        let mut ledger = Ledger::new(login_corrections()).unwrap();
        assert!(matches!(
            ledger.compare("unknown-account", &unknown, &changed),
            Err(ParityError::Mismatch { .. })
        ));
        let mut cookie = unknown.clone();
        cookie.set_cookie.push("pp_session=unexpected".into());
        assert!(matches!(
            ledger.compare("bad-password", &node("bad-password"), &cookie),
            Err(ParityError::Mismatch { .. })
        ));
        assert_eq!(
            ledger.compare("array-body", &node("array-body"), &node("array-body")),
            Err(ParityError::StaleCorrection("array-body".into()))
        );
        let mut drifted = corrected.clone();
        drifted.body = json!({"detail": "Invalid body"});
        assert!(matches!(
            ledger.compare("null-body", &node("null-body"), &drifted),
            Err(ParityError::Mismatch { .. })
        ));
        assert_eq!(
            ledger.compare("null-body", &node("null-body"), &corrected),
            Err(ParityError::DuplicateCase("null-body".into()))
        );
        assert_eq!(
            ledger.finish(),
            Err(ParityError::UnusedCorrections(vec![
                "malformed-json".into()
            ]))
        );

        assert_eq!(
            Ledger::new(vec![]).unwrap().finish(),
            Err(ParityError::NoCases)
        );
        let mut twice = login_corrections();
        twice.push(login_corrections().remove(0));
        assert!(matches!(
            Ledger::new(twice),
            Err(ParityError::DuplicateCorrection(case)) if case == "array-body"
        ));

        let mut ledger = Ledger::new(login_corrections()).unwrap();
        ledger
            .compare("unknown-account", &unknown, &unknown)
            .unwrap();
        for id in ["array-body", "null-body", "malformed-json"] {
            ledger.compare(id, &node(id), &corrected).unwrap();
        }
        let report = ledger.finish().unwrap();
        assert_eq!(report.matched, 1);
        assert_eq!(
            report.corrected,
            ["array-body", "null-body", "malformed-json"]
                .map(|id| (id.to_owned(), CorrectionKind::Security))
        );
    }

    #[test]
    fn state_graph_detects_row_file_and_nested_database_changes() {
        let sandbox = Sandbox::new("t10-graph").unwrap();
        let path = sandbox.path().to_path_buf();
        let db = rusqlite::Connection::open(path.join("print-partner.db")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE t(a INTEGER, b TEXT, c BLOB); INSERT INTO t VALUES(1,'x',x'00ff'),(2,NULL,NULL);",
        )
        .unwrap();
        std::fs::create_dir(path.join("nested")).unwrap();
        std::fs::write(path.join("nested/file.txt"), "one").unwrap();
        let initial = StateGraph::capture(&path).unwrap();
        assert_eq!(initial.rows("print-partner.db/t"), Some(2));
        assert_eq!(initial.rows("print-partner.db/missing"), None);
        assert_eq!(StateGraph::capture(&path).unwrap(), initial);

        db.execute("UPDATE t SET b='y' WHERE a=1", []).unwrap();
        let updated = StateGraph::capture(&path).unwrap();
        assert_eq!(updated.rows("print-partner.db/t"), Some(2));
        assert_eq!(initial.changed(&updated), ["print-partner.db/t"]);

        // Distinct invalid UTF-8 text must not collapse to the same cell.
        db.execute("UPDATE t SET b=CAST(x'ff' AS TEXT) WHERE a=1", [])
            .unwrap();
        let invalid = StateGraph::capture(&path).unwrap();
        db.execute("UPDATE t SET b=CAST(x'fe' AS TEXT) WHERE a=1", [])
            .unwrap();
        assert_eq!(
            invalid.changed(&StateGraph::capture(&path).unwrap()),
            ["print-partner.db/t"]
        );
        db.execute("UPDATE t SET b='y' WHERE a=1", []).unwrap();

        std::fs::write(path.join("nested/file.txt"), "two").unwrap();
        std::fs::write(path.join("added.json"), "{}").unwrap();
        let other = rusqlite::Connection::open(path.join("nested/other.db")).unwrap();
        other.execute_batch("CREATE TABLE u(v INTEGER);").unwrap();
        drop(other);
        let changed = StateGraph::capture(&path).unwrap();
        assert_eq!(
            updated.changed(&changed),
            ["added.json", "nested/file.txt", "nested/other.db/u"]
        );
        drop(db);

        let gone = path.clone();
        drop(sandbox);
        assert!(!gone.exists());
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct JobsFixture {
        generated: String,
        sources: Vec<String>,
        cases: Vec<JobsCase>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct JobsCase {
        id: String,
        path: String,
        node: Exchange,
    }

    fn jobs_fixture() -> JobsFixture {
        let fixture: JobsFixture = serde_json::from_str(include_str!(
            "../../../../fixtures/parity/jobs-http/node.json"
        ))
        .unwrap();
        assert!(fixture.generated.contains("jobs-http/generate.mjs"));
        assert_eq!(fixture.sources.len(), 3);
        assert_eq!(fixture.cases.len(), 13);
        fixture
    }

    /// The durable job snapshot differences documented in docs/desktop-rebuild.md
    /// (GRE-609): every snapshot adds `created_at`, and a failed job keeps its
    /// last progress (none here) and reports "Job failed" instead of the
    /// handler's error, which Node holds only in memory.
    fn durable_snapshot(node: &Value) -> Value {
        let mut rust = node.clone();
        let created = match node["job_id"].as_str().unwrap() {
            "job-1" => "created-1",
            "job-2" => "created-2",
            other => panic!("unexpected job label {other}"),
        };
        rust["created_at"] = json!(created);
        if node["status"] == "error" {
            rust["message"] = json!("Job failed");
            rust["error"] = json!("Job failed");
            rust["progress"] = Value::Null;
        }
        rust
    }

    /// One declared correction for each Node response that carries a job.
    fn jobs_corrections(fixture: &JobsFixture) -> Vec<Correction> {
        fixture
            .cases
            .iter()
            .filter(|case| case.node.status == 200)
            .filter_map(|case| {
                let body = &case.node.body;
                let rust = match body.get("jobs") {
                    Some(Value::Array(jobs)) if jobs.is_empty() => return None,
                    Some(Value::Array(jobs)) => {
                        json!({"jobs": jobs.iter().map(durable_snapshot).collect::<Vec<_>>()})
                    }
                    _ => durable_snapshot(body),
                };
                Some(Correction {
                    case: case.id.clone().leak(),
                    kind: CorrectionKind::Durable,
                    reason: "durable snapshots add created_at and report a generic failure",
                    rust: Exchange {
                        status: 200,
                        body: rust,
                        set_cookie: vec![],
                    },
                })
            })
            .collect()
    }

    /// Seeds the two retained jobs Node's generator runs, in the same order:
    /// a finished update check, then (a second later) a failed checklist export.
    /// Returns the session cookie and the two job ids.
    async fn seed_jobs(owner: &WriterOwner) -> (String, String, String) {
        use pp_storage::{
            auth::Secret,
            jobs::{
                CompletedResult, Credential, JobKind, Outcome, Payload, SourceUpdatesResult,
                UserOperation, WorkerAdmission, WorkerOperation,
            },
        };
        use std::{sync::atomic::AtomicBool, time::Duration};

        let policy = AuthPolicy {
            registration: RegistrationPolicy::Open,
            first_user: FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::AccountTenant,
        };
        let auth = owner.auth_with_policy(policy).unwrap();
        let served = Served::start(|origin| {
            auth_router(
                AuthHttpConfig::new(origin, CookieTransport::LoopbackHttp, false, None, false)
                    .unwrap(),
                auth,
                ProviderClient::new(None, None).unwrap(),
                ResetMailer::disabled(),
            )
        })
        .await
        .unwrap();
        let registered = served
            .client
            .post(format!("{}/auth/register", served.origin))
            .header("Origin", &served.origin)
            .json(&json!({"email": "jobs-http@example.test", "password": "password-1234"}))
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
        served.stop().await.unwrap();
        let token = cookie.strip_prefix("pp_session=").unwrap().to_owned();

        let jobs = owner.jobs(policy).unwrap();
        let enqueue = |key: &str, payload: Payload| match jobs
            .submit(
                Credential::Session(Secret::new(token.clone())),
                UserOperation::Enqueue {
                    key: key.into(),
                    payload_version: 1,
                    payload,
                },
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
            .unwrap()
            .receive()
            .unwrap()
        {
            Outcome::Job(job, _) => job.job_id,
            _ => panic!("enqueued job expected"),
        };
        let worker = owner
            .job_worker_with_policy(
                policy,
                WorkerAdmission {
                    kinds: vec![
                        (JobKind::CheckSourceUpdates, 1),
                        (JobKind::ExportChecklistHtml, 1),
                    ],
                    total: 2,
                    per_resource: 1,
                    lease_seconds: 60,
                },
            )
            .unwrap();
        let done = enqueue("check", Payload::CheckSourceUpdates {});
        let mut lease = worker.claim().unwrap().unwrap().lease;
        assert_eq!(lease.job_id(), done);
        worker
            .update(
                &mut lease,
                WorkerOperation::FinishPublic {
                    artifact: None,
                    result: Box::new(CompletedResult::SourceUpdates(SourceUpdatesResult {
                        checked: vec![],
                        skipped: vec![],
                        updates_available: 0,
                        checked_count: 0,
                    })),
                },
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let failed = enqueue("export", Payload::ExportChecklistHtml { profile_id: 7 });
        let mut lease = worker.claim().unwrap().unwrap().lease;
        assert_eq!(lease.job_id(), failed);
        worker.update(&mut lease, WorkerOperation::Fail).unwrap();
        (cookie, done.to_string(), failed.to_string())
    }

    #[tokio::test]
    async fn jobs_flat_and_v1_reads_match_node_and_write_nothing() {
        use pp_api::{
            fixtures::Labels,
            jobs::{JobsHttpConfig, jobs_router},
        };

        let fixture = jobs_fixture();
        let sandbox = Sandbox::new("t10-jobs").unwrap();
        let owner = WriterOwner::open(sandbox.path(), Limits::default())
            .unwrap()
            .0;
        let (cookie, done, failed) = seed_jobs(&owner).await;
        let jobs = owner
            .jobs(AuthPolicy {
                registration: RegistrationPolicy::Open,
                first_user: FirstUserTenant::NewUser,
                session_tenant: SessionTenantPolicy::AccountTenant,
            })
            .unwrap();
        let served = Served::start(|origin| {
            jobs_router(
                JobsHttpConfig::from_startup(origin, "default", Some("1")).unwrap(),
                jobs,
            )
        })
        .await
        .unwrap();
        let mut labels = Labels::new(vec![
            ("job", &["job_id"]),
            // Rust's `created_at` has no Node counterpart; its own prefix keeps
            // the shared time labels independent of whole-second clock ticks.
            ("created", &["created_at"]),
            ("time", &["started_at", "finished_at", "updated_at"]),
        ]);
        let mut ledger = Ledger::new(jobs_corrections(&fixture)).unwrap();
        let before = StateGraph::capture(sandbox.path()).unwrap();
        for case in &fixture.cases {
            let path = case
                .path
                .replace("{done}", &done)
                .replace("{failed}", &failed);
            let mut actual = Exchange::observe(
                served
                    .client
                    .get(format!("{}{path}", served.origin))
                    .header("Origin", &served.origin)
                    .header("Cookie", &cookie)
                    .send()
                    .await
                    .unwrap(),
            )
            .await
            .unwrap();
            labels.scrub(&mut actual);
            ledger
                .compare(&case.id, &case.node, &actual)
                .unwrap_or_else(|error| panic!("{error}"));
        }
        let after = StateGraph::capture(sandbox.path()).unwrap();
        served.stop().await.unwrap();
        owner.shutdown().unwrap();
        assert_eq!(
            before.changed(&after),
            Vec::<String>::new(),
            "job reads wrote state"
        );
        let report = ledger.finish().unwrap();
        print_report("jobs-http", &report);
        assert_eq!(report.matched, 5);
        assert_eq!(report.corrected.len(), 8);
    }

    #[test]
    fn labels_keep_equality_links_and_catch_swapped_ids() {
        use pp_api::fixtures::Labels;
        let exchange = |body: Value| Exchange {
            status: 200,
            body,
            set_cookie: vec![],
        };
        let rules = || Labels::new(vec![("job", &["job_id"]), ("time", &["finished_at"])]);
        let node = exchange(json!({"jobs": [
            {"job_id": "job-1", "finished_at": "time-1"},
            {"job_id": "job-2", "finished_at": "time-1"},
        ]}));
        let mut labels = rules();
        let mut rust = exchange(json!({"jobs": [
            {"job_id": "a", "finished_at": "2026-01-01T00:00:00.000Z"},
            {"job_id": "b", "finished_at": "2026-01-01T00:00:00.000Z"},
        ]}));
        labels.scrub(&mut rust);
        assert_eq!(rust, node);
        // A repeated id where Node had two jobs no longer compares equal.
        let mut labels = rules();
        let mut collapsed = exchange(json!({"jobs": [
            {"job_id": "a", "finished_at": "2026-01-01T00:00:00.000Z"},
            {"job_id": "a", "finished_at": "2026-01-01T00:00:00.000Z"},
        ]}));
        labels.scrub(&mut collapsed);
        let mut ledger = Ledger::new(vec![]).unwrap();
        assert!(matches!(
            ledger.compare("collapsed", &node, &collapsed),
            Err(ParityError::Mismatch { .. })
        ));
    }
}
