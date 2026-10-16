#![cfg(test)]

use super::*;
use crate::working_drafts::observation::{PreparationBudget, PreparationLimits, ReadFailure};
use serde_json::{Value, json};

#[test]
fn accepted_base_reuse_and_freshness_match_literal_node_results() {
    for case in include_str!("../../tests/fixtures/preparation-prereqs-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|case| case["kind"] == "reuse")
    {
        let root = std::env::temp_dir().join(format!("pp-prep-reuse-{}", rand::random::<u64>()));
        std::fs::create_dir_all(root.join("repos/1/revisions/accepted")).unwrap();
        let db = root.join("fixture.db");
        std::fs::write(
            &db,
            include_bytes!("../../tests/fixtures/accepted-plan-node.db"),
        )
        .unwrap();
        let mut connection = Connection::open(&db).unwrap();
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        let triggers = connection
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for trigger in triggers {
            connection
                .execute_batch(&format!("DROP TRIGGER \"{trigger}\";"))
                .unwrap();
        }
        connection
            .execute_batch(case["sql"].as_str().unwrap())
            .unwrap();
        let tx = connection.transaction().unwrap();
        let naming = crate::catalog::naming::get(&tx, "default", 1).unwrap();
        assert_eq!(naming, case["naming"], "{}", case["name"]);
        let current =
            context::draft_freshness_current(&tx, "default", 1, &mut graph::Budget::default())
                .unwrap();
        assert_eq!(json!(current), case["current"], "{}", case["name"]);
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        let result = reusable_draft_base(&tx, "default", 1, &root.join("repos"), &mut b);
        if case["acceptedKind"] == "integrity_failure" {
            let error = result.unwrap_err();
            let integrity = error.downcast_ref::<graph::Integrity>().unwrap();
            assert_eq!(json!(integrity.code), case["errorCode"], "{}", case["name"]);
            assert_eq!(
                json!(integrity.message),
                case["errorMessage"],
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(json!(result.unwrap()), case["reusable"], "{}", case["name"]);
        }
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        cancelled.store(true, Ordering::Release);
        let error =
            reusable_draft_base(&tx, "default", 1, &root.join("repos"), &mut b).unwrap_err();
        assert!(matches!(
            error.downcast_ref::<ReadFailure>(),
            Some(ReadFailure::Cancelled)
        ));
        drop(tx);
        drop(connection);
        std::fs::remove_dir_all(root).unwrap();
    }
}
