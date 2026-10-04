use anyhow::{Result, anyhow, ensure};
use pp_source::{
    ArtifactBudget, LocalFiles, Selection, SnapshotRequest, SourcePath, TenantRepos,
    archive::{ArchiveLabelPolicy, ArchiveLimits, ZipInput},
    local_selection::{self, InputFile},
    media::MediaLimits,
};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::{Credential, JobKind, ServerWorkerClient, WorkerAdmission},
    uploads::{
        Admission, Artifact, File, ImportClient, Input, Operation, OwnedInput, Phase,
        RecordedArchiveLabels, State, ZipInputRef,
    },
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

pub struct SourceImports {
    client: ImportClient,
    worker: ServerWorkerClient,
    repos: PathBuf,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Through {
    OwnedInput,
    Published,
    Activated,
    Settled,
}
impl SourceImports {
    pub fn new(owner: &WriterOwner, policy: AuthPolicy, quota: u64) -> Result<Self> {
        Ok(Self {
            client: owner.imports(policy, quota)?,
            worker: owner.job_worker(WorkerAdmission {
                kinds: vec![(JobKind::SuppliedSourceImport, 1)],
                total: 1,
                per_resource: 1,
                lease_seconds: 3600,
            })?,
            repos: owner.import_repos_root()?,
        })
    }
    pub fn admit(
        &self,
        credential: Credential,
        request: Admission,
        supplied: &Path,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        ensure!(
            request.max_input_bytes > 0 && request.max_input_bytes <= 256 * 1024 * 1024,
            "Invalid import input limit"
        );
        let local = LocalFiles::open(supplied)?;
        let paths = request
            .input
            .requested_paths()
            .into_iter()
            .map(str::to_owned)
            .map(SourcePath::try_from)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let expected_files = local
            .inventory(&paths, request.max_input_bytes)?
            .into_iter()
            .map(input_file)
            .collect();
        let accounting_epoch = self.client.accounting_epoch();
        let disk = local_selection::stored_bytes(&self.repos)?;
        self.client.admit(
            credential,
            request,
            expected_files,
            disk,
            accounting_epoch,
            cancelled,
        )
    }
    pub fn import(
        &self,
        credential: Credential,
        request: Admission,
        supplied: &Path,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        let op = self.admit(credential, request, supplied, cancelled)?;
        if op.cleanup_settled {
            self.verify_artifact(&op)?;
            return Ok(op);
        }
        self.work_operation(&op.job_id, Some(supplied), Through::Settled, cancelled)?
            .ok_or_else(|| anyhow!("Import is already running"))
    }
    pub fn directory_input(supplied: &Path) -> Result<Input> {
        Ok(Input::Files {
            paths: LocalFiles::open(supplied)?
                .paths()?
                .into_iter()
                .map(|p| p.as_str().to_owned())
                .collect(),
        })
    }
    pub fn get(&self, credential: Credential, key: String) -> Result<Operation> {
        let op = self.client.get(credential, key)?;
        self.verify_artifact(&op)?;
        Ok(op)
    }
    fn verify_artifact(&self, op: &Operation) -> Result<()> {
        if let Some(artifact) = &op.artifact {
            let root = TenantRepos::open(op.tenant.clone(), &self.repos)?
                .source(op.source_id.try_into()?)?;
            let verified = root.verify_published(&artifact.upstream_key)?;
            ensure!(
                verified.stored_bytes == artifact.stored_bytes
                    && verified.manifest_digest == artifact.manifest_digest
                    && verified.snapshot_locator == artifact.locator
                    && verified
                        .files
                        .iter()
                        .map(|f| (
                            f.path.as_str().to_string(),
                            f.size_bytes,
                            f.sha256.clone(),
                            serde_json::to_value(&f.kind).unwrap()
                        ))
                        .collect::<Vec<_>>()
                        == artifact
                            .files
                            .iter()
                            .map(|f| (
                                f.path.clone(),
                                f.size,
                                f.sha256.clone(),
                                serde_json::Value::String(f.kind.clone())
                            ))
                            .collect::<Vec<_>>(),
                "Accepted artifact requires repair"
            );
        }
        Ok(())
    }
    fn cleanup(&self, op: &Operation) -> Result<()> {
        TenantRepos::open(op.tenant.clone(), &self.repos)?
            .source(op.source_id.try_into()?)?
            .discard_staging()?;
        local_selection::discard_owned(&self.repos, &op.job_id)?;
        Ok(())
    }
    pub fn work_next(&self, through: Through, cancelled: &AtomicBool) -> Result<Option<Operation>> {
        self.work(None, None, through, cancelled)
    }
    pub fn work_operation(
        &self,
        job_id: &str,
        supplied: Option<&Path>,
        through: Through,
        cancelled: &AtomicBool,
    ) -> Result<Option<Operation>> {
        self.work(Some(job_id), supplied, through, cancelled)
    }
    fn work(
        &self,
        job_id: Option<&str>,
        supplied: Option<&Path>,
        through: Through,
        cancelled: &AtomicBool,
    ) -> Result<Option<Operation>> {
        let claim = match job_id {
            Some(id) => self.worker.claim_import(id)?,
            None => self.worker.claim()?,
        };
        let Some((job, lease)) = claim else {
            return Ok(None);
        };
        let live =
            self.worker
                .begin_source_work(&lease, None, cancelled, Duration::from_secs(5))?;
        let mut op = self.worker.import_phase(&lease, Phase::Read)?;
        let result = (|| -> Result<Operation> {
            if job.cancel_requested && op.receipt.is_none() {
                op = self.worker.import_phase(&lease, Phase::Fail)?;
                self.cleanup(&op)?;
                return self.worker.import_phase(&lease, Phase::Cleanup);
            }
            if op.state == State::Admitted {
                let supplied =
                    supplied.ok_or_else(|| anyhow!("Import requires explicitly supplied input"))?;
                let paths = op
                    .input
                    .requested_paths()
                    .into_iter()
                    .map(str::to_owned)
                    .map(SourcePath::try_from)
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                local_selection::discard_owned(&self.repos, &op.job_id)?;
                let local = LocalFiles::open(supplied)?;
                let (_owned, inventory) = local.capture(
                    &paths,
                    &self.repos,
                    &op.job_id,
                    op.max_input_bytes,
                    cancelled,
                )?;
                let files = inventory.into_iter().map(input_file).collect::<Vec<_>>();
                let digest = hex::encode(Sha256::digest(serde_json::to_vec(&files)?));
                op = self.worker.import_phase(
                    &lease,
                    Phase::Owned(OwnedInput {
                        locator: format!(".pp-imports/{}", op.job_id),
                        digest,
                        files,
                    }),
                )?;
            }
            if through == Through::OwnedInput {
                return Ok(op.clone());
            }
            if op.state == State::OwnedInputReady {
                let owned = op
                    .owned
                    .as_ref()
                    .ok_or_else(|| anyhow!("Owned input missing"))?;
                let local = LocalFiles::open(&self.repos.join(&owned.locator))?;
                let paths = owned
                    .files
                    .iter()
                    .map(|f| SourcePath::try_from(f.path.clone()))
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                let inventory = local
                    .inventory(&paths, op.max_input_bytes)?
                    .into_iter()
                    .map(input_file)
                    .collect::<Vec<_>>();
                ensure!(
                    inventory == owned.files
                        && hex::encode(Sha256::digest(serde_json::to_vec(&inventory)?))
                            == owned.digest,
                    "Owned input requires repair"
                );
                let mut root = TenantRepos::open(op.tenant.clone(), &self.repos)?
                    .source(op.source_id.try_into()?)?;
                let archive = match op.input.zip_input() {
                    None => None,
                    Some(ZipInputRef {
                        path,
                        labels: RecordedArchiveLabels::LegacyStrict,
                    }) => Some(root.extract_zip(
                        ZipInput::open(&local, &SourcePath::try_from(path.to_owned())?)?,
                        ArchiveLimits {
                            max_compressed_bytes: op.max_input_bytes,
                            max_inflated_bytes: op.max_prepared_bytes,
                            max_entries: 10000,
                        },
                        cancelled,
                    )?),
                    Some(ZipInputRef {
                        path,
                        labels: RecordedArchiveLabels::CapturedNfcAtAcquisition,
                    }) => Some(root.extract_zip_with_label_policy(
                        ZipInput::open(&local, &SourcePath::try_from(path.to_owned())?)?,
                        ArchiveLimits {
                            max_compressed_bytes: op.max_input_bytes,
                            max_inflated_bytes: op.max_prepared_bytes,
                            max_entries: 10000,
                        },
                        ArchiveLabelPolicy::NfcAtAcquisition,
                        cancelled,
                    )?),
                };
                let input = archive.as_ref().map_or(&local, |a| a.files());
                let prepared = root.prepare_media(
                    input,
                    &input.paths()?,
                    archive
                        .as_ref()
                        .map_or(&[], |a| a.receipt().directories.as_slice()),
                    MediaLimits {
                        max_total_bytes: op.max_prepared_bytes,
                        max_output_bytes: op.max_prepared_bytes.min(256 * 1024 * 1024),
                        ..Default::default()
                    },
                    cancelled,
                )?;
                let (key, files) = prepared.files().local_snapshot_selection()?;
                let snapshot = root.materialize(
                    SnapshotRequest {
                        upstream_revision_key: key,
                        files,
                        selection: Selection {
                            max_stl_files: 500,
                            max_documentation_bytes: 1024 * 1024 * 1024,
                            omitted_files: vec![],
                        },
                    },
                    prepared.files(),
                    ArtifactBudget::new(op.reserved_bytes, op.max_prepared_bytes)?,
                )?;
                let artifact = Artifact {
                    tenant: snapshot.tenant_id,
                    source_id: snapshot.source_id.try_into()?,
                    upstream_key: snapshot.upstream_revision_key,
                    manifest_digest: snapshot.manifest_digest,
                    locator: snapshot.snapshot_locator,
                    stored_bytes: snapshot.stored_bytes,
                    files: snapshot
                        .files
                        .into_iter()
                        .map(|f| {
                            Ok(File {
                                path: f.path.as_str().into(),
                                size: f.size_bytes,
                                sha256: f.sha256,
                                kind: serde_json::to_value(f.kind)?.as_str().unwrap().into(),
                            })
                        })
                        .collect::<Result<_>>()?,
                    suggested_rules: prepared.receipt().suggested_import_rules.clone(),
                };
                op = self
                    .worker
                    .import_phase(&lease, Phase::Published(artifact))?;
                prepared.discard()?;
                if let Some(archive) = archive {
                    archive.discard()?;
                }
            }
            if through == Through::Published {
                return Ok(op.clone());
            }
            if op.state == State::Published {
                self.verify_artifact(&op)?;
                op = self.worker.import_phase(&lease, Phase::Activate)?;
            }
            if through == Through::Activated {
                return Ok(op.clone());
            }
            self.cleanup(&op)?;
            op = self.worker.import_phase(&lease, Phase::Cleanup)?;
            Ok(op.clone())
        })();
        if result.is_err()
            && op.receipt.is_none()
            && self.worker.import_phase(&lease, Phase::Fail).is_ok()
            && self.cleanup(&op).is_ok()
        {
            let _ = self.worker.import_phase(&lease, Phase::Cleanup);
        }
        drop(live);
        result.map(Some)
    }
}
fn input_file(f: InputFile) -> File {
    File {
        path: f.path.as_str().into(),
        size: f.size,
        sha256: f.sha256,
        kind: "input".into(),
    }
}
