use pp_contracts::autosave as contracts;
use serde::Serialize;
use serde_json::{Value, json};
use std::{env, fs, process};

fn outcome<T: Serialize>(result: Result<T, contracts::BoundaryError>) -> Value {
    match result {
        Ok(value) => {
            json!({ "kind": "accepted", "parsed": serde_json::to_value(value).expect("DTO serialization") })
        }
        Err(error) => json!({ "kind": "rejected", "error": error }),
    }
}

fn parse_case(item: &Value) -> Value {
    let text = item["raw_input"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| item["input"].to_string());
    match item["parser"].as_str().expect("exported parser name") {
        "parseSavePlanChoicesRequest" => outcome(contracts::parse_request(&text)),
        "parseApplyPlanDraftReceipt" => outcome(contracts::parse_receipt(&text)),
        "parsePlanDraftIdentity" => outcome(contracts::parse_identity(&text)),
        other => panic!("Unimplemented parser in authoritative corpus: {other}"),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        return Err("Usage: pp-contracts-probe NODE-CASES.json OUTPUT.json".into());
    }
    let corpus: Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let mut mismatches = Vec::new();
    let mut cases = Vec::new();
    for collection in ["cases", "supplemental"] {
        for item in corpus[collection]
            .as_array()
            .ok_or("Missing Node case array")?
        {
            let rust = parse_case(item);
            let matches = rust["kind"] == item["outcome"]["kind"]
                && (rust["kind"] != "accepted" || rust["parsed"] == item["outcome"]["parsed"]);
            let result = json!({ "name": item["name"], "collection": collection, "direction": item["direction"], "node": item["outcome"], "rust": rust, "matches": matches });
            if !matches {
                mismatches.push(result.clone());
            }
            cases.push(result);
        }
    }
    let mut receipts = Vec::new();
    for item in corpus["route_receipts"]
        .as_array()
        .ok_or("Missing actual route receipts")?
    {
        let rust = outcome(contracts::parse_receipt(&item["receipt"].to_string()));
        let matches = rust["kind"] == "accepted" && rust["parsed"] == item["receipt"];
        let result = json!({ "name": item["name"], "node_receipt": item["receipt"], "rust": rust, "matches": matches });
        if !matches {
            mismatches.push(result.clone());
        }
        receipts.push(result);
    }
    let report = json!({ "source": corpus["source"], "projection": { "required": ["accept_or_reject", "accepted_parsed_json", "serialized_receipt_identity"], "diagnostics": "Rust category/field/detail retained separately; Zod issue wording is not projected as equal" }, "cases": cases, "route_receipts": receipts, "mismatches": mismatches });
    fs::write(
        &args[2],
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    println!(
        "{}: {} actual Node cases, {} supplemental cases, {} actual route receipts; {} mismatches",
        if mismatches.is_empty() {
            "PASS"
        } else {
            "ISSUES"
        },
        corpus["cases"].as_array().unwrap().len(),
        corpus["supplemental"].as_array().unwrap().len(),
        receipts.len(),
        mismatches.len()
    );
    if !mismatches.is_empty() {
        process::exit(1);
    }
    Ok(())
}
