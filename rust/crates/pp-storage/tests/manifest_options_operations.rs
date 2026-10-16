#![cfg(feature = "desktop_rebuild")]

use pp_domain::PositiveId;
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    build_graph::{
        BuildCommand, BuildGraphClient, BuildOutcome, Failure, ManifestOptionsCommand,
        ManifestOptionsOutcome,
    },
    read_model::Credential,
    working_drafts::observation::{
        ArtifactRead, CheckoutManifestUse, DocumentRead, DraftReads, InventoryPath,
        OwnedCatalogReadRequest, OwnedCheckoutReadRequest, OwnedStlReadRequest, PreparationBudget,
        PreparationLimits, ReadFailure, ReadResult, StlInventory, StlRootRead,
    },
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

const MANIFEST: &[u8] = b"option_groups:\n  toolhead:\n    variants:\n      - id: stock\n        parts: [part.stl]\n      - id: mini\n        parts: [mini.stl]\nselections:\n  toolhead: stock\n";

#[derive(Clone, Copy)]
enum Change {
    None,
    Stamps,
    Once,
    Basis,
    Cancel,
    Fail,
}
struct Reads {
    calls: AtomicUsize,
    change: Change,
    database: PathBuf,
    cancelled: Arc<AtomicBool>,
}
impl DraftReads for Reads {
    fn read_checkout_manifest(
        &self,
        request: &OwnedCheckoutReadRequest,
        _: CheckoutManifestUse,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        assert_eq!(request.tenant(), "default");
        assert_eq!(request.source_id(), 1);
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.change, Change::Fail) {
            return Err(ReadFailure::Unavailable);
        }
        if call == 1 {
            if matches!(self.change, Change::Basis) {
                Connection::open(&self.database)
                    .unwrap()
                    .execute(
                        "UPDATE build_profiles SET config_modified_at='changed' WHERE id=1",
                        [],
                    )
                    .unwrap();
            }
            if matches!(self.change, Change::Cancel) {
                self.cancelled.store(true, Ordering::Release);
            }
        }
        budget.check()?;
        let mut bytes = MANIFEST.to_vec();
        if matches!(self.change, Change::Stamps) && call % 2 == 1
            || matches!(self.change, Change::Once) && call > 0
        {
            bytes.extend_from_slice(b"# changed\n");
        }
        budget.document(bytes.len(), bytes.len())?;
        Ok(DocumentRead::Bytes(bytes))
    }
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        budget.check()?;
        Ok(Box::new(Root))
    }
    fn read_catalog_document(
        &self,
        _: &OwnedCatalogReadRequest,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<DocumentRead> {
        panic!("declared groups need no hints")
    }
}
struct Root;
impl StlRootRead for Root {
    fn logical_resolved_path(&self) -> Option<&str> {
        Some("/checkout")
    }
    fn scan_stls(
        &mut self,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlInventory>> {
        budget.entry(1, 8)?;
        Ok(Box::new(Inventory(vec![InventoryPath {
            physical_relative_path: "part.stl".into(),
            traversal_ordinal: 0,
        }])))
    }
}
struct Inventory(Vec<InventoryPath>);
impl StlInventory for Inventory {
    fn entries(&self) -> &[InventoryPath] {
        &self.0
    }
    fn hash_tracked_winner(
        &mut self,
        _: usize,
        _: &mut PreparationBudget<'_>,
    ) -> ReadResult<ArtifactRead> {
        panic!("builder does not hash artifacts")
    }
}
struct Fixture {
    root: PathBuf,
    owner: Option<WriterOwner>,
    client: BuildGraphClient,
    reads: Arc<Reads>,
}
impl Fixture {
    fn new(change: Change) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-manifest-commands-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("print-partner.db");
        std::fs::write(&database, include_bytes!("fixtures/accepted-plan-node.db")).unwrap();
        let c = Connection::open(&database).unwrap();
        c.execute("UPDATE projects SET name='Base',url='https://example.test/Base',local_path='/checkout',imported_paths=NULL,manifest_community_slug=NULL WHERE id=1", []).unwrap();
        c.execute(
            "UPDATE build_profiles SET config_modified_at='before' WHERE id=1",
            [],
        )
        .unwrap();
        drop(c);
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let reads = Arc::new(Reads {
            calls: AtomicUsize::new(0),
            change,
            database,
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        let client = owner
            .build_graph_with_observations(
                auth::AuthPolicy {
                    registration: auth::RegistrationPolicy::Open,
                    first_user: auth::FirstUserTenant::NewUser,
                    session_tenant: auth::SessionTenantPolicy::AccountTenant,
                },
                reads.clone(),
                PreparationLimits::default(),
            )
            .unwrap();
        Self {
            root,
            owner: Some(owner),
            client,
            reads,
        }
    }
    fn run(&self, command: ManifestOptionsCommand) -> anyhow::Result<ManifestOptionsOutcome> {
        let outcome = self.client.execute(
            Credential::Session(Secret::new("read-fixture-secret".into())),
            BuildCommand::Manifest(command),
            self.reads.cancelled.clone(),
            Duration::from_secs(3),
        )?;
        let BuildOutcome::Manifest(outcome) = outcome else {
            panic!("{outcome:?}")
        };
        Ok(outcome)
    }
    fn save(&self, kit: Value) -> anyhow::Result<ManifestOptionsOutcome> {
        self.run(ManifestOptionsCommand::SaveKit {
            build: id(1),
            request: serde_json::to_vec(&json!({"kit":kit})).unwrap(),
        })
    }
    fn state(&self) -> (Option<String>, String) {
        let c = Connection::open(self.root.join("print-partner.db")).unwrap();
        c.query_row("SELECT (SELECT value FROM app_settings WHERE tenant_id='default' AND key='kit_manifest_1'),config_modified_at FROM build_profiles WHERE id=1", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            owner.shutdown().unwrap();
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn id(n: u64) -> PositiveId {
    PositiveId::new(n).unwrap()
}
fn body(outcome: ManifestOptionsOutcome) -> Value {
    serde_json::from_slice(&outcome.into_success_body().unwrap().into_bytes()).unwrap()
}

#[test]
fn read_builder_and_save_readback_match_node() {
    let mut f = Fixture::new(Change::None);
    let oracle: Value =
        serde_json::from_slice(include_bytes!("fixtures/manifest-commands-node.json")).unwrap();
    assert_eq!(
        body(
            f.run(ManifestOptionsCommand::ReadKit { build: id(1) })
                .unwrap()
        ),
        oracle["empty"]
    );
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        body(
            f.run(ManifestOptionsCommand::ReadBuilder { build: id(1) })
                .unwrap()
        ),
        oracle["builder"]
    );
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 2);
    let saved = body(
        f.save(json!({"name":"Saved", "selections":{"toolhead":" mini "},"include":["part.stl"]}))
            .unwrap(),
    );
    assert_eq!(saved, oracle["saved"]);
    assert_eq!(
        body(
            f.run(ManifestOptionsCommand::ReadKit { build: id(1) })
                .unwrap()
        ),
        saved
    );
    assert_ne!(f.state().1, "before");
    let builder = body(
        f.run(ManifestOptionsCommand::ReadBuilder { build: id(1) })
            .unwrap(),
    );
    assert_eq!(builder["resolved_selections"], json!({"toolhead":"mini"}));
    let reset = body(f.save(json!({"name":"Replacement"})).unwrap());
    assert_eq!(reset["kit"]["include"], json!([]));
    assert_eq!(reset["kit"]["selections"], json!({}));
    f.owner.take().unwrap().shutdown().unwrap();
    let owner = WriterOwner::open(&f.root, Limits::default()).unwrap().0;
    f.client = owner
        .build_graph_with_policy(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            first_user: auth::FirstUserTenant::NewUser,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
        })
        .unwrap();
    f.owner = Some(owner);
    assert_eq!(
        body(
            f.run(ManifestOptionsCommand::ReadKit { build: id(1) })
                .unwrap()
        ),
        reset
    );
}

#[test]
fn unstable_stamps_refuse_without_writing_and_builder_retry_is_bounded() {
    let f = Fixture::new(Change::Stamps);
    let before = f.state();
    assert!(matches!(
        f.save(json!({"name":"Refused"})).unwrap(),
        ManifestOptionsOutcome::StaleObservation
    ));
    assert_eq!(f.state(), before);
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 2);
    assert!(matches!(
        f.run(ManifestOptionsCommand::ReadBuilder { build: id(1) })
            .unwrap(),
        ManifestOptionsOutcome::StaleObservation
    ));
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 6);
    assert_eq!(f.state(), before);
    let f = Fixture::new(Change::Once);
    assert!(matches!(
        f.run(ManifestOptionsCommand::ReadBuilder { build: id(1) })
            .unwrap(),
        ManifestOptionsOutcome::Builder(_)
    ));
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 4);
}

#[test]
fn changed_database_basis_refuses_save_and_builder_rechecks() {
    let f = Fixture::new(Change::Basis);
    assert!(matches!(
        f.save(json!({"name":"Refused"})).unwrap(),
        ManifestOptionsOutcome::StaleObservation
    ));
    assert_eq!(f.state(), (None, "changed".into()));
    let f = Fixture::new(Change::Basis);
    assert!(matches!(
        f.save(json!({"selections":{"toolhead":[]}})).unwrap(),
        ManifestOptionsOutcome::StaleObservation
    ));
    assert_eq!(f.state(), (None, "changed".into()));
    let f = Fixture::new(Change::Basis);
    assert!(matches!(
        f.run(ManifestOptionsCommand::ReadBuilder { build: id(1) })
            .unwrap(),
        ManifestOptionsOutcome::Builder(_)
    ));
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 4);
    assert_eq!(f.state(), (None, "changed".into()));
}

#[test]
fn unknown_selections_and_invalid_cardinality_refuse_without_writing() {
    let f = Fixture::new(Change::None);
    let before = f.state();
    for (selections, expected) in [
        (
            json!({"missing":"stock"}),
            "kit.selections.missing is an unknown option group",
        ),
        (
            json!({"toolhead":"missing"}),
            "kit.selections.toolhead contains an unknown variant id",
        ),
        (
            json!({"toolhead":[]}),
            "kit.selections.toolhead must contain at least one variant id",
        ),
        (
            json!({"toolhead":["stock","mini"]}),
            "kit.selections.toolhead must contain no more than 1 variant id",
        ),
    ] {
        let ManifestOptionsOutcome::InvalidInput { detail } =
            f.save(json!({"selections":selections})).unwrap()
        else {
            panic!("invalid input expected")
        };
        let value: Value = serde_json::from_slice(&detail.into_body().into_bytes()).unwrap();
        assert_eq!(value, json!({"detail":expected}));
        assert_eq!(f.state(), before);
    }
}

#[test]
fn cancellation_observation_failure_missing_plan_and_tenant_isolation() {
    let f = Fixture::new(Change::Cancel);
    let before = f.state();
    let error = f.save(json!({"name":"Cancelled"})).unwrap_err();
    assert!(matches!(
        error.downcast_ref::<Failure>(),
        Some(Failure::Cancelled)
    ));
    assert_eq!(f.state(), before);
    let f = Fixture::new(Change::Fail);
    assert!(matches!(
        f.save(json!({})).unwrap(),
        ManifestOptionsOutcome::ObservationFailed { .. }
    ));
    assert_eq!(f.state(), (None, "before".into()));
    let f = Fixture::new(Change::None);
    Connection::open(f.root.join("print-partner.db"))
        .unwrap()
        .execute(
            "INSERT INTO build_profiles(id,tenant_id,name) VALUES(50,'other','Hidden')",
            [],
        )
        .unwrap();
    for build in [id(999), id(50)] {
        for command in [
            ManifestOptionsCommand::ReadKit { build },
            ManifestOptionsCommand::ReadBuilder { build },
            ManifestOptionsCommand::SaveKit {
                build,
                request: b"invalid".to_vec(),
            },
        ] {
            assert!(matches!(
                f.run(command).unwrap(),
                ManifestOptionsOutcome::MissingBuild
            ));
        }
    }
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 0);
    f.reads.cancelled.store(true, Ordering::Release);
    for command in [
        ManifestOptionsCommand::ReadKit { build: id(1) },
        ManifestOptionsCommand::ReadBuilder { build: id(1) },
        ManifestOptionsCommand::SaveKit {
            build: id(1),
            request: b"{}".to_vec(),
        },
    ] {
        assert!(matches!(
            f.run(command).unwrap_err().downcast_ref::<Failure>(),
            Some(Failure::Cancelled)
        ));
    }
    assert_eq!(f.state(), (None, "before".into()));
}

#[test]
fn failed_freshness_update_rolls_back_kit_and_corrupt_stored_kit_reads_empty() {
    let f = Fixture::new(Change::None);
    let c = Connection::open(f.root.join("print-partner.db")).unwrap();
    c.execute_batch("CREATE TRIGGER reject_freshness BEFORE UPDATE OF config_modified_at ON build_profiles BEGIN SELECT RAISE(ABORT,'test freshness failure'); END;").unwrap();
    let before = f.state();
    assert!(
        f.save(json!({"name":"Refused"}))
            .unwrap_err()
            .to_string()
            .contains("test freshness failure")
    );
    assert_eq!(f.state(), before);
    c.execute(
        "INSERT INTO app_settings(tenant_id,key,value) VALUES('default','kit_manifest_1','broken')",
        [],
    )
    .unwrap();
    let oracle: Value =
        serde_json::from_slice(include_bytes!("fixtures/manifest-commands-node.json")).unwrap();
    assert_eq!(
        body(
            f.run(ManifestOptionsCommand::ReadKit { build: id(1) })
                .unwrap()
        ),
        oracle["empty"]
    );
}

#[test]
fn invalid_credentials_and_stopped_owner_refuse_before_observation() {
    let mut f = Fixture::new(Change::None);
    for manifest in [
        ManifestOptionsCommand::ReadKit { build: id(1) },
        ManifestOptionsCommand::ReadBuilder { build: id(1) },
        ManifestOptionsCommand::SaveKit {
            build: id(1),
            request: b"{}".to_vec(),
        },
    ] {
        assert!(
            f.client
                .execute(
                    Credential::Session(Secret::new("invalid".into())),
                    BuildCommand::Manifest(manifest),
                    Arc::new(AtomicBool::new(false)),
                    Duration::from_secs(3)
                )
                .is_err()
        );
    }
    assert_eq!(f.reads.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.state(), (None, "before".into()));
    f.owner.take().unwrap().shutdown().unwrap();
    for manifest in [
        ManifestOptionsCommand::ReadKit { build: id(1) },
        ManifestOptionsCommand::ReadBuilder { build: id(1) },
        ManifestOptionsCommand::SaveKit {
            build: id(1),
            request: b"{}".to_vec(),
        },
    ] {
        assert!(matches!(
            f.run(manifest).unwrap_err().downcast_ref::<Failure>(),
            Some(Failure::Stopped)
        ));
    }
}
