use anyhow::{Result, ensure};
use pp_source::{LocalFiles, SourcePath, local_selection};
use pp_storage::{
    WriterOwner,
    auth::AuthPolicy,
    jobs::Credential,
    uploads::{Admission, File, ImportClient, Input, Operation},
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

/// Synchronous admission and lookup for supplied Source imports. It reads the
/// supplied directory but never runs the import.
pub struct SourceImports {
    client: ImportClient,
    repos: PathBuf,
}

impl SourceImports {
    pub fn new(owner: &WriterOwner, policy: AuthPolicy, quota: u64) -> Result<Self> {
        Ok(Self {
            client: owner.imports(policy, quota)?,
            repos: owner.import_repos_root()?,
        })
    }

    /// Admits `request` once per key, hashing its named files from `supplied`.
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
        let requested = match &request.input {
            Input::Files { paths } => paths.clone(),
            Input::Zip { path } => vec![path.clone()],
        };
        let paths = requested
            .into_iter()
            .map(SourcePath::try_from)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let expected_files = LocalFiles::open(supplied)?
            .inventory(&paths, request.max_input_bytes)?
            .into_iter()
            .map(|file| File {
                path: file.path.as_str().into(),
                size: file.size,
                sha256: file.sha256,
                kind: "input".into(),
            })
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

    pub fn get(&self, credential: Credential, key: String) -> Result<Operation> {
        self.client.get(credential, key)
    }

    /// Names every regular file below `supplied`.
    pub fn directory_input(supplied: &Path) -> Result<Input> {
        Ok(Input::Files {
            paths: LocalFiles::open(supplied)?
                .paths()?
                .into_iter()
                .map(String::from)
                .collect(),
        })
    }
}
