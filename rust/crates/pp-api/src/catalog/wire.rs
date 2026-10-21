use pp_storage::catalog::SourceSummary;
use serde_json::{Value, json};

pub(super) fn sources(rows: Vec<SourceSummary>) -> Value {
    json!({ "sources": rows })
}

pub(super) fn source(row: SourceSummary) -> Result<Value, serde_json::Error> {
    serde_json::to_value(row)
}
