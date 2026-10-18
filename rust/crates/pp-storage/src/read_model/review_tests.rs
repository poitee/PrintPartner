#![cfg(all(test, feature = "desktop_rebuild"))]

use super::*;
use crate::manifest_text::JsText;
use crate::read_model::views::{self, CatalogOnly, MediaObservation, ReviewObservations};
use rusqlite::Connection;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    connection: Connection,
    // Fields drop in declaration order, so the connection closes before directory cleanup.
    _directory: FixtureDirectory,
}

struct FixtureDirectory(PathBuf);

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            if std::thread::panicking() {
                eprintln!(
                    "failed to remove fixture directory {}: {error}",
                    self.0.display()
                );
            } else {
                panic!(
                    "failed to remove fixture directory {}: {error}",
                    self.0.display()
                );
            }
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pp-review-{}", rand::random::<u64>()));
        let directory = FixtureDirectory(root.clone());
        std::fs::create_dir_all(root.join("repos/1/revisions/accepted")).unwrap();
        let path = root.join("fixture.db");
        std::fs::write(
            &path,
            include_bytes!("../../tests/fixtures/accepted-plan-node.db"),
        )
        .unwrap();
        Self {
            root,
            connection: Connection::open(path).unwrap(),
            _directory: directory,
        }
    }
    fn read(&mut self) -> AcceptedRead {
        let tx = self.connection.transaction().unwrap();
        read(
            &tx,
            "default",
            1,
            &self.root.join("repos"),
            &mut Budget::default(),
        )
        .unwrap()
    }
    fn metadata(&mut self, requirement: JsText, option: JsText) {
        let tx = self.connection.transaction().unwrap();
        // The fixture deliberately edits immutable accepted rows, then reseals their digest.
        let triggers = tx
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for trigger in triggers {
            tx.execute_batch(&format!("DROP TRIGGER \"{trigger}\";"))
                .unwrap();
        }
        for table in ["parts", "plan_revision_parts"] {
            tx.execute(
                &format!("UPDATE {table} SET requirement=?1,option_group_id=?2"),
                rusqlite::params![
                    requirement.sqlite_value().unwrap(),
                    option.sqlite_value().unwrap()
                ],
            )
            .unwrap();
        }
        let revisions = tx
            .prepare("SELECT id FROM plan_revisions")
            .unwrap()
            .query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for revision in revisions {
            let mut canonical = rows(
                &tx,
                "plan_revision_parts",
                "revision_id=?1",
                &[&revision],
                "revision",
                &mut Budget::default(),
            )
            .unwrap()
            .iter()
            .map(canonical_part)
            .collect::<Result<Vec<_>>>()
            .unwrap();
            canonical.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let digest = sha(&format!(
                "{{\"format\":\"plan-revision-parts-v1\",\"parts\":[{}]}}",
                canonical.join(",")
            ));
            tx.execute(
                "UPDATE plan_revisions SET snapshot_digest=?1 WHERE id=?2",
                rusqlite::params![digest, revision],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
}

#[test]
fn fixture_closes_connection_before_directory_cleanup() {
    let fixture = Fixture::new();
    let root = fixture.root.clone();
    drop(fixture);
    assert!(!root.exists());
}

#[test]
fn fixture_cleans_up_during_unwind() {
    let fixture = Fixture::new();
    let root = fixture.root.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _fixture = fixture;
        panic!("exercise fixture cleanup during unwind");
    }));
    assert!(result.is_err());
    assert!(!root.exists());
}

#[test]
fn fixture_cleanup_reports_removal_errors_without_double_panic() {
    for panicking in [false, true] {
        let root = std::env::temp_dir().join(format!("pp-review-{}", rand::random::<u64>()));
        std::fs::write(&root, b"not a directory").unwrap();
        let fixture = Fixture {
            root: root.clone(),
            connection: Connection::open_in_memory().unwrap(),
            _directory: FixtureDirectory(root.clone()),
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _fixture = fixture;
            if panicking {
                panic!("exercise failed fixture cleanup during unwind");
            }
        }));
        std::fs::remove_file(root).unwrap();
        let panic = result.unwrap_err();
        if panicking {
            assert_eq!(
                panic.downcast_ref::<&str>(),
                Some(&"exercise failed fixture cleanup during unwind")
            );
        } else {
            assert!(
                panic
                    .downcast_ref::<String>()
                    .unwrap()
                    .contains("failed to remove fixture directory")
            );
        }
    }
}

fn observations(read: &AcceptedRead) -> ReviewObservations {
    let AcceptedRead::Ready { snapshot } = read else {
        panic!("{read:?}")
    };
    ReviewObservations {
        available_input_roots: match &snapshot.provenance {
            Provenance::Tracked { inputs, .. } => inputs.iter().map(|i| i.input_id).collect(),
            _ => Default::default(),
        },
        media_by_part_id: snapshot
            .parts
            .iter()
            .map(|p| {
                (
                    p.projection_part_id,
                    MediaObservation {
                        artifact_missing: false,
                        thumb_empty: false,
                    },
                )
            })
            .collect(),
    }
}

#[test]
fn scalar_review_and_summary_keep_the_node_shape() {
    let mut fixture = Fixture::new();
    let text = "Needs \"glue\"\n🧩";
    fixture.metadata(JsText::scalar(text), JsText::scalar("group/α"));
    let read = fixture.read();
    let obs = observations(&read);
    let body = views::review_json(&read, true, &obs, &CatalogOnly).unwrap();
    let summary: Value =
        serde_json::from_slice(&body.summary_json().unwrap().into_bytes()).unwrap();
    let body: Value = serde_json::from_slice(&body.into_bytes()).unwrap();
    assert_eq!(body["kind"], "ready");
    let review = &body["body"];
    for group in review["part_groups"].as_array().unwrap() {
        for part in group["parts"].as_array().unwrap() {
            assert_eq!(part["requirement"], text);
            assert_eq!(part["option_group_id"], "group/α");
            assert!(part.get("optionGroupId").is_none());
        }
    }
    assert_eq!(summary["totals"], review["totals"]);
    assert_eq!(summary["has_blockers"], review["has_blockers"]);
    assert_eq!(summary["plan_id"], review["profile_id"]);
    assert_eq!(summary["plan_name"], review["plan_name"]);
    assert!(summary["sample_issues"].is_array());
    assert!(summary.get("part_groups").is_none());
}

#[test]
fn stored_surrogates_reach_review_and_accepted_json_without_writes() {
    let mut fixture = Fixture::new();
    fixture.metadata(
        JsText::from_units(vec![0x61, 0xd800, 0x22, 0xa]),
        JsText::from_units(vec![0xdc00]),
    );
    let before = fixture.connection.total_changes();
    let read = fixture.read();
    let obs = observations(&read);
    let review = views::review_json(&read, true, &obs, &CatalogOnly).unwrap();
    let summary: Value =
        serde_json::from_slice(&review.summary_json().unwrap().into_bytes()).unwrap();
    let body = String::from_utf8(review.into_bytes()).unwrap();
    assert!(body.contains(r#""requirement":"a\ud800\"\n""#), "{body}");
    assert!(body.contains(r#""option_group_id":"\udc00""#), "{body}");
    let accepted = String::from_utf8(read.into_json_body().unwrap().into_bytes()).unwrap();
    assert!(accepted.contains(r#""requirement":"a\ud800\"\n""#));
    assert!(accepted.contains(r#""optionGroupId":"\udc00""#));
    assert!(summary["totals"]["included_parts"].as_i64().unwrap() > 0);
    assert_eq!(before, fixture.connection.total_changes());
}

#[test]
fn excluded_parts_can_be_hidden_or_shown_without_media_observations() {
    let mut fixture = Fixture::new();
    let mut read = fixture.read();
    let mut obs = observations(&read);
    let AcceptedRead::Ready { snapshot } = &mut read else {
        unreachable!()
    };
    for part in &mut snapshot.parts {
        part.included = false;
    }
    obs.media_by_part_id.clear();
    let body = views::review_json(&read, false, &obs, &CatalogOnly).unwrap();
    let body: Value = serde_json::from_slice(&body.into_bytes()).unwrap();
    assert_eq!(body["body"]["part_groups"], json!([]));
    assert_eq!(body["body"]["totals"]["included_parts"], 0);
    assert_eq!(body["body"]["has_blockers"], true);
    let body = views::review_json(&read, true, &obs, &CatalogOnly).unwrap();
    let body: Value = serde_json::from_slice(&body.into_bytes()).unwrap();
    let parts = body["body"]["part_groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["parts"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(parts.len(), 2);
    assert!(
        parts
            .iter()
            .all(|part| part["included"] == false && part["stl_missing"] == false)
    );
}

#[test]
fn empty_and_unavailable_review_bodies_have_the_expected_summaries() {
    let obs = ReviewObservations {
        available_input_roots: Default::default(),
        media_by_part_id: Default::default(),
    };
    for (read, expected) in [
        (AcceptedRead::Missing, json!({"kind":"not_found"})),
        (
            AcceptedRead::CompatibilityDirty,
            json!({"kind":"accepted_state_unavailable","reason":"compatibility_dirty"}),
        ),
        (
            AcceptedRead::Uninitialized,
            json!({"kind":"accepted_state_unavailable","reason":"uninitialized"}),
        ),
        (
            AcceptedRead::IntegrityFailure {
                code: "digest".into(),
                message: "corrupt".into(),
            },
            json!({"kind":"integrity_failure","code":"digest","message":"corrupt"}),
        ),
    ] {
        let body = views::review_json(&read, false, &obs, &CatalogOnly).unwrap();
        assert!(body.summary_json().is_none());
        assert_eq!(
            serde_json::from_slice::<Value>(&body.into_bytes()).unwrap(),
            expected
        );
    }
    let read = AcceptedRead::Empty {
        profile: Profile {
            id: 1,
            name: "Build".into(),
            order_number: None,
            special_request: None,
            archived_at: None,
        },
    };
    let body = views::review_json(&read, false, &obs, &CatalogOnly).unwrap();
    let summary: Value =
        serde_json::from_slice(&body.summary_json().unwrap().into_bytes()).unwrap();
    assert_eq!(summary["has_blockers"], true);
    let body: Value = serde_json::from_slice(&body.into_bytes()).unwrap();
    assert_eq!(body["kind"], "empty");
    assert_eq!(body["body"]["part_groups"], json!([]));
}

#[test]
fn non_scalar_metadata_still_requires_matching_projection_and_valid_encoding() {
    for value in [
        rusqlite::types::Value::Text("changed".into()),
        rusqlite::types::Value::Blob(b"PPJS\x01".to_vec()),
    ] {
        let mut fixture = Fixture::new();
        fixture.metadata(
            JsText::from_units(vec![0xd800]),
            JsText::from_units(vec![0xdc00]),
        );
        fixture
            .connection
            .execute("UPDATE parts SET requirement=?1", [value])
            .unwrap();
        let before = fixture.connection.total_changes();
        let tx = fixture.connection.transaction().unwrap();
        assert!(
            read(
                &tx,
                "default",
                1,
                &fixture.root.join("repos"),
                &mut Budget::default()
            )
            .is_err()
        );
        drop(tx);
        assert_eq!(before, fixture.connection.total_changes());
    }
}
