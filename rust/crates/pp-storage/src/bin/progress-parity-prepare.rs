use anyhow::{Result, ensure};
use pp_storage::{Limits, WriterOwner};
use std::path::Path;

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 2, "usage: progress-parity-prepare DIRECTORY");
    let (owner, ready) = WriterOwner::open(Path::new(&args[1]), Limits::default())?;
    owner.shutdown()?;
    println!(
        "{}",
        serde_json::json!({"schema": ready.version, "writer_opens": 1})
    );
    Ok(())
}
