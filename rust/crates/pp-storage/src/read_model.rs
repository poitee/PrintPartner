mod context;
pub(crate) mod graph;
pub use context::{CapturedContext, PlateRef, RevisionRef, UnitHistory};
pub mod views;
pub mod workflow;

use crate::{
    Envelope, Shared, WriterOwner,
    auth::{self, Secret},
};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, TransactionBehavior};

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub use graph::{Artifact, Input, Part, Profile, Provenance, Snapshot, Unit};

pub enum Credential {
    Session(Secret),
    ApiKey {
        routed_tenant: String,
        secret: Secret,
    },
}

#[derive(Debug, Clone)]
pub enum AcceptedRead {
    Ready { snapshot: Box<Snapshot> },
    Empty { profile: Profile },
    Missing,
    CompatibilityDirty,
    Uninitialized,
    IntegrityFailure { code: String, message: String },
}
#[derive(Debug)]
pub struct BuildRead {
    pub profile_id: i64,
    pub accepted: AcceptedRead,
    pub context: Option<CapturedContext>,
    pub context_error: Option<String>,
}
#[derive(Debug)]
pub struct Batch {
    pub builds: Vec<BuildRead>,
}

pub struct AcceptedReadJsonBody(Vec<u8>);
pub struct AcceptedSnapshotJsonBody(Vec<u8>);
pub struct AcceptedBatchJsonBody(Vec<u8>);
impl AcceptedReadJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}
impl AcceptedSnapshotJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}
impl AcceptedBatchJsonBody {
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}
impl AcceptedRead {
    fn json_bytes(&self) -> Vec<u8> {
        match self {
            Self::Ready { snapshot } => {
                let mut bytes = b"{\"kind\":\"ready\",\"snapshot\":".to_vec();
                bytes.extend_from_slice(&snapshot.json_bytes());
                bytes.push(b'}');
                bytes
            }
            Self::Empty { .. } => b"{\"kind\":\"empty\"}".to_vec(),
            Self::Missing => b"{\"kind\":\"missing\"}".to_vec(),
            Self::CompatibilityDirty => b"{\"kind\":\"compatibility_dirty\"}".to_vec(),
            Self::Uninitialized => b"{\"kind\":\"uninitialized\"}".to_vec(),
            Self::IntegrityFailure { code, message } => serde_json::to_vec(
                &serde_json::json!({"kind":"integrity_failure","code":code,"message":message}),
            )
            .expect("scalar integrity failure"),
        }
    }
    pub fn into_json_body(self) -> AcceptedReadJsonBody {
        AcceptedReadJsonBody(self.json_bytes())
    }
}
impl Batch {
    pub fn into_json_body(self) -> AcceptedBatchJsonBody {
        let mut output = b"{\"builds\":[".to_vec();
        for (i, build) in self.builds.iter().enumerate() {
            if i > 0 {
                output.push(b',');
            }
            output.extend_from_slice(b"{\"profileId\":");
            output.extend_from_slice(build.profile_id.to_string().as_bytes());
            output.extend_from_slice(b",\"accepted\":");
            output.extend_from_slice(&build.accepted.json_bytes());
            output.extend_from_slice(b",\"context\":");
            output.extend_from_slice(&serde_json::to_vec(&build.context).expect("scalar context"));
            if let Some(error) = &build.context_error {
                output.extend_from_slice(b",\"contextError\":");
                output.extend_from_slice(&serde_json::to_vec(error).expect("context error"));
            }
            output.push(b'}');
        }
        output.extend_from_slice(b"]}");
        AcceptedBatchJsonBody(output)
    }
}

#[derive(Clone)]
pub struct ReadClient {
    shared: Arc<Shared>,
    repos: PathBuf,
    policy: auth::AuthPolicy,
}
pub(super) struct Command {
    credential: Credential,
    profile_ids: Vec<i64>,
    repos: PathBuf,
    policy: auth::AuthPolicy,
}

impl WriterOwner {
    pub fn accepted_reads(&self) -> ReadClient {
        self.accepted_reads_with_policy(auth::AuthPolicy {
            registration: auth::RegistrationPolicy::Open,
            session_tenant: auth::SessionTenantPolicy::AccountTenant,
            first_user: auth::FirstUserTenant::NewUser,
        })
        .expect("neutral policy")
    }
    pub fn accepted_reads_with_policy(&self, policy: auth::AuthPolicy) -> Result<ReadClient> {
        auth::validate_policy(policy)?;
        Ok(ReadClient {
            policy,
            shared: self.client.shared.clone(),
            repos: self
                .lease
                .as_ref()
                .expect("live owner")
                .data_dir()
                .join("repos"),
        })
    }
}
impl ReadClient {
    pub fn read(
        &self,
        credential: Credential,
        profile_ids: &[i64],
        cancelled: &AtomicBool,
        wait: Duration,
    ) -> Result<Batch> {
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        for &id in profile_ids {
            ensure!(
                id > 0 && id <= 9_007_199_254_740_991,
                "Accepted Plan Progress profile IDs must be positive safe integers"
            );
            if seen.insert(id) {
                ids.push(id);
            }
            ensure!(
                ids.len() <= 64,
                "Accepted Plan Progress batches contain at most 64 Plans"
            );
        }
        let deadline = Instant::now() + wait;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!("Writer admission poisoned"))?;
        loop {
            ensure!(!queue.closed, "Storage stopped");
            ensure!(
                !cancelled.load(Ordering::Acquire),
                "Cancelled before admission"
            );
            if queue.pending.len() < self.shared.capacity {
                break;
            }
            ensure!(Instant::now() < deadline, "Writer queue full");
            queue = self
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!("Writer admission poisoned"))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::Read {
            command: Command {
                credential,
                profile_ids: ids,
                repos: self.repos.clone(),
                policy: self.policy,
            },
            reply,
        });
        self.shared.changed.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|_| anyhow!("Storage stopped without read result"))?
    }
}
pub(super) fn execute(connection: &mut Connection, command: Command) -> Result<Batch> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let tenant = match command.credential {
        Credential::Session(secret) => auth::read_session_tenant(&tx, &secret, command.policy)?,
        Credential::ApiKey {
            routed_tenant,
            secret,
        } => auth::read_key_tenant(&tx, &routed_tenant, &secret)?,
    };
    let mut builds = Vec::new();
    let mut budget = graph::Budget::default();
    for profile_id in command.profile_ids {
        let accepted = match graph::read(&tx, &tenant, profile_id, &command.repos, &mut budget) {
            Ok(read) => read,
            Err(error) => match error.downcast_ref::<graph::Integrity>() {
                Some(error) => AcceptedRead::IntegrityFailure {
                    code: error.code.to_owned(),
                    message: error.message.clone(),
                },
                None => return Err(error),
            },
        };
        let (context, context_error) =
            match context::capture(&tx, &tenant, profile_id, &accepted, &mut budget) {
                Ok(value) => (value, None),
                Err(error) => (None, Some(error.to_string())),
            };
        builds.push(BuildRead {
            profile_id,
            accepted,
            context,
            context_error,
        });
    }
    tx.commit()?;
    Ok(Batch { builds })
}
pub(crate) fn reusable_draft_base(
    tx: &rusqlite::Transaction<'_>,
    tenant: &str,
    profile: i64,
    repos: &std::path::Path,
) -> Result<bool> {
    let mut budget = graph::Budget::default();
    if !context::draft_freshness_current(tx, tenant, profile, &mut budget)? {
        return Ok(false);
    }
    Ok(matches!(
        graph::read(tx, tenant, profile, repos, &mut budget)?,
        AcceptedRead::Ready { .. }
    ))
}
pub(crate) fn capture_published(
    tx: &rusqlite::Transaction<'_>,
    tenant: &str,
    profile: i64,
    repos: &std::path::Path,
    minimum_version: u64,
) -> Result<(Box<Snapshot>, CapturedContext)> {
    let mut budget = graph::Budget::default();
    let accepted = graph::read(tx, tenant, profile, repos, &mut budget)?;
    let context = context::capture(tx, tenant, profile, &accepted, &mut budget)?
        .ok_or_else(|| anyhow!("Published Build context missing"))?;
    let AcceptedRead::Ready { snapshot } = accepted else {
        return Err(anyhow!("Published accepted authority unavailable"));
    };
    ensure!(
        snapshot.plan_version >= minimum_version as i64,
        "Accepted capture predates Save receipt"
    );
    Ok((snapshot, context))
}
