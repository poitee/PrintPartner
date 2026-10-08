pub mod manifest_options;
mod model;
pub(crate) mod projection;

pub use manifest_options::{ManifestOptionsCommand, ManifestOptionsOutcome};
pub use pp_contracts::build_identity::BuildName;
pub use model::{
    AcceptedProgress, AcceptedProgressUnavailable, PlanFreshness, PlanStaleReason,
    PlanUntrackedReason, ProfileLayer, ProfileSummary,
};

use crate::{Envelope, SettingsClient, Shared, WriterOwner, auth, read_model};
use anyhow::{Result, anyhow, ensure};
use pp_contracts::PositiveId;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
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
    Manifest(ManifestOptionsCommand),
    List,
    Read {
        build: PositiveId,
    },
    Create {
        name: BuildName,
        base_source: Option<PositiveId>,
    },
    Touch {
        build: PositiveId,
    },
    ListLayers {
        build: PositiveId,
    },
    SetBase {
        build: PositiveId,
        source: PositiveId,
    },
    AttachAddon {
        build: PositiveId,
        source: PositiveId,
    },
    ReplaceAttachment {
        build: PositiveId,
        layer: PositiveId,
        source: PositiveId,
    },
    Detach {
        build: PositiveId,
        layer: PositiveId,
    },
    Delete {
        build: PositiveId,
    },
}

#[derive(Debug)]
pub enum BuildOutcome {
    Manifest(ManifestOptionsOutcome),
    Listed {
        profiles: Vec<ProfileSummary>,
    },
    Read {
        profile: ProfileSummary,
    },
    Created {
        profile: ProfileSummary,
        layers: Vec<ProfileLayer>,
    },
    Touched {
        profile: ProfileSummary,
    },
    Layers {
        profile_id: i64,
        layers: Vec<ProfileLayer>,
    },
    Deleted,
    MissingBuild,
    InvalidBaseSource,
    MissingSource,
    MissingLayer,
    DuplicateName {
        name: String,
    },
    DuplicateAttachment {
        source_name: String,
    },
}

#[derive(Clone)]
pub struct BuildGraphClient {
    shared: Arc<Shared>,
    settings: SettingsClient,
    policy: auth::AuthPolicy,
    repos: PathBuf,
    manifest_reads: Option<Arc<dyn crate::working_drafts::observation::DraftReads>>,
    manifest_limits: crate::working_drafts::observation::PreparationLimits,
}

pub(super) struct Command {
    credential: read_model::Credential,
    policy: auth::AuthPolicy,
    command: BuildCommand,
    prepared_manifest: Option<Box<manifest_options::PreparedManifestCommand>>,
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
            settings: self.client.clone(),
            policy,
            repos: self
                .lease
                .as_ref()
                .expect("live owner")
                .data_dir()
                .join("repos"),
            manifest_reads: None,
            manifest_limits: crate::working_drafts::observation::PreparationLimits::default(),
        })
    }

    pub fn build_graph_with_observations(
        &self,
        policy: auth::AuthPolicy,
        reads: Arc<dyn crate::working_drafts::observation::DraftReads>,
        limits: crate::working_drafts::observation::PreparationLimits,
    ) -> Result<BuildGraphClient> {
        limits.validate()?;
        let mut client = self.build_graph_with_policy(policy)?;
        client.manifest_reads = Some(reads);
        client.manifest_limits = limits;
        Ok(client)
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
        if matches!(
            command,
            BuildCommand::Manifest(
                ManifestOptionsCommand::ReadBuilder { .. } | ManifestOptionsCommand::SaveKit { .. }
            )
        ) {
            return self.execute_observed_manifest(credential, command, cancelled, wait, false);
        }
        self.execute_with_reply(credential, command, None, cancelled, wait, false)
    }

    fn execute_observed_manifest(
        &self,
        credential: read_model::Credential,
        command: BuildCommand,
        cancelled: Arc<AtomicBool>,
        wait: Duration,
        discard_reply: bool,
    ) -> Result<BuildOutcome> {
        let BuildCommand::Manifest(manifest_command) = &command else {
            return Err(anyhow!("Manifest preparation command mismatch"));
        };
        let retries = usize::from(matches!(
            manifest_command,
            ManifestOptionsCommand::ReadBuilder { .. }
        ));
        for attempt in 0..=retries {
            ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);
            let capture = self.capture_manifest(&credential, manifest_command, wait)?;
            let Some(capture) = capture else {
                return Ok(BuildOutcome::Manifest(ManifestOptionsOutcome::MissingBuild));
            };
            let parsed_kit = match manifest_options::parse_save(manifest_command) {
                Ok(parsed) => parsed,
                Err(failure) => {
                    return Ok(BuildOutcome::Manifest(failure.into_outcome()));
                }
            };
            let observed = match manifest_options::observe(
                &capture,
                self.manifest_reads.as_deref(),
                self.manifest_limits,
                &cancelled,
            ) {
                Ok(observed) => observed,
                Err(crate::working_drafts::observation::ReadFailure::Cancelled) => {
                    return Err(Failure::Cancelled.into());
                }
                Err(error) => {
                    return Ok(BuildOutcome::Manifest(
                        ManifestOptionsOutcome::ObservationFailed {
                            detail: error.to_string(),
                        },
                    ));
                }
            };
            let rechecked = match manifest_options::observe(
                &capture,
                self.manifest_reads.as_deref(),
                self.manifest_limits,
                &cancelled,
            ) {
                Ok(observed) => observed,
                Err(crate::working_drafts::observation::ReadFailure::Cancelled) => {
                    return Err(Failure::Cancelled.into());
                }
                Err(error) => {
                    return Ok(BuildOutcome::Manifest(
                        ManifestOptionsOutcome::ObservationFailed {
                            detail: error.to_string(),
                        },
                    ));
                }
            };
            if !manifest_options::stamps_match(&observed, &rechecked) {
                if attempt < retries {
                    continue;
                }
                return Ok(BuildOutcome::Manifest(
                    ManifestOptionsOutcome::StaleObservation,
                ));
            }
            let prepared =
                match manifest_options::prepare(manifest_command, capture, observed, parsed_kit) {
                    Ok(prepared) => prepared,
                    Err(failure) => {
                        return Ok(BuildOutcome::Manifest(failure.into_outcome()));
                    }
                };
            let outcome = self.execute_with_reply(
                duplicate_credential(&credential),
                command.clone(),
                Some(prepared),
                cancelled.clone(),
                wait,
                discard_reply,
            )?;
            if attempt < retries
                && matches!(
                    outcome,
                    BuildOutcome::Manifest(ManifestOptionsOutcome::StaleObservation)
                )
            {
                continue;
            }
            return Ok(outcome);
        }
        Ok(BuildOutcome::Manifest(
            ManifestOptionsOutcome::StaleObservation,
        ))
    }

    fn capture_manifest(
        &self,
        credential: &read_model::Credential,
        command: &ManifestOptionsCommand,
        wait: Duration,
    ) -> Result<Option<manifest_options::CapturedManifestGraph>> {
        ensure!(
            !self
                .shared
                .queue
                .lock()
                .map_err(|_| anyhow!(Failure::Stopped))?
                .closed,
            Failure::Stopped
        );
        let mut checkout = self.settings.reader(wait)?;
        let tx = checkout
            .connection
            .as_mut()
            .expect("checked out connection")
            .transaction()?;
        let tenant = credential_tenant(&tx, credential, self.policy)?;
        let captured = manifest_options::capture(&tx, &tenant, command)?;
        tx.commit()?;
        Ok(captured)
    }

    fn execute_with_reply(
        &self,
        credential: read_model::Credential,
        command: BuildCommand,
        prepared_manifest: Option<manifest_options::PreparedManifestCommand>,
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
                prepared_manifest: prepared_manifest.map(Box::new),
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

    #[cfg(test)]
    fn execute_losing_reply(
        &self,
        credential: read_model::Credential,
        command: BuildCommand,
    ) -> Result<BuildOutcome> {
        if matches!(
            command,
            BuildCommand::Manifest(
                ManifestOptionsCommand::ReadBuilder { .. } | ManifestOptionsCommand::SaveKit { .. }
            )
        ) {
            return self.execute_observed_manifest(
                credential,
                command,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
                true,
            );
        }
        self.execute_with_reply(
            credential,
            command,
            None,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
            true,
        )
    }
}

fn duplicate_credential(credential: &read_model::Credential) -> read_model::Credential {
    match credential {
        read_model::Credential::Session(secret) => {
            read_model::Credential::Session(auth::Secret::new(secret.expose().to_owned()))
        }
        read_model::Credential::ApiKey {
            routed_tenant,
            secret,
        } => read_model::Credential::ApiKey {
            routed_tenant: routed_tenant.clone(),
            secret: auth::Secret::new(secret.expose().to_owned()),
        },
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

fn source_name(tx: &Transaction<'_>, tenant: &str, source: i64) -> Result<Option<String>> {
    tx.query_row(
        "SELECT name FROM projects WHERE tenant_id=?1 AND id=?2",
        params![tenant, source],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn duplicate_source(
    tx: &Transaction<'_>,
    tenant: &str,
    build: i64,
    source: i64,
    except_layer: Option<i64>,
) -> Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM profile_layers WHERE tenant_id=?1 AND profile_id=?2 AND project_id=?3 AND (?4 IS NULL OR id<>?4))",
        params![tenant, build, source, except_layer],
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

fn mark_modified(tx: &Transaction<'_>, tenant: &str, build: i64, now: &str) -> Result<()> {
    ensure!(
        tx.execute(
            "UPDATE build_profiles SET config_modified_at=?1 WHERE tenant_id=?2 AND id=?3",
            params![now, tenant, build],
        )? == 1,
        "Build freshness update failed"
    );
    Ok(())
}

fn mutation(
    tx: &Transaction<'_>,
    tenant: &str,
    command: &BuildCommand,
    prepared_manifest: Option<manifest_options::PreparedManifestCommand>,
    repos: &std::path::Path,
) -> Result<BuildOutcome> {
    match command {
        BuildCommand::Manifest(_) => Ok(BuildOutcome::Manifest(manifest_options::finish(
            tx,
            tenant,
            prepared_manifest.ok_or_else(|| anyhow!("Manifest preparation missing"))?,
            &auth::catalog_timestamp(),
        )?)),
        BuildCommand::Create { name, base_source } => {
            let duplicate: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM build_profiles WHERE tenant_id=?1 AND name=?2)",
                params![tenant, name.as_str()],
                |row| row.get(0),
            )?;
            if duplicate {
                return Ok(BuildOutcome::DuplicateName {
                    name: name.as_str().to_owned(),
                });
            }
            let source = if let Some(source) = base_source {
                let id = source.get() as i64;
                if source_name(tx, tenant, id)?.is_none() {
                    return Ok(BuildOutcome::InvalidBaseSource);
                }
                Some(id)
            } else {
                None
            };
            let now = auth::catalog_timestamp();
            tx.execute(
                "INSERT INTO build_profiles(tenant_id,name,config_modified_at,last_used_at) VALUES(?1,?2,?3,?3)",
                params![tenant, name.as_str(), now],
            )?;
            let build = tx.last_insert_rowid();
            if let Some(source) = source {
                tx.execute(
                    "INSERT INTO profile_layers(tenant_id,profile_id,layer_order,layer_type,project_id) VALUES(?1,?2,0,'base',?3)",
                    params![tenant, build, source],
                )?;
            }
            let profile = summary(tx, tenant, build, repos)?
                .ok_or_else(|| anyhow!("Created Build missing"))?;
            Ok(BuildOutcome::Created {
                profile,
                layers: layers(tx, tenant, build)?,
            })
        }
        BuildCommand::Touch { build } => {
            let build = build.get() as i64;
            let now = auth::catalog_timestamp();
            if tx.execute(
                "UPDATE build_profiles SET last_used_at=?1 WHERE tenant_id=?2 AND id=?3",
                params![now, tenant, build],
            )? == 0
            {
                return Ok(BuildOutcome::MissingBuild);
            }
            Ok(BuildOutcome::Touched {
                profile: summary(tx, tenant, build, repos)?
                    .ok_or_else(|| anyhow!("Touched Build missing"))?,
            })
        }
        BuildCommand::SetBase { build, source } => {
            let build = build.get() as i64;
            let source = source.get() as i64;
            if !build_exists(tx, tenant, build)? {
                return Ok(BuildOutcome::MissingBuild);
            }
            let Some(source_name) = source_name(tx, tenant, source)? else {
                return Ok(BuildOutcome::MissingSource);
            };
            let existing: Option<i64> = tx.query_row(
                "SELECT id FROM profile_layers WHERE tenant_id=?1 AND profile_id=?2 AND layer_type='base' ORDER BY id LIMIT 1",
                params![tenant, build],
                |row| row.get(0),
            ).optional()?;
            if duplicate_source(tx, tenant, build, source, existing)? {
                return Ok(BuildOutcome::DuplicateAttachment { source_name });
            }
            if let Some(layer) = existing {
                tx.execute(
                    "UPDATE profile_layers SET project_id=?1,layer_order=0 WHERE tenant_id=?2 AND profile_id=?3 AND id=?4",
                    params![source, tenant, build, layer],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO profile_layers(tenant_id,profile_id,layer_order,layer_type,project_id) VALUES(?1,?2,0,'base',?3)",
                    params![tenant, build, source],
                )?;
            }
            mark_modified(tx, tenant, build, &auth::catalog_timestamp())?;
            Ok(BuildOutcome::Layers {
                profile_id: build,
                layers: layers(tx, tenant, build)?,
            })
        }
        BuildCommand::AttachAddon { build, source } => {
            let build = build.get() as i64;
            let source = source.get() as i64;
            if !build_exists(tx, tenant, build)? {
                return Ok(BuildOutcome::MissingBuild);
            }
            let Some(source_name) = source_name(tx, tenant, source)? else {
                return Ok(BuildOutcome::MissingSource);
            };
            if duplicate_source(tx, tenant, build, source, None)? {
                return Ok(BuildOutcome::DuplicateAttachment { source_name });
            }
            let next: i64 = tx.query_row(
                "SELECT coalesce(max(layer_order),-1)+1 FROM profile_layers WHERE tenant_id=?1 AND profile_id=?2",
                params![tenant, build],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO profile_layers(tenant_id,profile_id,layer_order,layer_type,project_id) VALUES(?1,?2,?3,'addon',?4)",
                params![tenant, build, next, source],
            )?;
            mark_modified(tx, tenant, build, &auth::catalog_timestamp())?;
            Ok(BuildOutcome::Layers {
                profile_id: build,
                layers: layers(tx, tenant, build)?,
            })
        }
        BuildCommand::ReplaceAttachment {
            build,
            layer,
            source,
        } => {
            let build = build.get() as i64;
            let layer = layer.get() as i64;
            let source = source.get() as i64;
            if !build_exists(tx, tenant, build)? {
                return Ok(BuildOutcome::MissingBuild);
            }
            let member: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM profile_layers WHERE tenant_id=?1 AND profile_id=?2 AND id=?3)",
                params![tenant, build, layer],
                |row| row.get(0),
            )?;
            if !member {
                return Ok(BuildOutcome::MissingLayer);
            }
            let Some(source_name) = source_name(tx, tenant, source)? else {
                return Ok(BuildOutcome::MissingSource);
            };
            if duplicate_source(tx, tenant, build, source, Some(layer))? {
                return Ok(BuildOutcome::DuplicateAttachment { source_name });
            }
            ensure!(
                tx.execute(
                    "UPDATE profile_layers SET project_id=?1 WHERE tenant_id=?2 AND profile_id=?3 AND id=?4",
                    params![source, tenant, build, layer],
                )? == 1,
                "Build attachment changed concurrently"
            );
            mark_modified(tx, tenant, build, &auth::catalog_timestamp())?;
            Ok(BuildOutcome::Layers {
                profile_id: build,
                layers: layers(tx, tenant, build)?,
            })
        }
        BuildCommand::Detach { build, layer } => {
            let build = build.get() as i64;
            let layer = layer.get() as i64;
            if !build_exists(tx, tenant, build)? {
                return Ok(BuildOutcome::MissingBuild);
            }
            if tx.execute(
                "DELETE FROM profile_layers WHERE tenant_id=?1 AND profile_id=?2 AND id=?3",
                params![tenant, build, layer],
            )? == 0
            {
                return Ok(BuildOutcome::MissingLayer);
            }
            mark_modified(tx, tenant, build, &auth::catalog_timestamp())?;
            Ok(BuildOutcome::Deleted)
        }
        BuildCommand::Delete { build } => {
            let build = build.get() as i64;
            if !build_exists(tx, tenant, build)? {
                return Ok(BuildOutcome::MissingBuild);
            }
            tx.pragma_update(None, "defer_foreign_keys", "ON")?;
            tx.execute(
                "DELETE FROM app_settings WHERE tenant_id=?1 AND key IN (?2,?3)",
                params![
                    tenant,
                    format!("production_setup:{build}"),
                    format!("role_filaments_{build}")
                ],
            )?;
            ensure!(
                tx.execute(
                    "DELETE FROM build_profiles WHERE tenant_id=?1 AND id=?2",
                    params![tenant, build],
                )? == 1,
                "Build changed concurrently"
            );
            Ok(BuildOutcome::Deleted)
        }
        BuildCommand::List | BuildCommand::Read { .. } | BuildCommand::ListLayers { .. } => {
            unreachable!("read command in mutation transaction")
        }
    }
}

fn read(
    tx: &Transaction<'_>,
    tenant: &str,
    command: &BuildCommand,
    repos: &std::path::Path,
) -> Result<BuildOutcome> {
    match command {
        BuildCommand::Manifest(command) => Ok(BuildOutcome::Manifest(manifest_options::read(
            tx, tenant, command,
        )?)),
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
        _ => unreachable!("mutation command in read transaction"),
    }
}

pub(super) fn execute(connection: &mut Connection, mut command: Command) -> Result<BuildOutcome> {
    ensure!(
        !command.cancelled.load(Ordering::Acquire),
        Failure::Cancelled
    );
    let read_only = matches!(
        &command.command,
        BuildCommand::List | BuildCommand::Read { .. } | BuildCommand::ListLayers { .. }
    ) || matches!(&command.command, BuildCommand::Manifest(command) if manifest_options::is_read(command));
    let behavior = if read_only {
        TransactionBehavior::Deferred
    } else {
        TransactionBehavior::Immediate
    };
    let tx = connection.transaction_with_behavior(behavior)?;
    let tenant = tenant(&tx, &command)?;
    let outcome = if read_only {
        read(&tx, &tenant, &command.command, &command.repos)?
    } else {
        mutation(
            &tx,
            &tenant,
            &command.command,
            command.prepared_manifest.take().map(|prepared| *prepared),
            &command.repos,
        )?
    };
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
    use crate::{
        Limits,
        auth::{
            FirstUserTenant, Outcome as AuthOutcome, RegistrationPolicy, Request, Secret,
            SessionTenantPolicy,
        },
    };

    #[test]
    fn manifest_reply_loss_is_outcome_unknown() {
        let root = std::env::temp_dir().join(format!(
            "pp-build-reply-loss-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let client = owner
            .build_graph_with_policy(auth::AuthPolicy {
                registration: auth::RegistrationPolicy::Open,
                first_user: auth::FirstUserTenant::NewUser,
                session_tenant: auth::SessionTenantPolicy::AccountTenant,
            })
            .unwrap();
        let error = client
            .execute_losing_reply(
                read_model::Credential::Session(Secret::new("missing-session".into())),
                BuildCommand::Manifest(ManifestOptionsCommand::ReadKit {
                    build: PositiveId::new(1).unwrap(),
                }),
            )
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref(),
            Some(Failure::OutcomeUnknown)
        ));
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uncertain_manifest_save_is_recovered_by_reopen_without_retry() {
        let root = std::env::temp_dir().join(format!(
            "pp-build-uncertain-save-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let policy = auth::AuthPolicy {
            registration: RegistrationPolicy::Open,
            first_user: FirstUserTenant::NewUser,
            session_tenant: SessionTenantPolicy::AccountTenant,
        };
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let AuthOutcome::Session { token, .. } = owner
            .auth(FirstUserTenant::NewUser)
            .submit(
                Request::Register {
                    email: "uncertain-manifest@example.test".into(),
                    display_name: "Uncertain manifest".into(),
                    password: Secret::new("uncertain-manifest-password-123".into()),
                },
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
        else {
            panic!("session expected")
        };
        let token = token.expose().to_owned();
        let client = owner.build_graph_with_policy(policy).unwrap();
        let BuildOutcome::Created { profile, .. } = client
            .execute(
                read_model::Credential::Session(Secret::new(token.clone())),
                BuildCommand::Create {
                    name: BuildName::parse("Uncertain manifest".into()).unwrap(),
                    base_source: None,
                },
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
        else {
            panic!("build expected")
        };
        let build = PositiveId::new(profile.id as u64).unwrap();
        let error = client
            .execute_losing_reply(
                read_model::Credential::Session(Secret::new(token.clone())),
                BuildCommand::Manifest(ManifestOptionsCommand::SaveKit {
                    build,
                    request: br#"{"kit":{"name":"uncertain"}}"#.to_vec(),
                }),
            )
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref(),
            Some(Failure::OutcomeUnknown)
        ));
        owner.shutdown().unwrap();
        let (owner, _) = WriterOwner::open(&root, Limits::default()).unwrap();
        let client = owner.build_graph_with_policy(policy).unwrap();
        let BuildOutcome::Manifest(ManifestOptionsOutcome::Kit { kit, .. }) = client
            .execute(
                read_model::Credential::Session(Secret::new(token)),
                BuildCommand::Manifest(ManifestOptionsCommand::ReadKit { build }),
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(2),
            )
            .unwrap()
        else {
            panic!("kit expected")
        };
        assert_eq!(kit.name_scalar().as_deref(), Some("uncertain"));
        owner.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
