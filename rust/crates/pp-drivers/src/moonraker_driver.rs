//! Moonraker driver reads (T-21): connection test, status, filament used,
//! `object_list`, cameras and print-file browse, ported from the Node adapter.
//! Guarded GET only. Upload/start, file download and the camera proxy follow.
//! Until GRE-359, redirects are not followed (a 3xx is a non-OK reply), HTTPS
//! is refused, and replies are bounded by the guard's 2 MiB body limit.
use crate::moonraker::{QUERY, recorded_status};
use anyhow::{Context, Result, bail, ensure};
use pp_api_types::printer_status::PrinterHostStatus as Status;
use pp_net::outbound::HttpGuard;
use serde::Serialize;
use serde_json::{Map, Value};
use url::Url;

/// Moonraker's print-file root. Every browsable path is relative to it.
const GCODES_ROOT: &str = "gcodes";
const INVALID_PATH: &str = "Invalid Moonraker print-file path";

#[derive(Debug, PartialEq, Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CameraView {
    Mjpeg,
    Snapshot,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Camera {
    pub id: String,
    pub name: String,
    pub view: CameraView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StorageEntry {
    Directory {
        path: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        modified_at: Option<String>,
    },
    File {
        path: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        modified_at: Option<String>,
    },
}

#[derive(Debug, PartialEq, Serialize)]
pub struct StorageListing {
    pub path: String,
    pub entries: Vec<StorageEntry>,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

pub struct Driver {
    guard: HttpGuard,
    base_url: String,
    api_key: Option<String>,
}

impl Driver {
    pub fn new(guard: HttpGuard, base_url: &str, api_key: Option<&str>) -> Self {
        Self {
            guard,
            base_url: base_url.into(),
            api_key: api_key.map(Into::into),
        }
    }

    fn base(&self) -> Result<&str> {
        let base = self.base_url.trim().trim_end_matches('/');
        ensure!(!base.is_empty(), "base_url is required");
        // Same rule as the watcher: never append a path to a query or fragment.
        ensure!(!base.contains(['?', '#']), "Invalid base_url");
        Ok(base)
    }

    async fn fetch(&self, path: &str) -> Result<Reply> {
        let url = format!("{}{path}", self.base()?);
        let reply = self
            .guard
            .get(&url, self.api_key.as_deref().map(str::trim))
            .await?;
        Ok(Reply {
            status: reply.status,
            body: reply.body,
        })
    }

    pub async fn test_connection(&self) -> TestResult {
        let result = async {
            let reply = self.fetch("/server/info").await?;
            if !reply.ok() {
                bail!("Moonraker returned HTTP {}", reply.status);
            }
            let result = envelope(&reply.body)?;
            let state = result
                .get("klippy_state")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Ok(format!("Connected (klippy: {state})"))
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

    /// Status with `uptime_seconds` from `/machine/proc_stats` (the watcher omits it).
    pub async fn status(&self) -> Status {
        let result = async {
            let reply = self.fetch(QUERY).await?;
            if !reply.ok() {
                return Ok(Status::offline(&format!(
                    "Moonraker returned HTTP {}",
                    reply.status
                )));
            }
            let mut status = recorded_status(&reply.body, self.base()?)?;
            status.uptime_seconds = self.uptime().await;
            Ok::<_, anyhow::Error>(status)
        }
        .await;
        result.unwrap_or_else(|error| Status::offline(&error.to_string()))
    }

    async fn uptime(&self) -> Option<f64> {
        let reply = self.fetch("/machine/proc_stats").await.ok()?;
        reply.ok().then_some(())?;
        envelope(&reply.body)
            .ok()?
            .get("system_uptime")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(f64::round)
    }

    pub async fn filament_used(&self) -> Option<f64> {
        let status = self.query_status("print_stats").await?;
        status
            .get("print_stats")?
            .get("filament_used")?
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
    }

    pub async fn object_list(&self) -> Vec<String> {
        let Some(status) = self.query_status("exclude_object").await else {
            return Vec::new();
        };
        let objects = status
            .get("exclude_object")
            .and_then(|v| v.get("objects"))
            .and_then(Value::as_array);
        objects
            .into_iter()
            .flatten()
            .filter_map(|object| object.as_object()?.get("name")?.as_str())
            .map(js_trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect()
    }

    async fn query_status(&self, object: &str) -> Option<Value> {
        let reply = self
            .fetch(&format!("/printer/objects/query?{object}"))
            .await
            .ok()?;
        reply.ok().then_some(())?;
        let status = envelope(&reply.body).ok()?.get("status")?.clone();
        status.is_object().then_some(status)
    }

    pub async fn cameras(&self) -> Result<Vec<Camera>> {
        let base = self.base()?;
        let reply = self.fetch("/server/webcams/list").await?;
        if reply.status == 404 {
            return Ok(Vec::new());
        }
        ensure!(
            reply.ok(),
            "Moonraker webcam list returned HTTP {}",
            reply.status
        );
        let result = envelope(&reply.body)?;
        let webcams = result.get("webcams").and_then(Value::as_array);
        Ok(webcams
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .enumerate()
            .filter_map(|(index, camera)| list_camera(base, index, camera))
            .collect())
    }

    /// Browse one directory of the `gcodes` root via `/server/files/directory`,
    /// which, unlike `/server/files/list`, also reports folders and non-G-code files.
    pub async fn browse(&self, path: &str) -> Result<StorageListing> {
        self.base()?;
        let stripped = path.trim_matches('/');
        let requested = if stripped.is_empty() {
            String::new()
        } else {
            safe_storage_path(stripped).context(INVALID_PATH)?
        };
        let provider = if requested.is_empty() {
            GCODES_ROOT.to_owned()
        } else {
            format!("{GCODES_ROOT}/{requested}")
        };
        let encoded: Vec<String> = provider.split('/').map(encode_uri_component).collect();
        let reply = self
            .fetch(&format!(
                "/server/files/directory?path={}&extended=true",
                encoded.join("/")
            ))
            .await?;
        ensure!(
            reply.ok(),
            "Moonraker directory listing returned HTTP {}",
            reply.status
        );
        let result = envelope(&reply.body)?;
        let rows = |key: &str| {
            result
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
        };
        let prefix = if requested.is_empty() {
            String::new()
        } else {
            format!("{requested}/")
        };
        let directories = rows("dirs").filter_map(|row| {
            let name = entry_name(row.get("dirname"))?;
            Some(StorageEntry::Directory {
                path: format!("{prefix}{name}"),
                name,
                modified_at: modified_at(row.get("modified")),
            })
        });
        let files = rows("files").filter_map(|row| {
            let name = entry_name(row.get("filename"))?;
            Some(StorageEntry::File {
                path: format!("{prefix}{name}"),
                name,
                size_bytes: row
                    .get("size")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .map(|v| v.round() as u64),
                modified_at: modified_at(row.get("modified")),
            })
        });
        Ok(StorageListing {
            path: requested,
            entries: directories.chain(files).collect(),
        })
    }
}

/// Moonraker wraps nearly every success in `{ "result": ... }`; anything else is empty.
fn envelope(body: &[u8]) -> Result<Value> {
    let body: Value = serde_json::from_slice(body)?;
    Ok(match body.get("result") {
        Some(result) if result.is_object() => result.clone(),
        _ => Value::Null,
    })
}

/// `String.prototype.trim`: Unicode White_Space without NEL, plus the BOM.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

fn text<'a>(row: &'a Map<String, Value>, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).map_or("", js_trim)
}

fn list_camera(base: &str, index: usize, camera: &Map<String, Value>) -> Option<Camera> {
    if camera.get("enabled") == Some(&Value::Bool(false)) {
        return None;
    }
    let (view, _url) = camera_view(base, camera)?;
    let nonempty = |value: &str| (!value.is_empty()).then(|| value.to_owned());
    Some(Camera {
        id: nonempty(text(camera, "uid")).unwrap_or_else(|| format!("camera-{index}")),
        name: nonempty(text(camera, "name")).unwrap_or_else(|| format!("Camera {}", index + 1)),
        view,
        service: nonempty(text(camera, "service")),
        aspect_ratio: nonempty(text(camera, "aspect_ratio")),
    })
}

/// Pick a browser-renderable view, or None. Moonraker replays whatever a camera
/// service wrote into its database, so a cross-origin value in either URL
/// discredits the whole entry instead of falling back to its sibling.
fn camera_view(base: &str, camera: &Map<String, Value>) -> Option<(CameraView, String)> {
    let stream_url = text(camera, "stream_url");
    let stream = same_origin(base, stream_url)?;
    let snapshot = same_origin(base, text(camera, "snapshot_url"))?;
    let service = text(camera, "service").to_lowercase();
    // MJPEG is the only continuous format proxied; `action=stream` is mjpg-streamer's.
    let mjpeg = service.contains("mjpeg")
        || service.contains("ustreamer")
        || stream_url.to_ascii_lowercase().contains("action=stream");
    match (stream, snapshot) {
        (Some(url), _) if mjpeg => Some((CameraView::Mjpeg, url)),
        (_, Some(url)) => Some((CameraView::Snapshot, url)),
        _ => None,
    }
}

/// `Some(None)` when nothing was advertised, `None` when the value does not
/// resolve onto the Moonraker origin.
fn same_origin(base: &str, advertised: &str) -> Option<Option<String>> {
    if advertised.is_empty() {
        return Some(None);
    }
    let origin = Url::parse(base).ok()?.origin();
    let resolved = Url::parse(&format!("{base}/"))
        .ok()?
        .join(advertised)
        .ok()?;
    (resolved.origin() == origin).then(|| Some(resolved.into()))
}

/// Host-reported paths are untrusted: reject backslashes, NULs and empty,
/// `.` or `..` segments. Leading and trailing slashes are trimmed.
fn safe_storage_path(raw: &str) -> Option<String> {
    if raw.contains(['\\', '\0']) {
        return None;
    }
    let normalized = raw.trim_matches('/');
    let bad = |segment: &str| segment.is_empty() || segment == "." || segment == "..";
    (!normalized.is_empty() && !normalized.split('/').any(bad)).then(|| normalized.to_owned())
}

/// A directory row names one segment; a separator in it is a provider surprise.
fn entry_name(raw: Option<&Value>) -> Option<String> {
    safe_storage_path(raw?.as_str()?).filter(|name| !name.contains('/'))
}

fn encode_uri_component(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Moonraker reports `modified: 0` when it has no timestamp; that stays absent.
/// Node's `toISOString()` throws past year 9999; such values are omitted here.
fn modified_at(raw: Option<&Value>) -> Option<String> {
    let seconds = raw?.as_f64().filter(|v| v.is_finite() && *v > 0.0)?;
    let millis = (seconds * 1000.0).trunc();
    if millis >= 253_402_300_800_000.0 {
        return None;
    }
    let millis = millis as i64;
    let (days, rest) = (millis / 86_400_000, millis % 86_400_000);
    // Howard Hinnant's civil_from_days, for days since 1970-01-01 (non-negative).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_t_21_iso_timestamps_match_to_iso_string() {
        for (seconds, expected) in [
            (1e-3, Some("1970-01-01T00:00:00.001Z")),
            (951_782_400.0, Some("2000-02-29T00:00:00.000Z")),
            (1_727_784_000.123_9, Some("2024-10-01T12:00:00.123Z")),
            (253_402_300_799.999, Some("9999-12-31T23:59:59.999Z")),
            (253_402_300_800.0, None),
            (0.0, None),
            (-1.0, None),
        ] {
            assert_eq!(
                modified_at(Some(&serde_json::json!(seconds))).as_deref(),
                expected,
                "{seconds}"
            );
        }
        assert_eq!(modified_at(Some(&serde_json::json!("1"))), None);
    }

    #[test]
    fn ticket_t_21_path_rules_match_storage_path_guard() {
        assert_eq!(safe_storage_path("/a/b/").as_deref(), Some("a/b"));
        for bad in ["a//b", "a/./b", "../a", "a\\b", "a\0b", "/", ""] {
            assert_eq!(safe_storage_path(bad), None, "{bad:?}");
        }
        assert_eq!(
            encode_uri_component("Plate & Lid #2 ü!~*'()"),
            "Plate%20%26%20Lid%20%232%20%C3%BC!~*'()"
        );
        assert_eq!(js_trim("\u{feff} x \u{85}"), "x \u{85}");
    }
}
