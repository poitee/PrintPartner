use crate::{Envelope, SettingsClient, WriterOwner, auth::AuthPolicy, catalog, jobs};
use anyhow::{Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[cfg(test)]
mod tests;

const COLUMNS: &str = include_str!("remote_sources/columns38.sql");

type Install = fn(&Connection) -> Result<()>;

pub(crate) const SCHEMA_STEPS: [(u64, Install); 2] =
    [(38, install_imports), (39, install_preclaim)];

fn install_imports(connection: &Connection) -> Result<()> {
    for (table, column, definition) in added_columns()? {
        crate::schema::add_column(
            connection,
            table,
            column,
            &format!("ALTER TABLE {table} ADD COLUMN {definition}"),
        )?;
    }
    connection.execute_batch(include_str!("uploads/schema.sql"))?;
    Ok(connection.execute_batch(include_str!("remote_sources/schema.sql"))?)
}

fn install_preclaim(connection: &Connection) -> Result<()> {
    Ok(connection.execute_batch(include_str!("remote_sources/preclaim39.sql"))?)
}

type Object = (String, String, Option<String>);

fn objects(connection: &Connection) -> Result<Vec<Object>> {
    Ok(connection
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

fn expected(version: u64) -> Result<Connection> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(
        "CREATE TABLE projects(id INTEGER PRIMARY KEY);
         CREATE TABLE source_revisions(id INTEGER PRIMARY KEY);
         CREATE TABLE source_docs(id INTEGER PRIMARY KEY);",
    )?;
    for (step, install) in SCHEMA_STEPS {
        if step <= version {
            install(&expected)?;
        }
    }
    Ok(expected)
}

pub(crate) fn owned_objects() -> Result<BTreeSet<String>> {
    let stubs: BTreeSet<String> = objects(&expected(0)?)?
        .into_iter()
        .map(|(_, name, _)| name)
        .collect();
    Ok(objects(&expected(u64::MAX)?)?
        .into_iter()
        .map(|(_, name, _)| name)
        .filter(|name| !stubs.contains(name))
        .collect())
}

pub(crate) fn added_columns() -> Result<Vec<(&'static str, &'static str, &'static str)>> {
    COLUMNS
        .lines()
        .map(|statement| {
            let words: Vec<&str> = statement.split_whitespace().collect();
            let definition = statement
                .split_once(" ADD COLUMN ")
                .map(|(_, definition)| definition.trim_end_matches(';'));
            match (words.get(2), words.get(5), definition) {
                (Some(table), Some(column), Some(definition)) => Ok((*table, *column, definition)),
                _ => Err(anyhow!("Invalid Source column migration")),
            }
        })
        .collect()
}

pub(crate) fn validate_schema(connection: &Connection, version: u64) -> Result<()> {
    let owned = owned_objects()?;
    let actual: Vec<Object> = objects(connection)?
        .into_iter()
        .filter(|(_, name, _)| owned.contains(name))
        .collect();
    let expected: Vec<Object> = objects(&expected(version)?)?
        .into_iter()
        .filter(|(_, name, _)| owned.contains(name))
        .collect();
    ensure!(actual == expected, "Source import schema mismatch");
    if version < SCHEMA_STEPS[0].0 {
        return Ok(());
    }
    for (table, column, definition) in added_columns()? {
        ensure!(
            column_definition(connection, table, column)? == definition,
            "Source revision column schema mismatch: {table}.{column}"
        );
    }
    for (check, message) in [
        (
            "SELECT EXISTS(SELECT 1 FROM source_import_quota q LEFT JOIN source_import_operations o USING(tenant,operation_key) WHERE o.tenant IS NULL)",
            "Orphan Source quota",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_import_operations WHERE json_extract(document,'$.tenant') IS NOT tenant OR json_extract(document,'$.key') IS NOT operation_key OR json_extract(document,'$.actor') IS NOT actor OR json_extract(document,'$.intent_digest') IS NOT intent_digest OR json_extract(document,'$.source_id') IS NOT source_id OR json_extract(document,'$.job_id') IS NOT job_id OR json_extract(document,'$.state') IS NOT state)",
            "Corrupt Source import journal",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_import_operations o LEFT JOIN source_import_quota q USING(tenant,operation_key) WHERE q.settled IS NOT json_extract(o.document,'$.cleanup_settled') OR q.reserved_bytes IS NOT CASE WHEN q.settled THEN 0 ELSE json_extract(o.document,'$.reserved_bytes') END OR q.retained_bytes IS NOT CASE WHEN q.settled THEN coalesce(json_extract(o.document,'$.artifact.stored_bytes'),0) ELSE 0 END)",
            "Corrupt Source quota journal",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_docs WHERE NOT ((source_revision_id IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_revision_id IS NOT NULL AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL)))",
            "Partial Source document provenance",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_revisions WHERE NOT ((source_configuration_version IS NULL AND activation_observation_digest IS NULL AND input_digest IS NULL AND producer_version IS NULL) OR (source_configuration_version IS NOT NULL AND activation_observation_digest IS NOT NULL AND length(activation_observation_digest) = 64 AND input_digest IS NOT NULL AND length(input_digest) = 64 AND producer_version IS NOT NULL)))",
            "Partial Source revision provenance",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_revision_observations WHERE attempt_generation <= 0 OR cancel_requested NOT IN (0,1) OR receipt_activated NOT IN (0,1) OR (receipt_activated IS NOT NULL AND revision_id IS NULL))",
            "Invalid Source observation context",
        ),
    ] {
        let failed: bool = connection.query_row(check, [], |row| row.get(0))?;
        ensure!(!failed, "{message}");
    }
    validate_journal(connection)?;
    if version < SCHEMA_STEPS[1].0 {
        return Ok(());
    }
    for (check, message) in [
        (
            "SELECT EXISTS(SELECT 1 FROM source_preclaim_refusals WHERE cursor<=0 OR phase!='authority_refused' OR admitted_generation!=0 OR cancel_requested NOT IN (0,1))",
            "Invalid Source preclaim refusal",
        ),
        (
            "SELECT EXISTS(SELECT 1 FROM source_preclaim_refusals p JOIN source_revision_observations o USING(tenant_id,operation_key,cursor))",
            "Source observation cursor collision",
        ),
    ] {
        let failed: bool = connection.query_row(check, [], |row| row.get(0))?;
        ensure!(!failed, "{message}");
    }
    Ok(())
}

fn column_definition(connection: &Connection, table: &str, column: &str) -> Result<String> {
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    let body = &sql[sql
        .find('(')
        .ok_or_else(|| anyhow!("Missing table definition"))?
        + 1..];
    let mut depth = 0;
    let mut literal = false;
    let mut start = 0;
    for (index, character) in body.char_indices() {
        if character == '\'' {
            literal = !literal;
        }
        if literal {
            continue;
        }
        if character == '(' {
            depth += 1;
        } else if (character == ',' || character == ')') && depth == 0 {
            let definition = body[start..index].trim();
            if definition.split_whitespace().next() == Some(column) {
                return Ok(definition.to_owned());
            }
            start = index + 1;
        } else if character == ')' {
            depth -= 1;
        }
    }
    Err(anyhow!("Missing Source column definition {table}.{column}"))
}

fn validate_journal(connection: &Connection) -> Result<()> {
    let documents = connection
        .prepare("SELECT document FROM source_import_operations")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for document in documents {
        let op: Operation = serde_json::from_str(&document)?;
        validate_operation(&op)?;
        let payload = jobs::Payload::SuppliedSourceImport {
            project_id: u64::try_from(op.source_id)?,
            operation_key: op.key.clone(),
            input_version: op.input_version,
        };
        let job = connection
            .query_row(
                "SELECT document FROM durable_jobs WHERE id=?1 UNION ALL SELECT archived_document FROM durable_job_keys WHERE job_id=?1 AND archived_document IS NOT NULL LIMIT 1",
                [&op.job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|job| jobs::decode(&job))
            .transpose()?;
        ensure!(
            job.as_ref().is_some_and(|job| job.payload_version == 1
                && job.job_id == op.job_id
                && job.tenant == op.tenant
                && job.payload == payload),
            "Import job binding mismatch"
        );
        ensure!(
            !op.cleanup_settled || job.is_some_and(|job| job.state.terminal()),
            "Import completion job mismatch"
        );
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Existing {
        source_id: i64,
    },
    Create {
        metadata: Box<catalog::CreateSource>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Files { paths: Vec<String> },
    Zip { path: String },
}

impl Input {
    fn requested_paths(&self) -> Vec<&str> {
        match self {
            Self::Files { paths } => paths.iter().map(String::as_str).collect(),
            Self::Zip { path } => vec![path],
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub key: String,
    pub target: Target,
    pub input: Input,
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Basis {
    pub current_source_revision_id: Option<i64>,
    pub url: String,
    pub branch: String,
    pub tag: Option<String>,
    pub source_kind: String,
    pub source_type: String,
    pub local_path: Option<String>,
    pub last_commit_sha: Option<String>,
    pub legacy_manifest_cutover: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Admitted,
    OwnedInputReady,
    Published,
    Activated,
    Conflict,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OwnedInput {
    pub locator: String,
    pub digest: String,
    pub files: Vec<File>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub tenant: String,
    pub source_id: i64,
    pub upstream_key: String,
    pub manifest_digest: String,
    pub locator: String,
    pub stored_bytes: u64,
    pub files: Vec<File>,
    pub suggested_rules: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceAuthorityRevision {
    pub version: u8,
    pub source_configuration_version: i64,
    pub activation_observation_digest: String,
    pub input_digest: String,
    pub producer_version: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Postprocessing {
    NotActivated,
    DocumentMetadataIndexed,
    DocumentMetadataIndexedPdfPending,
    IndexError,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub tenant: String,
    pub operation_key: String,
    pub job_id: String,
    pub source_id: i64,
    pub revision_id: i64,
    pub artifact: Artifact,
    pub basis: Basis,
    pub activated: bool,
    pub applied_at: String,
    pub postprocessing: Postprocessing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_revision: Option<SourceAuthorityRevision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub tenant: String,
    pub actor: String,
    pub key: String,
    pub intent_digest: String,
    pub source_id: i64,
    pub job_id: String,
    pub input_version: u32,
    pub input: Input,
    pub requested_files: Vec<File>,
    pub requested_digest: String,
    pub state: State,
    pub basis: Basis,
    pub default_rules: bool,
    pub original_rules: Option<String>,
    pub reserved_bytes: u64,
    pub max_input_bytes: u64,
    pub max_prepared_bytes: u64,
    pub owned: Option<OwnedInput>,
    pub artifact: Option<Artifact>,
    pub receipt: Option<Receipt>,
    pub cleanup_settled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_revision: Option<SourceAuthorityRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_cursor: Option<i64>,
}

pub(crate) enum Command {
    Admit(Admit),
    Get {
        credential: jobs::Credential,
        policy: AuthPolicy,
        storage: Arc<crate::Shared>,
        key: String,
    },
}

pub(crate) struct Admit {
    credential: jobs::Credential,
    policy: AuthPolicy,
    storage: Arc<crate::Shared>,
    request: Admission,
    expected_files: Vec<File>,
    disk_bytes: u64,
    accounting_epoch: u64,
    quota: u64,
}

impl Command {
    pub(crate) fn changes_accounting(&self) -> bool {
        !matches!(self, Self::Get { .. })
    }
}

#[derive(Clone)]
pub struct ImportClient {
    storage: SettingsClient,
    policy: AuthPolicy,
    quota: u64,
}

impl WriterOwner {
    /// Opens the upload journal with the owner's import quota in bytes. Every
    /// client of one owner must name the same quota.
    pub fn imports(&self, policy: AuthPolicy, quota: u64) -> Result<ImportClient> {
        ensure!(
            quota > 0 && quota <= 64 * 1024 * 1024 * 1024,
            "Invalid desktop quota"
        );
        crate::auth::validate_policy(policy)?;
        let mut configured = self
            .client
            .shared
            .import_quota
            .lock()
            .map_err(|_| anyhow!("Import quota poisoned"))?;
        ensure!(
            configured.is_none_or(|configured| configured == quota),
            "Import quota already configured"
        );
        *configured = Some(quota);
        Ok(ImportClient {
            storage: self.client(),
            policy,
            quota,
        })
    }
}

impl ImportClient {
    /// Read before measuring `disk_bytes`; admission refuses a measurement
    /// taken across another journal write.
    pub fn accounting_epoch(&self) -> u64 {
        self.storage.shared.import_epoch.load(Ordering::Acquire)
    }

    pub fn admit(
        &self,
        credential: jobs::Credential,
        request: Admission,
        expected_files: Vec<File>,
        disk_bytes: u64,
        accounting_epoch: u64,
        cancelled: &AtomicBool,
    ) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Admit(Admit {
                credential,
                policy: self.policy,
                storage: self.storage.shared.clone(),
                request,
                expected_files,
                disk_bytes,
                accounting_epoch,
                quota: self.quota,
            }),
            cancelled,
        )
    }

    pub fn get(&self, credential: jobs::Credential, key: String) -> Result<Operation> {
        submit(
            &self.storage,
            Command::Get {
                credential,
                policy: self.policy,
                storage: self.storage.shared.clone(),
                key,
            },
            &AtomicBool::new(false),
        )
    }
}

fn submit(storage: &SettingsClient, command: Command, cancelled: &AtomicBool) -> Result<Operation> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut queue = storage
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
        if queue.pending.len() < storage.shared.capacity {
            let (reply, receiver) = mpsc::channel();
            queue
                .pending
                .push_back(Envelope::Uploads { command, reply });
            storage.shared.changed.notify_all();
            drop(queue);
            return receiver
                .recv()
                .map_err(|_| anyhow!("Import commit outcome unknown"))?;
        }
        ensure!(Instant::now() < deadline, "Writer queue full");
        queue = storage
            .shared
            .changed
            .wait_timeout(queue, Duration::from_millis(5))
            .map_err(|_| anyhow!("Writer admission poisoned"))?
            .0;
    }
}

pub(crate) fn execute(
    connection: &mut Connection,
    catalog_state: &catalog::State,
    command: Command,
    admission: crate::writer_admission::Deadline,
) -> Result<Operation> {
    let tx = crate::writer_admission::begin_immediate(connection, admission)?;
    let operation = match command {
        Command::Get {
            credential,
            policy,
            storage,
            key,
        } => {
            let (tenant, actor) = jobs::actor(&tx, credential, policy, &storage)?;
            let op = load(&tx, &tenant, &key)?.ok_or_else(|| anyhow!("Import not found"))?;
            ensure!(op.actor == actor, "Import belongs to another actor");
            op
        }
        Command::Admit(command) => admit(&tx, catalog_state, command)?,
    };
    tx.commit()?;
    Ok(operation)
}

fn admit(
    tx: &Transaction<'_>,
    catalog_state: &catalog::State,
    command: Admit,
) -> Result<Operation> {
    let Admit {
        credential,
        policy,
        storage,
        mut request,
        expected_files,
        disk_bytes,
        accounting_epoch,
        quota,
    } = command;
    ensure!(
        storage.import_epoch.load(Ordering::Acquire) == accounting_epoch,
        "Import accounting changed; retry admission"
    );
    let (tenant, actor, authority) =
        crate::auth::authority::admit(tx, credential, policy, &storage)?;
    ensure!(
        !request.key.is_empty()
            && request.key.len() <= 128
            && !request.key.chars().any(char::is_control),
        "Invalid operation key"
    );
    files(&expected_files, request.max_input_bytes)?;
    let requested_digest = serialized_digest(&expected_files)?;
    let intent_digest = serialized_digest(&(&request, &expected_files))?;
    if let Some(prior) = load(tx, &tenant, &request.key)? {
        ensure!(
            prior.actor == actor && prior.intent_digest == intent_digest,
            "Import idempotency conflict"
        );
        return Ok(prior);
    }
    match &mut request.target {
        Target::Existing { source_id } => {
            catalog::validate_capture_existing(tx, &tenant, *source_id)?
        }
        Target::Create { metadata } => catalog::validate_capture_create(tx, &tenant, metadata)?,
    }
    validate_limits(&request, quota)?;
    let pending: i64 = tx.query_row(
        "SELECT COALESCE(SUM(reserved_bytes),0) FROM source_import_quota WHERE settled=0",
        [],
        |row| row.get(0),
    )?;
    ensure!(
        disk_bytes
            .checked_add(u64::try_from(pending)?)
            .and_then(|total| total.checked_add(request.reserved_bytes))
            .is_some_and(|total| total <= quota),
        "Owner import quota exceeded"
    );
    let source_id = match request.target {
        Target::Existing { source_id } => source_id,
        Target::Create { metadata } => match catalog::run(
            tx,
            catalog_state,
            &tenant,
            catalog::Request::CreateCatalogSource { source: *metadata },
        )? {
            catalog::Outcome::Source(Some(source)) => source.id,
            _ => return Err(anyhow!("Supplied Source was not created")),
        },
    };
    let basis = basis(tx, &tenant, source_id)?;
    let (source_configuration_version, original_rules): (i64, Option<String>) = tx.query_row(
        "SELECT source_configuration_version,imported_paths FROM projects WHERE tenant_id=?1 AND id=?2",
        params![tenant, source_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    ensure!(
        source_configuration_version > 0,
        "Invalid Source configuration version"
    );
    let authority_revision = SourceAuthorityRevision {
        version: 1,
        source_configuration_version,
        activation_observation_digest: serialized_digest(&basis)?,
        input_digest: requested_digest.clone(),
        producer_version: PRODUCER.into(),
    };
    let jobs::Outcome::Job(job, _) = jobs::user(
        tx,
        &tenant,
        &actor,
        authority,
        jobs::UserOperation::Enqueue {
            key: format!(
                "source-import:{}",
                hex::encode(Sha256::digest(request.key.as_bytes()))
            ),
            payload_version: 1,
            payload: jobs::Payload::SuppliedSourceImport {
                project_id: source_id.try_into()?,
                operation_key: request.key.clone(),
                input_version: 1,
            },
        },
    )?
    else {
        return Err(anyhow!("Supplied import was not enqueued"));
    };
    let op = Operation {
        tenant,
        actor,
        key: request.key,
        intent_digest,
        source_id,
        job_id: job.job_id,
        input_version: 1,
        input: request.input,
        requested_files: expected_files,
        requested_digest,
        state: State::Admitted,
        basis,
        default_rules: original_rules.is_none(),
        original_rules,
        reserved_bytes: request.reserved_bytes,
        max_input_bytes: request.max_input_bytes,
        max_prepared_bytes: request.max_prepared_bytes,
        owned: None,
        artifact: None,
        receipt: None,
        cleanup_settled: false,
        authority_revision: Some(authority_revision),
        observation_cursor: Some(0),
    };
    validate_operation(&op)?;
    tx.execute(
        "INSERT INTO source_import_operations(tenant,operation_key,actor,intent_digest,source_id,job_id,state,document_version,document) VALUES(?1,?2,?3,?4,?5,?6,'admitted',1,?7)",
        params![op.tenant, op.key, op.actor, op.intent_digest, op.source_id, op.job_id, serde_json::to_string(&op)?],
    )?;
    tx.execute(
        "INSERT INTO source_import_quota VALUES(?1,?2,?3,0,0)",
        params![op.tenant, op.key, i64::try_from(op.reserved_bytes)?],
    )?;
    Ok(op)
}

const PRODUCER: &str = "supplied-source-import-v1";

fn validate_limits(request: &Admission, quota: u64) -> Result<()> {
    ensure!(
        (1..=256 * 1024 * 1024).contains(&request.max_input_bytes)
            && (1..=1024 * 1024 * 1024).contains(&request.max_prepared_bytes),
        "Invalid import limits"
    );
    let minimum = request
        .max_input_bytes
        .checked_add(3 * request.max_prepared_bytes)
        .and_then(|minimum| minimum.checked_add(16 * 1024 * 1024))
        .ok_or_else(|| anyhow!("Quota overflow"))?;
    ensure!(
        (minimum..=quota).contains(&request.reserved_bytes),
        "Import quota exceeded"
    );
    Ok(())
}

fn serialized_digest(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn load(tx: &Transaction<'_>, tenant: &str, key: &str) -> Result<Option<Operation>> {
    tx.query_row(
        "SELECT document FROM source_import_operations WHERE tenant=?1 AND operation_key=?2",
        params![tenant, key],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .map(|document| {
        let op: Operation = serde_json::from_str(&document)?;
        validate_operation(&op)?;
        Ok(op)
    })
    .transpose()
}

fn basis(tx: &Transaction<'_>, tenant: &str, id: i64) -> Result<Basis> {
    Ok(tx.query_row(
        "SELECT current_source_revision_id,url,branch,tag,source_kind,source_type,local_path,last_commit_sha,legacy_manifest_cutover FROM projects WHERE tenant_id=?1 AND id=?2",
        params![tenant, id],
        |row| {
            Ok(Basis {
                current_source_revision_id: row.get(0)?,
                url: row.get(1)?,
                branch: row.get(2)?,
                tag: row.get(3)?,
                source_kind: row.get(4)?,
                source_type: row.get(5)?,
                local_path: row.get(6)?,
                last_commit_sha: row.get(7)?,
                legacy_manifest_cutover: row.get(8)?,
            })
        },
    )?)
}

fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "Invalid digest"
    );
    Ok(())
}

fn path(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 4096
            && !value.contains(['\\', ':', '\0'])
            && !value.starts_with('/')
            && value
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "Invalid relative path"
    );
    Ok(())
}

fn files(files: &[File], max: u64) -> Result<()> {
    ensure!(!files.is_empty() && files.len() <= 10000, "Invalid files");
    let mut names = HashSet::new();
    let mut total = 0u64;
    for file in files {
        path(&file.path)?;
        digest(&file.sha256)?;
        ensure!(names.insert(&file.path), "Duplicate file");
        total = total
            .checked_add(file.size)
            .ok_or_else(|| anyhow!("Input size overflow"))?;
    }
    ensure!(total <= max, "Input limit");
    Ok(())
}

fn validate_operation(op: &Operation) -> Result<()> {
    ensure!(
        op.source_id > 0 && !op.key.is_empty() && op.key.len() <= 128 && !op.actor.is_empty(),
        "Invalid import identity"
    );
    digest(&op.job_id)?;
    digest(&op.intent_digest)?;
    digest(&op.requested_digest)?;
    if let Some(revision) = &op.authority_revision {
        ensure!(
            revision.version == 1
                && revision.source_configuration_version > 0
                && revision.producer_version == PRODUCER
                && revision.input_digest == op.requested_digest
                && revision.activation_observation_digest == serialized_digest(&op.basis)?,
            "Invalid Source authority revision"
        );
        ensure!(
            op.observation_cursor.is_some_and(|cursor| cursor >= 0),
            "Invalid U10 cursor"
        );
    } else {
        ensure!(
            op.observation_cursor.is_none(),
            "Legacy Source cursor without authority revision"
        );
    }
    files(&op.requested_files, op.max_input_bytes)?;
    ensure!(
        serialized_digest(&op.requested_files)? == op.requested_digest,
        "Input digest mismatch"
    );
    ensure!(op.input_version == 1, "Invalid import input version");
    ensure!(
        op.input.requested_paths()
            == op
                .requested_files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>()
            && op.requested_files.iter().all(|file| file.kind == "input"),
        "Input binding mismatch"
    );
    if let Some(owned) = &op.owned {
        ensure!(
            owned.locator == format!(".pp-imports/{}", op.job_id)
                && owned.digest == op.requested_digest
                && owned.files == op.requested_files,
            "Owned input binding mismatch"
        );
    }
    if let Some(artifact) = &op.artifact {
        digest(&artifact.upstream_key)?;
        digest(&artifact.manifest_digest)?;
        files(&artifact.files, op.max_prepared_bytes)?;
        ensure!(
            artifact.tenant == op.tenant
                && artifact.source_id == op.source_id
                && artifact.locator
                    == format!("{}/revisions/{}", op.source_id, artifact.upstream_key)
                && artifact.stored_bytes <= op.reserved_bytes
                && artifact.files.iter().all(|file| {
                    ["stl", "artifact", "readme", "md", "pdf"].contains(&file.kind.as_str())
                }),
            "Artifact binding mismatch"
        );
    }
    if let Some(receipt) = &op.receipt {
        ensure!(
            receipt.tenant == op.tenant
                && receipt.source_id == op.source_id
                && receipt.operation_key == op.key
                && receipt.job_id == op.job_id
                && receipt.revision_id > 0
                && receipt.basis == op.basis
                && Some(&receipt.artifact) == op.artifact.as_ref()
                && receipt.activated == (op.state == State::Activated),
            "Receipt binding mismatch"
        );
        ensure!(
            receipt.authority_revision == op.authority_revision,
            "Receipt authority revision mismatch"
        );
        let pdf = receipt.artifact.files.iter().any(|file| file.kind == "pdf");
        ensure!(
            match receipt.postprocessing {
                Postprocessing::NotActivated => !receipt.activated && op.state == State::Conflict,
                Postprocessing::DocumentMetadataIndexed => receipt.activated && !pdf,
                Postprocessing::DocumentMetadataIndexedPdfPending => receipt.activated && pdf,
                Postprocessing::IndexError => receipt.activated,
            },
            "Receipt postprocessing mismatch"
        );
    }
    let (owned, artifact, receipt) = (
        op.owned.is_some(),
        op.artifact.is_some(),
        op.receipt.is_some(),
    );
    ensure!(
        match op.state {
            State::Admitted => !owned && !artifact && !receipt,
            State::OwnedInputReady => owned && !artifact && !receipt,
            State::Published => owned && artifact && !receipt,
            State::Activated | State::Conflict => owned && artifact && receipt,
            State::Failed | State::Cancelled => !receipt,
        },
        "Invalid import state"
    );
    ensure!(
        !op.cleanup_settled
            || matches!(
                op.state,
                State::Activated | State::Conflict | State::Failed | State::Cancelled
            ),
        "Unsettled import cleanup"
    );
    Ok(())
}
