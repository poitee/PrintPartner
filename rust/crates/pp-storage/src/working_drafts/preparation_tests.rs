#![cfg(test)]

use super::observation::*;
use super::preparation::*;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, atomic::AtomicBool};

fn cases() -> Vec<Value> {
    include_str!("../../tests/fixtures/working-draft-preparation-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
struct FixtureRoot(std::path::PathBuf);
impl FixtureRoot {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for FixtureRoot {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn database(case: &Value) -> (FixtureRoot, Connection) {
    let root =
        FixtureRoot(std::env::temp_dir().join(format!("pp-preparation-{}", rand::random::<u64>())));
    std::fs::create_dir_all(root.path().join("repos/1/revisions/accepted")).unwrap();
    let path = root.path().join("fixture.db");
    std::fs::write(
        &path,
        include_bytes!("../../tests/fixtures/accepted-plan-node.db"),
    )
    .unwrap();
    let connection = Connection::open(path).unwrap();
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
            .execute_batch(&format!("DROP TRIGGER \"{trigger}\""))
            .unwrap();
    }
    for step in case["setup"].as_array().unwrap() {
        connection.execute_batch(step.as_str().unwrap()).unwrap();
    }
    (root, connection)
}
struct Reads {
    case: Value,
    hashes: Arc<Mutex<Vec<String>>>,
}
struct Root {
    logical: Option<String>,
    files: Vec<Value>,
    hashes: Arc<Mutex<Vec<String>>>,
}
struct Inventory {
    entries: Vec<InventoryPath>,
    files: Vec<Value>,
    hashes: Arc<Mutex<Vec<String>>>,
}
impl DraftReads for Reads {
    fn resolve_stl_root(
        &self,
        request: &OwnedStlReadRequest,
        b: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        b.check()?;
        let logical = request.stored_path().map(|p| {
            if request.purpose() == StlPurpose::Revision {
                format!("/logical/{p}")
            } else {
                p.into()
            }
        });
        let files = self.case["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["source"] == request.source_id())
            .cloned()
            .collect();
        Ok(Box::new(Root {
            logical,
            files,
            hashes: self.hashes.clone(),
        }))
    }
    fn read_checkout_manifest(
        &self,
        request: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        b: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        b.check()?;
        match self.case["docs"][request.source_id().to_string()].as_str() {
            Some(s) => {
                b.document(s.len(), s.len())?;
                Ok(DocumentRead::Bytes(s.as_bytes().to_vec()))
            }
            None => Ok(DocumentRead::Missing),
        }
    }
    fn read_catalog_document(
        &self,
        request: &OwnedCatalogReadRequest,
        b: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        b.check()?;
        if matches!(request.purpose(), CatalogPurpose::CustomHints)
            && let Some(raw) = self.case["hints"].as_str()
        {
            b.document(raw.len(), raw.len())?;
            return Ok(DocumentRead::Bytes(raw.as_bytes().to_vec()));
        }
        Ok(DocumentRead::Missing)
    }
}
impl StlRootRead for Root {
    fn logical_resolved_path(&self) -> Option<&str> {
        self.logical.as_deref()
    }
    fn scan_stls(&mut self, b: &mut PreparationBudget<'_>) -> ReadResult<Box<dyn StlInventory>> {
        b.check()?;
        let mut entries = Vec::new();
        for (i, file) in self.files.iter().enumerate() {
            let path = file["path"].as_str().unwrap();
            b.entry(path.split('/').count() - 1, path.len())?;
            entries.push(InventoryPath {
                physical_relative_path: path.into(),
                traversal_ordinal: i,
            });
        }
        Ok(Box::new(Inventory {
            entries,
            files: self.files.clone(),
            hashes: self.hashes.clone(),
        }))
    }
}
impl StlInventory for Inventory {
    fn entries(&self) -> &[InventoryPath] {
        &self.entries
    }
    fn hash_tracked_winner(
        &mut self,
        index: usize,
        b: &mut PreparationBudget<'_>,
    ) -> ReadResult<ArtifactRead> {
        let bytes = self.files[index]["content"].as_str().unwrap().as_bytes();
        b.artifact(bytes.len() as u64, bytes.len())?;
        self.hashes
            .lock()
            .unwrap()
            .push(self.files[index]["path"].as_str().unwrap().into());
        Ok(ArtifactRead {
            byte_count: bytes.len() as u64,
            byte_sha256: hex::encode(Sha256::digest(bytes)),
        })
    }
}
fn options(case: &Value) -> PreparationOptions {
    let o = &case["options"];
    let paths =
        |key: &str| (!o[key].is_null()).then(|| serde_json::from_value(o[key].clone()).unwrap());
    let choice = |v: &Value| PartChoice {
        quantity: serde_json::from_value(v["quantity"].clone()).unwrap(),
        role: v["role"].as_str().unwrap().into(),
        color: v["color"].as_str().map(str::to_owned),
    };
    let choices = o["choices"].as_object().map(|sources| {
        sources
            .iter()
            .map(|(id, parts)| {
                let parts = parts
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(path, v)| (path.clone(), choice(v)))
                    .collect();
                (id.parse().unwrap(), parts)
            })
            .collect()
    });
    PreparationOptions {
        apply_manifest: o["applyManifest"].as_bool().unwrap_or(true),
        prefer_accepted: o["preferAccepted"].as_bool().unwrap_or(false),
        excluded_paths_by_source_id: paths("excluded"),
        included_paths_by_source_id: paths("included"),
        part_choices_by_source_id: choices,
    }
}
fn projection(prepared: PreparedDraftSnapshot) -> Value {
    let fields = [
        vec!["baseRevisionPartId"],
        crate::required_units::model::PART_FIELDS.to_vec(),
    ]
    .concat();
    let parts: Vec<Value> = prepared
        .parts
        .iter()
        .map(|p| serde_json::from_slice(&p.json_fields(&fields, false)).unwrap())
        .collect();
    json!({"kind":"prepared","inputs":prepared.capture.inputs,"parts":parts,"digest":prepared.digest})
}

#[test]
fn preparation_matches_literal_node_results() {
    for case in cases() {
        let (root, mut connection) = database(&case);
        let writes = connection.total_changes();
        let reads = Reads {
            case: case.clone(),
            hashes: Default::default(),
        };
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        let result = if case["capture"] == true {
            let tx = connection.transaction().unwrap();
            capture(&tx, "default", 1, &reads, &mut b)
                .map(|c| json!({"fingerprint":c.fingerprint,"inputs":c.inputs}))
        } else {
            prepare(
                &mut connection,
                "default",
                1,
                case["base"].clone(),
                PreparationContext {
                    options: &options(&case),
                    repos: &root.path().join("repos"),
                },
                &reads,
                &mut b,
            )
            .map(|prepared| {
                assert_eq!(prepared.base, case["base"]);
                projection(prepared)
            })
        };
        let actual = match result {
            Ok(value) => value,
            Err(e) => match e.downcast_ref::<Failure>() {
                Some(Failure::NoLayers) => json!({"kind":"no_layers"}),
                Some(Failure::NoStls) => json!({"kind":"no_stls"}),
                None => json!({"error":e.to_string()}),
            },
        };
        assert_eq!(actual, case["result"], "{}", case["name"]);
        assert_eq!(
            connection.total_changes(),
            writes,
            "{} wrote rows",
            case["name"]
        );
        if case["name"] == "reuse" || case["name"] == "untracked" {
            assert_eq!(*reads.hashes.lock().unwrap(), Vec::<String>::new());
        }
        if case["name"] == "layer-winners-and-conflicts" {
            assert_eq!(
                *reads.hashes.lock().unwrap(),
                vec![
                    "[a]clip_x3.stl",
                    "excluded.stl",
                    "folder/bracket.stl",
                    "included.stl"
                ]
            );
        }
    }
}
#[test]
fn preparation_cancels_mid_attempt_and_propagates_resource_refusals() {
    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "manifest")
        .unwrap();
    let (root, mut connection) = database(&case);
    let reads = Reads {
        case: case.clone(),
        hashes: Default::default(),
    };
    {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(
            &cancelled,
            PreparationLimits {
                visits: 0,
                ..Default::default()
            },
        )
        .unwrap();
        let tx = connection.transaction().unwrap();
        let error = capture(&tx, "default", 1, &reads, &mut b).err().unwrap();
        assert_eq!(error.to_string(), "LimitExceeded(Visits)");
    }
    for (limits, resource) in [
        (
            PreparationLimits {
                entries: 0,
                ..Default::default()
            },
            "Entries",
        ),
        (
            PreparationLimits {
                artifact_bytes: 0,
                ..Default::default()
            },
            "ArtifactBytes",
        ),
        (
            PreparationLimits {
                document_bytes: 0,
                ..Default::default()
            },
            "DocumentBytes",
        ),
        (
            PreparationLimits {
                comparison_work: 0,
                ..Default::default()
            },
            "ComparisonWork",
        ),
        (
            PreparationLimits {
                visits: 0,
                ..Default::default()
            },
            "Visits",
        ),
    ] {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, limits).unwrap();
        let e = prepare(
            &mut connection,
            "default",
            1,
            case["base"].clone(),
            PreparationContext {
                options: &options(&case),
                repos: root.path(),
            },
            &reads,
            &mut b,
        )
        .err()
        .unwrap();
        assert_eq!(e.to_string(), format!("LimitExceeded({resource})"));
    }
    let mut completed = false;
    for checks in 0..1000 {
        let cancelled = AtomicBool::new(false);
        let mut b = PreparationBudget::new(&cancelled, PreparationLimits::default()).unwrap();
        b.cancel_after_checks(checks);
        let tx = connection.transaction().unwrap();
        let mut tx = tx;
        match prepare(
            &mut tx,
            "default",
            1,
            case["base"].clone(),
            PreparationContext {
                options: &options(&case),
                repos: root.path(),
            },
            &reads,
            &mut b,
        ) {
            Ok(prepared) => {
                assert_eq!(projection(prepared), case["result"]);
                completed = true;
                break;
            }
            Err(e) => assert!(
                matches!(
                    e.downcast_ref::<ReadFailure>(),
                    Some(ReadFailure::Cancelled)
                ),
                "{checks}: {e:?}"
            ),
        }
    }
    assert!(completed);
}
