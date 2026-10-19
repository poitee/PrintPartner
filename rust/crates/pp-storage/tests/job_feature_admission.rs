#![cfg(feature = "desktop_rebuild")]

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/claimed_attempt.rs"
));
use anyhow::Result;
use pp_domain::{PositiveId, features::Feature};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    features::Scope,
    jobs::*,
    read_model::Credential as FeatureCredential,
};
use rusqlite::{Connection, params, types::Value};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

const WAIT: Duration = Duration::from_secs(5);
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}
fn admission() -> WorkerAdmission {
    WorkerAdmission {
        kinds: JobKind::ALL.into_iter().map(|kind| (kind, 16)).collect(),
        total: 16,
        per_resource: 1,
        lease_seconds: 3600,
    }
}
struct Account {
    tenant: String,
    token: String,
    subject: String,
}
struct Fixture {
    root: PathBuf,
    owner: Option<WriterOwner>,
}
impl Fixture {
    fn new(enforced: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-job-features-{}",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        let open = if enforced {
            WriterOwner::open_with_job_feature_admission
        } else {
            WriterOwner::open
        };
        Self {
            owner: Some(open(&root, Limits::default()).unwrap().0),
            root,
        }
    }
    fn owner(&self) -> &WriterOwner {
        self.owner.as_ref().unwrap()
    }
    fn reopen(&mut self) {
        self.owner.take().unwrap().shutdown().unwrap();
        self.owner = Some(
            WriterOwner::open_with_job_feature_admission(&self.root, Limits::default())
                .unwrap()
                .0,
        );
    }
    fn account(&self, name: &str) -> Account {
        let result = self
            .owner()
            .auth(FirstUserTenant::NewUser)
            .submit(
                auth::Request::Register {
                    email: format!("{name}@example.com"),
                    display_name: name.into(),
                    password: Secret::new("correct-horse".into()),
                },
                Arc::new(AtomicBool::new(false)),
                WAIT,
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        let auth::Outcome::Session { user, token } = result else {
            panic!("session")
        };
        Account {
            tenant: user.tenant_id,
            token: token.expose().into(),
            subject: format!("user:{}", user.user_id),
        }
    }
    fn call(&self, account: &Account, operation: UserOperation) -> Result<Outcome> {
        self.owner()
            .jobs(policy())?
            .submit(
                Credential::Session(Secret::new(account.token.clone())),
                operation,
                &ACTIVE,
                WAIT,
            )?
            .receive()
    }
    fn set(&self, account: &Account, scope: Scope, choice: Option<bool>) {
        self.owner()
            .features_with_policy(policy())
            .unwrap()
            .set(
                FeatureCredential::Session(Secret::new(account.token.clone())),
                scope,
                Feature::Spoolman,
                choice,
                &ACTIVE,
                WAIT,
            )
            .unwrap();
    }
    fn raw(&self) -> Connection {
        let raw = Connection::open(self.root.join("print-partner.db")).unwrap();
        raw.busy_timeout(WAIT).unwrap();
        raw
    }
    fn plan(&self, account: &Account) -> PositiveId {
        let raw = self.raw();
        raw.execute(
            "INSERT INTO build_profiles(tenant_id,name) VALUES(?1,?2)",
            params![account.tenant, format!("plan-{}", rand::random::<u64>())],
        )
        .unwrap();
        PositiveId::new(raw.last_insert_rowid().try_into().unwrap()).unwrap()
    }
    fn setting(&self, account: &Account, plan: Option<PositiveId>, value: &str) {
        let key = plan.map_or_else(
            || "feature_toggles".into(),
            |id| format!("feature_toggles:plan:{}", id.get()),
        );
        self.raw().execute("INSERT INTO app_settings(tenant_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value", params![account.tenant,key,value]).unwrap();
    }
    fn enqueue(&self, account: &Account, key: &str, payload: Payload) -> JobRecord {
        record(
            self.call(
                account,
                UserOperation::Enqueue {
                    key: key.into(),
                    payload_version: 1,
                    payload,
                },
            )
            .unwrap(),
        )
    }
    fn claim(
        &self,
        account: &Account,
        worker: &ServerWorkerClient,
        key: &str,
        plan: Option<PositiveId>,
        start: bool,
    ) -> AttemptLease {
        let job = self.enqueue(account, key, printer(key, plan, start));
        let claimed_attempt!(claimed, lease) = worker.claim().unwrap().unwrap();
        assert_eq!(claimed.job_id, job.job_id);
        lease
    }
    fn get(&self, account: &Account, lease: &AttemptLease) -> JobRecord {
        record(
            self.call(
                account,
                UserOperation::Get {
                    job_id: lease.job_id().into(),
                },
            )
            .unwrap(),
        )
    }
    fn snapshot(&self, id: &str) -> Vec<Vec<Vec<Value>>> {
        let raw = self.raw();
        [
            "SELECT * FROM durable_jobs WHERE id=?1 ORDER BY rowid",
            "SELECT * FROM durable_job_history WHERE job_id=?1 ORDER BY version",
            "SELECT * FROM durable_job_keys WHERE job_id=?1 ORDER BY rowid",
            "SELECT * FROM durable_job_reconciliations WHERE job_id=?1 ORDER BY version",
        ]
        .into_iter()
        .map(|sql| {
            let mut stmt = raw.prepare(sql).unwrap();
            let count = stmt.column_count();
            stmt.query_map([id], |r| {
                (0..count)
                    .map(|i| r.get(i))
                    .collect::<rusqlite::Result<Vec<Value>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        })
        .collect()
    }
    fn refuse(
        &self,
        worker: &ServerWorkerClient,
        lease: &mut AttemptLease,
        operation: WorkerOperation,
    ) -> anyhow::Error {
        let before = self.snapshot(lease.job_id());
        let error = worker.update(lease, operation).unwrap_err();
        assert_eq!(self.snapshot(lease.job_id()), before);
        error
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
fn record(outcome: Outcome) -> JobRecord {
    let Outcome::Job(record, _) = outcome else {
        panic!("job")
    };
    record
}
fn printer(name: &str, plan: Option<PositiveId>, start: bool) -> Payload {
    Payload::PrinterUpload {
        printer_id: name.into(),
        artifact_path: "exports/candidate.gcode".into(),
        filename: "candidate.gcode".into(),
        start,
        profile_id: plan.map(PositiveId::get),
        host_name: None,
        checkoff_units: vec![],
        unlabeled_names: vec![],
    }
}
fn intent(operation: EffectOperation, target: &str) -> EffectIntent {
    EffectIntent {
        operation,
        basis_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        target: target.into(),
    }
}
fn deduction(target: &str) -> WorkerOperation {
    WorkerOperation::BeginEffect(intent(EffectOperation::SpoolmanDeduction, target))
}
fn receipt(target: &str) -> ResultArtifact {
    ResultArtifact {
        receipt_id: format!("receipt-{target}"),
        content_hash: "b".repeat(64),
        target: target.into(),
    }
}
fn confirm(
    worker: &ServerWorkerClient,
    lease: &mut AttemptLease,
    operation: EffectOperation,
    target: &str,
) -> ResultArtifact {
    worker
        .update(
            lease,
            WorkerOperation::BeginEffect(intent(operation, target)),
        )
        .unwrap();
    let receipt = receipt(target);
    worker
        .update(lease, WorkerOperation::ConfirmEffect(receipt.clone()))
        .unwrap();
    receipt
}
fn disabled(error: anyhow::Error) {
    assert_eq!(
        error.downcast_ref::<JobFailure>(),
        Some(&JobFailure::FeatureDisabled {
            feature: Feature::Spoolman
        })
    );
}

#[test]
fn refusal_is_atomic_and_same_lease_can_retry_after_enable() {
    let f = Fixture::new(true);
    let account = f.account("one");
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let mut lease = f.claim(&account, &worker, "printer", None, false);
    disabled(f.refuse(&worker, &mut lease, deduction("spool")));
    f.set(&account, Scope::User, Some(true));
    let admitted = worker.update(&mut lease, deduction("spool")).unwrap();
    assert_eq!(admitted.state, PersistentState::EffectAdmitted);
    assert_eq!(admitted.effects.len(), 1);
}

#[test]
fn ordinary_owner_never_reads_feature_layers() {
    for scenario in [
        "default",
        "disabled",
        "plan-disabled",
        "corrupt",
        "missing-plan",
    ] {
        let f = Fixture::new(false);
        let account = f.account("legacy");
        let plan = match scenario {
            "plan-disabled" => {
                let id = f.plan(&account);
                f.set(&account, Scope::Plan(id), Some(false));
                Some(id)
            }
            "missing-plan" => Some(PositiveId::new(999999).unwrap()),
            _ => None,
        };
        if scenario == "disabled" {
            f.set(&account, Scope::User, Some(false));
        }
        if scenario == "corrupt" {
            f.setting(&account, None, "{");
        }
        let worker = f
            .owner()
            .job_worker_with_policy(policy(), admission())
            .unwrap();
        let mut lease = f.claim(&account, &worker, "printer", plan, false);
        assert_eq!(
            worker.update(&mut lease, deduction("spool")).unwrap().state,
            PersistentState::EffectAdmitted,
            "{scenario}"
        );
    }
}

#[test]
fn live_controls_resolve_plan_then_user_then_default() {
    let f = Fixture::new(true);
    let account = f.account("choices");
    let plan = f.plan(&account);
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let mut lease = f.claim(&account, &worker, "printer", Some(plan), false);
    for (index, (scope, choice, allowed)) in [
        (Scope::User, Some(true), true),
        (Scope::Plan(plan), Some(false), false),
        (Scope::Plan(plan), None, true),
        (Scope::User, Some(false), false),
        (Scope::Plan(plan), Some(true), true),
        (Scope::Plan(plan), None, false),
        (Scope::User, Some(true), true),
        (Scope::User, None, false),
    ]
    .into_iter()
    .enumerate()
    {
        f.set(&account, scope, choice);
        let target = format!("spool-{index}");
        if allowed {
            confirm(
                &worker,
                &mut lease,
                EffectOperation::SpoolmanDeduction,
                &target,
            );
        } else {
            disabled(f.refuse(&worker, &mut lease, deduction(&target)));
        }
    }
    f.set(&account, Scope::User, Some(true));
    let mut user_lease = f.claim(&account, &worker, "user-only", None, false);
    f.set(&account, Scope::User, Some(false));
    disabled(f.refuse(&worker, &mut user_lease, deduction("spool")));
    f.set(&account, Scope::User, Some(true));
    assert_eq!(
        worker
            .update(&mut user_lease, deduction("spool"))
            .unwrap()
            .effects
            .len(),
        1
    );
}

#[test]
fn stored_tenant_and_plan_ownership_are_authoritative() {
    let f = Fixture::new(true);
    let alice = f.account("alice");
    let bob = f.account("bob");
    let alice_plan = f.plan(&alice);
    let bob_plan = f.plan(&bob);
    f.set(&alice, Scope::User, Some(true));
    f.set(&bob, Scope::Plan(bob_plan), Some(true));
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let mut alice_lease = f.claim(&alice, &worker, "alice", Some(alice_plan), false);
    confirm(
        &worker,
        &mut alice_lease,
        EffectOperation::SpoolmanDeduction,
        "bob-looking-target",
    );
    let mut bob_lease = f.claim(&bob, &worker, "bob", None, false);
    disabled(f.refuse(&worker, &mut bob_lease, deduction("alice-looking-target")));
    let mut bob_plan_lease = f.claim(&bob, &worker, "bob-plan", Some(bob_plan), false);
    confirm(
        &worker,
        &mut bob_plan_lease,
        EffectOperation::SpoolmanDeduction,
        "spool",
    );
    let orphan = f.plan(&alice);
    f.set(&alice, Scope::Plan(orphan), Some(true));
    f.raw()
        .execute(
            "DELETE FROM build_profiles WHERE id=?1",
            [i64::try_from(orphan.get()).unwrap()],
        )
        .unwrap();
    let removed = f.plan(&alice);
    let mut removed_lease = f.claim(&alice, &worker, "removed-after-claim", Some(removed), false);
    f.raw()
        .execute(
            "DELETE FROM build_profiles WHERE id=?1",
            [i64::try_from(removed.get()).unwrap()],
        )
        .unwrap();
    assert_eq!(
        f.refuse(&worker, &mut removed_lease, deduction("spool"))
            .to_string(),
        "Plan not found"
    );
    assert_eq!(
        worker
            .update(&mut removed_lease, WorkerOperation::Heartbeat)
            .unwrap()
            .state,
        PersistentState::Running
    );
    for (name, plan) in [
        ("foreign", bob_plan),
        ("missing", PositiveId::new(999999).unwrap()),
        ("orphan", orphan),
    ] {
        let mut lease = f.claim(&alice, &worker, name, Some(plan), false);
        assert_eq!(
            f.refuse(&worker, &mut lease, deduction("spool"))
                .to_string(),
            "Plan not found"
        );
        let primary = confirm(&worker, &mut lease, EffectOperation::PrinterUpload, name);
        let done = worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap();
        assert_eq!(done.result, Some(primary));
        assert_eq!(done.state, PersistentState::Succeeded);
    }
}

#[test]
fn corrupt_layers_fail_closed_without_changing_the_lease() {
    let f = Fixture::new(true);
    let account = f.account("corrupt");
    let plan = f.plan(&account);
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let mut lease = f.claim(&account, &worker, "printer", Some(plan), false);
    for scope in [None, Some(plan)] {
        for value in [
            "{",
            r#"{"spoolman":"yes"}"#,
            r#"{"farm":1,"spoolman":true}"#,
        ] {
            f.setting(&account, scope, value);
            let error = f.refuse(&worker, &mut lease, deduction("spool"));
            assert!(error.downcast_ref::<JobFailure>().is_none());
            let key = scope.map_or_else(
                || "feature_toggles".into(),
                |id| format!("feature_toggles:plan:{}", id.get()),
            );
            assert!(
                error
                    .to_string()
                    .starts_with(&format!("Stored {key} is invalid:")),
                "{error}"
            );
            f.setting(&account, scope, "{}");
        }
    }
    f.setting(&account, None, r#"{"future":{"nested":3}}"#);
    f.set(&account, Scope::User, Some(true));
    f.set(&account, Scope::User, None);
    let value: String = f
        .raw()
        .query_row(
            "SELECT value FROM app_settings WHERE tenant_id=?1 AND key='feature_toggles'",
            [&account.tenant],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&value).unwrap(),
        serde_json::json!({"future":{"nested":3}})
    );
    disabled(f.refuse(&worker, &mut lease, deduction("spool")));
    f.set(&account, Scope::User, Some(true));
    assert_eq!(
        worker
            .update(&mut lease, deduction("spool"))
            .unwrap()
            .effects
            .len(),
        1
    );
}

#[test]
fn siblings_and_clones_share_policy_and_capacity_contract() {
    let f = Fixture::new(true);
    let account = f.account("siblings");
    let first = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let second = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let cloned = first.clone();
    let mut conflicting = admission();
    conflicting.per_resource = 2;
    assert_eq!(
        f.owner().job_worker(conflicting).err().unwrap().to_string(),
        "Worker admission already configured"
    );
    let workers = [first, second, cloned];
    let mut leases = Vec::new();
    for (i, worker) in workers.iter().enumerate() {
        let mut lease = f.claim(&account, worker, &format!("printer-{i}"), None, false);
        disabled(f.refuse(worker, &mut lease, deduction("spool")));
        leases.push(lease);
    }
    f.set(&account, Scope::User, Some(true));
    for (worker, lease) in workers.iter().zip(&mut leases) {
        assert_eq!(
            worker.update(lease, deduction("spool")).unwrap().state,
            PersistentState::EffectAdmitted
        );
    }
}

#[test]
fn existing_validation_precedes_feature_resolution() {
    let f = Fixture::new(true);
    let account = f.account("validation");
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let sibling = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let mut lease = f.claim(&account, &worker, "printer", None, false);
    let mut stale = lease.clone();
    worker
        .update(&mut lease, WorkerOperation::Heartbeat)
        .unwrap();
    f.setting(&account, None, "{");
    assert_eq!(
        f.refuse(&worker, &mut stale, deduction("spool"))
            .to_string(),
        "Stale attempt fence"
    );
    assert_eq!(
        f.refuse(&sibling, &mut lease, deduction("spool"))
            .to_string(),
        "Foreign worker lease"
    );
    let mut malformed = intent(EffectOperation::SpoolmanDeduction, "spool");
    malformed.content_hash = "bad".into();
    assert_eq!(
        f.refuse(&worker, &mut lease, WorkerOperation::BeginEffect(malformed))
            .to_string(),
        "Invalid digest"
    );
    f.enqueue(&account, "updates", Payload::CheckSourceUpdates {});
    let claimed_attempt!(_, mut source) = worker.claim().unwrap().unwrap();
    assert_eq!(
        f.refuse(&worker, &mut source, deduction("spool"))
            .to_string(),
        "Effect does not belong to job kind"
    );
    confirm(
        &worker,
        &mut source,
        EffectOperation::SourceRefresh,
        "source",
    );
    f.setting(&account, None, "{}");
    f.set(&account, Scope::User, Some(true));
    confirm(
        &worker,
        &mut lease,
        EffectOperation::SpoolmanDeduction,
        "spool",
    );
    f.setting(&account, None, "{");
    assert_eq!(
        f.refuse(&worker, &mut lease, deduction("spool"))
            .to_string(),
        "Effect already admitted"
    );
    confirm(
        &worker,
        &mut lease,
        EffectOperation::PrinterUpload,
        "printer",
    );
    assert_eq!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap()
            .state,
        PersistentState::Succeeded
    );
}

#[test]
fn denied_optional_deduction_preserves_primary_completion_rules() {
    let f = Fixture::new(true);
    let account = f.account("primary");
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    for (name, start, combined) in [
        ("upload", false, false),
        ("start", true, false),
        ("combined", true, true),
    ] {
        let mut lease = f.claim(&account, &worker, name, None, start);
        let primary = confirm(
            &worker,
            &mut lease,
            if combined {
                EffectOperation::PrinterUploadAndStart
            } else {
                EffectOperation::PrinterUpload
            },
            name,
        );
        disabled(f.refuse(&worker, &mut lease, deduction("spool")));
        let expected = if start && !combined {
            assert_eq!(
                f.refuse(&worker, &mut lease, WorkerOperation::Finish(None))
                    .to_string(),
                "Completion requires effect receipts"
            );
            confirm(&worker, &mut lease, EffectOperation::PrinterStart, name)
        } else {
            primary
        };
        let before = f.get(&account, &lease).effects;
        let done = worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap();
        assert_eq!(done.state, PersistentState::Succeeded);
        assert_eq!(done.result, Some(expected));
        assert_eq!(done.effects, before);
        assert!(
            done.effects
                .iter()
                .all(|e| e.intent.operation != EffectOperation::SpoolmanDeduction)
        );
    }
}

#[test]
fn bound_printer_start_rejects_deduction_before_feature_read() {
    let f = Fixture::new(true);
    let account = f.account("bound");
    let worker = f
        .owner()
        .job_worker_with_policy(policy(), admission())
        .unwrap();
    let mut parent = f.claim(&account, &worker, "printer", None, true);
    worker
        .update(
            &mut parent,
            WorkerOperation::BeginEffect(intent(EffectOperation::PrinterUpload, "printer")),
        )
        .unwrap();
    let uncertain = worker.update(&mut parent, WorkerOperation::Fail).unwrap();
    let uploaded = record(
        f.call(
            &account,
            UserOperation::Reconcile {
                job_id: uncertain.job_id.clone(),
                expected_version: uncertain.state_version,
                expected_generation: uncertain.generation,
                effect_hash: "b".repeat(64),
                decision: Decision::ConfirmSucceeded,
                receipt: Some(receipt("printer")),
            },
        )
        .unwrap(),
    );
    assert_eq!(uploaded.state, PersistentState::UploadedOnly);
    f.enqueue(
        &account,
        "start",
        Payload::PrinterStart(PrinterStartRequest::new(&uploaded.job_id)),
    );
    let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();
    f.setting(&account, None, "{");
    assert_eq!(
        f.refuse(&worker, &mut lease, deduction("spool"))
            .to_string(),
        "Effect does not match uploaded artifact"
    );
    confirm(
        &worker,
        &mut lease,
        EffectOperation::PrinterStart,
        "printer",
    );
    assert_eq!(
        worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap()
            .state,
        PersistentState::Succeeded
    );
}

fn change_after_admission(f: &Fixture, account: &Account, plan: PositiveId, change: &str) {
    f.set(account, Scope::User, Some(false));
    f.set(account, Scope::Plan(plan), None);
    match change {
        "disabled" => (),
        "corrupt-user" => f.setting(account, None, "{"),
        "corrupt-plan" => f.setting(account, Some(plan), r#"{"spoolman":0}"#),
        "deleted-plan" => {
            f.raw()
                .execute(
                    "DELETE FROM build_profiles WHERE id=?1",
                    [i64::try_from(plan.get()).unwrap()],
                )
                .unwrap();
        }
        _ => panic!("change"),
    }
}

#[test]
fn admitted_effect_can_confirm_and_finish_after_choices_become_invalid() {
    for change in ["disabled", "corrupt-user", "corrupt-plan", "deleted-plan"] {
        let f = Fixture::new(true);
        let account = f.account("confirmed");
        let plan = f.plan(&account);
        f.set(&account, Scope::Plan(plan), Some(true));
        let worker = f
            .owner()
            .job_worker_with_policy(policy(), admission())
            .unwrap();
        let mut lease = f.claim(&account, &worker, "printer", Some(plan), false);
        let primary = confirm(
            &worker,
            &mut lease,
            EffectOperation::PrinterUpload,
            "printer",
        );
        worker.update(&mut lease, deduction("spool")).unwrap();
        change_after_admission(&f, &account, plan, change);
        worker
            .update(&mut lease, WorkerOperation::ConfirmEffect(receipt("spool")))
            .unwrap();
        let error = f.refuse(&worker, &mut lease, deduction("new-spool"));
        match change {
            "disabled" => disabled(error),
            "deleted-plan" => assert_eq!(error.to_string(), "Plan not found"),
            _ => assert!(error.to_string().starts_with("Stored feature_toggles")),
        }
        let done = worker
            .update(&mut lease, WorkerOperation::Finish(None))
            .unwrap();
        assert_eq!(done.state, PersistentState::Succeeded);
        assert_eq!(done.result, Some(primary));
        assert_eq!(done.effects.len(), 2);
        assert!(done.effects.iter().all(|e| e.confirmed));
    }
}

#[test]
fn admitted_effect_can_reconcile_after_recovery_or_failure_despite_invalid_choices() {
    for change in ["disabled", "corrupt-user", "corrupt-plan", "deleted-plan"] {
        for (reopen, decision) in [
            (false, Decision::ConfirmSucceeded),
            (true, Decision::ConfirmSucceeded),
            (true, Decision::ConfirmNoEffect),
        ] {
            let mut f = Fixture::new(true);
            let account = f.account("operator");
            let plan = f.plan(&account);
            f.set(&account, Scope::Plan(plan), Some(true));
            let worker = f
                .owner()
                .job_worker_with_policy(policy(), admission())
                .unwrap();
            let mut lease = f.claim(&account, &worker, "printer", Some(plan), false);
            let primary = confirm(
                &worker,
                &mut lease,
                EffectOperation::PrinterUpload,
                "printer",
            );
            worker.update(&mut lease, deduction("spool")).unwrap();
            change_after_admission(&f, &account, plan, change);
            if reopen {
                drop(worker);
                f.reopen();
            } else {
                worker.update(&mut lease, WorkerOperation::Fail).unwrap();
            }
            let uncertain = f.get(&account, &lease);
            assert_eq!(uncertain.state, PersistentState::ReconciliationRequired);
            let deduction_receipt = if decision == Decision::ConfirmSucceeded {
                Some(receipt("spool"))
            } else {
                None
            };
            let done = record(
                f.call(
                    &account,
                    UserOperation::Reconcile {
                        job_id: uncertain.job_id.clone(),
                        expected_version: uncertain.state_version,
                        expected_generation: uncertain.generation,
                        effect_hash: "b".repeat(64),
                        decision,
                        receipt: deduction_receipt.clone(),
                    },
                )
                .unwrap(),
            );
            assert_eq!(done.state, PersistentState::Succeeded);
            assert_eq!(done.result, Some(primary));
            assert_eq!(done.effects[0], uncertain.effects[0]);
            assert_eq!(done.effects[1].receipt, deduction_receipt);
            assert_eq!(
                done.effects[1].no_effect,
                decision == Decision::ConfirmNoEffect
            );
            let Outcome::Reconciliations(audit) = f
                .call(
                    &account,
                    UserOperation::Reconciliations {
                        job_id: done.job_id,
                        before_version: None,
                        limit: 10,
                    },
                )
                .unwrap()
            else {
                panic!("audit")
            };
            assert_eq!(audit.len(), 1);
            assert_eq!(audit[0].subject, account.subject);
            assert_eq!(audit[0].target, "spool");
            assert_eq!(audit[0].effect_hash, "b".repeat(64));
            assert_eq!(audit[0].decision, format!("{decision:?}"));
            assert_eq!(audit[0].receipt, deduction_receipt);
        }
    }
}
