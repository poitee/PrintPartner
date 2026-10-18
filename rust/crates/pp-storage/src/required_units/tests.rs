use super::{storage, view};
use rusqlite::{Connection, Transaction};
use serde_json::{Value, json};

const UNCHANGED: &[u8] = include_bytes!("../../tests/fixtures/required-units/unchanged.db");
const SHRINK: &[u8] = include_bytes!("../../tests/fixtures/required-units/shrink.db");
const UNSAFE: &[u8] = include_bytes!("../../tests/fixtures/required-units/unsafe.db");
const UNCHANGED_RESULT: &str = include_str!("../../tests/fixtures/required-units/unchanged.json");
const SELECTED: &str = "780d6b57347b7aea81c8c6772b289b58bb244b2bf5dd621b97e627c7f7df04c6";
const MAPPING: &str = "8c446659d41d31efe3d95931c9f898b0d5442a41104474671bdccab4779e3a41";

struct Database {
    path: std::path::PathBuf,
    connection: Connection,
}

impl Database {
    fn open(bytes: &[u8]) -> Self {
        let path = crate::tests::directory("required-units");
        std::fs::write(path.join("node.db"), bytes).unwrap();
        let connection = Connection::open(path.join("node.db")).unwrap();
        Self { path, connection }
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn error(result: anyhow::Result<impl Sized>) -> String {
    result
        .err()
        .map(|error| error.to_string())
        .unwrap_or_default()
}

#[test]
fn node_digests_and_required_unit_sets_verify() {
    for (bytes, planning, completed) in [
        (
            UNCHANGED,
            "ae11e670337e3e5eab736b29b4e294edbea8b564661cf15972625783f8930ee3",
            None,
        ),
        (
            SHRINK,
            "3053fc914dfaf337f2985855d5a844b1052c2243c764730b29b0670bffcf6db7",
            Some(3),
        ),
        (
            UNSAFE,
            "bf94903ce115487a4680bf6c4bb49b1033acbe9ab1e40ce84aa9b8cd55e8dea1",
            None,
        ),
    ] {
        let mut db = Database::open(bytes);
        let tx = db.connection.transaction().unwrap();
        let open = storage::draft(&tx, "default", 1, 2).unwrap().unwrap();
        assert_eq!(open.planning, planning);
        assert!(open.selected.is_none());
        let consumed = storage::draft(&tx, "default", 1, 1).unwrap().unwrap();
        assert_eq!(
            consumed.selected.unwrap().header["reconciliationDigest"],
            SELECTED
        );
        assert!(storage::draft(&tx, "default", 1, 9).unwrap().is_none());
        assert!(storage::draft(&tx, "other", 1, 2).unwrap().is_none());
        let (mapping, parts) = storage::base(&tx, "default", 1, Some(1)).unwrap().unwrap();
        assert_eq!(mapping, MAPPING);
        let units: Vec<_> = parts
            .iter()
            .flat_map(|part| part.units.iter().map(move |unit| (part.id, unit)))
            .map(|(part, unit)| json!([part, unit.prior_index, unit.token, unit.completed]))
            .collect();
        let expected: Vec<_> = [(1, 0), (1, 1), (1, 2), (2, 0), (3, 0), (3, 1)]
            .into_iter()
            .zip(1..)
            .map(|((part, index), n)| {
                json!([part, index, format!("ppu_{n:032x}"), completed == Some(n)])
            })
            .collect();
        assert_eq!(units, expected);
        assert!(parts.iter().all(|part| part.source_id == Some(1)));
        assert_eq!(
            storage::base(&tx, "default", 1, None).unwrap().unwrap().0,
            Value::Null
        );
    }
}

#[test]
fn workspaces_match_node_parts_diff_and_selection() {
    let mut db = Database::open(UNCHANGED);
    let tx = db.connection.transaction().unwrap();
    let profile = json!({"acceptedPlanRevisionId":1,"acceptedPlanVersion":1});
    let workspace = |id| {
        let draft = storage::draft(&tx, "default", 1, id).unwrap().unwrap();
        serde_json::to_value(view::workspace(&tx, "default", &profile, &draft).unwrap()).unwrap()
    };
    let case: Value = serde_json::from_str(UNCHANGED_RESULT).unwrap();
    let mut unselected = case["result"]["workspace"].clone();
    unselected["draft"]["snapshot_digest"] = case["request"]["expected_snapshot_digest"].clone();
    unselected["reconciliation"] = json!({"kind":"unresolved","conflicts":[]});
    assert_eq!(workspace(2), unselected);
    let consumed = workspace(1);
    assert_eq!(consumed["draft"]["state"], "consumed");
    assert_eq!(
        consumed["reconciliation"],
        json!({"kind":"ready","reused_units":0,"new_units":6,"surplus_units":0})
    );
}

fn check(tx: &Transaction<'_>, sql: &str, draft: i64) -> String {
    tx.execute_batch(&format!("SAVEPOINT corrupt; {sql}"))
        .unwrap();
    let message = if draft == 0 {
        error(storage::base(tx, "default", 1, Some(1)))
    } else {
        error(storage::draft(tx, "default", 1, draft))
    };
    tx.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
        .unwrap();
    message
}

fn allow_corruption(db: &Database) {
    let triggers: Vec<String> = db
        .connection
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    db.connection
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    for trigger in triggers {
        db.connection
            .execute_batch(&format!("DROP TRIGGER \"{trigger}\""))
            .unwrap();
    }
}

#[test]
fn corrupt_rows_return_node_messages() {
    let mut db = Database::open(UNCHANGED);
    allow_corruption(&db);
    let tx = db.connection.transaction().unwrap();
    let zero = "0".repeat(64);
    let reconciliation = "UPDATE plan_draft_required_unit_reconciliations SET";
    let set = "UPDATE plan_revision_required_unit_sets SET";
    let cases = [
        (
            format!("UPDATE plan_drafts SET snapshot_digest='{zero}' WHERE id=2"),
            2,
            "Plan draft snapshot digest mismatch",
        ),
        (
            "UPDATE plan_drafts SET digest_format='plan-draft-v3' WHERE id=2".into(),
            2,
            "Plan draft digest format is unsupported",
        ),
        (
            "UPDATE plan_drafts SET current_required_unit_reconciliation_id=1 WHERE id=2".into(),
            2,
            "Plan draft Required-unit selection is corrupt",
        ),
        (
            "UPDATE plan_drafts SET digest_format='plan-draft-v1' WHERE id=1".into(),
            1,
            "Plan draft v1 cannot select a Required-unit reconciliation",
        ),
        (
            format!("{reconciliation} finalized_at=NULL"),
            1,
            "Plan draft Required-unit selection is corrupt",
        ),
        (
            format!("{reconciliation} format='v0'"),
            1,
            "Required-unit reconciliation format is unsupported",
        ),
        (
            format!("{reconciliation} selection_basis_json=' []'"),
            1,
            "Required-unit selection basis is not canonical",
        ),
        (
            format!("{reconciliation} result_json='{{}}'"),
            1,
            "Required-unit reconciliation kind is invalid",
        ),
        (
            format!(
                "{reconciliation} result_json=replace(result_json,'\"surplus\":[]','\"surplus\":[\"ppu_1\"]')"
            ),
            1,
            "Required-unit token is invalid",
        ),
        (
            format!("{reconciliation} result_kind='unresolved'"),
            1,
            "Required-unit reconciliation result kind mismatch",
        ),
        (
            format!("{reconciliation} result_digest='{zero}'"),
            1,
            "Required-unit reconciliation result digest mismatch",
        ),
        (
            format!("{reconciliation} decision_digest='{zero}'"),
            1,
            "Required-unit reconciliation decision digest mismatch",
        ),
        (
            format!("{reconciliation} reconciliation_digest='{zero}'"),
            1,
            "Required-unit reconciliation digest mismatch",
        ),
        (
            "DELETE FROM plan_draft_required_unit_assignments WHERE unit_index=2".into(),
            1,
            "Required-unit reconciliation assignment count mismatch",
        ),
        (
            format!("{set} mapping_digest='{zero}'"),
            0,
            "Required-unit set digest is corrupt",
        ),
        (
            format!("{set} format='v0'"),
            0,
            "Required-unit set format is corrupt",
        ),
        (
            format!("{set} expected_unit_count=7"),
            0,
            "Required-unit set is incomplete",
        ),
        (
            "DELETE FROM plan_revision_required_unit_sets".into(),
            0,
            "Required-unit set is partial",
        ),
        (
            "UPDATE required_units SET object_name='bad/'||token".into(),
            0,
            "Required-unit Object name is invalid",
        ),
        (
            "UPDATE print_progress SET assembled=1".into(),
            0,
            "Required-unit progress is corrupt",
        ),
        (
            "UPDATE plan_revision_parts SET quantity_effective=0 WHERE id=2".into(),
            0,
            "Accepted Plan revision Part 2 has invalid quantity",
        ),
        (
            "UPDATE plan_revision_parts SET projection_part_id=NULL".into(),
            0,
            "Accepted Plan revision Part has no compatibility projection ID",
        ),
    ];
    let messages: Vec<_> = cases
        .iter()
        .map(|(sql, draft, _)| check(&tx, sql, *draft))
        .collect();
    let expected: Vec<_> = cases.iter().map(|case| case.2).collect();
    assert_eq!(messages, expected);
}

fn node_message_cases(column: &str) {
    let mut db = Database::open(UNCHANGED);
    allow_corruption(&db);
    let tx = db.connection.transaction().unwrap();
    let cases = include_str!("../../tests/fixtures/required-units/messages-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|case| case["column"] == column)
        .collect::<Vec<_>>();
    assert!(!cases.is_empty());
    let mut mismatches = Vec::new();
    for case in cases {
        tx.execute_batch("SAVEPOINT malformed_json").unwrap();
        let sql = match column {
            "result_json" => {
                "UPDATE plan_draft_required_unit_reconciliations SET result_json=? WHERE id=1"
            }
            "selection_basis_json" => {
                "UPDATE plan_draft_required_unit_reconciliations SET selection_basis_json=? WHERE id=1"
            }
            _ => unreachable!(),
        };
        tx.execute(sql, [case["input"].as_str().unwrap()]).unwrap();
        let actual = error(storage::saved(&tx, "default", 1, 1, 1));
        let expected = case.get("rust").unwrap_or(&case["message"]);
        if actual != expected.as_str().unwrap() {
            mismatches.push(json!({"name":case["name"],"actual":actual,"expected":expected}));
        }
        tx.execute_batch("ROLLBACK TO malformed_json; RELEASE malformed_json")
            .unwrap();
    }
    assert_eq!(mismatches, Vec::<Value>::new());
}

#[test]
fn result_json_matches_node_messages() {
    node_message_cases("result_json");
}

#[test]
fn selection_basis_matches_node_messages() {
    node_message_cases("selection_basis_json");
}

#[test]
fn gre764_cancellation_during_base_mapping_read() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    let mut db = Database::open(UNCHANGED);
    let before = {
        let tx = db.connection.transaction().unwrap();
        storage::draft(&tx, "default", 1, 2).unwrap().unwrap()
    };
    let reading = Arc::new(AtomicBool::new(false));
    let flag = reading.clone();
    db.connection
        .authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
            if matches!(
                ctx.action,
                rusqlite::hooks::AuthAction::Read {
                    table_name: "plan_revision_required_units",
                    ..
                }
            ) {
                flag.store(true, Ordering::Relaxed);
            }
            rusqlite::hooks::Authorization::Allow
        }))
        .unwrap();
    let read_steps = Arc::new(AtomicUsize::new(0));
    let steps = read_steps.clone();
    let flag = reading.clone();
    db.connection
        .progress_handler(
            1,
            Some(move || {
                if flag.load(Ordering::Relaxed) {
                    steps.fetch_add(1, Ordering::Relaxed);
                }
                false
            }),
        )
        .unwrap();
    let complete_read_steps = {
        let tx = db.connection.transaction().unwrap();
        storage::base_checked(&tx, "default", 1, Some(1), &|| Ok(()))
            .unwrap()
            .unwrap();
        read_steps.load(Ordering::Relaxed)
    };
    read_steps.store(0, Ordering::Relaxed);
    reading.store(false, Ordering::Relaxed);
    let checks = std::cell::Cell::new(0);
    {
        let tx = db.connection.transaction().unwrap();
        tx.execute(
            "UPDATE plan_draft_parts SET notes='uncommitted' WHERE draft_id=2",
            [],
        )
        .unwrap();
        let result = storage::base_checked(&tx, "default", 1, Some(1), &|| {
            if reading.load(Ordering::Relaxed) {
                checks.set(checks.get() + 1);
                if checks.get() == 2 {
                    return Err(anyhow::anyhow!(crate::working_drafts::Failure::Cancelled));
                }
            }
            Ok(())
        });
        let error = result
            .err()
            .expect("base mapping read must stop before loading all six units");
        assert!(
            matches!(
                error.downcast_ref(),
                Some(crate::working_drafts::Failure::Cancelled)
            ),
            "{error:?}"
        );
        assert_eq!(checks.get(), 2);
        let stopped_read_steps = read_steps.load(Ordering::Relaxed);
        assert!(
            stopped_read_steps > 0 && stopped_read_steps < complete_read_steps,
            "mapping read executed {stopped_read_steps} SQL steps versus {complete_read_steps} for a complete read"
        );
    }
    let tx = db.connection.transaction().unwrap();
    let after = storage::draft(&tx, "default", 1, 2).unwrap().unwrap();
    assert_eq!(after.header, before.header);
    assert_eq!(after.parts, before.parts);
    assert_eq!(after.inputs, before.inputs);
}

#[test]
fn gre764_cancellation_during_result_json_and_digest() {
    use serde::ser::{Serialize, SerializeSeq, Serializer};
    struct Assignments<'a>(&'a std::cell::Cell<usize>);
    impl Serialize for Assignments<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut seq = serializer.serialize_seq(Some(200_000))?;
            for index in 0..200_000 {
                self.0.set(self.0.get() + 1);
                seq.serialize_element(&json!({"kind":"create","draftPartId":4,"unitIndex":index}))?;
            }
            seq.end()
        }
    }
    #[derive(serde::Serialize)]
    struct ResultBody<'a> {
        kind: &'static str,
        assignments: Assignments<'a>,
        surplus: &'a [String],
    }
    for hashing in [false, true] {
        let mut db = Database::open(UNCHANGED);
        let before = {
            let tx = db.connection.transaction().unwrap();
            storage::draft(&tx, "default", 1, 2).unwrap().unwrap()
        };
        let visited = std::cell::Cell::new(0);
        let checks = std::cell::Cell::new(0);
        let cancelled = std::cell::Cell::new(false);
        let check = || {
            if cancelled.get() {
                return Err(anyhow::anyhow!(crate::working_drafts::Failure::Cancelled));
            }
            if visited.get() > 0 {
                checks.set(checks.get() + 1);
                if checks.get() == 2 {
                    cancelled.set(true);
                    return Err(anyhow::anyhow!(crate::working_drafts::Failure::Cancelled));
                }
            }
            Ok(())
        };
        {
            let tx = db.connection.transaction().unwrap();
            tx.execute(
                "UPDATE plan_draft_parts SET notes='uncommitted' WHERE draft_id=2",
                [],
            )
            .unwrap();
            let body = ResultBody {
                kind: "ready",
                assignments: Assignments(&visited),
                surplus: &[],
            };
            let result = if hashing {
                storage::checked_digest(&body, &check)
            } else {
                storage::checked_string(&body, &check)
            };
            let error = result
                .map(|_| ())
                .expect_err("result serialization must stop when cancelled");
            assert!(
                matches!(
                    error.downcast_ref(),
                    Some(crate::working_drafts::Failure::Cancelled)
                ),
                "{error:?}"
            );
            assert_eq!(checks.get(), 2);
            assert!(
                visited.get() > 0 && visited.get() < 1000,
                "serialized {} assignments",
                visited.get()
            );
        }
        let tx = db.connection.transaction().unwrap();
        let after = storage::draft(&tx, "default", 1, 2).unwrap().unwrap();
        assert_eq!(after.header, before.header);
        assert_eq!(after.parts, before.parts);
        assert_eq!(after.inputs, before.inputs);
    }
}

#[test]
fn gre764_checked_result_bytes_and_digests_match_existing_order() {
    use super::model::{Reconciled, digest};
    for result in [
        json!({"kind":"ready","assignments":[{"kind":"create","draftPartId":4,"unitIndex":0},{"kind":"reuse","draftPartId":4,"unitIndex":1,"token":"ppu_00000000000000000000000000000001"}],"surplus":["ppu_00000000000000000000000000000002"]}),
        json!({"kind":"unresolved","conflicts":[{"kind":"unsafe_predecessor","targetDraftPartId":4,"predecessorRevisionPartId":1}]}),
    ] {
        let reconciled = Reconciled {
            result,
            basis: json!([{"revisionPartId":1,"token":"ppu_00000000000000000000000000000001","priorIndex":0,"createdAt":"2026-08-20T09:00:00.000Z","completed":true,"assembled":false}]),
        };
        let check = || Ok(());
        assert_eq!(
            storage::checked_string(&reconciled.result, &check).unwrap(),
            reconciled.result.to_string()
        );
        assert_eq!(
            storage::checked_string(&reconciled.basis, &check).unwrap(),
            reconciled.basis.to_string()
        );
        assert_eq!(
            storage::checked_string(&reconciled.full_borrowed(), &check).unwrap(),
            reconciled.full().to_string()
        );
        assert_eq!(
            storage::checked_digest(&reconciled.full_borrowed(), &check).unwrap(),
            digest(&reconciled.full())
        );
        let mapping = json!(MAPPING);
        assert_eq!(
            storage::selection_basis_digest_checked(&mapping, &reconciled.basis, &check).unwrap(),
            storage::selection_basis_digest(&mapping, &reconciled.basis)
        );
    }
}
