use anyhow::{Result, ensure};
use pp_storage::{
    Limits, WriterOwner,
    auth::Secret,
    read_model::{
        AcceptedRead, Credential,
        views::{self, CatalogOnly, ReviewObservations},
        workflow,
    },
};
use serde_json::{Value, json};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() >= 3,
        "usage: plan-read-fixture DIRECTORY PROFILE_ID... | --workflow FILE | --collation FILE"
    );
    if args[1] == "--workflow" {
        let facts: Vec<workflow::Facts> = serde_json::from_slice(&std::fs::read(&args[2])?)?;
        println!(
            "{}",
            serde_json::to_string(
                &facts
                    .iter()
                    .map(workflow::resolve)
                    .collect::<Result<Vec<_>>>()?
            )?
        );
        return Ok(());
    }
    if args[1] == "--collation" {
        let mut folders: Vec<String> = serde_json::from_slice(&std::fs::read(&args[2])?)?;
        folders.sort_by(|a, b| views::folder_compare(a, b));
        println!("{}", serde_json::to_string(&folders)?);
        return Ok(());
    }
    let secret = std::env::var("PP_READ_SESSION")?;
    let observations: Option<ReviewObservations> = std::env::var("PP_REVIEW_OBSERVATIONS")
        .ok()
        .map(|p| Ok::<_, anyhow::Error>(serde_json::from_slice(&std::fs::read(p)?)?))
        .transpose()?;
    let (owner, _) = WriterOwner::open(Path::new(&args[1]), Limits::default())?;
    let ids = args[2..]
        .iter()
        .map(|s| s.parse())
        .collect::<std::result::Result<Vec<i64>, _>>()?;
    let witness = rusqlite::Connection::open(Path::new(&args[1]).join("print-partner.db"))?;
    let before: i64 = witness.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    let result = owner.accepted_reads().read(
        Credential::Session(Secret::new(secret)),
        &ids,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )?;
    let after: i64 = witness.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    ensure!(before == after, "Read operation changed database");
    let mut output = serde_json::to_value(&result)?;
    output["readOnly"] =
        json!({"dataVersionBefore":before,"dataVersionAfter":after,"unchanged":before==after});
    for (i, build) in result.builds.iter().enumerate() {
        output["builds"][i]["checkoff"] =
            views::checkoff(build.profile_id, &build.accepted, &CatalogOnly)?;
        output["builds"][i]["progress"] = views::progress(build.profile_id, &build.accepted);
        let ids = if let AcceptedRead::Ready { snapshot } = &build.accepted {
            snapshot
                .parts
                .iter()
                .map(|p| p.projection_part_id)
                .collect()
        } else {
            Vec::new()
        };
        output["builds"][i]["assembled"] = Value::Array(
            ids.into_iter()
                .map(|id| views::assembled(id, &build.accepted))
                .collect(),
        );
        if let Some(obs) = &observations {
            output["builds"][i]["review"] =
                views::review(&build.accepted, false, obs, &CatalogOnly)?;
            output["builds"][i]["reviewAll"] =
                views::review(&build.accepted, true, obs, &CatalogOnly)?;
            if output["builds"][i]["review"]["body"].is_object() {
                output["builds"][i]["reviewSummary"] =
                    views::summarize_review(&output["builds"][i]["review"]["body"])?;
            }
        }
    }
    println!("{}", json!(output));
    owner.shutdown()?;
    Ok(())
}
