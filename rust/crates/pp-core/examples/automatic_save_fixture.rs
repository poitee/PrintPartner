use anyhow::{Result, anyhow};
use pp_core::draft_observations::{DraftReadConfiguration, FilesystemPolicy, issue_working_drafts};
use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    plan_publication::{PublicationCommand, RequiredUnitTokenAllocator, TokenAllocationFailure},
    read_model::Credential,
    working_drafts::{Outcome, PositiveId, Request, observation::PreparationLimits},
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::Duration,
};
struct Tokens {
    next: u128,
    emitted: Arc<Mutex<Vec<String>>>,
}
impl RequiredUnitTokenAllocator for Tokens {
    fn allocate(&mut self) -> std::result::Result<[u8; 16], TokenAllocationFailure> {
        self.next += 1;
        self.emitted
            .lock()
            .unwrap()
            .push(format!("ppu_{:032x}", self.next));
        Ok(self.next.to_be_bytes())
    }
}
fn main() -> Result<()> {
    for key in ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES"] {
        anyhow::ensure!(std::env::var_os(key).is_none(), "preloads rejected");
    }
    let args: Vec<_> = std::env::args().collect();
    let root = PathBuf::from(args.get(1).ok_or_else(|| anyhow!("root required"))?);
    let shared = PathBuf::from(args.get(2).ok_or_else(|| anyhow!("shared required"))?);
    let emitted = Arc::new(Mutex::new(Vec::new()));
    let next = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(1000);
    let (owner, _) = WriterOwner::open_with_token_allocator(
        &root,
        Limits::default(),
        Box::new(Tokens {
            next,
            emitted: emitted.clone(),
        }),
    )?;
    let policy = auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::AccountTenant,
        first_user: auth::FirstUserTenant::ClaimDefault,
    };
    let auth = owner.auth_with_policy(policy)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let wait = Duration::from_secs(5);
    let register = !root.join("fixture-auth-issued").exists();
    let request = if register {
        auth::Request::Register {
            email: "draft-owner@example.test".into(),
            display_name: "Draft fixture owner".into(),
            password: Secret::new("ordinary-fixture-password".into()),
        }
    } else {
        auth::Request::Login {
            email: "draft-owner@example.test".into(),
            password: Secret::new("ordinary-fixture-password".into()),
        }
    };
    let auth::Outcome::Session { token, user } =
        auth.submit(request, cancelled.clone(), wait)?.recv()??
    else {
        return Err(anyhow!("Expected issued session"));
    };
    std::fs::write(root.join("fixture-auth-issued"), user.user_id.as_bytes())?;
    let credential = || Credential::Session(Secret::new(token.expose().into()));
    let mut limits = PreparationLimits::default();
    if let Some(entries) = args.get(3) {
        let fields: Vec<_> = entries.split(':').collect();
        let value = fields
            .last()
            .ok_or_else(|| anyhow!("limit missing"))?
            .parse()?;
        match fields.first().copied().unwrap_or("entries") {
            "document" => limits.document_bytes = value,
            "nodes" => limits.nodes = value,
            "visits" => limits.visits = value,
            _ => limits.entries = value,
        }
    }
    let data = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../web/apps/server/src/data");
    let client = issue_working_drafts(
        &owner,
        policy,
        DraftReadConfiguration {
            repos: shared.join("repos"),
            relative_base: shared.clone(),
            policy: FilesystemPolicy::TrustedSingleUser,
            limits,
            shipped_hints: [data.join("path-hints.yaml"), data.join("path-hints.yaml")],
            custom_hints: Some(shared.join("path-hints.yaml")),
            community_manifests: std::collections::BTreeMap::from([(
                "working-draft-ordinary".into(),
                shared.join("community.yaml"),
            )]),
        },
    )?;
    println!(
        "{}",
        json!({"ready":true,"user_id":user.user_id,"tenant_id":user.tenant_id,"user":user})
    );
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let result = (|| -> Result<Value> {
            let c: Value = serde_json::from_str(&line)?;
            let profile = PositiveId::new(
                c["profile"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("profile required"))?,
            )
            .map_err(|e| anyhow!(e))?;
            if c["action"] == "save" {
                let request = serde_json::from_value(c["request"].clone())?;
                let command = pp_storage::plan_save::SaveCommand::new(
                    credential(),
                    profile,
                    request,
                    c["key"]
                        .as_str()
                        .ok_or_else(|| anyhow!("key required"))?
                        .into(),
                )?;
                return match client.plan_save().save(command, cancelled.clone(), wait) {
                    Ok(outcome) => Ok(serde_json::to_value(outcome)?),
                    Err(error) => {
                        if let Some(committed) = error
                            .downcast_ref::<pp_storage::plan_save::CommittedSaveCaptureFailure>(
                        ) {
                            Ok(
                                json!({"committed_capture_failure": {"receipt":committed.receipt,"closed_draft_ids":committed.closed_draft_ids,"error":committed.capture_failure.to_string()}}),
                            )
                        } else {
                            Err(error)
                        }
                    }
                };
            }
            if c["action"] == "full" {
                let draft_id = PositiveId::new(
                    c["draft"]
                        .as_u64()
                        .ok_or_else(|| anyhow!("draft required"))?,
                )
                .map_err(|e| anyhow!(e))?;
                let Outcome::Read { draft } = client.execute(
                    credential(),
                    profile,
                    Request::Read { draft_id },
                    cancelled.clone(),
                    wait,
                )?
                else {
                    return Err(anyhow!("Draft missing"));
                };
                return Ok(draft);
            }
            if c["action"] == "publish" {
                let draft_id = PositiveId::new(
                    c["draft"]
                        .as_u64()
                        .ok_or_else(|| anyhow!("draft required"))?,
                )
                .map_err(|e| anyhow!(e))?;
                let Outcome::Read { draft } = client.execute(
                    credential(),
                    profile,
                    Request::Read { draft_id },
                    cancelled.clone(),
                    wait,
                )?
                else {
                    return Err(anyhow!("Draft missing"));
                };
                let request = serde_json::from_value(
                    json!({"expected_snapshot_digest":draft["snapshotDigest"],"expected_lifecycle_version":draft["lifecycleVersion"],"expected_base":{"revision_id":draft["baseRevisionId"],"plan_version":draft["basePlanVersion"]}}),
                )?;
                return Ok(serde_json::to_value(
                    owner.publication_with_policy(policy)?.apply(
                        PublicationCommand::new(
                            profile,
                            draft_id,
                            request,
                            c["key"]
                                .as_str()
                                .ok_or_else(|| anyhow!("key required"))?
                                .into(),
                            credential(),
                        )?,
                        &cancelled,
                        wait,
                    )?,
                )?);
            }
            let request: Request = serde_json::from_value(c["request"].clone())?;
            let outcome = if c["service"] == true {
                client.service(credential(), profile, request, cancelled.clone(), wait)?
            } else {
                client.execute(credential(), profile, request, cancelled.clone(), wait)?
            };
            Ok(serde_json::to_value(outcome)?)
        })();
        println!(
            "{}",
            match result {
                Ok(v) => json!({"ok":v}),
                Err(e) => json!({"error":e.to_string()}),
            }
        );
        io::stdout().flush()?;
    }
    owner.shutdown()?;
    std::fs::write(
        root.join("token-transcript.json"),
        serde_json::to_vec(&*emitted.lock().unwrap())?,
    )?;
    Ok(())
}
