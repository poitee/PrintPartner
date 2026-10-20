use anyhow::{Context, Result, ensure};
use pp_api::auth::{
    AuthHttpConfig, CookieTransport, ProviderClient, ResetMailer, SmtpConfig, SmtpSecurity,
    auth_router,
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
};
use rusqlite::{Connection, types::ValueRef};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::oneshot,
    task::{JoinHandle, JoinSet},
    time::{Instant, timeout, timeout_at},
};

#[path = "../../pp-storage/tests/common/process.rs"]
mod child_process;
const FIXTURE: &str = include_str!("../../../../fixtures/parity/auth-admission/node.json");
const EMAIL: &str = "admission@example.test";
const REGISTER: &str = r#"{"email":"admission@example.test","password":"fixture-admission-password","display_name":"Admission"}"#;
const FORGOT: &str = r#"{"email":"admission@example.test"}"#;
const TABLES: [&str; 4] = [
    "users",
    "sessions",
    "password_reset_tokens",
    "auth_identities",
];
const FORGOT_SUCCESS: &str =
    r#"{"ok":true,"message":"If an account exists for that email, a reset link was sent."}"#;
const ORIGIN_ERROR: &str = r#"{"detail":"Invalid request origin"}"#;
const HOST_ERROR: &str = r#"{"detail":"Invalid request host"}"#;
const JSON_ERROR: &str = r#"{"detail":"Invalid JSON body"}"#;
const NODE_JSON_ERROR: &str = r#"{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY","error":"Bad Request","message":"Body is not valid JSON but content-type is set to 'application/json'"}"#;
const NODE_SIZE_ERROR: &str = r#"{"statusCode":413,"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}"#;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Route {
    Register,
    Forgot,
}
impl Route {
    fn name(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::Forgot => "forgot",
        }
    }
    fn path(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::Forgot => "forgot-password",
        }
    }
}
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Authority {
    Listener,
    Foreign,
    Absent,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum BodyRecipe {
    Valid,
    ExactBytes { bytes: usize },
    Raw { text: String },
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Rows {
    users: i64,
    sessions: i64,
    reset_tokens: i64,
    identities: i64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Reply {
    status: u16,
    public_error: Option<Value>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    status: u16,
    public_error: Option<Value>,
    rows: Rows,
    mail_connections: u32,
    session_issued: bool,
}
impl Observation {
    fn reply(&self) -> Reply {
        Reply {
            status: self.status,
            public_error: self.public_error.clone(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    route: Route,
    origin: Authority,
    host: Authority,
    content_type: String,
    body: BodyRecipe,
    body_len: usize,
    body_sha256: String,
    node: Observation,
}
impl Case {
    fn body(&self) -> Vec<u8> {
        let base = match self.route {
            Route::Register => REGISTER,
            Route::Forgot => FORGOT,
        };
        match &self.body {
            BodyRecipe::Valid => base.as_bytes().to_vec(),
            BodyRecipe::Raw { text } => text.as_bytes().to_vec(),
            BodyRecipe::ExactBytes { bytes } => {
                assert!(*bytes >= base.len());
                let mut result = base.as_bytes()[..base.len() - 1].to_vec();
                result.resize(bytes - 1, b' ');
                result.push(b'}');
                result
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    version: u8,
    cors_origin: bool,
    cases: Vec<Case>,
}
#[derive(Clone, Copy)]
enum Kind {
    SecurityCorrection,
    ErrorMapping,
}
struct Lit {
    status: u16,
    error: Option<&'static str>,
}
impl Lit {
    fn reply(&self) -> Reply {
        Reply {
            status: self.status,
            public_error: self.error.map(|text| serde_json::from_str(text).unwrap()),
        }
    }
}
struct Difference {
    id: &'static str,
    kind: Kind,
    node: Lit,
    rust: Lit,
    reason: &'static str,
}
macro_rules! difference {
    ($id:literal, $kind:ident, $ns:literal, $ne:expr, $rs:literal, $re:expr, $reason:literal) => {
        Difference {
            id: $id,
            kind: Kind::$kind,
            node: Lit {
                status: $ns,
                error: $ne,
            },
            rust: Lit {
                status: $rs,
                error: $re,
            },
            reason: $reason,
        }
    };
}
const DIFFERENCES: &[Difference] = &[
    difference!(
        "register/foreign-origin",
        SecurityCorrection,
        200,
        None,
        403,
        Some(ORIGIN_ERROR),
        "Reject foreign Origin before registration"
    ),
    difference!(
        "register/missing-origin",
        SecurityCorrection,
        200,
        None,
        403,
        Some(ORIGIN_ERROR),
        "Require Origin before registration"
    ),
    difference!(
        "register/foreign-host",
        SecurityCorrection,
        200,
        None,
        403,
        Some(HOST_ERROR),
        "Reject foreign Host before registration"
    ),
    difference!(
        "forgot/foreign-origin",
        SecurityCorrection,
        200,
        None,
        403,
        Some(ORIGIN_ERROR),
        "Reject foreign Origin before reset-token issuance"
    ),
    difference!(
        "forgot/missing-origin",
        SecurityCorrection,
        200,
        None,
        403,
        Some(ORIGIN_ERROR),
        "Require Origin before reset-token issuance"
    ),
    difference!(
        "forgot/foreign-host",
        SecurityCorrection,
        200,
        None,
        403,
        Some(HOST_ERROR),
        "Reject foreign Host before reset-token issuance"
    ),
    difference!(
        "forgot/over-16384",
        SecurityCorrection,
        200,
        None,
        400,
        Some(JSON_ERROR),
        "Bound reset bodies to 16 KiB"
    ),
    difference!(
        "forgot/over-1048576",
        ErrorMapping,
        413,
        Some(NODE_SIZE_ERROR),
        400,
        Some(JSON_ERROR),
        "Both refuse oversized JSON with different public errors"
    ),
    difference!(
        "forgot/malformed",
        ErrorMapping,
        400,
        Some(NODE_JSON_ERROR),
        400,
        Some(JSON_ERROR),
        "Both refuse malformed JSON with different public errors"
    ),
    difference!(
        "forgot/text-plain",
        ErrorMapping,
        400,
        Some(r#"{"detail":"Valid email is required"}"#),
        400,
        Some(JSON_ERROR),
        "Both refuse text/plain with different public errors"
    ),
    difference!(
        "forgot/foreign-origin-over-1048576",
        ErrorMapping,
        413,
        Some(NODE_SIZE_ERROR),
        403,
        Some(ORIGIN_ERROR),
        "Rust checks Origin before reading an oversized body"
    ),
];
fn fixture() -> Fixture {
    let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(fixture.version, 1);
    assert!(fixture.cors_origin);
    let suffixes = [
        "control",
        "foreign-origin",
        "missing-origin",
        "foreign-host",
        "at-16384",
        "over-16384",
        "over-1048576",
        "malformed",
        "text-plain",
        "foreign-origin-over-1048576",
    ];
    let mut expected = HashSet::new();
    for route in [Route::Register, Route::Forgot] {
        for suffix in &suffixes[..if route == Route::Register {
            4
        } else {
            suffixes.len()
        }] {
            expected.insert(format!("{}/{suffix}", route.name()));
        }
    }
    for case in &fixture.cases {
        assert!(
            expected.remove(&case.id),
            "duplicate or unknown case {}",
            case.id
        );
        let suffix = case
            .id
            .strip_prefix(&format!("{}/", case.route.name()))
            .unwrap();
        assert_eq!(
            case.origin,
            if suffix.starts_with("foreign-origin") {
                Authority::Foreign
            } else if suffix == "missing-origin" {
                Authority::Absent
            } else {
                Authority::Listener
            }
        );
        assert_eq!(
            case.host,
            if suffix == "foreign-host" {
                Authority::Foreign
            } else {
                Authority::Listener
            }
        );
        assert_eq!(
            case.content_type,
            if suffix == "text-plain" {
                "text/plain"
            } else {
                "application/json"
            }
        );
        match (&case.body, suffix) {
            (BodyRecipe::ExactBytes { bytes: 16384 }, "at-16384")
            | (BodyRecipe::ExactBytes { bytes: 16385 }, "over-16384")
            | (
                BodyRecipe::ExactBytes { bytes: 1048577 },
                "over-1048576" | "foreign-origin-over-1048576",
            ) => {}
            (BodyRecipe::Raw { text }, "malformed") => assert_eq!(text, "{\"email\":"),
            (
                BodyRecipe::Valid,
                "control" | "foreign-origin" | "missing-origin" | "foreign-host" | "text-plain",
            ) => {}
            _ => panic!("wrong body recipe for {}", case.id),
        }
        let admitted = case.node.status < 400;
        let rows = if !admitted {
            Rows::default()
        } else {
            match case.route {
                Route::Register => Rows {
                    users: 1,
                    sessions: 1,
                    ..Rows::default()
                },
                Route::Forgot => Rows {
                    reset_tokens: 1,
                    ..Rows::default()
                },
            }
        };
        assert_eq!(case.node.rows, rows, "{}: Node work", case.id);
        assert_eq!(
            case.node.mail_connections,
            u32::from(admitted && case.route == Route::Forgot)
        );
        assert_eq!(
            case.node.session_issued,
            admitted && case.route == Route::Register
        );
        assert_eq!(case.node.public_error.is_none(), admitted);
        let body = case.body();
        assert_eq!(case.body_len, body.len());
        assert_eq!(case.body_sha256, hex::encode(Sha256::digest(&body)));
    }
    assert!(expected.is_empty(), "missing cases {expected:?}");
    let mut used = HashSet::new();
    for diff in DIFFERENCES {
        assert!(used.insert(diff.id), "duplicate difference");
        let case = fixture
            .cases
            .iter()
            .find(|case| case.id == diff.id)
            .expect("unused difference");
        assert!(!diff.reason.is_empty());
        assert_eq!(
            case.node.reply(),
            diff.node.reply(),
            "{}: literal Node contract",
            diff.id
        );
        assert_ne!(diff.node.reply(), diff.rust.reply(), "equal difference");
        match diff.kind {
            Kind::SecurityCorrection => {
                assert!(diff.node.status < 400 && diff.rust.status >= 400);
                assert_ne!(case.node.rows, Rows::default());
            }
            Kind::ErrorMapping => assert!(diff.node.status >= 400 && diff.rust.status >= 400),
        }
    }
    fixture
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot(BTreeMap<String, Vec<Vec<Value>>>);
impl Snapshot {
    fn read(db: &Connection) -> Result<Self> {
        let mut tables = TABLES.to_vec();
        if db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='sqlite_sequence'",
            [],
            |row| row.get::<_, i64>(0),
        )? != 0
        {
            tables.push("sqlite_sequence");
        }
        let mut result = BTreeMap::new();
        for table in tables {
            let mut statement = db.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|i| {
                            Ok(match row.get_ref(i)? {
                                ValueRef::Null => Value::Null,
                                ValueRef::Integer(n) => json!(n),
                                ValueRef::Real(n) => json!(n),
                                ValueRef::Text(bytes) => json!(String::from_utf8_lossy(bytes)),
                                ValueRef::Blob(bytes) => json!({"blob":hex::encode(bytes)}),
                            })
                        })
                        .collect::<rusqlite::Result<Vec<_>>>()
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            result.insert(table.to_owned(), rows);
        }
        Ok(Self(result))
    }
    fn delta(&self, before: &Self) -> Rows {
        let count = |table: &str| self.0[table].len() as i64 - before.0[table].len() as i64;
        Rows {
            users: count("users"),
            sessions: count("sessions"),
            reset_tokens: count("password_reset_tokens"),
            identities: count("auth_identities"),
        }
    }
}
struct Scratch(Option<PathBuf>);
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}
struct Server {
    directory: PathBuf,
    owner: Option<WriterOwner>,
    db: Option<Connection>,
    origin: String,
    client: reqwest::Client,
    mailer: ResetMailer,
    connections: Arc<AtomicU32>,
    http: Option<JoinHandle<std::io::Result<()>>>,
    stop_http: Option<oneshot::Sender<()>>,
    smtp: Option<JoinHandle<Result<()>>>,
    stop_smtp: Option<oneshot::Sender<()>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(task) = self.http.take() {
            task.abort();
        }
        if let Some(task) = self.smtp.take() {
            task.abort();
        }
        drop(self.db.take());
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
impl Server {
    async fn start() -> Result<Self> {
        let mut random = [0; 12];
        getrandom::fill(&mut random)?;
        let directory =
            std::env::temp_dir().join(format!("pp-auth-admission-{}", hex::encode(random)));
        let mut scratch = Scratch(Some(directory.clone()));
        let owner = WriterOwner::open(&directory, Limits::default())?.0;
        let policy = AuthPolicy {
            registration: RegistrationPolicy::Open,
            first_user: FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::AccountTenant,
        };
        #[cfg(feature = "desktop_rebuild")]
        let auth = owner.rebuild_auth_with_policy(policy, Default::default())?;
        #[cfg(not(feature = "desktop_rebuild"))]
        let auth = owner.auth_with_policy(policy)?;
        let smtp = TcpListener::bind("127.0.0.1:0").await?;
        let mailer = ResetMailer::smtp(SmtpConfig {
            security: SmtpSecurity::StartTls,
            host: "127.0.0.1".into(),
            port: smtp.local_addr()?.port(),
            from: "fixture@example.test".into(),
            credentials: None,
        })?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let router = auth_router(
            AuthHttpConfig::new(
                &origin,
                CookieTransport::LoopbackHttp,
                true,
                Some("https://admission.example.test"),
                false,
            )?,
            auth,
            ProviderClient::new(None, None)?,
            mailer.clone(),
        );
        let db = Connection::open(directory.join("print-partner.db"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        let (stop_http, rx) = oneshot::channel();
        let http = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
        });
        let connections = Arc::new(AtomicU32::new(0));
        let counter = connections.clone();
        let (stop_smtp, mut rx) = oneshot::channel();
        let smtp = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = smtp.accept() => {
                        let (stream, _) = accepted?;
                        counter.fetch_add(1, Ordering::SeqCst);
                        clients.spawn(async move {
                            let mut stream = BufReader::new(stream);
                            stream.get_mut().write_all(b"220 fixture ESMTP\r\n").await?;
                            let mut line = String::new();
                            while stream.read_line(&mut line).await? != 0 {
                                stream.get_mut().write_all(b"250 fixture\r\n").await?;
                                line.clear();
                            }
                            Ok::<_, std::io::Error>(())
                        });
                    }
                }
            }
            clients.abort_all();
            while clients.join_next().await.is_some() {}
            Ok(())
        });
        scratch.0.take();
        Ok(Self {
            directory,
            owner: Some(owner),
            db: Some(db),
            origin,
            client,
            mailer,
            connections,
            http: Some(http),
            stop_http: Some(stop_http),
            smtp: Some(smtp),
            stop_smtp: Some(stop_smtp),
        })
    }
    async fn post(&self, case: &Case) -> Result<(Reply, Value, bool)> {
        let mut request = self
            .client
            .post(format!("{}/auth/{}", self.origin, case.route.path()))
            .header(
                "Host",
                if case.host == Authority::Foreign {
                    "evil.example"
                } else {
                    self.origin.strip_prefix("http://").unwrap()
                },
            )
            .header("Content-Type", &case.content_type)
            .header("Connection", "close")
            .body(case.body());
        match case.origin {
            Authority::Listener => request = request.header("Origin", &self.origin),
            Authority::Foreign => request = request.header("Origin", "http://evil.example"),
            Authority::Absent => {}
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        let cookie = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .any(|value| {
                value.to_str().is_ok_and(|value| {
                    value.starts_with("pp_session=") && !value.starts_with("pp_session=;")
                })
            });
        let body: Value = response.json().await?;
        Ok((
            Reply {
                status,
                public_error: (status >= 400).then(|| body.clone()),
            },
            body,
            cookie,
        ))
    }
    async fn close(&mut self, deadline: Instant) -> (Result<Snapshot>, Vec<String>) {
        let mut errors = Vec::new();
        if let Some(stop) = self.stop_http.take() {
            let _ = stop.send(());
        }
        if let Some(mut task) = self.http.take() {
            match timeout_at(
                deadline.min(Instant::now() + Duration::from_secs(10)),
                &mut task,
            )
            .await
            {
                Ok(Ok(Ok(()))) => {}
                other => {
                    errors.push(format!("HTTP stop: {other:?}"));
                    task.abort();
                    let _ = task.await;
                }
            }
        }
        if timeout_at(
            deadline.min(Instant::now() + Duration::from_secs(25)),
            self.mailer.drain_deliveries(),
        )
        .await
        .is_err()
        {
            errors.push("mail drain timed out".into());
        }
        if let Some(stop) = self.stop_smtp.take() {
            let _ = stop.send(());
        }
        if let Some(mut task) = self.smtp.take() {
            match timeout_at(
                deadline.min(Instant::now() + Duration::from_secs(5)),
                &mut task,
            )
            .await
            {
                Ok(Ok(Ok(()))) => {}
                other => {
                    errors.push(format!("SMTP stop: {other:?}"));
                    task.abort();
                    let _ = task.await;
                }
            }
        }
        if let Some(owner) = self.owner.take()
            && let Err(error) = owner.shutdown()
        {
            errors.push(format!("owner shutdown: {error}"));
        }
        let snapshot = Snapshot::read(self.db.as_ref().unwrap());
        drop(self.db.take());
        if let Err(error) = std::fs::remove_dir_all(&self.directory) {
            errors.push(format!("remove directory: {error}"));
        }
        if self.directory.exists() {
            errors.push("directory remains".into());
        }
        (snapshot, errors)
    }
}
struct Evidence {
    observation: Observation,
    before: Snapshot,
    after: Snapshot,
    body: Value,
    mail_failures: u64,
    cleanup_errors: Vec<String>,
}
async fn observe(case: &Case, seed: &Case) -> Result<Evidence> {
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut server = timeout(Duration::from_secs(10), Server::start())
        .await
        .context("case setup lifetime")??;
    let result = timeout_at(deadline, async {
        if case.route == Route::Forgot {
            let (reply, _, cookie) = server.post(seed).await?;
            ensure!(
                reply.status == 200 && cookie,
                "seed registration failed: {reply:?}"
            );
        }
        let before = Snapshot::read(server.db.as_ref().unwrap())?;
        let (reply, body, session_issued) = server.post(case).await?;
        Ok::<_, anyhow::Error>((before, reply, body, session_issued))
    })
    .await
    .context("case request lifetime")
    .and_then(|result| result);
    let (after, mut cleanup_errors) = server.close(deadline).await;
    let (before, reply, body, session_issued) = match result {
        Ok(value) => value,
        Err(error) => {
            eprintln!("cleanup after request failure: {cleanup_errors:?}; snapshot: {after:?}");
            return Err(error);
        }
    };
    let after = after.with_context(|| {
        format!("settled snapshot failed after {reply:?}; cleanup {cleanup_errors:?}")
    })?;
    if Instant::now() > deadline {
        cleanup_errors.push("case exceeded 45 seconds".into());
    }
    Ok(Evidence {
        observation: Observation {
            status: reply.status,
            public_error: reply.public_error,
            rows: after.delta(&before),
            mail_connections: server.connections.load(Ordering::SeqCst),
            session_issued,
        },
        before,
        after,
        body,
        mail_failures: server.mailer.delivery_failure_count(),
        cleanup_errors,
    })
}
fn validate(case: &Case, evidence: &Evidence) -> Result<()> {
    let actual = &evidence.observation;
    let expected = DIFFERENCES
        .iter()
        .find(|diff| diff.id == case.id)
        .map_or_else(|| case.node.reply(), |diff| diff.rust.reply());
    if actual.status >= 400 {
        ensure!(
            evidence.before == evidence.after,
            "refusal changed full auth snapshot"
        );
        ensure!(actual.rows == Rows::default(), "refusal row delta");
        ensure!(
            actual.mail_connections == 0 && evidence.mail_failures == 0,
            "refusal mail traffic"
        );
        ensure!(!actual.session_issued, "refusal issued session");
    } else {
        let expected_rows = match case.route {
            Route::Register => Rows {
                users: 1,
                sessions: 1,
                ..Rows::default()
            },
            Route::Forgot => Rows {
                reset_tokens: 1,
                ..Rows::default()
            },
        };
        ensure!(actual.rows == expected_rows, "productive row delta");
        match case.route {
            Route::Register => {
                ensure!(
                    actual.session_issued
                        && actual.mail_connections == 0
                        && evidence.mail_failures == 0,
                    "register cookie/mail"
                );
                ensure!(
                    evidence.body["user"]["email"] == EMAIL
                        && evidence.body["user"]["display_name"] == "Admission",
                    "register success fields"
                );
                let id = evidence.body["user"]["user_id"]
                    .as_str()
                    .context("response user id")?;
                ensure!(
                    evidence.after.0["users"]
                        .iter()
                        .any(|row| row.iter().any(|v| v == id)),
                    "response user persisted"
                );
            }
            Route::Forgot => {
                ensure!(
                    !actual.session_issued
                        && actual.mail_connections >= 1
                        && evidence.mail_failures == 1,
                    "reset must attempt SMTP and fail STARTTLS"
                );
                ensure!(
                    evidence.body == serde_json::from_str::<Value>(FORGOT_SUCCESS)?,
                    "forgot success fields"
                );
            }
        }
    }
    ensure!(
        actual.reply() == expected,
        "reply mismatch, expected {expected:?}"
    );
    ensure!(
        evidence.cleanup_errors.is_empty(),
        "cleanup: {:?}",
        evidence.cleanup_errors
    );
    Ok(())
}
async fn compare(route: Route) {
    let fixture = fixture();
    let seed = fixture
        .cases
        .iter()
        .find(|case| case.id == "register/control")
        .unwrap();
    for case in fixture.cases.iter().filter(|case| case.route == route) {
        let evidence = observe(case, seed)
            .await
            .unwrap_or_else(|error| panic!("{}: {error:#}", case.id));
        eprintln!(
            "{} observed {:?}, mail failures {}",
            case.id, evidence.observation, evidence.mail_failures
        );
        validate(case, &evidence).unwrap_or_else(|error| {
            panic!(
                "{}: {error:#}; actual {:?}; cleanup {:?}",
                case.id, evidence.observation, evidence.cleanup_errors
            )
        });
    }
}
#[tokio::test]
async fn register_auth_admission_parity() {
    compare(Route::Register).await;
}
#[tokio::test]
async fn forgot_auth_admission_parity() {
    compare(Route::Forgot).await;
}
#[test]
fn node_auth_admission_snapshot_is_current() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = std::env::var_os("PP_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = child_process::command(node)
        .current_dir(root)
        .args([
            "--conditions=development",
            "fixtures/parity/auth-admission/generate.mjs",
            "--check",
            // The auth-admission-freshness workflow owns the canonical Node 22.23.3 gate.
            "--additional-runtime",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "Node freshness failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("auth admission: 14 real-listener cases passed on "));
}
#[test]
fn comparator_rejects_response_and_work_changes() {
    let fixture = fixture();
    let case = fixture
        .cases
        .iter()
        .find(|case| case.id == "register/foreign-host")
        .unwrap();
    let empty = || {
        Snapshot(
            TABLES
                .into_iter()
                .map(|table| (table.into(), Vec::new()))
                .collect(),
        )
    };
    let baseline = || Evidence {
        observation: Observation {
            status: 403,
            public_error: Some(json!({"detail":"Invalid request host"})),
            rows: Rows::default(),
            mail_connections: 0,
            session_issued: false,
        },
        before: empty(),
        after: empty(),
        body: json!({"detail":"Invalid request host"}),
        mail_failures: 0,
        cleanup_errors: Vec::new(),
    };
    assert!(validate(case, &baseline()).is_ok());
    for mutation in 0..10 {
        let mut evidence = baseline();
        match mutation {
            0 => evidence.observation.status = 400,
            1 => evidence.observation.public_error = Some(json!({"detail":"changed"})),
            2 => evidence.observation.rows.users = 1,
            3 => evidence.observation.rows.sessions = 1,
            4 => evidence.observation.rows.reset_tokens = 1,
            5 => evidence.observation.rows.identities = 1,
            6 => evidence.observation.mail_connections = 1,
            7 => evidence.mail_failures = 1,
            8 => evidence.observation.session_issued = true,
            9 => {
                evidence
                    .after
                    .0
                    .get_mut("users")
                    .unwrap()
                    .push(vec![json!("changed")]);
            }
            _ => unreachable!(),
        }
        assert!(
            validate(case, &evidence).is_err(),
            "accepted mutation {mutation}"
        );
    }
}
