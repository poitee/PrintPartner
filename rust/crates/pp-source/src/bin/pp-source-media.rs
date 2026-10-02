use pp_source::{
    ArtifactBudget, LocalFiles, Selection, SnapshotRequest, SourcePath, TenantRepos,
    archive::{ArchiveLimits, ZipInput},
    media::MediaLimits,
};
use serde::Deserialize;
use std::{
    io::{self, Read},
    path::Path,
    sync::atomic::AtomicBool,
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    tenant_id: String,
    source_id: u64,
    repos_dir: String,
    input_dir: String,
    revision_key: String,
    #[serde(default)]
    files: Vec<SourcePath>,
    #[serde(default)]
    zip_path: Option<SourcePath>,
    #[serde(default)]
    limits: MediaLimits,
    #[serde(default)]
    archive_limits: ArchiveLimits,
}
fn main() {
    if let Err(e) = run() {
        println!("{}", serde_json::json!({"error":e.to_string()}));
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin().take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err("command-limit".into());
    }
    let command: Command = serde_json::from_slice(&bytes)?;
    if command.zip_path.is_some() && !command.files.is_empty() {
        return Err("choose zipPath or files".into());
    }
    let tenant = TenantRepos::open(command.tenant_id, Path::new(&command.repos_dir))?;
    let mut source = tenant.source(command.source_id)?;
    let local = LocalFiles::open(Path::new(&command.input_dir))?;
    let cancelled = AtomicBool::new(false);
    let extracted = command
        .zip_path
        .as_ref()
        .map(|path| {
            source.extract_zip(
                ZipInput::open(&local, path)?,
                command.archive_limits,
                &cancelled,
            )
        })
        .transpose()?;
    let paths = extracted
        .as_ref()
        .map(|a| {
            a.receipt()
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or(command.files);
    let prepared = source.prepare_media(
        extracted.as_ref().map(|a| a.files()).unwrap_or(&local),
        &paths,
        extracted
            .as_ref()
            .map(|a| a.receipt().directories.as_slice())
            .unwrap_or(&[]),
        command.limits,
        &cancelled,
    )?;
    let snapshot = source.materialize(
        SnapshotRequest {
            upstream_revision_key: command.revision_key,
            files: prepared.receipt().selected_files.clone(),
            selection: Selection {
                max_stl_files: 10_000,
                max_documentation_bytes: command.limits.max_total_bytes,
                omitted_files: vec![],
            },
        },
        prepared.files(),
        ArtifactBudget::new(
            command.limits.max_total_bytes + 8 * 1024 * 1024,
            command.limits.max_total_bytes,
        )?,
    )?;
    let output = serde_json::json!({"media":prepared.receipt(),"extraction":extracted.as_ref().map(|a| a.receipt()),"snapshot":snapshot});
    prepared.discard()?;
    if let Some(archive) = extracted {
        archive.discard()?;
    }
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
