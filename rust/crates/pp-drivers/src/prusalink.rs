//! PrusaLink driver (T-22), ported from the Node adapter: HTTP Digest auth,
//! connection test, status with the `/api/v1/job` fallback, filament used, and
//! upload. Storage browse, download, cameras and `object_list` follow.
//!
//! Every request first sends a bodyless GET `/api/v1/status` for a fresh
//! Digest challenge, never a write. A GET answered 401 is retried once with
//! that reply's challenge, as in Node. Unlike Node, a PUT answered 401 is not
//! resent: the upload body goes out at most once.
//! Until GRE-359, HTTPS is refused and redirects are not followed.
use crate::digest;
use crate::moonraker_driver::{
    TestResult, UploadResult, UploadSource, encode_uri_component, error_text, js_trim,
    safe_storage_path,
};
use anyhow::{Result, anyhow, bail, ensure};
use pp_api_types::printer_status::{PrinterHostState as State, PrinterHostStatus as Status};
use pp_net::outbound::{HttpGuard, HttpReply, PostBody, PostError};
use serde_json::{Map, Value};
use std::{io::Cursor, pin::Pin, time::Duration};
use tokio::io::AsyncRead;
use url::Url;

const PROBE: &str = "/api/v1/status";
const READ_DEADLINE: Duration = Duration::from_secs(8);
const UPLOAD_DEADLINE: Duration = Duration::from_secs(120);

pub struct Driver {
    guard: HttpGuard,
    base_url: String,
    username: String,
    password: Option<String>,
    storage: Option<String>,
}

impl Driver {
    /// `storage` is the operator-pinned storage root; uploads default to `usb`.
    pub fn new(
        guard: HttpGuard,
        base_url: &str,
        username: &str,
        password: Option<&str>,
        storage: Option<&str>,
    ) -> Self {
        Self {
            guard,
            base_url: base_url.into(),
            username: js_trim(username).into(),
            password: password
                .map(js_trim)
                .filter(|p| !p.is_empty() && *p != "****")
                .map(Into::into),
            storage: storage.and_then(safe_storage_path),
        }
    }

    fn base(&self) -> Result<&str> {
        let base = self.base_url.trim().trim_end_matches('/');
        ensure!(!base.is_empty(), "base_url is required");
        ensure!(!base.contains(['?', '#']), "Invalid base_url");
        Ok(base)
    }

    fn password(&self) -> Result<&str> {
        self.password
            .as_deref()
            .ok_or_else(|| anyhow!("username and password are required"))
    }

    fn url(&self, path: &str) -> Result<Url> {
        let url =
            Url::parse(&format!("{}{path}", self.base()?)).map_err(|_| anyhow!("Invalid URL"))?;
        match url.scheme() {
            "http" => Ok(url),
            "https" => bail!("HTTPS PrusaLink hosts are not supported until GRE-359"),
            other => bail!("Unsupported URL protocol: {other}:"),
        }
    }

    /// The challenge from a bodyless GET of `/api/v1/status` on the same origin.
    async fn challenge(&self, url: &Url) -> Result<Option<Challenge>, PostError> {
        let probe = format!("{}{PROBE}", url.origin().ascii_serialization());
        let reply = self
            .guard
            .request("GET", &probe, &[], None, READ_DEADLINE)
            .await?;
        Ok(Challenge::from_reply(&reply))
    }

    fn authorization(&self, method: &str, url: &Url, challenge: &Challenge) -> Result<String> {
        let uri = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        let request = digest::Request {
            username: &self.username,
            password: self.password()?,
            method,
            uri: &uri,
            nc: 1,
            cnonce: &digest::cnonce(),
        };
        digest::authorization(&request, &challenge.params)
    }

    /// One Digest-authorized request. Only a GET is retried after a 401.
    async fn send(
        &self,
        method: &str,
        url: &Url,
        headers: &[(&str, &str)],
        body: Option<PostBody>,
        deadline: Duration,
    ) -> Result<HttpReply, PostError> {
        let unsent = PostError::Unsent;
        let challenge = self.challenge(url).await?;
        let authorization = challenge
            .as_ref()
            .map(|c| self.authorization(method, url, c))
            .transpose()
            .map_err(unsent)?;
        let mut all = headers.to_vec();
        if let Some(value) = &authorization {
            all.push(("authorization", value));
        }
        let reply = self
            .guard
            .request(method, url.as_str(), &all, body, deadline)
            .await?;
        if reply.status != 401 || method != "GET" {
            return Ok(reply);
        }
        let Some(retry) = Challenge::from_reply(&reply) else {
            return Ok(reply);
        };
        let value = self.authorization(method, url, &retry).map_err(unsent)?;
        let mut all = headers.to_vec();
        all.push(("authorization", &value));
        self.guard
            .request(method, url.as_str(), &all, None, deadline)
            .await
    }

    async fn get(&self, path: &str) -> Result<HttpReply> {
        let url = self.url(path)?;
        self.password()?;
        self.send("GET", &url, &[], None, READ_DEADLINE)
            .await
            .map_err(|error| anyhow!("{error}"))
    }

    pub async fn test_connection(&self) -> TestResult {
        let result = async {
            self.base()?;
            self.password()?;
            let info = self.get("/api/v1/info").await?;
            if ok(&info) {
                let info = json(&info.body)?;
                let label = ["name", "hostname", "printer_model"]
                    .iter()
                    .find_map(|key| {
                        info.get(*key)
                            .and_then(Value::as_str)
                            .filter(|v| !v.is_empty())
                    })
                    .unwrap_or("PrusaLink");
                let state = self.read_status().await.ok().map(|s| state_name(&s.state));
                let state = state.map_or(String::new(), |s| format!(", state: {s}"));
                return Ok(format!("Connected ({label}{state})"));
            }
            // Older builds have no `/api/v1/info`.
            let status = self.read_status().await?;
            if status.state == State::Offline {
                let fallback = format!("PrusaLink returned HTTP {}", info.status);
                bail!("{}", status.message.unwrap_or(fallback));
            }
            let message = status
                .message
                .unwrap_or_else(|| state_name(&status.state).into());
            Ok(format!("Connected ({message})"))
        }
        .await;
        match result {
            Ok(message) => TestResult { ok: true, message },
            Err(error) => TestResult {
                ok: false,
                message: error.to_string(),
            },
        }
    }

    pub async fn status(&self) -> Status {
        self.read_status()
            .await
            .unwrap_or_else(|error| Status::offline(&error.to_string()))
    }

    async fn read_status(&self) -> Result<Status> {
        if let Err(error) = self.base().and_then(|_| self.password()) {
            return Ok(Status::offline(&error.to_string()));
        }
        let reply = self.get(PROBE).await?;
        if reply.status == 204 {
            let mut idle = Status::offline("Idle");
            idle.state = State::Idle;
            return Ok(idle);
        }
        if !ok(&reply) {
            return Ok(Status::offline(&format!(
                "PrusaLink returned HTTP {}",
                reply.status
            )));
        }
        let body = json(&reply.body)?;
        let printer = body.get("printer").and_then(Value::as_object);
        let job = body.get("job").and_then(Value::as_object);
        let raw_state = printer.and_then(|p| {
            p.get("state")
                .and_then(Value::as_str)
                .or_else(|| p.get("status").and_then(Value::as_str))
        });
        let state = map_state(raw_state.unwrap_or(""));
        let mut progress = job.and_then(|j| percent(j.get("progress")));
        let mut filename = job.and_then(|j| file_name(j.get("file")));
        // Node tests these with truthiness, so an empty name counts as none.
        let named =
            |name: &Option<String>| name.as_deref().filter(|n| !n.is_empty()).map(str::to_owned);
        let mut eta = job.and_then(|j| seconds(j.get("time_remaining")));
        let active = matches!(state, State::Printing | State::Paused);
        if active && let Some(meta) = self.job_meta().await {
            filename = named(&meta.filename).or(filename);
            progress = progress.or(meta.progress);
            eta = eta.or(meta.eta);
        }
        let message = match (&state, &named(&filename)) {
            (State::Printing, Some(name)) => Some(format!("Printing {name}")),
            (State::Complete, Some(name)) => Some(format!("Complete · {name}")),
            (State::Complete, None) => Some("Complete".into()),
            (State::Idle, _) => Some("Idle".into()),
            _ => raw_state.map(str::to_owned),
        };
        let number = |key: &str| printer.and_then(|p| p.get(key)).and_then(Value::as_f64);
        Ok(Status {
            progress: if active { progress } else { None },
            filename,
            message,
            eta_seconds: eta,
            ip_address: Url::parse(self.base()?)?.host_str().map(str::to_owned),
            uptime_seconds: None,
            nozzle_temperature_c: number("temp_nozzle"),
            nozzle_target_c: number("target_nozzle"),
            bed_temperature_c: number("temp_bed"),
            bed_target_c: number("target_bed"),
            state,
        })
    }

    async fn job_meta(&self) -> Option<JobMeta> {
        let reply = self.get("/api/v1/job").await.ok()?;
        ok(&reply).then_some(())?;
        let body = json(&reply.body).ok()?;
        Some(JobMeta {
            filename: file_name(body.get("file")),
            progress: percent(body.get("progress")),
            eta: seconds(body.get("time_remaining")),
        })
    }

    pub async fn filament_used(&self) -> Option<f64> {
        let reply = self.get("/api/v1/job").await.ok()?;
        ok(&reply).then_some(())?;
        json(&reply.body)
            .ok()?
            .get("consumed_material")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
    }

    /// PUT the file into the pinned storage (default `usb`). The body is sent
    /// once; a 401 reply is reported, never answered with a resend.
    pub async fn upload_file(
        &self,
        source: UploadSource,
        filename: &str,
        start: bool,
    ) -> UploadResult {
        let replaced = filename.replace(['/', '\\'], "_");
        let name = match js_trim(&replaced) {
            "" => "print.gcode",
            dots if dots.chars().all(|c| c == '.') => "print.gcode",
            name => name,
        }
        .to_owned();
        let root = self.storage.as_deref().unwrap_or("usb");
        let remote_path = format!("{root}/{name}");
        let encoded: Vec<_> = remote_path.split('/').map(encode_uri_component).collect();
        let path = format!("/api/v1/files/{}", encoded.join("/"));
        let checked = self.url(&path).and_then(|url| self.password().map(|_| url));
        let url = match checked {
            Ok(url) => url,
            Err(error) => return UploadResult::failed(error.to_string(), false),
        };
        let body = match octet_stream(source).await {
            Ok(body) => body,
            Err(error) => return UploadResult::failed(error.to_string(), false),
        };
        let headers = [
            ("print-after-upload", if start { "?1" } else { "?0" }),
            ("overwrite", "?1"),
        ];
        let reply = match self
            .send("PUT", &url, &headers, Some(body), UPLOAD_DEADLINE)
            .await
        {
            Ok(reply) => reply,
            Err(PostError::Unsent(error) | PostError::SourceFailed(error)) => {
                return UploadResult::failed(format!("{error:#}"), false);
            }
            Err(PostError::Unknown(error)) => {
                let message = format!("Upload outcome unknown: {error:#}");
                return UploadResult::failed(message, true);
            }
        };
        if reply.status == 401 {
            let reason = match Challenge::from_reply(&reply) {
                Some(c) if c.stale() => "the Digest nonce went stale; send again",
                _ => "PrusaLink rejected the username or password",
            };
            return UploadResult::failed(format!("Upload failed (HTTP 401): {reason}"), false);
        }
        if !ok(&reply) {
            let message = format!(
                "Upload failed (HTTP {}){}",
                reply.status,
                error_text(&reply.body)
            );
            return UploadResult::failed(message, false);
        }
        UploadResult {
            ok: true,
            remote_path: Some(remote_path),
            started: Some(start),
            message: if start {
                format!("Uploaded and started {name}")
            } else {
                format!("Uploaded {name}")
            },
            outcome_unknown: false,
        }
    }
}

struct Challenge {
    params: std::collections::BTreeMap<String, String>,
}

impl Challenge {
    /// A Digest challenge with a nonce from a 401 reply.
    fn from_reply(reply: &HttpReply) -> Option<Self> {
        if reply.status != 401 {
            return None;
        }
        let params = digest::parse_www_authenticate(reply.www_authenticate.as_deref()?);
        params
            .get("nonce")
            .is_some_and(|n| !n.is_empty())
            .then_some(Self { params })
    }

    fn stale(&self) -> bool {
        self.params
            .get("stale")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
    }
}

struct JobMeta {
    filename: Option<String>,
    progress: Option<f64>,
    eta: Option<f64>,
}

fn ok(reply: &HttpReply) -> bool {
    (200..300).contains(&reply.status)
}

fn json(body: &[u8]) -> Result<Map<String, Value>> {
    let value: Value = serde_json::from_slice(body)?;
    Ok(match value {
        Value::Object(map) => map,
        _ => Map::new(),
    })
}

fn map_state(raw: &str) -> State {
    match raw.to_uppercase().as_str() {
        "PRINTING" => State::Printing,
        "PAUSED" => State::Paused,
        "FINISHED" => State::Complete,
        // Buddy firmware reports READY between jobs; a cancel must not read as complete.
        "READY" | "IDLE" | "STOPPED" => State::Idle,
        "ATTENTION" | "ERROR" => State::Error,
        _ => State::Unknown,
    }
}

fn state_name(state: &State) -> &'static str {
    match state {
        State::Idle => "idle",
        State::Printing => "printing",
        State::Paused => "paused",
        State::Complete => "complete",
        State::Error => "error",
        State::Offline => "offline",
        State::Unknown => "unknown",
    }
}

fn percent(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.0, 100.0).round())
}

fn seconds(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
}

/// `display_name`, then `name`, then `path`.
fn file_name(file: Option<&Value>) -> Option<String> {
    let file = file?.as_object()?;
    ["display_name", "name", "path"]
        .iter()
        .find_map(|key| file.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
}

async fn octet_stream(source: UploadSource) -> Result<PostBody> {
    let (reader, length): (Pin<Box<dyn AsyncRead + Send>>, u64) = match source {
        UploadSource::Bytes(bytes) => {
            let length = bytes.len() as u64;
            (Box::pin(Cursor::new(bytes)), length)
        }
        UploadSource::Path(path) => {
            let file = tokio::fs::File::open(&path).await?;
            let length = file.metadata().await?.len();
            (Box::pin(file), length)
        }
    };
    Ok(PostBody {
        content_type: "application/octet-stream".into(),
        reader,
        length,
    })
}
