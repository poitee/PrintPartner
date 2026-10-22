use pp_storage::catalog::{CreateSource, Deletion, SourcePatch, SourceSummary};
use serde_json::{Map, Value, json};

pub(super) fn sources(rows: Vec<SourceSummary>) -> Value {
    json!({ "sources": rows })
}

pub(super) fn source(row: SourceSummary) -> Result<Value, serde_json::Error> {
    serde_json::to_value(row)
}

/// `String(body.name ?? "")`, with null and missing fields omitted on the other columns.
pub(super) fn source_create(body: &Value) -> CreateSource {
    CreateSource {
        name: text(body, "name").unwrap_or_default(),
        url: text(body, "url"),
        branch: text(body, "branch"),
        tag: text(body, "tag"),
        source_kind: text(body, "source_kind"),
        role: text(body, "role"),
        metadata: object(body, "metadata"),
        ..Default::default()
    }
}

/// Patch omits null columns. An explicit null `tag` clears the stored tag.
pub(super) fn source_patch(body: &Value) -> SourcePatch {
    SourcePatch {
        name: text(body, "name"),
        url: text(body, "url"),
        branch: text(body, "branch"),
        tag: body
            .get("tag")
            .map(|value| (!value.is_null()).then(|| js_string(value))),
        source_kind: text(body, "source_kind"),
        role: text(body, "role"),
        metadata: object(body, "metadata"),
        metadata_version: body.get("metadata_version").and_then(Value::as_i64),
        ..Default::default()
    }
}

fn text(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .filter(|value| !value.is_null())
        .map(js_string)
}

fn object(body: &Value, key: &str) -> Option<Map<String, Value>> {
    body.get(key).and_then(Value::as_object).cloned()
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".into(),
        Value::Bool(value) => {
            if *value {
                "true".into()
            } else {
                "false".into()
            }
        }
        Value::Number(value) => js_number(value),
        Value::Array(items) => items
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub(super) enum DeletionHttp {
    Deleted,
    Refused { status: u16, detail: &'static str },
}

/// Node delete statuses, plus the catalog busy and reference refusals.
pub(super) fn source_deletion(outcome: Deletion) -> DeletionHttp {
    match outcome {
        Deletion::Deleted { .. } => DeletionHttp::Deleted,
        Deletion::NotFound => DeletionHttp::Refused {
            status: 404,
            detail: "Source not found",
        },
        Deletion::RetainedHistory => DeletionHttp::Refused {
            status: 409,
            detail: "Source has immutable revision history and cannot be deleted",
        },
        Deletion::Referenced => DeletionHttp::Refused {
            status: 409,
            detail: "Source is referenced and cannot be deleted",
        },
        Deletion::ActiveWork => DeletionHttp::Refused {
            status: 409,
            detail: "Source has active work and cannot be deleted",
        },
    }
}

fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(value) => ryu_js::Buffer::new().format(value).to_owned(),
        None => number.to_string(),
    }
}
