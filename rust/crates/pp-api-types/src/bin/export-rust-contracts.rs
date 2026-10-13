fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: export-rust-contracts --write|--check PATH".into());
    }
    match args[1].as_str() {
        "--write" => std::fs::write(&args[2], pp_api_types::contracts::schema_bytes()?)?,
        "--check" => pp_api_types::contracts::check_schema_file(std::path::Path::new(&args[2]))?,
        _ => return Err("Unsupported generation mode".into()),
    }
    Ok(())
}
