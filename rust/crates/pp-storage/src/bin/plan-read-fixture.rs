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
    let result = owner.accepted_reads()?.read(
        Credential::Session(Secret::new(secret)),
        &ids,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )?;
    let after: i64 = witness.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    ensure!(before == after, "Read operation changed database");
    #[cfg(not(feature = "desktop_rebuild"))]
    let mut output = serde_json::to_value(&result)?;
    #[cfg(feature = "desktop_rebuild")]
    let mut output = json!({"builds": result.builds.iter().map(|build| {
        let mut scalar = json!({"profileId": build.profile_id, "context": build.context});
        if let Some(error) = &build.context_error {
            scalar["contextError"] = json!(error);
        }
        scalar
    }).collect::<Vec<_>>()});
    #[cfg(feature = "desktop_rebuild")]
    let mut raw_builds = Vec::new();
    output["readOnly"] =
        json!({"dataVersionBefore":before,"dataVersionAfter":after,"unchanged":before==after});
    for (i, build) in result.builds.into_iter().enumerate() {
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
        #[cfg(feature = "desktop_rebuild")]
        let mut raw_fields = std::collections::BTreeMap::new();
        if let Some(obs) = &observations {
            #[cfg(feature = "desktop_rebuild")]
            {
                let review = views::review_json(&build.accepted, false, obs, &CatalogOnly)?;
                if let Some(summary) = review.summary_json() {
                    output["builds"][i]["reviewSummary"] =
                        serde_json::from_slice(&summary.into_bytes())?;
                }
                raw_fields.insert(
                    "review".to_string(),
                    serde_json::from_slice::<Box<serde_json::value::RawValue>>(
                        &review.into_bytes(),
                    )?,
                );
                raw_fields.insert(
                    "reviewAll".to_string(),
                    serde_json::from_slice::<Box<serde_json::value::RawValue>>(
                        &views::review_json(&build.accepted, true, obs, &CatalogOnly)?.into_bytes(),
                    )?,
                );
            }
            #[cfg(not(feature = "desktop_rebuild"))]
            {
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
        #[cfg(feature = "desktop_rebuild")]
        {
            raw_fields.insert(
                "accepted".to_string(),
                serde_json::from_slice::<Box<serde_json::value::RawValue>>(
                    &build.accepted.into_json_body()?.into_bytes(),
                )?,
            );
            for (key, value) in output["builds"][i].as_object().unwrap() {
                raw_fields.insert(key.clone(), serde_json::value::to_raw_value(value)?);
            }
            raw_builds.push(raw_fields);
        }
    }
    #[cfg(feature = "desktop_rebuild")]
    {
        let mut raw_output = std::collections::BTreeMap::new();
        raw_output.insert("builds", serde_json::value::to_raw_value(&raw_builds)?);
        raw_output.insert(
            "readOnly",
            serde_json::value::to_raw_value(&output["readOnly"])?,
        );
        println!("{}", serde_json::to_string(&raw_output)?);
    }
    #[cfg(not(feature = "desktop_rebuild"))]
    println!("{}", json!(output));
    owner.shutdown()?;
    Ok(())
}
