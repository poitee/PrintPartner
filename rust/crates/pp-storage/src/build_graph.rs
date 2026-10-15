mod model;
pub(crate) mod projection;
use crate::{Envelope, Shared, WriterOwner, auth, read_model};
use anyhow::{Result, anyhow, ensure};
pub use model::*;
use pp_domain::PositiveId;
use rusqlite::{Connection, Transaction, params};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum Failure {
    Cancelled,
    QueueFull,
    Stopped,
    OutcomeUnknown,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for Failure {}

#[derive(Clone)]
pub enum BuildCommand {
    List,
    Read { build: PositiveId },
    ListLayers { build: PositiveId },
}
#[derive(Debug)]
pub enum BuildOutcome {
    Listed {
        profiles: Vec<ProfileSummary>,
    },
    Read {
        profile: ProfileSummary,
    },
    Layers {
        profile_id: i64,
        layers: Vec<ProfileLayer>,
    },
    MissingBuild,
}
#[derive(Clone)]
pub struct BuildGraphClient {
    shared: Arc<Shared>,
    policy: auth::AuthPolicy,
    repos: PathBuf,
}
pub(super) struct Command {
    credential: read_model::Credential,
    policy: auth::AuthPolicy,
    command: BuildCommand,
    cancelled: Arc<AtomicBool>,
    repos: PathBuf,
}
pub(super) struct Reply {
    sender: mpsc::Sender<Result<BuildOutcome>>,
    #[cfg(test)]
    discard: bool,
}

impl Reply {
    pub(super) fn send(self, outcome: Result<BuildOutcome>) {
        #[cfg(test)]
        if self.discard {
            return;
        }
        let _ = self.sender.send(outcome);
    }
}

impl WriterOwner {
    pub fn build_graph_with_policy(&self, policy: auth::AuthPolicy) -> Result<BuildGraphClient> {
        auth::validate_policy(policy)?;
        Ok(BuildGraphClient {
            shared: self.client.shared.clone(),
            policy,
            repos: self
                .lease
                .as_ref()
                .expect("live owner")
                .data_dir()
                .join("repos"),
        })
    }
}
impl BuildGraphClient {
    pub fn execute(
        &self,
        credential: read_model::Credential,
        command: BuildCommand,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
    ) -> Result<BuildOutcome> {
        self.execute_with_reply(credential, command, cancelled, wait, false)
    }
    fn execute_with_reply(
        &self,
        credential: read_model::Credential,
        command: BuildCommand,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
        discard_reply: bool,
    ) -> Result<BuildOutcome> {
        #[cfg(not(test))]
        let _ = discard_reply;
        let deadline = Instant::now() + wait;
        let mut queue = self
            .shared
            .queue
            .lock()
            .map_err(|_| anyhow!(Failure::Stopped))?;
        loop {
            ensure!(!queue.closed, Failure::Stopped);
            ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
            if queue.pending.len() < self.shared.capacity {
                break;
            }
            ensure!(Instant::now() < deadline, Failure::QueueFull);
            queue = self
                .shared
                .changed
                .wait_timeout(queue, Duration::from_millis(5))
                .map_err(|_| anyhow!(Failure::Stopped))?
                .0;
        }
        let (reply, receiver) = mpsc::channel();
        queue.pending.push_back(Envelope::BuildGraph {
            command: Command {
                credential,
                policy: self.policy,
                command,
                cancelled,
                repos: self.repos.clone(),
            },
            reply: Reply {
                sender: reply,
                #[cfg(test)]
                discard: discard_reply,
            },
        });
        self.shared.changed.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|_| anyhow!(Failure::OutcomeUnknown))?
    }
}
fn credential_tenant(
    tx: &Transaction<'_>,
    credential: &read_model::Credential,
    policy: auth::AuthPolicy,
) -> Result<String> {
    match credential {
        read_model::Credential::Session(secret) => auth::read_session_tenant(tx, secret, policy),
        read_model::Credential::ApiKey {
            routed_tenant,
            secret,
        } => auth::read_key_tenant(tx, routed_tenant, secret),
    }
}

fn tenant(tx: &Transaction<'_>, command: &Command) -> Result<String> {
    credential_tenant(tx, &command.credential, command.policy)
}

fn build_exists(tx: &Transaction<'_>, tenant: &str, build: i64) -> Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM build_profiles WHERE tenant_id=?1 AND id=?2)",
        params![tenant, build],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn layers(tx: &Transaction<'_>, tenant: &str, build: i64) -> Result<Vec<ProfileLayer>> {
    let mut statement = tx.prepare(
        "SELECT layer.id,layer.layer_order,layer.layer_type,layer.project_id,source.name FROM profile_layers layer LEFT JOIN projects source ON source.tenant_id=layer.tenant_id AND source.id=layer.project_id WHERE layer.tenant_id=?1 AND layer.profile_id=?2 ORDER BY layer.layer_order,layer.id",
    )?;
    let rows = statement.query_map(params![tenant, build], |row| {
        Ok(ProfileLayer {
            id: row.get(0)?,
            layer_order: row.get(1)?,
            layer_type: row.get(2)?,
            project_id: row.get(3)?,
            project_name: row.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn summary(
    tx: &Transaction<'_>,
    tenant: &str,
    build: i64,
    repos: &std::path::Path,
) -> Result<Option<ProfileSummary>> {
    read_model::graph::build_summary(tx, tenant, build, repos)
}

fn read(
    tx: &Transaction<'_>,
    tenant: &str,
    command: &BuildCommand,
    repos: &std::path::Path,
) -> Result<BuildOutcome> {
    match command {
        BuildCommand::List => {
            let ids = {
                let mut statement = tx
                    .prepare("SELECT id FROM build_profiles WHERE tenant_id=?1 ORDER BY name,id")?;
                let rows = statement.query_map([tenant], |row| row.get::<_, i64>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            let profiles = ids
                .into_iter()
                .map(|build| {
                    summary(tx, tenant, build, repos)?
                        .ok_or_else(|| anyhow!("Listed Build missing"))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(BuildOutcome::Listed { profiles })
        }
        BuildCommand::Read { build } => {
            let Some(profile) = summary(tx, tenant, build.get() as i64, repos)? else {
                return Ok(BuildOutcome::MissingBuild);
            };
            Ok(BuildOutcome::Read { profile })
        }
        BuildCommand::ListLayers { build } => {
            let build = build.get() as i64;
            if !build_exists(tx, tenant, build)? {
                return Ok(BuildOutcome::MissingBuild);
            }
            Ok(BuildOutcome::Layers {
                profile_id: build,
                layers: layers(tx, tenant, build)?,
            })
        }
    }
}

pub(super) fn execute(connection: &mut Connection, command: Command) -> Result<BuildOutcome> {
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    let tx = connection.transaction()?;
    let tenant = tenant(&tx, &command)?;
    let outcome = read(&tx, &tenant, &command.command, &command.repos)?;
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    tx.commit()?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_reply_is_outcome_unknown() {
        let root = std::env::temp_dir().join(format!("pp-build-reply-{}", rand::random::<u64>()));
        let (owner, _) = WriterOwner::open(&root, crate::Limits::default()).unwrap();
        let client = owner
            .build_graph_with_policy(auth::AuthPolicy {
                registration: auth::RegistrationPolicy::Open,
                first_user: auth::FirstUserTenant::NewUser,
                session_tenant: auth::SessionTenantPolicy::AccountTenant,
            })
            .unwrap();
        let error = client
            .execute_with_reply(
                read_model::Credential::Session(auth::Secret::new("missing".into())),
                BuildCommand::List,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
                true,
            )
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref(),
            Some(Failure::OutcomeUnknown)
        ));
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
