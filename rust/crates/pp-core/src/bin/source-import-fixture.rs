use anyhow::{Result, anyhow};
use pp_core::uploads::{SourceImports, Through};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    jobs::Credential,
    uploads::Admission,
};
use std::{io::Read, path::Path, sync::atomic::AtomicBool};
fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    let directory = Path::new(
        args.get(1)
            .ok_or_else(|| anyhow!("Database directory required"))?,
    );
    let (owner, ready) = WriterOwner::open(directory, Limits::default())?;
    let policy = AuthPolicy {
        registration: RegistrationPolicy::Closed,
        session_tenant: SessionTenantPolicy::AccountTenant,
        first_user: FirstUserTenant::NewUser,
    };
    let service = SourceImports::new(&owner, policy, 128 * 1024 * 1024)?;
    let mut json = String::new();
    std::io::stdin().take(65536).read_to_string(&mut json)?;
    let request: Admission = serde_json::from_str(&json)?;
    let supplied = Path::new(
        args.get(2)
            .ok_or_else(|| anyhow!("Supplied input root required"))?,
    );
    let through = match args.get(3).map(String::as_str) {
        Some("owned") => Through::OwnedInput,
        Some("published") => Through::Published,
        Some("activated") => Through::Activated,
        _ => Through::Settled,
    };
    let result = if through == Through::Settled {
        service.import(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            request,
            supplied,
            &AtomicBool::new(false),
        )?
    } else {
        let op = service.admit(
            Credential::PhysicalOwner(owner.job_physical_owner()),
            request,
            supplied,
            &AtomicBool::new(false),
        )?;
        service
            .work_operation(&op.job_id, Some(supplied), through, &AtomicBool::new(false))?
            .ok_or_else(|| anyhow!("No import job claimed"))?
    };
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({"schema":ready.version,"operation":result}))?
    );
    drop(service);
    owner.shutdown()?;
    Ok(())
}
