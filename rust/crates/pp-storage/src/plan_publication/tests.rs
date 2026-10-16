use super::*;
use crate::manifest_text::{JsText, ManifestText, OptionGroupId, PartManifestMetadata};
use rusqlite::Connection;

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/plan-publication/node.json"
    ))
    .unwrap()
}

fn part(mut row: Value) -> DraftPart {
    let mut take = |field: &str| {
        row.as_object_mut()
            .unwrap()
            .remove(field)
            .filter(|v| !v.is_null())
            .map(|v| JsText::scalar(v.as_str().unwrap()))
    };
    let requirement = take("requirement").map(ManifestText);
    let option_group_id = take("optionGroupId").map(OptionGroupId);
    let manifest_source = take("manifestSource").map(|v| v.as_scalar().unwrap());
    DraftPart::new(
        row,
        PartManifestMetadata {
            requirement,
            option_group_id,
            manifest_source,
        },
    )
}

fn prepared(case: &Value) -> Result<Prepared> {
    let input = &case["input"];
    let parts = input["draft"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(part)
        .collect();
    let base = input["baseUnits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| {
            (
                unit["token"].as_str().unwrap().into(),
                (
                    Value::Null,
                    unit["completed"].as_bool().unwrap(),
                    unit["assembled"].as_bool().unwrap(),
                ),
            )
        })
        .collect();
    model::prepare(parts, &input["assignments"], &base)
}

fn error(result: Result<impl Sized>) -> String {
    result.err().unwrap().to_string()
}

#[test]
fn preparation_matches_literal_node_digests_progress_and_slots() {
    for case in golden()["prepare"].as_array().unwrap() {
        if case["expected"].get("error").is_some() {
            continue;
        }
        let prepared = prepared(case).unwrap();
        let slots: Vec<_> = prepared.assignments.iter().map(Assignment::slot).collect();
        assert_eq!(
            json!({"digest":prepared.digest,"progress":prepared.progress,"slots":slots}),
            case["expected"]["value"],
            "{}",
            case["id"]
        );
        let mut reversed = prepared.parts;
        reversed.reverse();
        assert_eq!(model::revision_digest(&reversed).unwrap(), prepared.digest);
        if let Some(first) = reversed.first_mut() {
            first["notes"] = json!("changed");
            assert_ne!(model::revision_digest(&reversed).unwrap(), prepared.digest);
        }
    }
}

#[test]
fn preparation_rejections_preserve_reference_diagnostics() {
    let cases = golden();
    for (id, node, reference) in [
        (
            "duplicate-part",
            "Plan publication draft Part is duplicated",
            "Duplicate draft Part",
        ),
        (
            "missing-part",
            "Plan publication assignment Part is missing",
            "Invalid assignment coordinate",
        ),
        (
            "noncontiguous",
            "Plan publication assignment indexes are not contiguous",
            "Invalid assignment coordinate",
        ),
        (
            "duplicate-reuse",
            "Plan publication reused token is duplicated",
            "Duplicate reused unit",
        ),
        (
            "unknown-reuse",
            "Plan publication reused token is unknown",
            "Unknown reused unit",
        ),
        (
            "invalid-progress",
            "Plan publication base progress is corrupt",
            "Invalid base progress",
        ),
        (
            "incomplete",
            "Plan publication assignment count is incomplete",
            "Incomplete publication quantity",
        ),
        (
            "invalid-quantity",
            "Plan publication quantity is invalid",
            "Incomplete publication quantity",
        ),
    ] {
        let case = cases["prepare"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap();
        assert_eq!(case["expected"]["error"], node);
        assert_eq!(error(prepared(case)), reference, "{id}");
    }
}

fn database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    let fields = ru::model::PART_FIELDS
        .iter()
        .map(|field| model::snake(field))
        .collect::<Vec<_>>()
        .join(",");
    connection.execute_batch(&format!(
        "CREATE TABLE parts(id INTEGER,tenant_id TEXT,profile_id INTEGER,match_key,quantity_auto,role,{fields});
         CREATE TABLE plan_revision_parts(id INTEGER,tenant_id TEXT,revision_id INTEGER,projection_part_id,{fields});
         CREATE TABLE plan_revisions(id INTEGER,tenant_id TEXT,profile_id INTEGER,digest_format,snapshot_digest);
         CREATE TABLE print_progress(tenant_id TEXT,part_id INTEGER,unit_index INTEGER,completed INTEGER,assembled INTEGER);
         CREATE TABLE app_settings(tenant_id TEXT,key TEXT,value TEXT);"
    )).unwrap();
    connection
}

fn insert_part(tx: &Transaction<'_>, table: &str, row: &Value) {
    let part = part(row.clone());
    let fields: Vec<_> = part
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .chain(["requirement", "optionGroupId", "manifestSource"])
        .collect();
    let fields = part.sql_fields(&fields).unwrap();
    let columns = fields
        .iter()
        .map(|(key, _)| model::snake(key))
        .collect::<Vec<_>>()
        .join(",");
    let placeholders = vec!["?"; fields.len()].join(",");
    tx.execute(
        &format!("INSERT INTO {table}(tenant_id,{columns}) VALUES('tenant',{placeholders})"),
        rusqlite::params_from_iter(fields.iter().map(|(_, value)| value)),
    )
    .unwrap();
}

fn seed_projection(tx: &Transaction<'_>, case: &Value) {
    let input = &case["input"];
    let revision = &input["revision"];
    if !revision.is_null() {
        tx.execute(
            "INSERT INTO plan_revisions VALUES(1,'tenant',1,?,?)",
            params![
                revision["digestFormat"].as_str(),
                revision["snapshotDigest"].as_str()
            ],
        )
        .unwrap();
        for row in revision["parts"].as_array().unwrap() {
            let mut row = row.clone();
            for key in ["draftId", "baseRevisionPartId", "effectiveRole"] {
                row.as_object_mut().unwrap().remove(key);
            }
            row["revisionId"] = json!(1);
            insert_part(tx, "plan_revision_parts", &row);
        }
    }
    for row in input["projections"].as_array().unwrap() {
        let mut row = row.clone();
        row["profileId"] = json!(1);
        insert_part(tx, "parts", &row);
        for index in 0..2 {
            tx.execute(
                "INSERT INTO print_progress VALUES('tenant',?, ?,1,0)",
                params![row["id"].as_i64(), index],
            )
            .unwrap();
        }
    }
}

#[test]
fn projection_acceptance_and_rejection_match_node_with_reference_diagnostics() {
    for case in golden()["projection"].as_array().unwrap() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        seed_projection(&tx, case);
        let result = validate_projection(&tx, "tenant", 1, 1);
        assert_eq!(
            result.is_ok(),
            case["expected"]["value"] == true,
            "{}",
            case["id"]
        );
        if let Some(node) = case["expected"]["error"].as_str() {
            let reference = match case["id"].as_str().unwrap() {
                "missing-revision" => "Missing accepted revision",
                "digest" | "format" => "Accepted revision digest mismatch",
                "count" => "Accepted projection count mismatch",
                "missing-projection" => "Missing accepted projection",
                "filename" => "Accepted projection mismatch filename",
                "manifest" => "Accepted manifest projection mismatch",
                _ => unreachable!(),
            };
            assert_eq!(
                node,
                if matches!(
                    case["id"].as_str(),
                    Some("missing-revision" | "digest" | "format")
                ) {
                    "Accepted Plan revision digest is corrupt"
                } else {
                    "Accepted Plan compatibility projection is corrupt"
                }
            );
            assert_eq!(error(result), reference);
        } else {
            let parts = result.unwrap();
            assert_eq!(parts.len(), 1);
            for field in ["filamentColorId", "filamentCustomHex", "spoolmanSpoolId"] {
                assert_eq!(parts[0][field], case["input"]["projections"][0][field]);
            }
            assert_eq!(
                error(validate_projection(&tx, "other", 1, 1)),
                "Missing accepted revision"
            );
            assert_eq!(
                error(validate_projection(&tx, "tenant", 2, 1)),
                "Missing accepted revision"
            );
        }
    }
}

#[test]
fn projection_progress_checks_preserve_reference_behavior() {
    for (sql, expected) in [
        (
            "DELETE FROM print_progress WHERE unit_index=1",
            "Incomplete accepted progress",
        ),
        (
            "UPDATE print_progress SET completed=0,assembled=1",
            "Invalid accepted progress",
        ),
        (
            "UPDATE print_progress SET completed=2",
            "Invalid accepted progress",
        ),
        (
            "UPDATE print_progress SET assembled=-1",
            "Invalid accepted progress",
        ),
    ] {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        seed_projection(&tx, &golden()["projection"][0]);
        tx.execute_batch(sql).unwrap();
        assert_eq!(error(validate_projection(&tx, "tenant", 1, 1)), expected);
    }
}

fn settings(tx: &Transaction<'_>, links: &Value, queue: &Value) {
    for (key, value) in [
        ("printer.checkoff_links", links),
        ("printer.send_queue", queue),
    ] {
        tx.execute(
            "INSERT INTO app_settings VALUES('tenant',?,?)",
            params![key, value.to_string()],
        )
        .unwrap();
    }
    tx.execute_batch("INSERT INTO parts(id,tenant_id,profile_id) VALUES(11,'tenant',1),(99,'tenant',2),(11,'other',2)").unwrap();
}

#[test]
fn remapped_settings_match_literal_node_results() {
    let cases = golden();
    for case in cases["remap"].as_array().unwrap() {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        settings(&tx, &case["input"]["links"], &case["input"]["queue"]);
        let production = production(&tx, "tenant", 1).unwrap();
        let active = usize::from(case["id"] == "links-queue-resolved");
        assert_eq!(
            (production.link_count, production.queue_count),
            (active, active)
        );
        let prepared = prepared(&cases["prepare"][2]).unwrap();
        let tokens = HashMap::from([
            ((11, 0), format!("ppu_{:032x}", 1)),
            ((11, 1), format!("ppu_{:032x}", 2)),
        ]);
        let Remap::Mapped(mapping) = remap(&production, 1, &tokens, &prepared).unwrap() else {
            panic!("unexpected unmappable link")
        };
        let mut actual: Vec<_> = mapping.iter().map(|(from, to)| (*from, *to)).collect();
        actual.sort();
        assert_eq!(json!(actual), case["expected"]["mapping"]);
        write_remap(
            &tx,
            "tenant",
            production,
            &mapping,
            &HashMap::from([(21, 31)]),
        )
        .unwrap();
        for key in ["printer.checkoff_links", "printer.send_queue"] {
            assert_eq!(
                json!(setting(&tx, "tenant", key).unwrap().unwrap()),
                case["expected"]["settings"][key]
            );
            assert!(setting(&tx, "other", key).unwrap().is_none());
        }
    }
}

#[test]
fn token_remap_handles_exclusion_missing_tokens_and_changed_indexes() {
    let cases = golden();
    let mut connection = database();
    let tx = connection.transaction().unwrap();
    let case = &cases["remap"][0];
    settings(&tx, &case["input"]["links"], &case["input"]["queue"]);
    let state = production(&tx, "tenant", 1).unwrap();
    let mut prepared = prepared(&cases["prepare"][2]).unwrap();
    let tokens = HashMap::from([
        ((11, 0), format!("ppu_{:032x}", 2)),
        ((11, 1), format!("ppu_{:032x}", 1)),
    ]);
    let Remap::Mapped(mapping) = remap(&state, 1, &tokens, &prepared).unwrap() else {
        panic!("expected mapping")
    };
    assert_eq!(
        mapping,
        HashMap::from([((11, 0), (21, 1)), ((11, 1), (21, 0))])
    );
    assert_eq!(
        error(write_remap(&tx, "tenant", state, &mapping, &HashMap::new())),
        "Missing remap projection"
    );
    let state = production(&tx, "tenant", 1).unwrap();
    prepared.parts[0]["included"] = json!(false);
    for tokens in [&tokens, &HashMap::new()] {
        let Remap::Unmappable(missing) = remap(&state, 1, tokens, &prepared).unwrap() else {
            panic!("expected unmappable links")
        };
        assert_eq!(
            serde_json::to_value(missing).unwrap(),
            json!([
                {"linkId":"link","filename":"bracket.stl","reason":"Required unit at Part 11 index 0 is absent or excluded in the selected Plan"},
                {"linkId":"link","filename":"bracket.stl","reason":"Required unit at Part 11 index 1 is absent or excluded in the selected Plan"}
            ])
        );
    }
}

#[test]
fn production_rejects_corrupt_settings_coordinates_and_owners() {
    for (key, value, expected) in [
        ("printer.checkoff_links", "{}", "Invalid production setting"),
        (
            "printer.checkoff_links",
            r#"[{"profile_id":1,"state":"bad","units":[]}]"#,
            "Invalid Checkoff link",
        ),
        (
            "printer.checkoff_links",
            r#"[{"profile_id":1,"state":"watching","units":{}}]"#,
            "Invalid Checkoff units",
        ),
        (
            "printer.checkoff_links",
            r#"[{"profile_id":1,"state":"watching","units":[{"part_id":0,"unit_index":0}]}]"#,
            "Invalid production coordinate",
        ),
        (
            "printer.checkoff_links",
            r#"[{"profile_id":1,"state":"watching","units":[{"part_id":99,"unit_index":0}]}]"#,
            "Checkoff coordinate ownership mismatch",
        ),
        (
            "printer.send_queue",
            r#"[{"state":"bad"}]"#,
            "Invalid queue state",
        ),
        (
            "printer.send_queue",
            r#"[{"state":"queued","profile_id":0}]"#,
            "Invalid queue owner",
        ),
        (
            "printer.send_queue",
            r#"[{"state":"queued","checkoff_units":{}}]"#,
            "Invalid queue units",
        ),
        (
            "printer.send_queue",
            r#"[{"state":"queued","checkoff_units":[{"part_id":11,"unit_index":0},{"part_id":99,"unit_index":0}]}]"#,
            "Queue owner mismatch",
        ),
    ] {
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        settings(&tx, &json!([]), &json!([]));
        tx.execute(
            "UPDATE app_settings SET value=? WHERE tenant_id='tenant' AND key=?",
            params![value, key],
        )
        .unwrap();
        assert_eq!(error(production(&tx, "tenant", 1)), expected);
    }
}

#[test]
fn empty_settings_and_model_utilities_preserve_reference_behavior() {
    let cases = golden();
    for case in cases["objects"].as_array().unwrap() {
        assert_eq!(
            model::object_name(
                case["filename"].as_str().unwrap(),
                case["token"].as_str().unwrap()
            ),
            case["expected"]
        );
    }
    assert_eq!(model::REQUEST_FORMAT, "plan-apply-request-v1");
    assert_eq!(
        model::inputs(&[json!({"sourceId":2}), json!({"sourceId":1})])[0]["source_id"],
        1
    );
    let mut connection = database();
    let tx = connection.transaction().unwrap();
    assert!(setting(&tx, "tenant", "missing").unwrap().is_none());
    tx.execute_batch("INSERT INTO app_settings VALUES('tenant','blank','  ')")
        .unwrap();
    assert!(setting(&tx, "tenant", "blank").unwrap().is_none());
    let empty = production(&tx, "tenant", 1).unwrap();
    write_remap(&tx, "tenant", empty, &HashMap::new(), &HashMap::new()).unwrap();
}
