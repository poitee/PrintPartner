use axum::{
    Json,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use pp_storage::{
    auth::{AuthFailure, Secret},
    catalog::{
        CatalogAccess, CatalogFailure, CatalogKeyAccess, CreateSource, Deletion, NamingCommand,
        NamingProfile, Outcome, Request, SourceCatalogClient, SourcePatch,
    },
};
use serde_json::{Value, json};

#[derive(Debug)]
pub(super) struct Failure {
    status: StatusCode,
    detail: String,
    code: Option<&'static str>,
}
impl Failure {
    pub(super) fn new(status: u16, detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).expect("status"),
            detail: detail.into(),
            code: None,
        }
    }
    pub(super) fn input(detail: &str, naming: bool) -> Self {
        Self::new(400, detail).for_naming(naming)
    }
    pub(super) fn for_naming(mut self, naming: bool) -> Self {
        if naming {
            match self.status.as_u16() {
                400 => self.code = Some("invalid_source_naming"),
                404 => {
                    self.code = Some("source_not_found");
                    self.detail = "Source not found".into();
                }
                _ => {}
            }
        }
        self
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let mut body = json!({"detail":self.detail});
        if let Some(code) = self.code {
            body["code"] = json!(code);
        }
        (self.status, Json(body)).into_response()
    }
}
impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        if let Some(f) = error.downcast_ref::<AuthFailure>() {
            return match f {
                AuthFailure::SessionRequired
                | AuthFailure::InvalidCredentials
                | AuthFailure::CredentialChanged => Self::new(401, "Authentication required"),
                AuthFailure::OwnerMappingRequired => {
                    Self::new(403, "Explicit account owner mapping is required")
                }
                AuthFailure::QueueFull | AuthFailure::Stopped => {
                    Self::new(503, "Catalog temporarily unavailable")
                }
                _ => Self::new(500, "Catalog unavailable"),
            };
        }
        match error.downcast_ref::<CatalogFailure>() {
            Some(CatalogFailure::Input(detail)) => Self::new(400, detail.clone()),
            Some(CatalogFailure::DuplicateName(_) | CatalogFailure::Referenced) => {
                Self::new(400, error.to_string())
            }
            Some(CatalogFailure::NotFound) => Self::new(404, "Source not found"),
            Some(CatalogFailure::InvalidStoredNaming) => Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "Stored Source naming settings are invalid".into(),
                code: Some("invalid_source_naming_state"),
            },
            Some(
                CatalogFailure::QueueFull | CatalogFailure::Stopped | CatalogFailure::Cancelled,
            ) => Self::new(503, "Catalog temporarily unavailable"),
            Some(CatalogFailure::TooLarge) => Self::new(413, "Request body too large"),
            _ => Self::new(500, "Catalog unavailable"),
        }
    }
}
pub(super) fn credential(
    headers: &HeaderMap,
    access: &CatalogAccess,
    keys: Option<&CatalogKeyAccess>,
) -> Result<SourceCatalogClient, Failure> {
    let denied = || Failure::new(401, "Authentication required");
    let mut session = None;
    for h in headers.get_all("cookie") {
        for item in h.to_str().map_err(|_| denied())?.split(';') {
            if let Some(("pp_session", value)) = item.trim().split_once('=')
                && session.replace(value).is_some()
            {
                return Err(denied());
            }
        }
    }
    let auth = headers.get("authorization");
    let custom = headers.get("x-print-partner-api-key");
    if headers.get_all("authorization").iter().count() > 1
        || headers.get_all("x-print-partner-api-key").iter().count() > 1
        || usize::from(session.is_some())
            + usize::from(auth.is_some())
            + usize::from(custom.is_some())
            != 1
    {
        return Err(denied());
    }
    if let Some(value) = session {
        if value.is_empty() || value.len() > 4096 {
            return Err(denied());
        }
        return Ok(access.session(Secret::new(value.into())));
    }
    let key = if let Some(auth) = auth {
        auth.to_str()
            .map_err(|_| denied())?
            .strip_prefix("Bearer ")
            .ok_or_else(denied)?
    } else {
        custom.ok_or_else(denied)?.to_str().map_err(|_| denied())?
    }
    .trim();
    if key.is_empty() || key.len() > 4096 {
        return Err(denied());
    }
    Ok(keys.ok_or_else(denied)?.key(Secret::new(key.into())))
}
pub(super) enum Wrapper {
    Bare,
    Sources,
    Profile,
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|_| Failure::new(400, "Invalid catalog input"))
}
pub(super) fn command(
    method: &Method,
    path: &str,
    query: &str,
    mut body: Value,
) -> Result<(Request, Wrapper), Failure> {
    if !body.is_object() {
        return Err(Failure::new(400, "Invalid JSON body"));
    }
    let read = matches!(*method, Method::GET | Method::HEAD);
    let request = match path {
        "/sources" if read => (Request::List {}, Wrapper::Sources),
        "/sources" => {
            if body.get("local_path").is_some() {
                return Err(Failure::new(
                    400,
                    "Raw local_path requires native Source selection",
                ));
            }
            (
                Request::CreateForHttp {
                    source: source_create(&body),
                },
                Wrapper::Bare,
            )
        }
        "/settings/stl-naming" if read => (Request::GetGlobalNaming {}, Wrapper::Profile),
        "/settings/stl-naming" => (
            Request::SaveGlobalNaming {
                profile: if body["profile"].is_null() {
                    NamingProfile::default()
                } else {
                    parse(body["profile"].take())?
                },
            },
            Wrapper::Profile,
        ),
        "/settings/source-categories" if read => (Request::GetCategoriesWithTree {}, Wrapper::Bare),
        "/settings/source-categories" => (
            Request::SaveCategoriesWithTree {
                categories: parse(body.get("categories").cloned().unwrap_or(json!([])))?,
                replacements: parse(body.get("replacements").cloned().unwrap_or(json!({})))?,
            },
            Wrapper::Bare,
        ),
        "/sources/bulk-category" => (
            Request::BulkCategoryForHttp {
                source_ids: body["source_ids"]
                    .as_array()
                    .map(|ids| {
                        ids.iter()
                            .filter_map(js_number)
                            .filter_map(serde_json::Number::from_f64)
                            .collect()
                    })
                    .unwrap_or_default(),
                category: body["category"].as_str().map(str::to_owned),
            },
            Wrapper::Bare,
        ),
        "/sources/activity" => {
            let url =
                reqwest::Url::parse(&format!("http://localhost/?{query}")).expect("query URL");
            let limit = url
                .query_pairs()
                .find(|(key, _)| key == "limit")
                .and_then(|(_, v)| js_number(&json!(v)))
                .unwrap_or(20.0)
                .trunc()
                .clamp(1.0, 100.0) as u8;
            (Request::SourceActivity { limit }, Wrapper::Bare)
        }
        "/settings/stl-naming/preview" => (
            Request::PreviewNaming {
                relative_path: optional_text(&body, "relative_path").unwrap_or_default(),
                profile: if body["profile"].is_null() {
                    None
                } else {
                    Some(parse(body["profile"].take())?)
                },
            },
            Wrapper::Bare,
        ),
        _ => {
            let segments: Vec<_> = path.trim_start_matches('/').split('/').collect();
            let raw = segments.get(1).copied().unwrap_or("");
            let naming = segments.get(2) == Some(&"naming");
            let number = js_number(&json!(raw));
            let id = number
                .filter(|n| n.fract() == 0.0 && *n >= i64::MIN as f64 && *n < -(i64::MIN as f64));
            if naming
                && (!raw.bytes().all(|b| b.is_ascii_digit())
                    || id.is_none_or(|n| n <= 0.0 || n > 9_007_199_254_740_991.0))
            {
                return Err(Failure::new(400, "Source id must be a positive integer"));
            }
            let id = id.ok_or_else(|| Failure::new(404, "Source not found"))? as i64;
            let request = match segments.get(2).copied() {
                Some("import-rules") if read => Request::GetImportRules { id },
                Some("import-rules") => Request::SaveImportRules {
                    id,
                    rules: parse(body.get("rules").cloned().unwrap_or(json!([])))?,
                },
                Some("naming") if read => Request::GetNaming { id },
                Some("naming") => {
                    let settings = match body["use_defaults"].as_bool() {
                        Some(true) if body.as_object().unwrap().len() == 1 => {
                            NamingCommand::UseDefaults
                        }
                        Some(false)
                            if body.as_object().unwrap().len() == 2
                                && body.get("override").is_some() =>
                        {
                            NamingCommand::Override {
                                profile: parse(body["override"].take())?,
                            }
                        }
                        _ => return Err(Failure::new(400, "Invalid Source naming input")),
                    };
                    Request::SaveNaming { id, settings }
                }
                None if read => Request::Get { id },
                None if *method == Method::DELETE => Request::Delete { id },
                None => {
                    if body.get("local_path").is_some() {
                        return Err(Failure::new(
                            400,
                            "Raw local_path requires native Source selection",
                        ));
                    }
                    Request::UpdateForHttp {
                        id,
                        patch: source_patch(&body),
                    }
                }
                _ => return Err(Failure::new(404, "Not found")),
            };
            (request, Wrapper::Bare)
        }
    };
    Ok(request)
}
pub(super) fn response(outcome: Outcome, wrapper: Wrapper) -> Result<Response, Failure> {
    let value = match outcome {
        Outcome::Source(Some(source)) => json!(source),
        Outcome::Source(None) => return Err(Failure::new(404, "Source not found")),
        Outcome::Preview(preview) => json!(preview),
        Outcome::Activity(events) => json!({"events":events}),
        Outcome::Categories(settings) => json!(settings),
        Outcome::Sources(sources) => json!(sources),
        Outcome::Data(value) => value,
        Outcome::Deletion(Deletion::Deleted { .. }) => {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        Outcome::Deletion(Deletion::NotFound) => return Err(Failure::new(404, "Source not found")),
        Outcome::Deletion(Deletion::RetainedHistory) => {
            return Err(Failure::new(
                409,
                "Source has immutable revision history and cannot be deleted",
            ));
        }
        Outcome::Deletion(Deletion::Referenced) => {
            return Err(Failure::new(
                409,
                "Source is referenced and cannot be deleted",
            ));
        }
        Outcome::Deletion(Deletion::ActiveWork) => {
            return Err(Failure::new(
                409,
                "Source has active work and cannot be deleted",
            ));
        }
    };
    Ok(Json(match wrapper {
        Wrapper::Bare => value,
        Wrapper::Sources => json!({"sources":value}),
        Wrapper::Profile => json!({"profile":value}),
    })
    .into_response())
}

fn trim(value: &str) -> &str {
    value.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(n) => {
            let n = n.as_f64().expect("JSON number");
            if n == 0.0 {
                "0".into()
            } else if !(1e-6..1e21).contains(&n.abs()) {
                let scientific = format!("{n:e}");
                let (mantissa, exponent) = scientific.split_once('e').expect("scientific number");
                let exponent = exponent.parse::<i32>().expect("exponent");
                format!("{mantissa}e{exponent:+}")
            } else {
                n.to_string()
            }
        }
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn optional_text(body: &Value, key: &str) -> Option<String> {
    body.get(key).filter(|v| !v.is_null()).map(js_string)
}
fn source_create(body: &Value) -> CreateSource {
    CreateSource {
        name: optional_text(body, "name").unwrap_or_default(),
        url: optional_text(body, "url"),
        branch: optional_text(body, "branch"),
        tag: optional_text(body, "tag"),
        source_kind: optional_text(body, "source_kind"),
        role: optional_text(body, "role"),
        metadata: body["metadata"].as_object().cloned(),
        ..Default::default()
    }
}
fn source_patch(body: &Value) -> SourcePatch {
    SourcePatch {
        name: optional_text(body, "name"),
        url: optional_text(body, "url"),
        branch: optional_text(body, "branch"),
        tag: body.get("tag").map(|v| {
            if v.is_null() {
                None
            } else {
                Some(js_string(v))
            }
        }),
        source_kind: optional_text(body, "source_kind"),
        role: optional_text(body, "role"),
        metadata: body["metadata"].as_object().cloned(),
        ..Default::default()
    }
}
fn js_number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64()?,
        Value::Array(_) => return js_number(&Value::String(js_string(value))),
        Value::String(s) => {
            let s = trim(s);
            if s.is_empty() {
                0.0
            } else if let Some((digits, radix)) = s
                .strip_prefix("0x")
                .or_else(|| s.strip_prefix("0X"))
                .map(|s| (s, 16))
                .or_else(|| {
                    s.strip_prefix("0b")
                        .or_else(|| s.strip_prefix("0B"))
                        .map(|s| (s, 2))
                })
                .or_else(|| {
                    s.strip_prefix("0o")
                        .or_else(|| s.strip_prefix("0O"))
                        .map(|s| (s, 8))
                })
            {
                if digits.is_empty() {
                    return None;
                }
                let mut number = 0.0;
                for digit in digits.chars() {
                    number = number * (radix as f64) + digit.to_digit(radix)? as f64;
                }
                number
            } else {
                s.parse().ok()?
            }
        }
        Value::Object(_) => return None,
    };
    number.is_finite().then_some(number)
}
