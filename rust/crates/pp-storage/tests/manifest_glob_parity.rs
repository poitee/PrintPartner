#![cfg(feature = "desktop_rebuild")]
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
    working_drafts::{
        PositiveId, RecomputeRequest,
        observation::{
            ArtifactRead, CheckoutManifestUse, DocumentRead, DraftReads, InventoryPath,
            OwnedCatalogReadRequest, OwnedCheckoutReadRequest, OwnedStlReadRequest,
            PreparationBudget, PreparationLimits, ReadResult, StlInventory, StlRootRead,
        },
    },
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, RwLock, atomic::AtomicBool},
    time::Duration,
};

#[path = "common/process.rs"]
mod child_process;

fn session() -> Credential {
    Credential::Session(Secret::new("required-unit-fixture-secret".into()))
}
fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
fn id(value: u64) -> PositiveId {
    PositiveId::new(value).unwrap()
}
struct Reads {
    files: Arc<Vec<String>>,
    manifest: RwLock<Vec<u8>>,
}
struct Root(Arc<Vec<String>>);
struct Inventory(Vec<InventoryPath>);
impl DraftReads for Reads {
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        budget.check()?;
        Ok(Box::new(Root(self.files.clone())))
    }
    fn read_checkout_manifest(
        &self,
        _: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        budget.check()?;
        let bytes = self.manifest.read().unwrap().clone();
        budget.document(bytes.len(), bytes.len())?;
        Ok(DocumentRead::Bytes(bytes))
    }
    fn read_catalog_document(
        &self,
        _: &OwnedCatalogReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        budget.check()?;
        Ok(DocumentRead::Missing)
    }
}
impl StlRootRead for Root {
    fn logical_resolved_path(&self) -> Option<&str> {
        Some("/logical/root")
    }
    fn scan_stls(
        &mut self,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlInventory>> {
        budget.check()?;
        let mut entries = Vec::new();
        for (traversal_ordinal, path) in self.0.iter().enumerate() {
            budget.entry(0, path.len())?;
            entries.push(InventoryPath {
                physical_relative_path: path.clone(),
                traversal_ordinal,
            });
        }
        Ok(Box::new(Inventory(entries)))
    }
}
impl StlInventory for Inventory {
    fn entries(&self) -> &[InventoryPath] {
        &self.0
    }
    fn hash_tracked_winner(
        &mut self,
        index: usize,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<ArtifactRead> {
        let bytes = self.0[index].physical_relative_path.as_bytes();
        budget.artifact(bytes.len() as u64, bytes.len())?;
        Ok(ArtifactRead {
            byte_count: bytes.len() as u64,
            byte_sha256: hex::encode(Sha256::digest(bytes)),
        })
    }
}

#[derive(Deserialize)]
struct ManifestGlobMatrix {
    domain: Value,
    patterns: Vec<String>,
    keys: Vec<String>,
    expected: Vec<Vec<bool>>,
}

struct Fixture {
    path: PathBuf,
    owner: Option<WriterOwner>,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-manifest-globs-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("print-partner.db"),
            include_bytes!("fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        let connection = Connection::open(path.join("print-partner.db")).unwrap();
        connection
            .execute_batch("UPDATE projects SET imported_paths=NULL;")
            .unwrap();
        drop(connection);
        let owner = WriterOwner::open(&path, Limits::default()).unwrap().0;
        Self {
            path,
            owner: Some(owner),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.owner.take().unwrap().shutdown().unwrap();
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}

#[test]
fn committed_matrix_matches_current_node() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/parity/manifest-globs/generate.mjs");
    let output = child_process::command(
        std::env::var_os("PP_SCHEMA_PARITY_NODE").unwrap_or_else(|| "node".into()),
    )
    .arg(script)
    .arg("--check")
    .output()
    .expect("run Node fixture generator");
    assert!(
        output.status.success(),
        "Node fixture drift check failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "102 patterns x 55 keys = 5610 Node matchKeyMatches outcomes verified (264 accept, 5346 reject)"
    );
}

#[test]
fn public_preparation_matches_node_matrix() {
    let matrix: ManifestGlobMatrix = serde_json::from_slice(include_bytes!(
        "../../../../fixtures/parity/manifest-globs/node.json"
    ))
    .unwrap();
    assert_eq!(
        matrix.domain["alphabet"],
        json!(["a", "😀", "\n", "\r", "\u{2028}", "\u{2029}"])
    );
    assert_eq!(matrix.domain["minLength"], 0);
    assert_eq!(matrix.domain["maxLength"], 2);
    assert_eq!(matrix.domain["boundedPatternCount"], 73);
    assert_eq!(matrix.domain["boundedKeyCount"], 43);
    assert_eq!(matrix.patterns.len(), 102);
    assert_eq!(matrix.keys.len(), 55);
    assert_eq!(matrix.expected.len(), matrix.patterns.len());
    for row in &matrix.expected {
        assert_eq!(row.len(), matrix.keys.len());
    }
    let pattern_a = matrix
        .patterns
        .iter()
        .position(|p| p == "probe-a-end.stl")
        .unwrap();
    let key_a = matrix
        .keys
        .iter()
        .position(|k| k == "probe-a-end.stl")
        .unwrap();
    let key_emoji = matrix
        .keys
        .iter()
        .position(|k| k == "probe-😀-end.stl")
        .unwrap();
    assert!(matrix.expected[pattern_a][key_a], "literal accept anchor");
    assert!(
        !matrix.expected[pattern_a][key_emoji],
        "literal reject anchor"
    );

    let fixture = Fixture::new();
    let reads = Arc::new(Reads {
        files: Arc::new(matrix.keys.clone()),
        manifest: RwLock::new(Vec::new()),
    });
    let client = fixture
        .owner
        .as_ref()
        .unwrap()
        .working_drafts_with_observations(policy(), reads.clone(), PreparationLimits::default())
        .unwrap();
    for (row, pattern) in matrix.patterns.iter().enumerate() {
        *reads.manifest.write().unwrap() = serde_json::to_vec(&json!({"parts":[
            {"match":pattern,"requirement":"optional"}
        ]}))
        .unwrap();
        let outcome = client
            .recompute(
                session(),
                id(1),
                RecomputeRequest::new(&format!("glob-matrix-{row}"), true).unwrap(),
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(60),
            )
            .unwrap();
        let actual: Value = serde_json::from_slice(&outcome.into_json_body().into_bytes()).unwrap();
        let parts = actual["draft"]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), matrix.keys.len(), "pattern {pattern:?}");
        let requirements: BTreeMap<_, _> = parts
            .iter()
            .map(|part| {
                (
                    part["relativePath"].as_str().unwrap(),
                    part.get("requirement").unwrap(),
                )
            })
            .collect();
        assert_eq!(
            requirements.len(),
            matrix.keys.len(),
            "unique inventory keys"
        );
        for (column, key) in matrix.keys.iter().enumerate() {
            let expected = if matrix.expected[row][column] {
                json!("optional")
            } else {
                Value::Null
            };
            assert_eq!(
                requirements.get(key.as_str()).copied(),
                Some(&expected),
                "Node parity row {row}, column {column}, pattern {pattern:?}, key {key:?}"
            );
        }
    }
    let accepted = matrix
        .expected
        .iter()
        .flatten()
        .filter(|matched| **matched)
        .count();
    eprintln!(
        "public preparation: {} patterns x {} keys = {} outcomes verified ({} accept, {} reject)",
        matrix.patterns.len(),
        matrix.keys.len(),
        matrix.patterns.len() * matrix.keys.len(),
        accepted,
        matrix.patterns.len() * matrix.keys.len() - accepted
    );
}
