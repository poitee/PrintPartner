use pp_storage::{Limits, WriterOwner, catalog::Request};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let fixture =
            Self(std::env::temp_dir().join(format!("pp-naming-{}", rand::random::<u64>())));
        std::fs::create_dir(&fixture.0).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fixture.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(
            fixture.0.join("print-partner.db"),
            include_bytes!("fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        std::fs::write(fixture.0.join("sentinel.stl"), b"disposable STL").unwrap();
        fixture
    }
    fn sql(&self) -> Connection {
        Connection::open(self.0.join("print-partner.db")).unwrap()
    }
    fn naming(&self, override_value: Value) {
        self.sql()
            .execute(
                "UPDATE projects SET metadata_json=? WHERE id=1",
                [json!({"naming":{"use_defaults":false,"override":override_value}}).to_string()],
            )
            .unwrap();
    }
    fn rows(&self) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
        let db = self.sql();
        let tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        tables
            .iter()
            .map(|table| {
                let mut statement = db
                    .prepare(&format!(
                        "SELECT * FROM \"{}\" ORDER BY rowid",
                        table.replace('"', "\"\"")
                    ))
                    .unwrap();
                let columns = statement.column_count();
                statement
                    .query_map([], |row| {
                        (0..columns).map(|column| row.get(column)).collect()
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap()
            })
            .collect()
    }
    fn unchanged(&self, before: Vec<Vec<Vec<rusqlite::types::Value>>>) {
        assert_eq!(self.rows(), before);
        assert_eq!(
            std::fs::read(self.0.join("sentinel.stl")).unwrap(),
            b"disposable STL"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn cases() -> Vec<Value> {
    include_str!("fixtures/preparation-naming-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn stored_naming_null_functional_class_is_refused() {
    let fixture = Fixture::new();
    let owner = WriterOwner::open(&fixture.0, Limits::default()).unwrap().0;
    let client = owner.local_source_catalog();
    for full in [false, true] {
        let mut override_value = if full {
            serde_json::to_value(pp_storage::catalog::NamingProfile::default()).unwrap()
        } else {
            json!({})
        };
        override_value["folder_rules"] = cases()[0]["override"]["folder_rules"].clone();
        fixture.naming(override_value.clone());
        let before = fixture.rows();
        let result = client.execute(Request::GetNaming { id: 1 });
        #[cfg(feature = "desktop_rebuild")]
        {
            let error = result.unwrap_err();
            assert_eq!(
                error.to_string(),
                "Stored Source naming settings are invalid"
            );
            assert!(matches!(
                error.downcast_ref(),
                Some(pp_storage::catalog::CatalogFailure::InvalidStoredNaming)
            ));
            assert_eq!(
                error.root_cause().to_string(),
                cases()[0]["error"].as_str().unwrap()
            );
        }
        #[cfg(not(feature = "desktop_rebuild"))]
        assert!(result.is_ok());
        fixture.unchanged(before);
        override_value["folder_rules"][0]
            .as_object_mut()
            .unwrap()
            .remove("functional_class");
        for class in [None, Some("functional"), Some("cosmetic")] {
            if let Some(class) = class {
                override_value["folder_rules"][0]["functional_class"] = json!(class);
            }
            fixture.naming(override_value.clone());
            let before = fixture.rows();
            let value = serde_json::to_value(client.execute(Request::GetNaming { id: 1 }).unwrap())
                .unwrap();
            assert_eq!(
                value["effective"]["folder_rules"][0]["functional_class"],
                json!(class)
            );
            fixture.unchanged(before);
        }
    }
    owner.shutdown().unwrap();
}

#[cfg(feature = "desktop_rebuild")]
mod preparation {
    use super::*;
    use pp_storage::{
        auth,
        read_model::Credential,
        working_drafts::{PositiveId, RecomputeRequest, observation::*},
    };
    use std::{
        sync::{Arc, atomic::AtomicBool},
        time::Duration,
    };

    struct Unread;
    impl DraftReads for Unread {
        fn resolve_stl_root(
            &self,
            _: &OwnedStlReadRequest,
            _: &mut PreparationBudget<'_>,
        ) -> ReadResult<Box<dyn StlRootRead>> {
            panic!("refuse before reading STL files")
        }
        fn read_checkout_manifest(
            &self,
            _: &OwnedCheckoutReadRequest,
            _: CheckoutManifestUse,
            _: &mut PreparationBudget<'_>,
        ) -> ReadResult<DocumentRead> {
            panic!("refuse before reading manifests")
        }
        fn read_catalog_document(
            &self,
            _: &OwnedCatalogReadRequest,
            _: &mut PreparationBudget<'_>,
        ) -> ReadResult<DocumentRead> {
            panic!("refuse before reading catalogs")
        }
    }

    #[test]
    fn preparation_naming_and_missing_base_errors_match_node() {
        let fixture = Fixture::new();
        let owner = WriterOwner::open(&fixture.0, Limits::default()).unwrap().0;
        let policy = auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
            first_user: auth::FirstUserTenant::NewUser,
        };
        let client = owner
            .working_drafts_with_observations(
                policy,
                Arc::new(Unread),
                PreparationLimits::default(),
            )
            .unwrap();
        for case in cases() {
            fixture.naming(case["override"].clone());
            if case["name"] == "missing-base" {
                fixture.sql().execute_batch("PRAGMA foreign_keys=OFF; DROP TRIGGER trg_build_profiles_revision_ownership_update; UPDATE build_profiles SET accepted_plan_revision_id=999 WHERE id=1").unwrap();
            }
            let before = fixture.rows();
            let error = client
                .recompute(
                    Credential::Session(auth::Secret::new("required-unit-fixture-secret".into())),
                    PositiveId::new(1).unwrap(),
                    RecomputeRequest::new(case["name"].as_str().unwrap(), true).unwrap(),
                    Arc::new(AtomicBool::new(false)),
                    Duration::from_secs(10),
                )
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                case["error"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            fixture.unchanged(before);
        }
        owner.shutdown().unwrap();
    }
}
