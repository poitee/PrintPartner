fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: export-rust-contracts --write|--check PATH".into());
    }
    let bytes = format!(
        "{}\n",
        serde_json::to_string_pretty(&pp_api_types::contracts::export())?
    );
    match args[1].as_str() {
        "--write" => std::fs::write(&args[2], bytes)?,
        "--check" => {
            if std::fs::read_to_string(&args[2])? != bytes {
                return Err("Rust contract schema drift".into());
            }
        }
        _ => return Err("Unsupported generation mode".into()),
    }
    Ok(())
}
