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
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

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
    files: Vec<String>,
}
struct Root(Arc<Reads>);
struct Inventory(Vec<InventoryPath>);
struct Shared(Arc<Reads>);
impl DraftReads for Shared {
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        budget.check()?;
        Ok(Box::new(Root(self.0.clone())))
    }
    fn read_checkout_manifest(
        &self,
        _: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        budget.check()?;
        Ok(DocumentRead::Missing)
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
        for (traversal_ordinal, path) in self.0.files.iter().enumerate() {
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

struct Fixture(PathBuf);
impl Fixture {
    fn new(case: &Value) -> Self {
        let fixture = Self(std::env::temp_dir().join(format!("pp-trim-{}", rand::random::<u64>())));
        std::fs::create_dir_all(&fixture.0).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fixture.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(
            fixture.database(),
            include_bytes!("fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        let revision = fixture.0.join("repos/1/revisions/fixture");
        for file in case["files"].as_array().unwrap() {
            let path = revision.join(file.as_str().unwrap());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, file.as_str().unwrap()).unwrap();
        }
        for sql in case["setup"].as_array().unwrap() {
            fixture.sql().execute_batch(sql.as_str().unwrap()).unwrap();
        }
        fixture
    }
    fn database(&self) -> PathBuf {
        self.0.join("print-partner.db")
    }
    fn sql(&self) -> Connection {
        Connection::open(self.database()).unwrap()
    }
    fn rows(&self) -> String {
        let connection = self.sql();
        let mut snapshot = String::new();
        for table in [
            "plan_drafts",
            "plan_draft_inputs",
            "plan_draft_parts",
            "plan_draft_required_unit_reconciliations",
            "plan_draft_required_unit_assignments",
        ] {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let mut rows = statement.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                for column in 0..columns {
                    snapshot.push_str(&format!("{:?};", row.get_ref(column).unwrap()));
                }
            }
        }
        snapshot
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn compare(name: &str) {
    let case = include_str!("fixtures/preparation-trim-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|case| case["name"] == name)
        .unwrap();
    let fixture = Fixture::new(&case);
    let owner = WriterOwner::open(&fixture.0, Limits::default()).unwrap().0;
    let reads = Arc::new(Shared(Arc::new(Reads {
        files: serde_json::from_value(case["files"].clone()).unwrap(),
    })));
    let client = owner
        .working_drafts_with_observations(policy(), reads, PreparationLimits::default())
        .unwrap();
    for key in ["filtered", "unfiltered", "wrapped"] {
        if key == "unfiltered" {
            fixture
                .sql()
                .execute_batch("UPDATE projects SET imported_paths=NULL WHERE id=1")
                .unwrap();
        }
        if key == "wrapped" {
            let space = match name {
                "bom" => "\u{feff}",
                "ordinary" => " ",
                _ => "\u{0085}",
            };
            fixture
                .sql()
                .execute(
                    "UPDATE projects SET imported_paths=?1 WHERE id=1",
                    [format!("{space}[\"plain.stl\"]{space}")],
                )
                .unwrap();
        }
        let outcome = client
            .recompute(
                session(),
                id(1),
                RecomputeRequest::new(key, true).unwrap(),
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(60),
            )
            .unwrap();
        let actual: Value = serde_json::from_slice(&outcome.into_json_body().into_bytes()).unwrap();
        let parts: Vec<_> = actual["draft"]["parts"].as_array().unwrap().iter().map(|part| json!({
            "relativePath": part["relativePath"], "roleInferred": part["roleInferred"],
            "quantityInferred": part["quantityInferred"], "included": part["included"],
            "filamentColorId": part["filamentColorId"], "spoolmanSpoolId": part["spoolmanSpoolId"],
        })).collect();
        assert_eq!(
            json!({"kind": actual["kind"], "parts": parts}),
            case[key],
            "{name}/{key}"
        );
    }
    fixture
        .sql()
        .execute_batch("UPDATE projects SET imported_paths=NULL WHERE id=1")
        .unwrap();
    if name == "non-js" {
        assert_eq!(case["prefixQuantity"], Value::Null);
        let filename = "part_x\u{0085}3.stl";
        let file = fixture.0.join("repos/1/revisions/fixture").join(filename);
        std::fs::write(&file, filename).unwrap();
        let before = fixture.rows();
        let invalid = owner
            .working_drafts_with_observations(
                policy(),
                Arc::new(Shared(Arc::new(Reads {
                    files: vec![filename.into()],
                }))),
                PreparationLimits::default(),
            )
            .unwrap();
        let error = invalid
            .recompute(
                session(),
                id(1),
                RecomputeRequest::new("invalid-prefix", true).unwrap(),
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(60),
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "NOT NULL constraint failed: plan_draft_parts.quantity_inferred"
        );
        assert_eq!(fixture.rows(), before);
        assert_eq!(std::fs::read(file).unwrap(), filename.as_bytes());
    }
    let rows = fixture.rows();
    let file_bytes: Vec<_> = case["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            std::fs::read(
                fixture
                    .0
                    .join("repos/1/revisions/fixture")
                    .join(file.as_str().unwrap()),
            )
            .unwrap()
        })
        .collect();
    let error = client
        .recompute(
            session(),
            id(1),
            RecomputeRequest::new("cancelled", true).unwrap(),
            Arc::new(AtomicBool::new(true)),
            Duration::from_secs(60),
        )
        .unwrap_err();
    assert!(
        matches!(
            error.downcast_ref(),
            Some(pp_storage::working_drafts::Failure::Cancelled)
        ),
        "{error:?}"
    );
    assert_eq!(fixture.rows(), rows);
    for (file, before) in case["files"].as_array().unwrap().iter().zip(file_bytes) {
        assert_eq!(
            std::fs::read(
                fixture
                    .0
                    .join("repos/1/revisions/fixture")
                    .join(file.as_str().unwrap())
            )
            .unwrap(),
            before
        );
    }
    owner.shutdown().unwrap();
}

#[test]
fn preparation_trim_matches_js_whitespace() {
    compare("bom");
    compare("ordinary");
}
#[test]
fn preparation_trim_preserves_non_js_space() {
    compare("non-js");
}
