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
    match part {
        Some(part) => upload_parts(profile, &[part]),
        None => upload_parts(profile, &[]),
    }
}
fn upload_parts(profile: Option<u64>, parts: &[u64]) -> jobs::Payload {
    jobs::Payload::PrinterUpload {
        printer_id: "fixture-printer".into(),
        artifact_path: "exports/fixture.gcode".into(),
        filename: "fixture.gcode".into(),
        start: false,
        profile_id: profile,
        host_name: None,
        checkoff_units: parts
            .iter()
            .map(|part_id| jobs::CheckoffUnit {
                part_id: *part_id,
                unit_index: 0,
                object_name: None,
            })
            .collect(),
        unlabeled_names: vec![],
    }
}
fn uploaded_only_parent(
    owner: &WriterOwner,
    key: &str,
    profile: Option<u64>,
    parts: &[u64],
) -> jobs::JobRecord {
    let mut payload = upload_parts(profile, parts);
    let jobs::Payload::PrinterUpload { start, .. } = &mut payload else {
        unreachable!()
    };
    *start = true;
    let parent = enqueue(owner, key, payload);
    let worker = owner.job_worker(admission()).unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    assert_eq!(claim.job.job_id, parent.job_id);
    assert!(claim.source_work.is_none());
    let intent = jobs::EffectIntent {
        operation: jobs::EffectOperation::PrinterUpload,
        basis_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        target: "fixture-printer".into(),
    };
    worker
        .update(
            &mut claim.lease,
            jobs::WorkerOperation::BeginEffect(intent.clone()),
        )
        .unwrap();
    let uncertain = worker
        .update(&mut claim.lease, jobs::WorkerOperation::Fail)
        .unwrap();
    jobs_call(
        owner,
        jobs::UserOperation::Reconcile {
            job_id: uncertain.job_id,
            expected_version: uncertain.state_version,
            expected_generation: uncertain.generation,
            effect_hash: intent.content_hash.clone(),
            decision: jobs::Decision::ConfirmSucceeded,
            receipt: Some(jobs::ResultArtifact {
                receipt_id: format!("{key}-receipt"),
                content_hash: intent.content_hash,
                target: intent.target,
            }),
        },
    )
}
fn bound_start(owner: &WriterOwner, key: &str, parent: &jobs::JobRecord) -> jobs::JobRecord {
    enqueue(
        owner,
        key,
        jobs::Payload::PrinterStart(jobs::PrinterStartRequest::new(&parent.job_id)),
    )
}
fn advance_bound_start(owner: &WriterOwner, child: &jobs::JobRecord, state: &str) {
    if state == "queued" {
        return;
    }
    let worker = owner.job_worker(admission()).unwrap();
    let mut claim = worker.claim().unwrap().unwrap();
    assert_eq!(claim.job.job_id, child.job_id);
    assert!(claim.source_work.is_none());
    if state == "running" {
        return;
    }
    let jobs::Payload::PrinterStart(request) = &claim.job.payload else {
        panic!("printer start")
    };
    let mut intent = request.upload_effect().unwrap().intent.clone();
    intent.operation = jobs::EffectOperation::PrinterStart;
    worker
        .update(&mut claim.lease, jobs::WorkerOperation::BeginEffect(intent))
        .unwrap();
    if state == "reconciliation_required" {
        jobs_call(
            owner,
            jobs::UserOperation::Cancel {
                job_id: child.job_id.clone(),
            },
        );
    }
}
fn archive_parent(fixture: &Fixture, owner: WriterOwner, parent: &jobs::JobRecord) -> WriterOwner {
    owner.shutdown().unwrap();
    let connection = fixture.sql();
    connection
        .execute(
            "UPDATE durable_jobs SET updated=updated-172800,document=json_set(document,'$.updated_at',updated-172800) WHERE id=?1",
            [&parent.job_id],
        )
        .unwrap();
    drop(connection);
    let owner = fixture.open();
    assert_eq!(owner.retain_jobs(1, 1).unwrap(), 1);
    let connection = fixture.sql();
    let retained: (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM durable_jobs WHERE id=?1),(SELECT COUNT(*) FROM durable_job_keys WHERE job_id=?1 AND archived_document IS NOT NULL)",
            [&parent.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(retained, (0, 1));
    drop(connection);
    owner.shutdown().unwrap();
    fixture.open()
}
fn assert_job_tables_unchanged(before: &Value, after: &Value) {
    for table in ["durable_jobs", "durable_job_keys", "durable_job_history"] {
        assert_eq!(before[table], after[table], "{table}");
    }
}
fn state_name(state: jobs::PersistentState) -> &'static str {
    match state {
        jobs::PersistentState::Queued => "queued",
        jobs::PersistentState::Running => "running",
        jobs::PersistentState::EffectAdmitted => "effect_admitted",
        jobs::PersistentState::ReconciliationRequired => "reconciliation_required",
        jobs::PersistentState::Succeeded => "succeeded",
        jobs::PersistentState::UploadedOnly => "uploaded_only",
        jobs::PersistentState::Failed => "failed",
        jobs::PersistentState::Cancelled => "cancelled",
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
fn bound_start_matching_profile_refuses_without_mutation() {
    let f = Fixture::new(true);
    let owner = f.open();
    let parent = uploaded_only_parent(&owner, "start-parent", Some(1), &[1]);
    let child = bound_start(&owner, "start-child", &parent);
    let before = f.graph();
    assert_eq!(
        f.call(&owner.publication(), "blocked").unwrap(),
        json!({"kind":"execution_conflict","operations":[{"operation_id":child.job_id,"kind":"printer-upload","state":"queued"}]})
    );
    assert_eq!(f.graph(), before);
    owner.shutdown().unwrap();
}
#[test]
fn bound_start_states_conflict_through_live_and_archived_parent_after_restart() {
    for archived in [false, true] {
        for state in [
            "queued",
            "running",
            "effect_admitted",
            "reconciliation_required",
        ] {
            let fixture = Fixture::new(true);
            let mut owner = fixture.open();
            let parent = uploaded_only_parent(
                &owner,
                &format!("state-parent-{archived}-{state}"),
                Some(1),
                &[1],
            );
            let child = bound_start(&owner, &format!("state-child-{archived}-{state}"), &parent);
            if archived {
                owner = archive_parent(&fixture, owner, &parent);
            }
            advance_bound_start(&owner, &child, state);
            for attempt in 0..if archived { 2 } else { 1 } {
                let current = jobs_call(
                    &owner,
                    jobs::UserOperation::Get {
                        job_id: child.job_id.clone(),
                    },
                );
                if attempt == 0 {
                    assert_eq!(state_name(current.state), state);
                }
                let expected_state = state_name(current.state);
                let before = fixture.graph();
                assert_eq!(
                    fixture
                        .call(
                            &owner.publication(),
                            &format!("state-publication-{archived}-{state}-{attempt}"),
                        )
                        .unwrap(),
                    json!({"kind":"execution_conflict","operations":[{"operation_id":child.job_id,"kind":"printer-upload","state":expected_state}]})
                );
                assert_eq!(fixture.graph(), before);
                if attempt == 0 {
                    owner.shutdown().unwrap();
                    owner = fixture.open();
                }
            }
            owner.shutdown().unwrap();
        }
    }
}
#[test]
fn bound_start_coordinate_matrix_matches_direct_upload_policy() {
    for (index, (profile, parts, conflicts)) in [
        (Some(1), vec![], true),
        (None, vec![1], true),
        (Some(2), vec![], false),
        (None, vec![], false),
        (None, vec![999], true),
        (Some(2), vec![999], true),
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = Fixture::new(true);
        let owner = fixture.open();
        let parent =
            uploaded_only_parent(&owner, &format!("matrix-parent-{index}"), profile, &parts);
        let child = bound_start(&owner, &format!("matrix-child-{index}"), &parent);
        let before = fixture.graph();
        let result = fixture
            .call(&owner.publication(), &format!("matrix-{index}"))
            .unwrap();
        if conflicts {
            assert_eq!(
                result,
                json!({"kind":"execution_conflict","operations":[{"operation_id":child.job_id,"kind":"printer-upload","state":"queued"}]})
            );
            assert_eq!(fixture.graph(), before);
        } else {
            assert_eq!(result["kind"], "applied");
            assert_job_tables_unchanged(&before, &fixture.graph());
        }
        owner.shutdown().unwrap();
    }
}
#[test]
fn bound_start_coordinate_contradictions_fail_without_mutation() {
    for multiple_owners in [false, true] {
        let fixture = Fixture::new(true);
        if multiple_owners {
            let connection = fixture.sql();
            connection
                .execute(
                    "INSERT INTO build_profiles(id,tenant_id,name,accepted_plan_version) VALUES(3,'default','Other',0)",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO parts(id,tenant_id,profile_id,match_key,relative_path,filename,source_layer,status,role,quantity_auto,quantity_effective,included,notes) VALUES(3,'default',3,'other-part','other.stl','other.stl','fixture','base','primary',1,1,1,'')",
                    [],
                )
                .unwrap();
        }
        let owner = fixture.open();
        let parent = uploaded_only_parent(
            &owner,
            &format!("contradiction-parent-{multiple_owners}"),
            (!multiple_owners).then_some(2),
            if multiple_owners { &[1, 3] } else { &[1] },
        );
        bound_start(
            &owner,
            &format!("contradiction-child-{multiple_owners}"),
            &parent,
        );
        let before = fixture.graph();
        assert!(
            fixture
                .call(
                    &owner.publication(),
                    &format!("contradiction-{multiple_owners}"),
                )
                .is_err()
        );
        assert_eq!(fixture.graph(), before);
        owner.shutdown().unwrap();
    }
}
#[test]
fn terminal_uploaded_parent_and_cancelled_bound_child_allow_publication() {
    for cancelled_child in [false, true] {
        let fixture = Fixture::new(true);
        let owner = fixture.open();
        let parent = uploaded_only_parent(
            &owner,
            &format!("terminal-parent-{cancelled_child}"),
            Some(1),
            &[1],
        );
        if cancelled_child {
            let child = bound_start(&owner, "terminal-child", &parent);
            let cancelled = jobs_call(
                &owner,
                jobs::UserOperation::Cancel {
                    job_id: child.job_id,
                },
            );
            assert_eq!(cancelled.state, jobs::PersistentState::Cancelled);
        }
        let before = fixture.graph();
        assert_eq!(
            fixture
                .call(&owner.publication(), &format!("terminal-{cancelled_child}"),)
                .unwrap()["kind"],
            "applied"
        );
        assert_job_tables_unchanged(&before, &fixture.graph());
        owner.shutdown().unwrap();
    }
}
#[test]
fn bound_start_parent_and_binding_tampering_fail_without_mutation() {
    for case in [
        "live-parent-id",
        "live-parent-tenant",
        "missing-parent",
        "binding-receipt",
        "archived-parent-id",
        "archived-parent-tenant",
        "archived-parent-kind",
        "archived-parent-state",
    ] {
        let fixture = Fixture::new(true);
        let mut owner = fixture.open();
        let parent = uploaded_only_parent(&owner, &format!("tamper-parent-{case}"), Some(1), &[1]);
        let child = bound_start(&owner, &format!("tamper-child-{case}"), &parent);
        if case.starts_with("archived-") {
            owner = archive_parent(&fixture, owner, &parent);
        }
        let connection = fixture.sql();
        match case {
            "live-parent-id" => {
                connection
                    .execute(
                        "UPDATE durable_jobs SET document=json_set(document,'$.job_id','other-parent') WHERE id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
            }
            "live-parent-tenant" => {
                connection
                    .execute(
                        "UPDATE durable_jobs SET document=json_set(document,'$.tenant','other-tenant') WHERE id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
            }
            "missing-parent" => {
                connection
                    .execute(
                        "DELETE FROM durable_job_history WHERE job_id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
                connection
                    .execute(
                        "DELETE FROM durable_job_keys WHERE job_id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
                connection
                    .execute("DELETE FROM durable_jobs WHERE id=?1", [&parent.job_id])
                    .unwrap();
            }
            "binding-receipt" => {
                connection
                    .execute(
                        "UPDATE durable_jobs SET document=json_set(document,'$.payload.payload.binding.upload_effect.receipt.receipt_id','other-receipt') WHERE id=?1",
                        [&child.job_id],
                    )
                    .unwrap();
            }
            "archived-parent-id" => {
                connection
                    .execute(
                        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.job_id','other-parent') WHERE job_id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
            }
            "archived-parent-tenant" => {
                connection
                    .execute(
                        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.tenant','other-tenant') WHERE job_id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
            }
            "archived-parent-kind" => {
                connection
                    .execute(
                        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.kind','sync') WHERE job_id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
            }
            "archived-parent-state" => {
                connection
                    .execute(
                        "UPDATE durable_job_keys SET archived_document=json_set(archived_document,'$.state','failed') WHERE job_id=?1",
                        [&parent.job_id],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);
        let before = fixture.graph();
        assert!(
            fixture
                .call(&owner.publication(), &format!("tamper-{case}"))
                .is_err(),
            "{case}"
        );
        assert_eq!(fixture.graph(), before, "{case}");
        owner.shutdown().unwrap();
    }
}
#[test]
fn production_random_tokens_receipt_replay_new_key_and_reopen() {
    let f = Fixture::new(false);
    let owner = f.open();
    let first = f.call(&owner.publication(), "random").unwrap();
    assert_eq!(first["kind"], "applied");
    let graph = f.graph();
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
            let mut claim = worker.claim().unwrap().unwrap();
            assert!(claim.source_work.is_none());
            if state != "running" {
                worker
                    .update(
                        &mut claim.lease,
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
            let claim = running.then(|| worker.claim().unwrap().unwrap());
            assert!(
                claim
                    .as_ref()
                    .is_none_or(|claim| claim.source_work.is_none())
            );
            let before = f.graph();
            let result = f.call(&owner.publication(), "publish").unwrap();
            assert_eq!(result["kind"], "execution_conflict");
            assert_eq!(result["operations"][0]["operation_id"], job.job_id);
            assert_eq!(before, f.graph());
            drop(claim);
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
    let mut claim = worker.claim().unwrap().unwrap();
    let mut source_lease = claim.source_work.take().expect("claimed Source work");
    assert!(
        worker
            .begin_source_work(&claim.lease, None, &AtomicBool::new(false), WAIT)
            .is_err()
    );
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
    assert!(
        worker
            .begin_source_work(&claim.lease, None, &AtomicBool::new(false), WAIT)
            .is_err()
    );
    source_lease.release().unwrap();
    let mut reacquired = worker
        .begin_source_work(&claim.lease, None, &AtomicBool::new(false), WAIT)
        .unwrap();
    reacquired.release().unwrap();
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
