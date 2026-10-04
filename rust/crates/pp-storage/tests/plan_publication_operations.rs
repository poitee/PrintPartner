use pp_contracts::{
    autosave::PositiveId,
    publication::{ApplyRequest, Outcome},
};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    jobs,
    plan_publication::{
        PublicationClient, PublicationCommand, RequiredUnitTokenAllocator, TokenAllocationFailure,
    },
    read_model::Credential,
};
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
const FIRST: &[u8] = include_bytes!("fixtures/plan-publication/first.db");
const FIRST_REQUEST: &str = include_str!("fixtures/plan-publication/first.json");
const EXISTING: &[u8] = include_bytes!("fixtures/plan-publication/unchanged.db");
const EXISTING_REQUEST: &str = include_str!("fixtures/plan-publication/unchanged.json");
const WAIT: Duration = Duration::from_secs(5);
struct Fixture {
    path: PathBuf,
    request: ApplyRequest,
    draft: u64,
}
impl Fixture {
    fn new(existing: bool) -> Self {
        let path = std::env::temp_dir().join(format!(
            "pp-publication-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("print-partner.db"),
            if existing { EXISTING } else { FIRST },
        )
        .unwrap();
        let repos = path.join("repos/1/revisions/fixture");
        std::fs::create_dir_all(&repos).unwrap();
        std::fs::write(
            repos.join("bracket.stl"),
            b"solid bracket\nendsolid bracket\n",
        )
        .unwrap();
        Self {
            path,
            request: serde_json::from_str(if existing {
                EXISTING_REQUEST
            } else {
                FIRST_REQUEST
            })
            .unwrap(),
            draft: if existing { 2 } else { 1 },
        }
    }
    fn open(&self) -> WriterOwner {
        WriterOwner::open(&self.path, Limits::default()).unwrap().0
    }
    fn sql(&self) -> Connection {
        Connection::open(self.path.join("print-partner.db")).unwrap()
    }
    fn command(
        &self,
        key: &str,
        request: ApplyRequest,
        credential: Credential,
    ) -> PublicationCommand {
        PublicationCommand::new(
            PositiveId::new(1).unwrap(),
            PositiveId::new(self.draft).unwrap(),
            request,
            key.into(),
            credential,
        )
        .unwrap()
    }
    fn normalized_command(
        &self,
        key: &str,
        admitted: ApplyRequest,
        execution: ApplyRequest,
    ) -> PublicationCommand {
        PublicationCommand::normalized_http(
            PositiveId::new(1).unwrap(),
            PositiveId::new(self.draft).unwrap(),
            admitted,
            execution,
            key.into(),
            session(),
        )
        .unwrap()
    }
    fn call(&self, client: &PublicationClient, key: &str) -> anyhow::Result<Value> {
        Ok(serde_json::to_value(client.apply(
            self.command(key, self.request.clone(), session()),
            &AtomicBool::new(false),
            WAIT,
        )?)?)
    }
    fn graph(&self) -> Value {
        let db = self.sql();
        let tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut graph = serde_json::Map::new();
        for table in tables {
            let mut stmt = db
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let names: Vec<_> = stmt.column_names().iter().map(|n| n.to_string()).collect();
            let mut cursor = stmt.query([]).unwrap();
            let mut rows = Vec::new();
            while let Some(row) = cursor.next().unwrap() {
                let mut object = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    object.insert(
                        name.clone(),
                        match row.get_ref(i).unwrap() {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(v) => json!(v),
                            ValueRef::Real(v) => json!(v),
                            ValueRef::Text(v) => json!(std::str::from_utf8(v).unwrap()),
                            ValueRef::Blob(v) => json!(hex::encode(v)),
                        },
                    );
                }
                rows.push(Value::Object(object));
            }
            graph.insert(table, json!(rows));
        }
        Value::Object(graph)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn session() -> Credential {
    Credential::Session(Secret::new("publication-fixture-secret".into()))
}
fn policy() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
fn jobs_call(owner: &WriterOwner, op: jobs::UserOperation) -> jobs::JobRecord {
    let result = owner
        .jobs(policy())
        .unwrap()
        .submit(
            jobs::Credential::PhysicalOwner(owner.job_physical_owner()),
            op,
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap();
    let jobs::Outcome::Job(job, _) = result else {
        panic!("job")
    };
    job
}
fn enqueue(owner: &WriterOwner, key: &str, payload: jobs::Payload) -> jobs::JobRecord {
    jobs_call(
        owner,
        jobs::UserOperation::Enqueue {
            key: key.into(),
            payload_version: 1,
            payload,
        },
    )
}
fn upload(profile: Option<u64>, part: Option<u64>) -> jobs::Payload {
    jobs::Payload::PrinterUpload {
        printer_id: "fixture-printer".into(),
        artifact_path: "exports/fixture.gcode".into(),
        filename: "fixture.gcode".into(),
        start: false,
        profile_id: profile,
        host_name: None,
        checkoff_units: part
            .into_iter()
            .map(|part_id| jobs::CheckoffUnit {
                part_id,
                unit_index: 0,
                object_name: None,
            })
            .collect(),
        unlabeled_names: vec![],
    }
}
fn admission() -> jobs::WorkerAdmission {
    jobs::WorkerAdmission {
        kinds: jobs::JobKind::ALL.into_iter().map(|k| (k, 1)).collect(),
        total: 2,
        per_resource: 1,
        lease_seconds: 60,
    }
}
#[test]
fn production_random_tokens_receipt_replay_new_key_and_reopen() {
    let f = Fixture::new(false);
    let owner = f.open();
    let first = f.call(&owner.publication(), "random").unwrap();
    assert_eq!(first["kind"], "applied");
    let graph = f.graph();
    assert_eq!(graph["plan_apply_requests"].as_array().unwrap().len(), 1);
    assert_eq!(graph["plan_apply_admissions"].as_array().unwrap().len(), 1);
    assert_eq!(
        graph["plan_apply_requests"][0]["request_digest"],
        graph["plan_apply_admissions"][0]["request_digest"]
    );
    let token = graph["required_units"][0]["token"].as_str().unwrap();
    assert_eq!(token.len(), 36);
    assert!(token.starts_with("ppu_") && token[4..].bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(
        graph["required_units"][0]["created_at"],
        first["receipt"]["applied_at"]
    );
    let mut toggle = f.request.clone();
    toggle.remap_checkoff_links = !toggle.remap_checkoff_links;
    let replay = owner
        .publication()
        .apply(
            f.command("random", toggle, session()),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    assert!(matches!(replay, Outcome::Existing { .. }));
    assert_eq!(
        f.call(&owner.publication(), "new-key").unwrap()["kind"],
        "already_applied"
    );
    let mut changed = f.request.clone();
    changed.expected_snapshot_digest = pp_contracts::autosave::Digest::new("f".repeat(64)).unwrap();
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.command("random", changed, session()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::IdempotencyConflict
    ));
    assert_eq!(f.graph(), graph);
    owner.shutdown().unwrap();
    let owner = f.open();
    let reopened = f.call(&owner.publication(), "random").unwrap();
    assert_eq!(reopened["receipt"], first["receipt"]);
    owner.shutdown().unwrap();
}

#[test]
fn normalized_admission_replays_after_reopen_and_execution_identity_conflicts() {
    let f = Fixture::new(false);
    let execution = f.request.clone();
    let mut admitted = execution.clone();
    admitted.expected_snapshot_digest =
        pp_contracts::autosave::Digest::new("f".repeat(64)).unwrap();
    let owner = f.open();
    let first = owner
        .publication()
        .apply(
            f.normalized_command("normalized", admitted.clone(), execution.clone()),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    assert!(matches!(first, Outcome::Applied { .. }));
    let graph = f.graph();
    assert_ne!(
        graph["plan_apply_requests"][0]["request_digest"],
        graph["plan_apply_admissions"][0]["request_digest"]
    );
    assert_eq!(
        graph["plan_apply_admissions"][0]["expected_snapshot_digest"],
        "f".repeat(64)
    );
    let mut remap = admitted.clone();
    remap.remap_checkoff_links = !remap.remap_checkoff_links;
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.normalized_command("normalized", remap, execution.clone()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::Existing { .. }
    ));
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.command("normalized", execution.clone(), session()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::IdempotencyConflict
    ));
    for changed in [
        serde_json::from_value(json!({
            "expected_snapshot_digest":"e".repeat(64),
            "expected_lifecycle_version":admitted.expected_lifecycle_version,
            "expected_base":admitted.expected_base,
        }))
        .unwrap(),
        serde_json::from_value(json!({
            "expected_snapshot_digest":admitted.expected_snapshot_digest,
            "expected_lifecycle_version":1,
            "expected_base":admitted.expected_base,
        }))
        .unwrap(),
        serde_json::from_value(json!({
            "expected_snapshot_digest":admitted.expected_snapshot_digest,
            "expected_lifecycle_version":admitted.expected_lifecycle_version,
            "expected_base":{"revision_id":1,"plan_version":1},
        }))
        .unwrap(),
    ] {
        assert!(matches!(
            owner
                .publication()
                .apply(
                    f.normalized_command("normalized", changed, execution.clone()),
                    &AtomicBool::new(false),
                    WAIT
                )
                .unwrap(),
            Outcome::IdempotencyConflict
        ));
        assert_eq!(f.graph(), graph);
    }
    owner.shutdown().unwrap();
    let owner = f.open();
    let reopened = owner
        .publication()
        .apply(
            f.normalized_command("normalized", admitted, execution),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(reopened).unwrap()["receipt"],
        serde_json::to_value(first).unwrap()["receipt"]
    );
    owner.shutdown().unwrap();
}

#[test]
fn admission_constraints_cascade_and_child_insert_failure_preserve_graph() {
    let f = Fixture::new(false);
    let owner = f.open();
    owner.shutdown().unwrap();
    f.sql().execute_batch("CREATE TRIGGER publication_admission_failure BEFORE INSERT ON plan_apply_admissions BEGIN SELECT RAISE(ABORT,'admission constraint'); END").unwrap();
    let owner = f.open();
    let before = f.graph();
    assert!(f.call(&owner.publication(), "child-failure").is_err());
    assert_eq!(f.graph(), before);
    owner.shutdown().unwrap();
    f.sql()
        .execute_batch("DROP TRIGGER publication_admission_failure")
        .unwrap();
    let owner = f.open();
    assert_eq!(
        f.call(&owner.publication(), "child-failure").unwrap()["kind"],
        "applied"
    );
    owner.shutdown().unwrap();

    let connection = f.sql();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    assert!(
        connection
            .execute(
                "INSERT INTO plan_apply_admissions SELECT * FROM plan_apply_admissions",
                []
            )
            .is_err()
    );
    assert!(connection.execute("INSERT INTO plan_apply_admissions VALUES(999,'plan-apply-request-v1','a','b',0,NULL,0)", []).is_err());
    assert!(
        connection
            .execute("UPDATE plan_apply_admissions SET request_digest='c'", [])
            .is_err()
    );
    assert!(
        connection
            .execute("DELETE FROM plan_apply_admissions", [])
            .is_err()
    );
    connection
        .execute("DELETE FROM build_profiles WHERE id=1", [])
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM plan_apply_admissions", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}

#[test]
fn legacy_schema36_rows_keep_execution_fallback_without_backfill() {
    let f = Fixture::new(false);
    let execution = f.request.clone();
    let mut admitted = execution.clone();
    admitted.expected_snapshot_digest =
        pp_contracts::autosave::Digest::new("f".repeat(64)).unwrap();
    let owner = f.open();
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.normalized_command("legacy", admitted.clone(), execution.clone()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::Applied { .. }
    ));
    owner.shutdown().unwrap();
    let connection = f.sql();
    connection.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    drop(connection);
    let owner = f.open();
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.command("legacy", execution.clone(), session()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::Existing { .. }
    ));
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.normalized_command("legacy", admitted, execution),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::IdempotencyConflict
    ));
    assert!(
        f.graph()["plan_apply_admissions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    owner.shutdown().unwrap();
}

#[test]
fn schema37_and_legacy36_backups_restore_identity_semantics() {
    let f = Fixture::new(false);
    let execution = f.request.clone();
    let mut admitted = execution.clone();
    admitted.expected_snapshot_digest =
        pp_contracts::autosave::Digest::new("f".repeat(64)).unwrap();
    let owner = f.open();
    let first = owner
        .publication()
        .apply(
            f.normalized_command("backup", admitted.clone(), execution.clone()),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let backup37 = std::env::temp_dir().join(format!(
        "pp-publication-backup37-{}.db",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    owner.backup(&backup37).unwrap();
    owner.shutdown().unwrap();

    let restore37 = std::env::temp_dir().join(format!(
        "pp-publication-restore37-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&restore37).unwrap();
    std::fs::copy(&backup37, restore37.join("print-partner.db")).unwrap();
    let restored37 = Fixture {
        path: restore37,
        request: execution.clone(),
        draft: f.draft,
    };
    let owner = restored37.open();
    let replay = owner
        .publication()
        .apply(
            restored37.normalized_command("backup", admitted.clone(), execution.clone()),
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(replay).unwrap()["receipt"],
        serde_json::to_value(first).unwrap()["receipt"]
    );
    owner.shutdown().unwrap();

    let connection = f.sql();
    connection.execute_batch("DROP TRIGGER trg_plan_apply_admissions_immutable_delete; DROP TRIGGER trg_plan_apply_admissions_immutable_update; DROP TABLE plan_apply_admissions; UPDATE app_settings SET value='36' WHERE tenant_id='default' AND key='schema_version'; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    drop(connection);
    let (owner, ready) = WriterOwner::open(&f.path, Limits::default()).unwrap();
    let backup36 = ready.backup.unwrap();
    owner.shutdown().unwrap();
    let restore36 = std::env::temp_dir().join(format!(
        "pp-publication-restore36-{}",
        hex::encode(rand::random::<[u8; 8]>())
    ));
    std::fs::create_dir_all(&restore36).unwrap();
    std::fs::copy(backup36, restore36.join("print-partner.db")).unwrap();
    let restored36 = Fixture {
        path: restore36,
        request: execution.clone(),
        draft: f.draft,
    };
    let owner = restored36.open();
    assert!(matches!(
        owner
            .publication()
            .apply(
                restored36.command("backup", execution.clone(), session()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::Existing { .. }
    ));
    assert!(matches!(
        owner
            .publication()
            .apply(
                restored36.normalized_command("backup", admitted, execution),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::IdempotencyConflict
    ));
    assert!(
        restored36.graph()["plan_apply_admissions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    owner.shutdown().unwrap();
}

#[test]
fn stored_admission_and_execution_tampering_fail_public_replay_validation() {
    for update in [
        "request_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
        "request_format='broken'",
        "expected_snapshot_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
        "expected_lifecycle_version=1",
        "expected_base_revision_id=1",
        "expected_base_plan_version=1",
    ] {
        let f = Fixture::new(false);
        let owner = f.open();
        assert_eq!(
            f.call(&owner.publication(), "tamper-child").unwrap()["kind"],
            "applied"
        );
        let connection = f.sql();
        connection
            .execute_batch(
                "PRAGMA ignore_check_constraints=ON; DROP TRIGGER trg_plan_apply_admissions_immutable_update;",
            )
            .unwrap();
        connection
            .execute(&format!("UPDATE plan_apply_admissions SET {update}"), [])
            .unwrap();
        drop(connection);
        assert!(f.call(&owner.publication(), "tamper-child").is_err());
        owner.shutdown().unwrap();
    }

    let f = Fixture::new(false);
    let owner = f.open();
    assert_eq!(
        f.call(&owner.publication(), "tamper-parent").unwrap()["kind"],
        "applied"
    );
    let connection = f.sql();
    connection
        .execute_batch("DROP TRIGGER trg_plan_apply_requests_immutable_update; UPDATE plan_apply_requests SET request_digest='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';")
        .unwrap();
    drop(connection);
    assert!(f.call(&owner.publication(), "tamper-parent").is_err());
    owner.shutdown().unwrap();
}

#[test]
fn concurrent_same_key_commands_choose_one_admission_identity() {
    let f = Fixture::new(false);
    let owner = f.open();
    let client = owner.publication();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let client = client.clone();
                let barrier = barrier.clone();
                let command = f.command("concurrent", f.request.clone(), session());
                scope.spawn(move || {
                    barrier.wait();
                    client
                        .apply(command, &AtomicBool::new(false), WAIT)
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results
            .iter()
            .filter(|outcome| matches!(outcome, Outcome::Applied { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|outcome| matches!(outcome, Outcome::Existing { .. }))
            .count(),
        1
    );
    let mut changed = f.request.clone();
    changed.expected_snapshot_digest = pp_contracts::autosave::Digest::new("f".repeat(64)).unwrap();
    assert!(matches!(
        client
            .apply(
                f.command("concurrent", changed, session()),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::IdempotencyConflict
    ));
    assert_eq!(
        f.graph()["plan_apply_requests"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        f.graph()["plan_apply_admissions"].as_array().unwrap().len(),
        1
    );
    owner.shutdown().unwrap();
}
#[test]
fn affected_printer_states_refuse_without_mutation() {
    for state in [
        "queued",
        "running",
        "effect_admitted",
        "reconciliation_required",
    ] {
        let f = Fixture::new(true);
        let owner = f.open();
        let job = enqueue(&owner, "printer", upload(Some(1), Some(1)));
        let worker = owner.job_worker(admission()).unwrap();
        if state != "queued" {
            let (_, mut lease) = worker.claim().unwrap().unwrap();
            if state != "running" {
                worker
                    .update(
                        &mut lease,
                        jobs::WorkerOperation::BeginEffect(jobs::EffectIntent {
                            operation: jobs::EffectOperation::PrinterUpload,
                            basis_hash: "a".repeat(64),
                            content_hash: "b".repeat(64),
                            target: "fixture-printer".into(),
                        }),
                    )
                    .unwrap();
                if state == "reconciliation_required" {
                    jobs_call(
                        &owner,
                        jobs::UserOperation::Cancel {
                            job_id: job.job_id.clone(),
                        },
                    );
                }
            }
        }
        let before = f.graph();
        let result = f.call(&owner.publication(), "blocked").unwrap();
        assert_eq!(
            result,
            json!({"kind":"execution_conflict","operations":[{"operation_id":job.job_id,"kind":"printer-upload","state":state}]})
        );
        assert_eq!(f.graph(), before);
        owner.shutdown().unwrap();
    }
}
#[test]
fn coordinate_only_printer_refuses_and_terminal_job_allows() {
    let f = Fixture::new(true);
    let owner = f.open();
    let job = enqueue(&owner, "coordinate", upload(None, Some(1)));
    assert_eq!(
        f.call(&owner.publication(), "same").unwrap()["kind"],
        "execution_conflict"
    );
    jobs_call(&owner, jobs::UserOperation::Cancel { job_id: job.job_id });
    assert_eq!(
        f.call(&owner.publication(), "same").unwrap()["kind"],
        "applied"
    );
    owner.shutdown().unwrap();
}
#[test]
fn unresolved_printer_coordinate_blocks_until_terminal() {
    for profile in [None, Some(2)] {
        let f = Fixture::new(true);
        let owner = f.open();
        let job = enqueue(&owner, "stale-coordinate", upload(profile, Some(999)));
        let before = f.graph();
        assert_eq!(
            f.call(&owner.publication(), "publish").unwrap(),
            json!({"kind":"execution_conflict","operations":[{"operation_id":job.job_id,"kind":"printer-upload","state":"queued"}]})
        );
        assert_eq!(before, f.graph());
        jobs_call(&owner, jobs::UserOperation::Cancel { job_id: job.job_id });
        assert_eq!(
            f.call(&owner.publication(), "publish").unwrap()["kind"],
            "applied"
        );
        owner.shutdown().unwrap();
    }
}
#[test]
fn unrelated_build_and_empty_upload_allow() {
    for payload in [upload(Some(2), None), upload(None, None)] {
        let f = Fixture::new(true);
        let owner = f.open();
        let job = enqueue(&owner, "unrelated", payload);
        let before = f.graph();
        assert_eq!(
            f.call(&owner.publication(), "publish").unwrap()["kind"],
            "applied"
        );
        let after = f.graph();
        for table in ["durable_jobs", "durable_job_keys", "durable_job_history"] {
            assert_eq!(before[table], after[table]);
        }
        assert_eq!(after["durable_jobs"][0]["id"], job.job_id);
        owner.shutdown().unwrap();
    }
}
#[test]
fn every_uncaptured_export_refuses_queued_and_running() {
    for payload in [
        jobs::Payload::ExportStlPack {
            profile_id: 1,
            missing_only: false,
            group_by: jobs::GroupBy::Color,
            unit_tokens: vec![],
            filename_grouping: None,
        },
        jobs::Payload::ExportChecklistHtml { profile_id: 1 },
        jobs::Payload::ExportKitBundle {
            profile_id: 1,
            include_print_progress: true,
        },
        jobs::Payload::ExportAcceptedPlate3mf {
            profile_id: 1,
            expected_plate_revision_id: 1,
        },
        jobs::Payload::ExportDirect3mf {
            profile_id: 1,
            tokens: vec!["ppu_00000000000000000000000000000001".into()],
        },
    ] {
        for running in [false, true] {
            let f = Fixture::new(true);
            let owner = f.open();
            let job = enqueue(&owner, "export", payload.clone());
            let worker = owner.job_worker(admission()).unwrap();
            if running {
                worker.claim().unwrap().unwrap();
            }
            let before = f.graph();
            let result = f.call(&owner.publication(), "publish").unwrap();
            assert_eq!(result["kind"], "execution_conflict");
            assert_eq!(result["operations"][0]["operation_id"], job.job_id);
            assert_eq!(before, f.graph());
            owner.shutdown().unwrap();
        }
    }
}
#[test]
fn pinned_publication_preserves_real_source_lease() {
    let f = Fixture::new(true);
    let owner = f.open();
    enqueue(
        &owner,
        "source",
        jobs::Payload::ImportScan { project_id: 1 },
    );
    let worker = owner.job_worker(admission()).unwrap();
    let (_, lease) = worker.claim().unwrap().unwrap();
    let mut source_lease = worker
        .begin_source_work(&lease, None, &AtomicBool::new(false), WAIT)
        .unwrap();
    let before = f.graph();
    assert_eq!(
        f.call(&owner.publication(), "publish").unwrap()["kind"],
        "applied"
    );
    let after = f.graph();
    for table in [
        "projects",
        "source_revisions",
        "durable_jobs",
        "durable_job_keys",
        "durable_job_history",
    ] {
        assert_eq!(before[table], after[table]);
    }
    source_lease.release().unwrap();
    owner.shutdown().unwrap();
}
#[test]
fn late_receipt_constraint_rolls_back_and_closed_retry_succeeds() {
    let f = Fixture::new(false);
    f.sql().execute_batch("CREATE TRIGGER publication_late_failure BEFORE INSERT ON plan_apply_requests BEGIN SELECT RAISE(ABORT,'publication receipt constraint'); END").unwrap();
    let owner = f.open();
    let before = f.graph();
    assert!(f.call(&owner.publication(), "retry").is_err());
    assert_eq!(f.graph(), before);
    owner.shutdown().unwrap();
    f.sql()
        .execute_batch("DROP TRIGGER publication_late_failure")
        .unwrap();
    let owner = f.open();
    assert_eq!(
        f.call(&owner.publication(), "retry").unwrap()["kind"],
        "applied"
    );
    owner.shutdown().unwrap();
}
#[test]
fn cancelled_admission_does_not_allocate_or_write() {
    let f = Fixture::new(false);
    let owner = f.open();
    let before = f.graph();
    let error = owner
        .publication()
        .apply(
            f.command("cancelled", f.request.clone(), session()),
            &AtomicBool::new(true),
            Duration::ZERO,
        )
        .unwrap_err();
    assert!(
        error
            .downcast_ref::<pp_storage::required_units::AdmissionFailure>()
            .is_some()
    );
    assert_eq!(before, f.graph());
    owner.shutdown().unwrap();
}
struct NoEntropy;
impl RequiredUnitTokenAllocator for NoEntropy {
    fn allocate(&mut self) -> Result<[u8; 16], TokenAllocationFailure> {
        Err(TokenAllocationFailure)
    }
}
#[test]
fn allocation_failure_preserves_complete_graph() {
    let f = Fixture::new(false);
    let (owner, _) =
        WriterOwner::open_with_token_allocator(&f.path, Limits::default(), Box::new(NoEntropy))
            .unwrap();
    let before = f.graph();
    assert_eq!(
        f.call(&owner.publication(), "none").unwrap()["kind"],
        "token_allocation_failed"
    );
    assert_eq!(before, f.graph());
    owner.shutdown().unwrap();
}
#[test]
fn routed_key_audit_rolls_back_then_uses_tenant_actor() {
    let f = Fixture::new(false);
    f.sql().execute_batch("CREATE TRIGGER publication_late_failure BEFORE INSERT ON plan_apply_requests BEGIN SELECT RAISE(ABORT,'publication receipt constraint'); END").unwrap();
    let owner = f.open();
    let auth = owner.auth_with_policy(policy()).unwrap();
    let result = auth
        .submit(
            auth::Request::CreateKey {
                session: Secret::new("publication-fixture-secret".into()),
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let auth::Outcome::KeyCreated { key, info } = result else {
        panic!("key")
    };
    let raw = key.expose().to_owned();
    let credential = |tenant: &str| Credential::ApiKey {
        routed_tenant: tenant.into(),
        secret: Secret::new(raw.clone()),
    };
    let before = f.graph();
    for tenant in ["foreign", "default"] {
        assert!(
            owner
                .publication()
                .apply(
                    f.command("key", f.request.clone(), credential(tenant)),
                    &AtomicBool::new(false),
                    WAIT
                )
                .is_err()
        );
        assert_eq!(before, f.graph());
    }
    owner.shutdown().unwrap();
    f.sql()
        .execute_batch("DROP TRIGGER publication_late_failure")
        .unwrap();
    let owner = f.open();
    assert!(matches!(
        owner
            .publication()
            .apply(
                f.command("key", f.request.clone(), credential("default")),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap(),
        Outcome::Applied { .. }
    ));
    assert_eq!(
        f.graph()["plan_apply_requests"][0]["actor_id"],
        "tenant:default"
    );
    owner
        .auth_with_policy(policy())
        .unwrap()
        .submit(
            auth::Request::RevokeKey {
                session: Secret::new("publication-fixture-secret".into()),
                key_id: info.id,
            },
            Arc::new(AtomicBool::new(false)),
            WAIT,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
    let revoked = f.graph();
    assert!(
        owner
            .publication()
            .apply(
                f.command("key", f.request.clone(), credential("default")),
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
    assert_eq!(revoked, f.graph());
    owner.shutdown().unwrap();
}
#[test]
fn historical_receipt_survives_new_publication_and_pointer_invalidation() {
    let f = Fixture::new(true);
    let old = f.graph()["plan_apply_requests"][0].clone();
    let request:ApplyRequest=serde_json::from_value(json!({"expected_snapshot_digest":old["expected_snapshot_digest"],"expected_lifecycle_version":old["expected_lifecycle_version"],"expected_base":{"revision_id":old["expected_base_revision_id"],"plan_version":old["expected_base_plan_version"]}})).unwrap();
    let make = || {
        PublicationCommand::new(
            PositiveId::new(1).unwrap(),
            PositiveId::new(1).unwrap(),
            request.clone(),
            "baseline".into(),
            session(),
        )
        .unwrap()
    };
    let owner = f.open();
    assert_eq!(
        f.call(&owner.publication(), "new-publication").unwrap()["kind"],
        "applied"
    );
    let first = serde_json::to_value(
        owner
            .publication()
            .apply(make(), &AtomicBool::new(false), WAIT)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["kind"], "existing");
    assert_eq!(first["receipt"]["revision_id"], 1);
    owner.shutdown().unwrap();
    f.sql()
        .execute(
            "UPDATE build_profiles SET accepted_plan_revision_id=NULL WHERE id=1",
            [],
        )
        .unwrap();
    let owner = f.open();
    let before = f.graph();
    let replay = serde_json::to_value(
        owner
            .publication()
            .apply(make(), &AtomicBool::new(false), WAIT)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(replay, first);
    assert_eq!(before, f.graph());
    owner.shutdown().unwrap();
}
#[test]
fn issued_policy_uses_actual_session_actor_and_distinct_tenant() {
    let f = Fixture::new(false);
    f.sql().execute_batch("BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE users SET id='publication-user-uuid' WHERE id='default'; UPDATE sessions SET user_id='publication-user-uuid' WHERE user_id='default'; COMMIT;").unwrap();
    let owner = f.open();
    let neutral = owner.publication();
    let strict = owner
        .publication_with_policy(auth::AuthPolicy {
            session_tenant: auth::SessionTenantPolicy::SingleAccountDefault,
            ..policy()
        })
        .unwrap();
    let before = f.graph();
    assert_eq!(f.call(&neutral, "neutral").unwrap()["kind"], "not_found");
    assert_eq!(before, f.graph());
    assert_eq!(f.call(&strict, "strict").unwrap()["kind"], "applied");
    assert_eq!(
        f.graph()["plan_apply_requests"][0]["actor_id"],
        "publication-user-uuid"
    );
    owner.shutdown().unwrap();
}
#[test]
fn foreign_tenant_job_remains_unchanged() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new(true);
    let db = f.sql();
    db.execute("INSERT INTO users(id,email,display_name,password_hash,is_admin,created_at) VALUES('foreign','foreign-job@example.test','Foreign',NULL,0,'2026-01-01T00:00:00.000Z')",[]).unwrap();
    db.execute("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,'foreign','2099-01-01T00:00:00.000Z')",[hex::encode(Sha256::digest("foreign-fixture"))]).unwrap();
    drop(db);
    let owner = f.open();
    let result = owner
        .jobs(policy())
        .unwrap()
        .submit(
            jobs::Credential::Session(Secret::new("foreign-fixture".into())),
            jobs::UserOperation::Enqueue {
                key: "foreign-export".into(),
                payload_version: 1,
                payload: jobs::Payload::ExportChecklistHtml { profile_id: 2 },
            },
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap()
        .receive()
        .unwrap();
    assert!(matches!(result, jobs::Outcome::Job(..)));
    let before = f.graph();
    assert_eq!(
        f.call(&owner.publication(), "publish").unwrap()["kind"],
        "applied"
    );
    let after = f.graph();
    for table in ["durable_jobs", "durable_job_keys", "durable_job_history"] {
        assert_eq!(before[table], after[table]);
    }
    owner.shutdown().unwrap();
}
