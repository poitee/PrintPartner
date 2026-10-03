use anyhow::{Result, ensure};
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, Secret, SessionTenantPolicy},
    catalog::Credentials,
    checkoff_progress::Request,
    read_model::{
        Credential,
        views::{self, CatalogOnly},
    },
};
use serde_json::{Value, json};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};
fn policy() -> AuthPolicy {
    AuthPolicy {
        registration: RegistrationPolicy::Open,
        session_tenant: if std::env::var("PP_CHECKOFF_POLICY").as_deref() == Ok("single") {
            SessionTenantPolicy::SingleAccountDefault
        } else {
            SessionTenantPolicy::AccountTenant
        },
        first_user: FirstUserTenant::NewUser,
    }
}
fn credentials() -> Result<Credentials> {
    let secret = Secret::new(std::env::var("PP_CHECKOFF_CREDENTIAL")?);
    Ok(match std::env::var("PP_CHECKOFF_KEY_TENANT") {
        Ok(tenant_id) => Credentials::Key {
            tenant_id,
            key: secret,
        },
        Err(_) => Credentials::Session(secret),
    })
}
fn read_credential() -> Result<Credential> {
    Ok(match credentials()? {
        Credentials::Session(secret) => Credential::Session(secret),
        Credentials::Key { tenant_id, key } => Credential::ApiKey {
            routed_tenant: tenant_id,
            secret: key,
        },
    })
}
fn projection(owner: &WriterOwner, profiles: &[i64]) -> Result<Value> {
    let batch = owner.accepted_reads_with_policy(policy())?.read(
        read_credential()?,
        profiles,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )?;
    let mut output = serde_json::to_value(&batch)?;
    for (i, build) in batch.builds.iter().enumerate() {
        output["builds"][i]["checkoff"] =
            views::checkoff(build.profile_id, &build.accepted, &CatalogOnly)?;
        output["builds"][i]["progress"] = views::progress(build.profile_id, &build.accepted);
    }
    Ok(output)
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 3,
        "usage: checkoff-progress-fixture DIRECTORY INPUT_JSON"
    );
    let input: Value = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let profiles: Vec<i64> = serde_json::from_value(input["profiles"].clone())?;
    let requests: Vec<Value> = serde_json::from_value(input["requests"].clone())?;
    let (owner, schema) = WriterOwner::open(Path::new(&args[1]), Limits::default())?;
    let client = owner.checkoff_progress_with_policy(policy())?;
    let mut results = Vec::new();
    for request in requests {
        let result = match Request::parse(request) {
            Ok(request) => client.apply(
                credentials()?,
                request,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )?,
            Err(response) => response,
        };
        results.push(json!({"response":result,"read":projection(&owner,&profiles)?}));
    }
    let before = projection(&owner, &profiles)?;
    owner.shutdown()?;
    let (owner, _) = WriterOwner::open(Path::new(&args[1]), Limits::default())?;
    let reopened = projection(&owner, &profiles)?;
    ensure!(before == reopened, "Orderly reopen changed public progress");
    owner.shutdown()?;
    println!(
        "{}",
        json!({"schema":schema,"results":results,"reopened":reopened})
    );
    Ok(())
}
