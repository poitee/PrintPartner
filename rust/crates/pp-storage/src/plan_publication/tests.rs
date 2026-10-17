#[path = "tests/client.rs"]
mod client;

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
    tx.execute_batch("INSERT INTO parts(id,tenant_id,profile_id,match_key) VALUES(11,'tenant',1,'bracket'),(99,'tenant',2,'other'),(11,'other',2,'other')").unwrap();
}

#[test]
fn remapped_settings_match_literal_node_results() {
    let cases = golden();
    for case in cases["remap"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["expected"]["kind"] != "unsafe")
    {
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
fn ownerless_queue_with_deleted_parts_is_unmappable_like_node() {
    let cases = golden();
    let case = cases["remap"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "ownerless-queue-deleted-part")
        .unwrap();
    assert_eq!(case["expected"]["kind"], "unsafe");
    assert_eq!(
        case["expected"]["unmappable"][0]["reason"],
        "Checked-off part id 500 no longer exists in this Plan's parts"
    );
    let mut connection = database();
    let tx = connection.transaction().unwrap();
    settings(&tx, &case["input"]["links"], &case["input"]["queue"]);
    let state = production(&tx, "tenant", 1).unwrap();
    assert_eq!((state.link_count, state.queue_count), (0, 0));
    let prepared = prepared(&cases["prepare"][2]).unwrap();
    let Remap::Unmappable(missing) = remap(&state, 1, &HashMap::new(), &prepared).unwrap() else {
        panic!("expected unmappable deleted queue part")
    };
    assert_eq!(missing.len(), 1);
    assert_eq!(
        serde_json::to_value(missing).unwrap(),
        case["expected"]["unmappable"]
    );
}

#[test]
fn production_accepts_checkoff_coordinates_owned_by_another_profile_like_node() {
    for case in golden()["production"].as_array().unwrap() {
        assert_eq!(
            case["input"]["parts"],
            json!([{ "id": 99, "profileId": 2 }])
        );
        let mut connection = database();
        let tx = connection.transaction().unwrap();
        settings(&tx, &case["input"]["links"], &case["input"]["queue"]);
        let state = production(&tx, "tenant", 1).unwrap();
        assert_eq!(
            json!({ "checkoffLinkCount": state.link_count, "sendQueueItemCount": state.queue_count }),
            case["expected"]["value"]
        );
        assert_eq!((state.link_count, state.queue_count), (1, 0));
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

mod transaction {
    use super::super::*;
    use rusqlite::{Connection, types::ValueRef};

    fn fixture() -> Value {
        let data = super::golden();
        json!({"definitions":data["transactionSchema"],"at":data["transactionAt"],"cases":data["transactions"]})
    }
    fn value(row: &Value) -> rusqlite::types::Value {
        match row {
            Value::Number(n) if !n.is_i64() => rusqlite::types::Value::Real(n.as_f64().unwrap()),
            _ => sql_value(row).unwrap(),
        }
    }
    pub(super) fn database(fixture: &Value, case: &Value) -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        let definitions = fixture["definitions"].as_array().unwrap();
        for d in definitions.iter().filter(|d| d["type"] == "table") {
            c.execute_batch(d["sql"].as_str().unwrap()).unwrap();
        }
        for (table, rows) in case["before"].as_object().unwrap() {
            for row in rows.as_array().unwrap() {
                let fields = row.as_object().unwrap();
                let sql = format!(
                    "INSERT INTO {table}({}) VALUES({})",
                    fields.keys().cloned().collect::<Vec<_>>().join(","),
                    vec!["?"; fields.len()].join(",")
                );
                c.execute(&sql, rusqlite::params_from_iter(fields.values().map(value)))
                    .unwrap();
            }
        }
        for d in definitions.iter().filter(|d| d["type"] != "table") {
            c.execute_batch(d["sql"].as_str().unwrap()).unwrap();
        }
        c.execute_batch(include_str!("schema.sql")).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        c
    }
    fn snapshot(c: &Connection, table: &str) -> Value {
        let mut statement = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let names: Vec<_> = statement
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        let result = statement
            .query_map([], |row| {
                let mut result = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let v = match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(std::str::from_utf8(s).unwrap()),
                        ValueRef::Blob(_) => panic!("Unexpected blob"),
                    };
                    result.insert(name.clone(), v);
                }
                Ok(Value::Object(result))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        json!(result)
    }
    struct Tokens(u128);
    impl RequiredUnitTokenAllocator for Tokens {
        fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure> {
            self.0 += 1;
            Ok(self.0.to_be_bytes())
        }
    }
    fn publish(
        tx: &Transaction<'_>,
        case: &Value,
        tokens: &mut dyn RequiredUnitTokenAllocator,
    ) -> Value {
        let input = &case["input"];
        let request: ApplyRequest = serde_json::from_value(json!({
        "expected_snapshot_digest": input["expectedSnapshotDigest"],
        "expected_lifecycle_version": input["expectedLifecycleVersion"],
        "expected_base": {"revision_id":input["expectedBase"].get("revisionId"),"plan_version":input["expectedBase"]["planVersion"]},
        "remap_checkoff_links":input["remapCheckoffLinks"]
    })).unwrap();
        let outcome = publish_in_transaction(
            tx,
            &AuthenticatedPublicationContext {
                tenant: "default".into(),
                actor: input["actorId"].as_str().unwrap().into(),
            },
            serde_json::from_value(input["profileId"].clone()).unwrap(),
            serde_json::from_value(input["draftId"].clone()).unwrap(),
            PublicationRequests::direct(&request),
            input["idempotencyKey"].as_str().unwrap(),
            tokens,
        )
        .unwrap_or_else(|e| panic!("{}: {e:#}", case["id"]));
        serde_json::to_value(outcome).unwrap()
    }
    fn node_outcome(outcome: &Value) -> Value {
        let mut result = outcome.clone();
        if let Some(receipt) = result.get_mut("receipt") {
            *receipt = model::canonical(
                receipt,
                &[
                    "profileId",
                    "draftId",
                    "revisionId",
                    "planVersion",
                    "draftLifecycleVersion",
                    "revisionDigest",
                    "requiredUnitMappingDigest",
                    "appliedAt",
                ],
            );
        }
        result
    }
    pub(super) fn replace_time(value: &mut Value, actual: &str, expected: &Value) {
        if actual.is_empty() {
            return;
        }
        match value {
            Value::String(s) if s == actual => *value = expected.clone(),
            Value::Array(rows) => rows
                .iter_mut()
                .for_each(|v| replace_time(v, actual, expected)),
            Value::Object(row) => row
                .values_mut()
                .for_each(|v| replace_time(v, actual, expected)),
            _ => {}
        }
    }
    #[test]
    fn transaction_replays_node_outcomes_receipts_and_persisted_rows() {
        let fixture = fixture();
        let cases = fixture["cases"].as_array().unwrap();
        for id in [
            "mapped-remap",
            "mapped-remap-index-change",
            "mapped-remap-index-0",
            "mapped-remap-index-2",
            "renamed-part",
        ] {
            assert!(
                cases.iter().any(|case| case["id"] == id),
                "Missing Node {id} transaction"
            );
        }
        for case in cases {
            let mut c = database(&fixture, case);
            let tx = c.transaction().unwrap();
            let mut actual = publish(
                &tx,
                case,
                &mut Tokens(case["allocationStart"].as_u64().unwrap().into()),
            );
            tx.commit().unwrap();
            let at = actual["receipt"]["applied_at"]
                .as_str()
                .unwrap_or("")
                .to_string();
            replace_time(&mut actual, &at, &fixture["at"]);
            let mut expected = node_outcome(&case["outcome"]);
            if case["id"] == "running-export" {
                // Node has no durable-job publication guard. Its literal outcome is applied.
                assert_eq!(expected["kind"], "applied");
                let job = &case["before"]["durable_jobs"][0];
                expected = json!({"kind":"execution_conflict","operations":[{"operation_id":job["id"],"kind":job["kind"],"state":job["state"]}]});
            } else if case["id"] == "mapped-remap-index-0" {
                assert_eq!(expected["kind"], "applied");
                assert_token_consistent_remap(case, None);
                expected = json!({"kind":"checkoff_remap_unsafe","unmappable":[{"linkId":"kept-slot","filename":"bracket.stl","reason":"Required unit at Part 1 index 0 is absent or excluded in the selected Plan"}]});
            }
            assert_eq!(actual, expected, "{}", case["id"]);
            let state =
                if actual["kind"] == "execution_conflict" || case["id"] == "mapped-remap-index-0" {
                    &case["before"]
                } else {
                    &case["after"]
                };
            for table in [
                "build_profiles",
                "parts",
                "print_progress",
                "plan_revisions",
                "plan_revision_parts",
                "plan_revision_input_sets",
                "plan_revision_inputs",
                "plan_accepted_input_sets",
                "required_units",
                "plan_revision_required_unit_sets",
                "plan_revision_required_units",
                "plan_drafts",
                "plan_apply_requests",
                "app_settings",
            ] {
                let mut actual = snapshot(&c, table);
                replace_time(&mut actual, &at, &fixture["at"]);
                if case["id"] == "mapped-remap-index-change" && table == "app_settings" {
                    assert_token_consistent_remap(case, Some(&actual));
                } else {
                    assert_eq!(
                        actual,
                        state.get(table).cloned().unwrap_or(json!([])),
                        "{} {table}",
                        case["id"]
                    );
                }
            }
            if actual["kind"] == "checkoff_remap_unsafe" {
                assert_eq!(snapshot(&c, "plan_apply_admissions"), json!([]));
            }
            if actual["kind"] == "applied" {
                let tx = c.transaction().unwrap();
                let mut replay = publish(&tx, case, &mut Tokens(0));
                tx.commit().unwrap();
                replace_time(&mut replay, &at, &fixture["at"]);
                assert_eq!(replay["kind"], "existing");
                assert_eq!(replay["receipt"], actual["receipt"]);
                assert!(
                    c.execute(
                        "UPDATE plan_apply_admissions SET request_digest='tampered'",
                        []
                    )
                    .is_err()
                );
                assert!(c.execute("DELETE FROM plan_apply_admissions", []).is_err());
            }
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                0
            );
        }
    }

    fn assert_token_consistent_remap(case: &Value, actual: Option<&Value>) {
        let token = |state: &Value, coordinate: &Value| {
            let part = state["plan_revision_parts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|part| part["projection_part_id"] == coordinate["part_id"])
                .unwrap();
            state["plan_revision_required_units"]
                .as_array()
                .unwrap()
                .iter()
                .find(|unit| {
                    unit["revision_part_id"] == part["id"]
                        && unit["revision_id"] == part["revision_id"]
                        && unit["unit_index"] == coordinate["unit_index"]
                })
                .unwrap()["required_unit_token"]
                .clone()
        };
        let mut expected_settings = case["after"]["app_settings"].clone();
        for (key, field) in [
            ("printer.checkoff_links", "units"),
            ("printer.checkoff_links", "resolved_units"),
            ("printer.send_queue", "checkoff_units"),
        ] {
            let coordinate = |settings: &Value| {
                let setting = settings
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|setting| setting["key"] == key)
                    .unwrap();
                let rows: Value = serde_json::from_str(setting["value"].as_str().unwrap()).unwrap();
                rows[0][field][0].clone()
            };
            let before = token(
                &case["before"],
                &coordinate(&case["before"]["app_settings"]),
            );
            let node = token(&case["after"], &coordinate(&case["after"]["app_settings"]));
            assert_ne!(node, before, "{key} {field}");
            if let Some(actual) = actual {
                assert_eq!(before, "ppu_00000000000000000000000000000002");
                assert_eq!(node, "ppu_00000000000000000000000000000003");
                assert_eq!(
                    token(&case["after"], &coordinate(actual)),
                    before,
                    "{key} {field}"
                );
                let setting = expected_settings
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|setting| setting["key"] == key)
                    .unwrap();
                let mut rows: Value =
                    serde_json::from_str(setting["value"].as_str().unwrap()).unwrap();
                rows[0][field][0]["unit_index"] = json!(0);
                setting["value"] = json!(rows.to_string());
            } else {
                assert_eq!(before, "ppu_00000000000000000000000000000001");
                assert_eq!(node, "ppu_00000000000000000000000000000002");
                assert!(
                    case["after"]["plan_revision_required_units"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|unit| unit["revision_id"] == 2)
                        .all(|unit| unit["required_unit_token"] != before)
                );
            }
        }
        if let Some(actual) = actual {
            assert_eq!(*actual, expected_settings);
        }
    }

    #[test]
    fn caller_rollback_and_token_exhaustion_leave_publication_unwritten() {
        let fixture = fixture();
        let case = &fixture["cases"][0];
        let mut c = database(&fixture, case);
        {
            let tx = c.transaction().unwrap();
            assert_eq!(publish(&tx, case, &mut Tokens(0))["kind"], "applied");
        }
        struct Unavailable(usize);
        impl RequiredUnitTokenAllocator for Unavailable {
            fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure> {
                self.0 += 1;
                Err(TokenAllocationFailure)
            }
        }
        let mut tokens = Unavailable(0);
        let tx = c.transaction().unwrap();
        assert_eq!(
            publish(&tx, case, &mut tokens),
            json!({"kind":"token_allocation_failed"})
        );
        tx.commit().unwrap();
        assert_eq!(tokens.0, 32);
        for (table, rows) in case["before"].as_object().unwrap() {
            assert_eq!(snapshot(&c, table), *rows, "{table}");
        }
        for table in [
            "plan_revisions",
            "parts",
            "plan_apply_requests",
            "plan_apply_admissions",
            "plan_revision_input_sets",
            "required_units",
        ] {
            assert_eq!(snapshot(&c, table), json!([]), "{table}");
        }
    }
}

#[test]
fn publication_job_scope_terminal_states_and_deferred_start_bindings() {
    let golden = golden();
    let fixture = json!({"definitions":golden["transactionSchema"]});
    let cases = golden["transactions"].as_array().unwrap();
    let export = cases.iter().find(|c| c["id"] == "running-export").unwrap();
    let mut c = transaction::database(&fixture, export);
    let tx = c.transaction().unwrap();
    let update = |id: &str, record: &Value| {
        tx.execute(
            "UPDATE durable_jobs SET state=?,document=? WHERE id=?",
            params![record["state"].as_str().unwrap(), record.to_string(), id],
        )
        .unwrap();
    };
    let mut job: Value = serde_json::from_str(
        export["before"]["durable_jobs"][0]["document"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    job["state"] = json!("succeeded");
    update("running-export", &job);
    assert!(
        crate::jobs::publication_conflicts(&tx, "default", 1)
            .unwrap()
            .is_empty()
    );
    job["state"] = json!("running");
    job["payload"]["payload"]["profile_id"] = json!(2);
    update("running-export", &job);
    assert!(
        crate::jobs::publication_conflicts(&tx, "default", 1)
            .unwrap()
            .is_empty()
    );
    tx.rollback().unwrap();

    let upload = cases.iter().find(|c| c["id"] == "uploaded-only").unwrap();
    let mut c = transaction::database(&fixture, upload);
    let tx = c.transaction().unwrap();
    let mut parent: Value = serde_json::from_str(
        upload["before"]["durable_jobs"][0]["document"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(
        crate::jobs::publication_conflicts(&tx, "default", 1)
            .unwrap()
            .is_empty()
    );
    let mut start = parent.clone();
    start["job_id"] = json!("start");
    start["payload"] = json!({"kind":"printer-start","payload":{"uploaded_job_id":"uploaded-only","binding":{"printer_id":"printer","upload_effect":parent["effects"][0]}}});
    start["state"] = json!("running");
    start["effects"] = json!([]);
    start["result"] = Value::Null;
    start["finished_at"] = Value::Null;
    tx.execute("INSERT INTO durable_jobs VALUES ('start','default','printer-upload','running','fixture',1,1,NULL,1,1,?)", [start.to_string()]).unwrap();
    let conflicts = crate::jobs::publication_conflicts(&tx, "default", 1).unwrap();
    assert_eq!(
        conflicts
            .iter()
            .map(|c| c.operation_id.as_str())
            .collect::<Vec<_>>(),
        ["start"]
    );
    assert!(
        crate::jobs::publication_conflicts(&tx, "other", 1)
            .unwrap()
            .is_empty()
    );
    start["payload"]["payload"]["binding"]["printer_id"] = json!("different-printer");
    tx.execute(
        "UPDATE durable_jobs SET document=? WHERE id='start'",
        [start.to_string()],
    )
    .unwrap();
    assert!(crate::jobs::publication_conflicts(&tx, "default", 1).is_err());
    start["payload"]["payload"]["binding"]["printer_id"] = json!("printer");
    tx.execute(
        "UPDATE durable_jobs SET document=? WHERE id='start'",
        [start.to_string()],
    )
    .unwrap();
    parent["payload"]["payload"]["profile_id"] = Value::Null;
    parent["payload"]["payload"]["checkoff_units"] = json!([{"part_id":999,"unit_index":0}]);
    tx.execute(
        "UPDATE durable_jobs SET document=? WHERE id='uploaded-only'",
        [parent.to_string()],
    )
    .unwrap();
    assert_eq!(
        crate::jobs::publication_conflicts(&tx, "default", 1)
            .unwrap()
            .len(),
        1
    );
}
