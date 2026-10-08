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
fn projection(owner: &WriterOwner, profiles: &[i64]) -> Result<Vec<u8>> {
    let batch = owner.accepted_reads_with_policy(policy())?.read(
        read_credential()?,
        profiles,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )?;
    let mut output = b"{\"builds\":[".to_vec();
    for (i, build) in batch.builds.into_iter().enumerate() {
        if i > 0 {
            output.push(b',');
        }
        let ordinary = json!({"profileId":build.profile_id,"context":build.context});
        output.extend_from_slice(b"{\"profileId\":");
        output.extend_from_slice(&serde_json::to_vec(&ordinary["profileId"])?);
        output.extend_from_slice(b",\"accepted\":");
        let checkoff = views::checkoff(build.profile_id, &build.accepted, &CatalogOnly)?;
        let progress = views::progress(build.profile_id, &build.accepted);
        output.extend_from_slice(&build.accepted.into_json_body().into_bytes());
        output.extend_from_slice(b",\"context\":");
        output.extend_from_slice(&serde_json::to_vec(&ordinary["context"])?);
        if let Some(error) = build.context_error {
            output.extend_from_slice(b",\"contextError\":");
            output.extend_from_slice(&serde_json::to_vec(&error)?);
        }
        output.extend_from_slice(b",\"checkoff\":");
        output.extend_from_slice(&serde_json::to_vec(&checkoff)?);
        output.extend_from_slice(b",\"progress\":");
        output.extend_from_slice(&serde_json::to_vec(&progress)?);
        output.push(b'}');
    }
    output.extend_from_slice(b"]}");
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
        let mut row = b"{\"response\":".to_vec();
        row.extend_from_slice(&serde_json::to_vec(&result)?);
        row.extend_from_slice(b",\"read\":");
        row.extend_from_slice(&projection(&owner, &profiles)?);
        row.push(b'}');
        results.push(row);
    }
    let before = projection(&owner, &profiles)?;
    owner.shutdown()?;
    let (owner, _) = WriterOwner::open(Path::new(&args[1]), Limits::default())?;
    let reopened = projection(&owner, &profiles)?;
    ensure!(before == reopened, "Orderly reopen changed public progress");
    owner.shutdown()?;
    let mut output = b"{\"schema\":".to_vec();
    output.extend_from_slice(&serde_json::to_vec(&schema)?);
    output.extend_from_slice(b",\"results\":[");
    for (i, row) in results.into_iter().enumerate() {
        if i > 0 {
            output.push(b',');
        }
        output.extend_from_slice(&row);
    }
    output.extend_from_slice(b"],\"reopened\":");
    output.extend_from_slice(&reopened);
    output.push(b'}');
    println!("{}", String::from_utf8(output)?);
    Ok(())
}
