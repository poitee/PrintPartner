use pp_storage::{
    Limits, WriterOwner,
    catalog::{NamingCommand, NamingProfile, Outcome, Request},
};
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

struct Fixture(PathBuf);
#[derive(Debug, PartialEq)]
struct Snapshot {
    rows: Vec<(String, Vec<Vec<SqlValue>>)>,
    files: Vec<(PathBuf, Vec<u8>)>,
}
impl Fixture {
    fn new() -> Self {
        let fixture =
            Self(std::env::temp_dir().join(format!("pp-gre918-{}", rand::random::<u64>())));
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
        let root = fixture.0.join("repos/1/revisions/fixture");
        std::fs::create_dir_all(&root).unwrap();
        for (file, body) in [
            ("frame.stl", "disposable STL"),
            ("manifest.yaml", "parts: []\n"),
            ("catalog.yaml", "parts: []\n"),
        ] {
            std::fs::write(root.join(file), body).unwrap();
        }
        fixture
            .sql()
            .execute(
                "UPDATE projects SET local_path=? WHERE id=1",
                [root.to_str().unwrap()],
            )
            .unwrap();
        fixture
    }
    fn sql(&self) -> Connection {
        Connection::open(self.0.join("print-partner.db")).unwrap()
    }
    fn naming(&self, case: &Value) {
        let stored = match case["override_json"].as_str() {
            Some(raw) => format!(r#"{{"naming":{{"use_defaults":false,"override":{raw}}}}}"#),
            None => {
                json!({"naming":{"use_defaults":false,"override":case["override"]}}).to_string()
            }
        };
        self.sql()
            .execute("UPDATE projects SET metadata_json=? WHERE id=1", [stored])
            .unwrap();
    }
    fn snapshot(&self) -> Snapshot {
        let db = self.sql();
        let tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let rows = tables
            .into_iter()
            .map(|table| {
                let mut statement = db
                    .prepare(&format!(
                        "SELECT * FROM \"{}\" ORDER BY rowid",
                        table.replace('"', "\"\"")
                    ))
                    .unwrap();
                let columns = statement.column_count();
                let rows = statement
                    .query_map([], |row| {
                        (0..columns).map(|column| row.get(column)).collect()
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                (table, rows)
            })
            .collect();
        fn files(root: &Path, directory: &Path, output: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    files(root, &path, output);
                } else {
                    let relative = path.strip_prefix(root).unwrap();
                    if [
                        "print-partner.db",
                        "print-partner.db-wal",
                        "print-partner.db-shm",
                    ]
                    .iter()
                    .any(|name| relative == Path::new(name))
                    {
                        continue;
                    }
                    output.push((relative.to_owned(), std::fs::read(path).unwrap()));
                }
            }
        }
        let mut fixture_files = Vec::new();
        files(&self.0, &self.0, &mut fixture_files);
        fixture_files.sort_by(|a, b| a.0.cmp(&b.0));
        Snapshot {
            rows,
            files: fixture_files,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn cases() -> Vec<Value> {
    let cases: Vec<Value> = include_str!("fixtures/gre918-stored-naming-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        cases.len(),
        54,
        "the feature-off test must exercise the capture"
    );
    cases
}

#[test]
fn catalog_refusals_retain_exact_details_in_both_feature_modes() {
    let fixture = Fixture::new();
    let owner = WriterOwner::open(&fixture.0, Limits::default()).unwrap().0;
    let client = owner.local_source_catalog();
    for case in cases() {
        let name = case["name"].as_str().unwrap();
        fixture.naming(&case);
        let before = fixture.snapshot();
        let result = client.execute(Request::GetNaming { id: 1 });
        assert_eq!(
            fixture.snapshot(),
            before,
            "{name}: catalog changed stored data"
        );
        let error = result.unwrap_err();
        assert_eq!(
            case["node_catalog"],
            json!({"kind":"invalid_state"}),
            "{name}"
        );
        #[cfg(feature = "desktop_rebuild")]
        let expected = {
            assert_eq!(
                error.to_string(),
                "Stored Source naming settings are invalid",
                "{name}"
            );
            assert!(
                matches!(
                    error.downcast_ref(),
                    Some(pp_storage::catalog::CatalogFailure::InvalidStoredNaming)
                ),
                "{name}"
            );
            case["rust_on"].as_str().unwrap()
        };
        #[cfg(not(feature = "desktop_rebuild"))]
        let expected = {
            let expected = case["rust_off"].as_str().unwrap();
            assert_eq!(error.to_string(), expected, "{name}");
            expected
        };
        assert_eq!(error.root_cause().to_string(), expected, "{name}");
        #[cfg(feature = "desktop_rebuild")]
        let mode = "feature_on";
        #[cfg(not(feature = "desktop_rebuild"))]
        let mode = "feature_off";
        assert_eq!(
            case["known_mismatch"][mode],
            json!(expected != case["node_preparation"].as_str().unwrap()),
            "{name}: mismatch classification"
        );
    }
    owner.shutdown().unwrap();
}

#[test]
fn saving_valid_unicode_group_names_preserves_the_pattern() {
    let fixture = Fixture::new();
    let owner = WriterOwner::open(&fixture.0, Limits::default()).unwrap().0;
    let client = owner.local_source_catalog();
    for name in [r"\u0078", r"\u{78}", r"\uD835\uDC9C", r"\u{1D49C}"] {
        let pattern = format!("(?<{name}>a)");
        let mut profile = NamingProfile::default();
        profile.quantity.regex = pattern.clone();
        let Outcome::Data(saved) = client
            .execute(Request::SaveNaming {
                id: 1,
                settings: NamingCommand::Override { profile },
            })
            .unwrap()
        else {
            panic!("expected saved naming data for {name}");
        };
        assert_eq!(saved["effective"]["quantity"]["regex"], pattern, "{name}");
    }
    owner.shutdown().unwrap();
}

#[test]
fn saving_a_regex_node_22_rejects_follows_the_feature() {
    let fixture = Fixture::new();
    let owner = WriterOwner::open(&fixture.0, Limits::default()).unwrap().0;
    let client = owner.local_source_catalog();
    let mut profile = NamingProfile::default();
    profile.quantity.regex = "(?i:(a))".into();
    let before = fixture.snapshot();
    let result = client.execute(Request::SaveNaming {
        id: 1,
        settings: NamingCommand::Override { profile },
    });
    #[cfg(feature = "desktop_rebuild")]
    {
        let error = result.unwrap_err();
        assert_eq!(error.to_string(), "Invalid quantity regex");
        assert!(matches!(
            error.downcast_ref(),
            Some(pp_storage::catalog::CatalogFailure::Input(_))
        ));
        assert_eq!(
            fixture.snapshot(),
            before,
            "refused save changed stored data"
        );
    }
    #[cfg(not(feature = "desktop_rebuild"))]
    {
        result.unwrap();
        assert_ne!(
            fixture.snapshot(),
            before,
            "feature-off save still accepts it"
        );
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
            panic!("stored naming refusal must precede STL observation")
        }
        fn read_checkout_manifest(
            &self,
            _: &OwnedCheckoutReadRequest,
            _: CheckoutManifestUse,
            _: &mut PreparationBudget<'_>,
        ) -> ReadResult<DocumentRead> {
            panic!("stored naming refusal must precede manifest observation")
        }
        fn read_catalog_document(
            &self,
            _: &OwnedCatalogReadRequest,
            _: &mut PreparationBudget<'_>,
        ) -> ReadResult<DocumentRead> {
            panic!("stored naming refusal must precede catalog observation")
        }
    }

    #[test]
    fn preparation_captures_known_mismatches_before_any_file_observation() {
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
            let name = case["name"].as_str().unwrap();
            fixture.naming(&case);
            let before = fixture.snapshot();
            let result = client.recompute(
                Credential::Session(auth::Secret::new("required-unit-fixture-secret".into())),
                PositiveId::new(1).unwrap(),
                RecomputeRequest::new(name, true).unwrap(),
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(10),
            );
            assert_eq!(
                fixture.snapshot(),
                before,
                "{name}: preparation changed stored data"
            );
            let error = result.unwrap_err();
            let expected = case["rust_on"].as_str().unwrap();
            assert_eq!(error.to_string(), expected, "{name}");
            assert_eq!(error.root_cause().to_string(), expected, "{name}");
            assert!(
                matches!(
                    error.downcast_ref(),
                    Some(pp_storage::catalog::CatalogFailure::InvalidStoredNaming)
                ),
                "{name}"
            );
            assert_eq!(
                case["known_mismatch"]["feature_on"],
                json!(error.to_string() != case["node_preparation"].as_str().unwrap()),
                "{name}: mismatch classification"
            );
        }
        owner.shutdown().unwrap();
    }
}
