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
    let output = json!({"readOnly":{"dataVersionBefore":before,"dataVersionAfter":after,"unchanged":before==after}});
    let mut build_rows = Vec::new();
    let mut accepted_bodies = Vec::new();
    let mut review_bodies = Vec::new();
    for build in &result.builds {
        let mut row = json!({"profileId":build.profile_id,"context":build.context});
        if let Some(error) = &build.context_error {
            row["contextError"] = json!(error);
        }
        row["checkoff"] = views::checkoff(build.profile_id, &build.accepted, &CatalogOnly)?;
        row["progress"] = views::progress(build.profile_id, &build.accepted);
        let ids = if let AcceptedRead::Ready { snapshot } = &build.accepted {
            snapshot
                .parts
                .iter()
                .map(|p| p.projection_part_id)
                .collect()
        } else {
            Vec::new()
        };
        row["assembled"] = Value::Array(
            ids.into_iter()
                .map(|id| views::assembled(id, &build.accepted))
                .collect(),
        );
        build_rows.push(row);
        accepted_bodies.push(build.accepted.clone().into_json_body());
        if let Some(obs) = &observations {
            let review = views::review_json(&build.accepted, false, obs, &CatalogOnly)?;
            let review_all = views::review_json(&build.accepted, true, obs, &CatalogOnly)?;
            review_bodies.push(Some((
                review.summary_json(),
                review_all.summary_json(),
                review.into_bytes(),
                review_all.into_bytes(),
            )));
        } else {
            review_bodies.push(None);
        }
    }
    let mut bytes = serde_json::to_vec(&output)?;
    bytes.pop();
    if bytes.len() > 1 {
        bytes.push(b',');
    }
    bytes.extend_from_slice(b"\"builds\":[");
    for (index, ((build, accepted), reviews)) in build_rows
        .iter()
        .zip(accepted_bodies)
        .zip(review_bodies)
        .enumerate()
    {
        if index > 0 {
            bytes.push(b',');
        }
        let mut row = b"{\"accepted\":".to_vec();
        row.extend_from_slice(&accepted.into_bytes());
        let ordinary = serde_json::to_vec(build)?;
        if ordinary.len() > 2 {
            row.push(b',');
            row.extend_from_slice(&ordinary[1..]);
        } else {
            row.push(b'}');
        }
        if let Some((summary, summary_all, review, review_all)) = reviews {
            row.pop();
            row.extend_from_slice(b",\"review\":");
            row.extend_from_slice(&review);
            row.extend_from_slice(b",\"reviewAll\":");
            row.extend_from_slice(&review_all);
            if let Some(summary) = summary {
                row.extend_from_slice(b",\"reviewSummary\":");
                row.extend_from_slice(&summary.into_bytes());
            }
            if let Some(summary) = summary_all {
                row.extend_from_slice(b",\"reviewSummaryAll\":");
                row.extend_from_slice(&summary.into_bytes());
            }
            row.push(b'}');
        }
        bytes.extend_from_slice(&row);
    }
    bytes.extend_from_slice(b"]}");
    println!("{}", std::str::from_utf8(&bytes)?);
    owner.shutdown()?;
    Ok(())
}
