use anyhow::{Result, anyhow, ensure};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    jobs::*,
};
use std::{
    io::{self, BufRead, Write},
    path::Path,
    sync::{Arc, Barrier, atomic::AtomicBool},
    thread,
    time::Duration,
};
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Closed,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    }
}
fn call(owner: &WriterOwner, operation: UserOperation) -> Result<JobRecord> {
    match owner
        .jobs(policy())?
        .submit(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            operation,
            &AtomicBool::new(false),
            Duration::from_secs(5),
        )?
        .receive()?
    {
        Outcome::Job(job, _) => Ok(job),
        _ => Err(anyhow!("Expected job")),
    }
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let command = args
        .get(1)
        .ok_or_else(|| anyhow!("Usage: jobs-fixture enqueue-claim|restart DIRECTORY"))?;
    let dir = Path::new(args.get(2).ok_or_else(|| anyhow!("Directory required"))?);
    let (owner, ready) = WriterOwner::open(dir, Limits::default())?;
    let worker = owner.job_worker(WorkerAdmission {
        kinds: vec![
            (JobKind::CheckSourceUpdates, 1),
            (JobKind::ImportScan, 1),
            (JobKind::PrinterUpload, 1),
        ],
        total: 1,
        per_resource: 1,
        lease_seconds: 60,
    })?;
    match command.as_str() {
        "source-composition" => {
            use pp_storage::catalog::{CreateSource, Deletion, Outcome as CatalogOutcome, Request};
            let catalog = owner.local_source_catalog();
            let CatalogOutcome::Source(Some(source)) = catalog.execute(Request::Create {
                source: CreateSource {
                    name: "Public claimed Source".into(),
                    ..Default::default()
                },
            })?
            else {
                return Err(anyhow!("Source missing"));
            };
            let job = call(
                &owner,
                UserOperation::Enqueue {
                    key: "source-composition".into(),
                    payload_version: 1,
                    payload: Payload::ImportScan {
                        project_id: u64::try_from(source.id)?,
                    },
                },
            )?;
            ensure!(
                matches!(
                    catalog.execute(Request::Delete { id: source.id })?,
                    CatalogOutcome::Deletion(Deletion::ActiveWork)
                ),
                "Queued reservation missing"
            );
            let (_, lease) = worker
                .claim()?
                .ok_or_else(|| anyhow!("Source claim missing"))?;
            let mut source_work = worker.begin_source_work(
                &lease,
                None,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )?;
            ensure!(
                matches!(
                    catalog.execute(Request::Delete { id: source.id })?,
                    CatalogOutcome::Deletion(Deletion::ActiveWork)
                ),
                "Claimed lease missing"
            );
            source_work.release()?;
            ensure!(
                matches!(
                    catalog.execute(Request::Delete { id: source.id })?,
                    CatalogOutcome::Deletion(Deletion::ActiveWork)
                ),
                "Reservation lost after release"
            );
            call(&owner, UserOperation::Cancel { job_id: job.job_id })?;
            ensure!(
                worker
                    .begin_source_work(
                        &lease,
                        None,
                        &AtomicBool::new(false),
                        Duration::from_secs(5)
                    )
                    .is_err(),
                "Cancelled attempt accepted"
            );
            ensure!(
                matches!(
                    catalog.execute(Request::Delete { id: source.id })?,
                    CatalogOutcome::Deletion(Deletion::Deleted { .. })
                ),
                "Cancellation did not release reservation"
            );
            println!(
                "{}",
                serde_json::json!({"schema": ready.version, "source_id":source.id,"public_claim_bound_lease":true,"queued_guard":true,"released_lease_keeps_reservation":true,"cancel_releases_reservation":true,"handler_calls":0})
            );
        }

        "enqueue-claim" | "hold" | "concurrent" => {
            let enqueue = || UserOperation::Enqueue {
                key: "public-proof".into(),
                payload_version: 1,
                payload: Payload::CheckSourceUpdates {},
            };
            let first = call(&owner, enqueue())?;
            let duplicate = call(&owner, enqueue())?;
            ensure!(
                first.job_id == duplicate.job_id,
                "Duplicate created another job"
            );
            let (claimed, _lease) = if command == "concurrent" {
                let barrier = Arc::new(Barrier::new(8));
                let handles: Vec<_> = (0..8)
                    .map(|_| {
                        let worker = worker.clone();
                        let barrier = barrier.clone();
                        thread::spawn(move || {
                            barrier.wait();
                            worker.claim()
                        })
                    })
                    .collect();
                let mut claims = Vec::new();
                for handle in handles {
                    if let Some(claim) = handle
                        .join()
                        .map_err(|_| anyhow!("Consumer thread failed"))??
                    {
                        claims.push(claim);
                    }
                }
                ensure!(claims.len() == 1, "Concurrent claim exclusivity failed");
                claims.pop().expect("one claim")
            } else {
                worker.claim()?.ok_or_else(|| anyhow!("No claim"))?
            };
            ensure!(
                claimed.job_id == first.job_id && worker.claim()?.is_none(),
                "Claim exclusivity failed"
            );
            println!(
                "{}",
                serde_json::json!({"schema":ready.version,"duplicate_same_job":true,"claim":claimed.snapshot(),"attempt":claimed.attempt,"state_version":claimed.state_version,"concurrent_consumers":if command=="concurrent"{8}else{1}})
            );
        }
        "restart" => {
            let (claimed, _lease) = worker
                .claim()?
                .ok_or_else(|| anyhow!("No recovered claim"))?;
            ensure!(
                claimed.attempt == 2 && claimed.generation >= 3,
                "Restart failed to fence old attempt"
            );
            println!(
                "{}",
                serde_json::json!({"schema":ready.version,"restart_fenced":true,"attempt":claimed.attempt,"generation":claimed.generation,"job":claimed.snapshot()})
            );
        }
        "effect-intent" | "effect-restart" => {
            let record = call(
                &owner,
                UserOperation::Enqueue {
                    key: "incomplete-effect-fixture".into(),
                    payload_version: 1,
                    payload: Payload::PrinterUpload {
                        printer_id: "fixture-printer".into(),
                        artifact_path: "exports/fixture.gcode".into(),
                        filename: "fixture.gcode".into(),
                        start: true,
                        profile_id: None,
                        host_name: None,
                        checkoff_units: vec![],
                        unlabeled_names: vec![],
                    },
                },
            )?;
            if command == "effect-intent" {
                let (_, mut lease) = worker.claim()?.ok_or_else(|| anyhow!("No effect claim"))?;
                let admitted = worker.update(
                    &mut lease,
                    WorkerOperation::BeginEffect(EffectIntent {
                        operation: EffectOperation::PrinterUploadAndStart,
                        basis_hash: "a".repeat(64),
                        content_hash: "b".repeat(64),
                        target: "fixture-printer".into(),
                    }),
                )?;
                println!(
                    "{}",
                    serde_json::json!({"incomplete_fixture_persisted":admitted.state==PersistentState::EffectAdmitted,"effect_calls":0,"job":admitted.snapshot()})
                );
            } else {
                ensure!(
                    record.state == PersistentState::ReconciliationRequired
                        && worker.claim()?.is_none(),
                    "Uncertain effect was repeated"
                );
                println!(
                    "{}",
                    serde_json::json!({"uncertain_not_requeued":true,"effect_calls":0,"job":record.snapshot(),"generation":record.generation})
                );
            }
        }
        _ => return Err(anyhow!("Unknown command")),
    }
    io::stdout().flush()?;
    if command == "hold" {
        let _ = io::stdin().lock().lines().next();
    }
    owner.shutdown()?;
    Ok(())
}
