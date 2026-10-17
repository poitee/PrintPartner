#![cfg(feature = "desktop_rebuild")]
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    read_model::Credential,
    working_drafts::{
        Failure, PositiveId, RecomputeRequest,
        observation::{
            ArtifactRead, CheckoutManifestUse, DocumentRead, DraftReads, InventoryPath,
            OwnedCatalogReadRequest, OwnedCheckoutReadRequest, OwnedStlReadRequest,
            PreparationBudget, PreparationLimits, ReadFailure, ReadResult, Resource, StlInventory,
            StlRootRead,
        },
    },
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
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
fn node(name: &str) -> Value {
    include_str!("fixtures/working-draft-recompute-node.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|case| case["name"] == name)
        .unwrap()
}

/// Serves `files` from every STL root. The first scan runs `between` on its
/// own connection and can cancel. Preparation still reads settings, Source rows
/// and the Plan's existence after that scan, so `between` must not change what
/// those reads decide.
struct Reads {
    files: Vec<String>,
    database: PathBuf,
    between: Mutex<Option<String>>,
    cancel: Option<Arc<AtomicBool>>,
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
        if let Some(sql) = self.0.between.lock().unwrap().take() {
            Connection::open(&self.0.database)
                .unwrap()
                .execute_batch(&sql)
                .unwrap();
        }
        if let Some(cancel) = &self.0.cancel {
            cancel.store(true, Ordering::Release);
        }
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

struct Fixture {
    path: PathBuf,
}
impl Fixture {
    /// Node's accepted-base reuse reads the revision snapshot from the data
    /// directory, so the Source files also live there.
    fn new(case: &Value) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-draft-recompute-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("print-partner.db"),
            include_bytes!("fixtures/required-units/unchanged.db"),
        )
        .unwrap();
        let revision = path.join("repos/1/revisions/fixture");
        std::fs::create_dir_all(&revision).unwrap();
        for file in case["files"].as_array().unwrap() {
            let file = file.as_str().unwrap();
            std::fs::write(revision.join(file), file).unwrap();
        }
        let fixture = Self { path };
        for sql in case["setup"].as_array().unwrap() {
            fixture.sql().execute_batch(sql.as_str().unwrap()).unwrap();
        }
        fixture
    }
    fn database(&self) -> PathBuf {
        self.path.join("print-partner.db")
    }
    fn sql(&self) -> Connection {
        Connection::open(self.database()).unwrap()
    }
    fn reads(
        &self,
        files: &Value,
        between: &Value,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Arc<Shared> {
        Arc::new(Shared(Arc::new(Reads {
            files: serde_json::from_value(files.clone()).unwrap(),
            database: self.database(),
            between: Mutex::new(between.as_str().map(str::to_owned)),
            cancel,
        })))
    }
    fn rows(&self, sql: &str) -> Value {
        let connection = self.sql();
        let mut statement = connection.prepare(sql).unwrap();
        let columns = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let rows = statement
            .query_map([], |row| {
                Ok(Value::Object(
                    columns
                        .iter()
                        .enumerate()
                        .map(|(i, column)| {
                            let value = match row.get_ref(i).unwrap() {
                                rusqlite::types::ValueRef::Null => Value::Null,
                                rusqlite::types::ValueRef::Integer(n) => json!(n),
                                value => json!(value.as_str().unwrap()),
                            };
                            (column.clone(), value)
                        })
                        .collect(),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        Value::from(rows)
    }
    fn recorded_rows(&self) -> Value {
        json!({
            "drafts": self.rows("SELECT id,tenant_id,profile_id,base_revision_id,base_plan_version,state,lifecycle_version,rebased_from_draft_id,rebased_from_lifecycle_version,rebased_from_snapshot_digest,digest_format,snapshot_digest,created_by,idempotency_key,created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AS created_at_iso,current_required_unit_reconciliation_id,consumed_revision_id,consumed_at FROM plan_drafts ORDER BY id"),
            "inputs": self.rows("SELECT * FROM plan_draft_inputs ORDER BY id"),
            "parts": self.rows("SELECT * FROM plan_draft_parts ORDER BY id"),
        })
    }
    fn open(&self) -> WriterOwner {
        WriterOwner::open(&self.path, Limits::default()).unwrap().0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn recompute(
    owner: &WriterOwner,
    reads: Arc<Shared>,
    limits: PreparationLimits,
    key: &str,
    apply_manifest: bool,
    profile: u64,
    cancelled: Arc<AtomicBool>,
) -> anyhow::Result<Value> {
    let client = owner.working_drafts_with_observations(policy(), reads, limits)?;
    let outcome = client.recompute(
        session(),
        id(profile),
        RecomputeRequest::new(key, apply_manifest)?,
        cancelled,
        Duration::from_secs(5),
    )?;
    let mut outcome: Value = serde_json::from_slice(&outcome.into_json_body().into_bytes())?;
    if let Some(created_at) = outcome["draft"]["createdAt"].as_str() {
        let iso = created_at.len() == 24
            && created_at
                .bytes()
                .zip(b"0000-00-00T00:00:00.000Z")
                .all(|(c, p)| {
                    if *p == b'0' {
                        c.is_ascii_digit()
                    } else {
                        c == *p
                    }
                });
        outcome["draft"]["createdAt"] = json!(iso);
    }
    Ok(outcome)
}

fn compare_node(name: &str) {
    let case = node(name);
    let f = Fixture::new(&case);
    let calls = case["calls"].as_array().unwrap();
    let results = case["results"].as_array().unwrap();
    assert_eq!(calls.len(), results.len());
    for (index, (call, expected)) in calls.iter().zip(results).enumerate() {
        let owner = f.open();
        let actual = match call["op"].as_str().unwrap() {
            "edit" => owner
                .working_drafts_with_policy(policy())
                .unwrap()
                .edit(
                    session(),
                    id(call["profile"].as_u64().unwrap()),
                    id(call["draft"].as_u64().unwrap()),
                    serde_json::from_value(call["request"].clone()).unwrap(),
                    Arc::new(AtomicBool::new(false)),
                    Duration::from_secs(5),
                )
                .map(|outcome| serde_json::to_value(outcome).unwrap()),
            "recompute" => recompute(
                &owner,
                f.reads(&case["files"], &call["between"], None),
                PreparationLimits::default(),
                call["key"].as_str().unwrap(),
                call["applyManifest"].as_bool().unwrap(),
                call["profile"].as_u64().unwrap(),
                Arc::new(AtomicBool::new(false)),
            ),
            other => panic!("Unknown Node call {other}"),
        };
        match expected["error"].as_str() {
            Some(message) => assert_eq!(
                actual.unwrap_err().to_string(),
                message,
                "{name} call {index}"
            ),
            None => assert_eq!(&actual.unwrap(), expected, "{name} call {index}"),
        }
        owner.shutdown().unwrap();
    }
    let rows = f.recorded_rows();
    for table in ["drafts", "inputs", "parts"] {
        assert_eq!(rows[table], case[table], "{name} {table}");
    }
}
macro_rules! node_case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() {
            compare_node($name);
        }
    };
}
node_case!(
    created_draft_abandons_the_open_draft_and_replays_like_node,
    "created-then-replayed"
);
node_case!(
    a_recompute_draft_key_returns_that_draft,
    "existing-recompute-key"
);
node_case!(a_rebased_draft_key_conflicts, "rebased-key-conflicts");
node_case!(
    open_draft_quantities_carry_into_the_kit,
    "edits-carry-quantity"
);
node_case!(
    open_draft_inclusion_carries_when_the_draft_is_kept,
    "edits-carry-inclusion"
);
node_case!(
    missing_profile_and_blank_key_are_refused,
    "missing-profile-and-blank-key"
);
node_case!(a_profile_without_a_baseline_is_refused, "baseline-required");
node_case!(
    a_baseline_lost_after_preparation_is_refused,
    "baseline-required-after-prepare"
);
node_case!(
    a_base_moved_after_preparation_is_base_changed,
    "base-moved-after-prepare"
);
node_case!(
    a_profile_hidden_after_preparation_is_base_changed,
    "profile-hidden-after-prepare"
);
node_case!(
    inputs_changed_after_preparation_are_refused,
    "inputs-changed-after-prepare"
);
node_case!(
    a_winner_saved_after_preparation_is_returned,
    "winner-after-prepare"
);
node_case!(a_profile_without_layers_is_no_layers, "no-layers");
node_case!(a_profile_without_stls_is_no_stls, "no-stls");

fn refused(f: &Fixture, cancel: bool, limits: PreparationLimits) -> anyhow::Error {
    let owner = f.open();
    let cancelled = Arc::new(AtomicBool::new(false));
    let reads = f.reads(
        &node("created-then-replayed")["files"],
        &Value::Null,
        cancel.then(|| cancelled.clone()),
    );
    let error = recompute(&owner, reads, limits, "first", true, 1, cancelled).unwrap_err();
    owner.shutdown().unwrap();
    error
}

#[test]
fn cancellation_during_preparation_writes_nothing() {
    let f = Fixture::new(&node("created-then-replayed"));
    let before = f.recorded_rows();
    let error = refused(&f, true, PreparationLimits::default());
    assert!(
        matches!(error.downcast_ref(), Some(ReadFailure::Cancelled)),
        "{error:?}"
    );
    assert_eq!(f.recorded_rows(), before);
}

#[test]
fn a_budget_refusal_writes_nothing() {
    let f = Fixture::new(&node("created-then-replayed"));
    let before = f.recorded_rows();
    let limits = PreparationLimits {
        entries: 3,
        ..PreparationLimits::default()
    };
    let error = refused(&f, false, limits);
    assert!(
        matches!(
            error.downcast_ref(),
            Some(ReadFailure::LimitExceeded(Resource::Entries))
        ),
        "{error:?}"
    );
    assert_eq!(f.recorded_rows(), before);
}

/// Plan 3 shares Plan 1's layers, and its Source serves whatever STLs the
/// test reads.
const NEW_PLAN: &str = "INSERT INTO build_profiles(id,tenant_id,name) VALUES(3,'default','New Build'); INSERT INTO profile_layers(tenant_id,profile_id,project_id,layer_type,layer_order) SELECT tenant_id,3,project_id,layer_type,layer_order FROM profile_layers WHERE profile_id=1; UPDATE projects SET current_source_revision_id=NULL WHERE id=1";

/// Recomputes Plan 3 from one STL under a 512-visit limit and then a
/// 10,000-unit comparison limit. Both must refuse while carrying edits from the
/// open draft, and write nothing.
fn assert_carry_refused(f: &Fixture, owner: &WriterOwner) {
    let before = f.recorded_rows();
    let bounded = |limits| {
        recompute(
            owner,
            f.reads(&json!(["only-current.stl"]), &Value::Null, None),
            limits,
            "bounded",
            true,
            3,
            Arc::new(AtomicBool::new(false)),
        )
    };
    let visits = bounded(PreparationLimits {
        visits: 512,
        ..PreparationLimits::default()
    });
    let compared = bounded(PreparationLimits {
        comparison_work: 10_000,
        ..PreparationLimits::default()
    });
    assert!(
        matches!(
            visits.as_ref().map_err(|error| error.downcast_ref()),
            Err(Some(ReadFailure::LimitExceeded(Resource::Visits)))
        ),
        "{visits:?}"
    );
    assert!(
        matches!(
            compared.as_ref().map_err(|error| error.downcast_ref()),
            Err(Some(ReadFailure::LimitExceeded(Resource::ComparisonWork)))
        ),
        "{compared:?}"
    );
    assert_eq!(f.recorded_rows(), before);
}

#[test]
fn carrying_open_draft_edits_spends_the_recompute_budget() {
    let files = json!(
        (0..600)
            .map(|i| format!("old-{i:04}.stl"))
            .collect::<Vec<_>>()
    );
    let f = Fixture::new(&json!({"files": files, "setup": [NEW_PLAN]}));
    let owner = f.open();
    let large = recompute(
        &owner,
        f.reads(&files, &Value::Null, None),
        PreparationLimits::default(),
        "large",
        true,
        3,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert_eq!(large["kind"], "created");
    assert_eq!(large["draft"]["parts"].as_array().unwrap().len(), 600);
    assert_carry_refused(&f, &owner);
    owner.shutdown().unwrap();
}

/// The reviewer's probe. A v2 draft built through the public API selects a
/// reconciliation with 20,000 assignments over only 20 Parts. The reviewer
/// ran it with the maximum 200,000, which the default visit limit refuses.
#[test]
fn carrying_a_selected_reconciliation_spends_the_recompute_budget() {
    let files = json!(
        (0..20)
            .map(|i| format!("old-{i:04}.stl"))
            .collect::<Vec<_>>()
    );
    let f = Fixture::new(&json!({"files": files, "setup": [NEW_PLAN]}));
    let owner = f.open();
    let large = recompute(
        &owner,
        f.reads(&files, &Value::Null, None),
        PreparationLimits::default(),
        "large",
        true,
        3,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let ids = large["draft"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["id"].clone())
        .collect::<Vec<_>>();
    let request = serde_json::from_value(json!({
        "expected_snapshot_digest": large["draft"]["snapshotDigest"],
        "decision": {"kind": "set_quantity_override", "draft_part_ids": ids, "value": 1000},
    }))
    .unwrap();
    let edited = owner
        .working_drafts_with_policy(policy())
        .unwrap()
        .edit(
            session(),
            id(3),
            id(large["draft"]["id"].as_u64().unwrap()),
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(serde_json::to_value(edited).unwrap()["kind"], "ready");
    assert_eq!(
        f.rows("SELECT d.digest_format,(SELECT COUNT(*) FROM plan_draft_parts p WHERE p.draft_id=d.id) AS parts,(SELECT COUNT(*) FROM plan_draft_required_unit_assignments a WHERE a.reconciliation_id=d.current_required_unit_reconciliation_id) AS assignments FROM plan_drafts d WHERE d.profile_id=3"),
        json!([{"digest_format": "plan-draft-v2", "parts": 20, "assignments": 20000}])
    );
    assert_carry_refused(&f, &owner);
    owner.shutdown().unwrap();
}

/// Selects a new finalized, unresolved reconciliation on open draft 2 with
/// `basis` and `result` SQL values. Its digests are not valid, so loading the
/// draft fails unless the budget refuses first.
fn select_reconciliation(basis: &str, result: &str) -> String {
    format!(
        "INSERT INTO plan_draft_required_unit_reconciliations(tenant_id,profile_id,draft_id,format,planning_digest,base_revision_id,selection_basis_digest,selection_basis_json,decision_digest,result_kind,result_digest,result_json,reconciliation_digest,expected_assignment_count,actor_id,idempotency_key,payload_digest,created_at) SELECT tenant_id,profile_id,id,'required-unit-reconciliation-v1','',base_revision_id,'',{basis},'','unresolved','',{result},'',0,created_by,'padded','','2026-01-01T00:00:00.000Z' FROM plan_drafts WHERE id=2;
        UPDATE plan_draft_required_unit_reconciliations SET finalized_at='2026-01-01T00:00:00.000Z' WHERE idempotency_key='padded';
        UPDATE plan_drafts SET current_required_unit_reconciliation_id=(SELECT id FROM plan_draft_required_unit_reconciliations WHERE idempotency_key='padded') WHERE id=2;"
    )
}

/// Each case makes one column that loading open draft 2 reads too large for
/// the limit. Uncharged, the load fails a digest check instead.
/// `carrying_a_selected_reconciliation_spends_the_recompute_budget` covers
/// assignments.
#[test]
fn every_column_a_draft_load_reads_spends_the_carry_budget() {
    let padding = "hex(zeroblob(20000))";
    let unresolved = "json_object('kind','unresolved','conflicts',json_array()";
    let cases = [
        (
            "header",
            format!("UPDATE plan_drafts SET snapshot_digest={padding} WHERE id=2"),
        ),
        (
            "inputs",
            format!(
                "UPDATE plan_draft_inputs SET effective_naming_digest={padding} WHERE draft_id=2"
            ),
        ),
        (
            "parts",
            format!(
                "UPDATE plan_draft_parts SET spoolman_spool_id={padding} WHERE id=(SELECT MIN(id) FROM plan_draft_parts WHERE draft_id=2)"
            ),
        ),
        (
            "basis",
            select_reconciliation(&format!("json_array({padding})"), &format!("{unresolved})")),
        ),
        (
            "result",
            select_reconciliation("'[]'", &format!("{unresolved},'padding',{padding})")),
        ),
    ];
    let limits = PreparationLimits {
        comparison_work: 20_000,
        ..PreparationLimits::default()
    };
    for (name, sql) in cases {
        let f = Fixture::new(&node("created-then-replayed"));
        f.sql().execute_batch(&sql).unwrap();
        let before = f.recorded_rows();
        let error = refused(&f, false, limits);
        assert!(
            matches!(
                error.downcast_ref(),
                Some(ReadFailure::LimitExceeded(Resource::ComparisonWork))
            ),
            "{name}: {error:?}"
        );
        assert_eq!(f.recorded_rows(), before, "{name}");
    }
}

#[test]
fn cancellation_during_an_empty_scan_is_not_no_stls() {
    let f = Fixture::new(&node("no-stls"));
    let before = f.recorded_rows();
    let owner = f.open();
    let cancelled = Arc::new(AtomicBool::new(false));
    let error = recompute(
        &owner,
        f.reads(&json!([]), &Value::Null, Some(cancelled.clone())),
        PreparationLimits::default(),
        "first",
        true,
        1,
        cancelled,
    )
    .unwrap_err();
    owner.shutdown().unwrap();
    assert!(
        matches!(error.downcast_ref(), Some(Failure::Cancelled)),
        "{error:?}"
    );
    assert_eq!(f.recorded_rows(), before);
}

/// Has no STL root, and cancels when preparation asks for it a second time.
struct NoRoot(Arc<AtomicBool>);
struct MissingRoot {
    cancel: Arc<AtomicBool>,
    asked: AtomicBool,
}
impl DraftReads for NoRoot {
    fn resolve_stl_root(
        &self,
        _: &OwnedStlReadRequest,
        budget: &mut PreparationBudget<'_>,
    ) -> ReadResult<Box<dyn StlRootRead>> {
        budget.check()?;
        Ok(Box::new(MissingRoot {
            cancel: self.0.clone(),
            asked: AtomicBool::new(false),
        }))
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
impl StlRootRead for MissingRoot {
    fn logical_resolved_path(&self) -> Option<&str> {
        if self.asked.swap(true, Ordering::AcqRel) {
            self.cancel.store(true, Ordering::Release);
        }
        None
    }
    fn scan_stls(&mut self, _: &mut PreparationBudget<'_>) -> ReadResult<Box<dyn StlInventory>> {
        unreachable!("a missing root is never scanned")
    }
}

#[test]
fn cancellation_while_finding_no_layers_is_not_no_layers() {
    let f = Fixture::new(&node("created-then-replayed"));
    let before = f.recorded_rows();
    let owner = f.open();
    let cancelled = Arc::new(AtomicBool::new(false));
    let error = owner
        .working_drafts_with_observations(
            policy(),
            Arc::new(NoRoot(cancelled.clone())),
            PreparationLimits::default(),
        )
        .unwrap()
        .recompute(
            session(),
            id(1),
            RecomputeRequest::new("first", true).unwrap(),
            cancelled,
            Duration::from_secs(5),
        )
        .unwrap_err();
    owner.shutdown().unwrap();
    assert!(
        matches!(error.downcast_ref(), Some(Failure::Cancelled)),
        "{error:?}"
    );
    assert_eq!(f.recorded_rows(), before);
}

#[test]
fn refused_requests_write_nothing() {
    let f = Fixture::new(&node("created-then-replayed"));
    let before = f.recorded_rows();
    let long = "k".repeat(161);
    assert_eq!(
        RecomputeRequest::new(&long, true).unwrap_err().to_string(),
        "Invalid idempotency key"
    );
    assert!(RecomputeRequest::new(&long[1..], true).is_ok());
    let owner = f.open();
    let request = || RecomputeRequest::new("first", true).unwrap();
    let error = owner
        .working_drafts_with_policy(policy())
        .unwrap()
        .recompute(
            session(),
            id(1),
            request(),
            Arc::new(AtomicBool::new(false)),
            Duration::ZERO,
        )
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Working-draft observations are not configured"
    );
    let files = node("created-then-replayed")["files"].clone();
    let client = owner
        .working_drafts_with_observations(
            policy(),
            f.reads(&files, &Value::Null, None),
            PreparationLimits::default(),
        )
        .unwrap();
    let error = client
        .recompute(
            session(),
            id(1),
            request(),
            Arc::new(AtomicBool::new(true)),
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(Failure::Cancelled)));
    let error = client
        .recompute(
            Credential::Session(Secret::new("not-a-session".into())),
            id(1),
            request(),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "Authentication required");
    owner.shutdown().unwrap();
    assert_eq!(f.recorded_rows(), before);
}
