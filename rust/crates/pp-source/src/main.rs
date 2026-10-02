use pp_source::{ArtifactBudget, LocalFiles, MAX_CONTENT_BYTES, SnapshotRequest, TenantRepos};
use serde::Deserialize;
use std::{
    io::{self, Read},
    path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    tenant_id: String,
    source_id: u64,
    repos_dir: String,
    input_dir: String,
    reserved_stored_bytes: u64,
    #[serde(default = "content_limit")]
    max_content_bytes: u64,
    snapshot: SnapshotRequest,
}
fn content_limit() -> u64 {
    MAX_CONTENT_BYTES
}
fn main() {
    let result = run();
    if let Err(error) = result {
        println!("{}", serde_json::json!({"error": error.to_string()}));
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("command-limit".into());
    }
    let command: Command = serde_json::from_slice(&bytes)?;
    let tenant = TenantRepos::open(command.tenant_id, Path::new(&command.repos_dir))?;
    let mut source = tenant.source(command.source_id)?;
    let input = LocalFiles::open(Path::new(&command.input_dir))?;
    let budget = ArtifactBudget::new(command.reserved_stored_bytes, command.max_content_bytes)?;
    let receipt = source.materialize(command.snapshot, &input, budget)?;
    println!("{}", serde_json::to_string(&receipt)?);
    Ok(())
}
