//! `propose_add_custom_filament` and its apply, on `<dataDir>/custom_filaments.json`.
//!
//! Ports the tool case in `assistant/tools.ts` and `services/custom-filaments.ts`.
//! The file layout stays byte-compatible with Node: `{"filaments": [...]}`,
//! pretty-printed with two spaces and no trailing newline.

use super::{ProposedAction, ToolInvocation, js_string_or_empty, js_trim};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::Path;

// Rust writes this family only through McpSession, which nothing routes to
// yet. The GRE-441 MCP cutover sets the GRE-402 manifest's custom-filaments
// `rust_writes` to 1 when it switches the routes.
// ast-grep-ignore: no-writer-family-literal
const FILE_NAME: &str = "custom_filaments.json";

pub(super) fn propose(args: &Map<String, Value>) -> ToolInvocation {
    let display_name = js_trim(&js_string_or_empty(args.get("display_name"))).to_owned();
    let hex = js_trim(&js_string_or_empty(args.get("hex"))).to_owned();
    if display_name.is_empty() || !is_hex6(hex.strip_prefix('#').unwrap_or(&hex)) {
        return ToolInvocation {
            content: json!({ "error": "display_name and a six-digit hex color are required" })
                .to_string(),
            proposed_action: None,
        };
    }
    let mut params = Map::new();
    params.insert("display_name".into(), Value::String(display_name.clone()));
    params.insert("hex".into(), Value::String(hex));
    if let Some(Value::String(line)) = args.get("product_line") {
        params.insert("product_line".into(), Value::String(line.clone()));
    }
    let action = ProposedAction::new(
        "propose_add_custom_filament",
        0,
        format!("add custom filament {display_name}"),
        "Add a named external filament without stock tracking.",
        params,
    );
    ToolInvocation {
        content: action.proposed_content(),
        proposed_action: Some(action),
    }
}

pub(super) fn apply(data_dir: Option<&Path>, params: &Map<String, Value>) -> Value {
    let Some(data_dir) = data_dir else {
        return json!({ "ok": false, "detail": "Custom filament storage is unavailable" });
    };
    match add_or_replay(data_dir, params) {
        Ok((filament, replay)) => json!({
            "ok": true,
            "result": {
                "filament": filament,
                "inventory_tracking": "external_named_color_only",
                "idempotent_replay": replay,
            },
        }),
        Err(detail) => json!({ "ok": false, "detail": detail }),
    }
}

fn add_or_replay(data_dir: &Path, params: &Map<String, Value>) -> Result<(Value, bool), String> {
    let display_name = js_trim(&js_string_or_empty(params.get("display_name"))).to_owned();
    let hex_raw = js_string_or_empty(params.get("hex"));
    let hex_trimmed = js_trim(&hex_raw);
    let hex = hex_trimmed
        .strip_prefix('#')
        .unwrap_or(hex_trimmed)
        .to_lowercase();
    let product_line = match params.get("product_line") {
        Some(Value::String(line)) => js_trim(line).to_owned(),
        _ => "Custom".to_owned(),
    };

    let mut store = load_store(data_dir);
    let filaments = store
        .get_mut("filaments")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("{FILE_NAME} does not hold a filaments list"))?;
    // Node calls toLowerCase on each field in `&&` order, so a non-string
    // field it reaches throws and the apply fails without writing.
    let field = |entry: &Value, key: &str| {
        entry
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .ok_or_else(|| format!("{FILE_NAME} has a filament without a text {key}"))
    };
    for entry in filaments.iter() {
        if field(entry, "display_name")? != display_name.to_lowercase() {
            continue;
        }
        let entry_hex = field(entry, "hex")?;
        if entry_hex.strip_prefix('#').unwrap_or(&entry_hex) != hex {
            continue;
        }
        if field(entry, "product_line")? == product_line.to_lowercase() {
            return Ok((entry.clone(), true));
        }
    }

    // addCustomFilament re-validates what the propose step checked.
    if display_name.is_empty() {
        return Err("display_name is required".into());
    }
    if !is_hex6(&hex) {
        return Err("hex must be 6-digit RGB".into());
    }
    let id: [u8; 4] = rand::random();
    let entry = json!({
        "id": format!("custom-{}", id.iter().map(|b| format!("{b:02x}")).collect::<String>()),
        "display_name": display_name,
        "product_line": if product_line.is_empty() { "Custom" } else { &product_line },
        "hex": format!("#{hex}"),
        "combo_label": display_name,
    });
    filaments.push(entry.clone());
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    fs::write(data_dir.join(FILE_NAME), text).map_err(|e| e.to_string())?;
    Ok((entry, false))
}

/// `listCustomFilaments` input: a missing or unparsable file reads as empty.
fn load_store(data_dir: &Path) -> Value {
    fs::read_to_string(data_dir.join(FILE_NAME))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({ "filaments": [] }))
}

/// Filaments as Node's `listCustomFilaments` returns them.
pub fn list(data_dir: &Path) -> Vec<Value> {
    load_store(data_dir)
        .get("filaments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn is_hex6(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
