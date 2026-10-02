use pp_source::{
    ArtifactBudget, FileKind, LocalFiles, SelectedFile, Selection, SnapshotRequest, SourcePath,
    TenantRepos,
    archive::{ArchiveLimits, ZipInput},
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
    zip_path: SourcePath,
    revision_key: String,
    #[serde(default)]
    limits: ArchiveLimits,
}
fn main() {
    if let Err(error) = run() {
        println!("{}", serde_json::json!({"error":error.to_string()}));
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
    let tenant = TenantRepos::open(command.tenant_id, Path::new(&command.repos_dir))?;
    let mut source = tenant.source(command.source_id)?;
    let local = LocalFiles::open(Path::new(&command.input_dir))?;
    let archive = source.extract_zip(
        ZipInput::open(&local, &command.zip_path)?,
        command.limits,
        &AtomicBool::new(false),
    )?;
    let request = SnapshotRequest {
        upstream_revision_key: command.revision_key,
        files: archive
            .receipt()
            .files
            .iter()
            .map(|file| SelectedFile {
                path: file.path.clone(),
                kind: if file.path.as_str().to_ascii_lowercase().ends_with(".stl") {
                    FileKind::Stl
                } else {
                    FileKind::Artifact
                },
                size_hint_bytes: Some(file.size_bytes),
            })
            .collect(),
        selection: Selection {
            max_stl_files: command.limits.max_entries as u64,
            max_documentation_bytes: command.limits.max_inflated_bytes,
            omitted_files: vec![],
        },
    };
    let snapshot = source.materialize(
        request,
        archive.files(),
        ArtifactBudget::new(
            command.limits.max_inflated_bytes + 8 * 1024 * 1024,
            command.limits.max_inflated_bytes,
        )?,
    )?;
    let output = serde_json::json!({"extraction":archive.receipt(),"snapshot":snapshot});
    archive.discard()?;
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
