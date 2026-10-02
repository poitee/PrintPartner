use anyhow::{Context, Result, bail};
use pp_core::{CoreRuntime, DesktopLaunch, VerifiedBundle};
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut data = None;
    let mut web = None;
    let mut node = None;
    let mut commit = None;
    let mut credential_file = None;
    while let Some(arg) = args.next() {
        let value = args.next().context("Argument value missing")?;
        match arg.as_str() {
            "--data" => data = Some(PathBuf::from(value)),
            "--web" => web = Some(PathBuf::from(value)),
            "--node" => node = Some(PathBuf::from(value)),
            "--commit" => commit = Some(value),
            "--test-credential-file" => credential_file = Some(PathBuf::from(value)),
            _ => bail!("Unknown argument"),
        }
    }
    let web = web.context("--web is required")?.canonicalize()?;
    let package: serde_json::Value =
        serde_json::from_slice(&std::fs::read(web.join("package.json"))?)?;
    let version = package["version"]
        .as_str()
        .context("Package version missing")?;
    let bundle = VerifiedBundle {
        node: node.context("--node is required")?.canonicalize()?,
        entry: web.join("apps/server/dist/current/desktop.js"),
        web_root: web.clone(),
        runtime_version: format!("{version}-web"),
        commit: commit.context("--commit is required")?,
    };
    let mut runtime = CoreRuntime::start(DesktopLaunch {
        data_dir: data.context("--data is required")?,
        assets: web.join("apps/web/dist"),
        bundle,
    })
    .await?;
    if let Some(path) = credential_file {
        let url = runtime.take_launch_target()?.into_url();
        let result = (|| -> Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(
                serde_json::json!({"bootstrap_url":url})
                    .to_string()
                    .as_bytes(),
            )?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let receipt = runtime.shutdown().await;
            anyhow::ensure!(receipt.complete(), "Desktop shutdown incomplete");
            return Err(error);
        }
    }
    println!("{}", runtime.origin());
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = terminate.recv()=>{}}
    let receipt = runtime.shutdown().await;
    anyhow::ensure!(receipt.complete(), "Desktop shutdown incomplete");
    Ok(())
}
