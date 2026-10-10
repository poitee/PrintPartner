use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Sources {
    Empty,
    Ready {
        #[serde(rename = "attachedCount")]
        attached_count: u64,
    },
    Stale {
        #[serde(rename = "attachedCount")]
        attached_count: u64,
        #[serde(rename = "issueCount")]
        issue_count: u64,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Accepted {
    None,
    Ready {
        #[serde(rename = "revisionId")]
        revision_id: i64,
        #[serde(rename = "planVersion")]
        plan_version: i64,
        #[serde(rename = "totalUnits")]
        total_units: u64,
        #[serde(rename = "remainingUnits")]
        remaining_units: u64,
    },
    Unavailable {
        reason: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Working {
    None,
    Ready {
        #[serde(rename = "draftId")]
        draft_id: i64,
        #[serde(rename = "changeCount")]
        change_count: u64,
    },
    NeedsAttention {
        #[serde(rename = "draftId")]
        draft_id: i64,
        #[serde(rename = "changeCount")]
        change_count: u64,
        #[serde(rename = "issueCount")]
        issue_count: u64,
    },
    Stale {
        #[serde(rename = "draftId")]
        draft_id: i64,
        #[serde(rename = "changeCount")]
        change_count: u64,
        #[serde(rename = "issueCount")]
        issue_count: u64,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlateState {
    NotStarted,
    Preparing,
    Ready,
    Stale,
    Error,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Production {
    pub plate_state: PlateState,
    pub queued_jobs: u64,
    pub sending_jobs: u64,
    pub printing_jobs: u64,
    pub failed_jobs: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkoff {
    pub awaiting_verification: u64,
    pub failed_verifications: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Build {
    pub id: i64,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub build: Build,
    pub sources: Sources,
    pub accepted_plan: Accepted,
    pub working_plan: Working,
    pub production: Production,
    pub checkoff: Checkoff,
}
fn plural(n: u64, s: &str) -> String {
    if n == 1 { s.into() } else { format!("{s}s") }
}
fn status(kind: &str, summary: impl Into<String>) -> Value {
    json!({"kind":kind,"summary":summary.into()})
}
fn counted(kind: &str, summary: impl Into<String>, key: &str, n: u64) -> Value {
    let mut v = status(kind, summary);
    v[key] = json!(n);
    v
}
fn source_status(s: &Sources) -> Value {
    match s {
        Sources::Empty => status("not_started", "No Sources attached."),
        Sources::Ready { attached_count: n } => status(
            "complete",
            format!("{n} {} attached.", plural(*n, "Source")),
        ),
        Sources::Stale { issue_count, .. } => counted(
            "stale",
            "Sources have changed since this Plan was accepted.",
            "task_count",
            *issue_count,
        ),
    }
}
fn plan_status(f: &Facts) -> Value {
    if let Accepted::Unavailable { reason } = &f.accepted_plan {
        return counted("error", reason, "task_count", 1);
    }
    match &f.working_plan {
        Working::Ready {
            change_count: n, ..
        } => status(
            "ready",
            format!("Working Plan has {n} {} to review.", plural(*n, "change")),
        ),
        Working::NeedsAttention { issue_count: n, .. } => counted(
            "needs_attention",
            format!("{n} Plan {} to finish before saving.", plural(*n, "choice")),
            "task_count",
            *n,
        ),
        Working::Stale { issue_count, .. } => counted(
            "stale",
            "Open Plan to refresh its saved changes.",
            "task_count",
            *issue_count,
        ),
        Working::None => match &f.accepted_plan {
            Accepted::Ready { plan_version, .. } => {
                status("complete", format!("Plan revision {plan_version} saved."))
            }
            _ => {
                if matches!(f.sources, Sources::Ready { .. }) {
                    status("ready", "Ready to choose parts in Plan.")
                } else {
                    status("not_started", "Add Sources before choosing parts in Plan.")
                }
            }
        },
    }
}
fn production_status(f: &Facts) -> Value {
    let remaining = match &f.accepted_plan {
        Accepted::Unavailable { .. } => {
            return counted(
                "error",
                "Production cannot read the saved Plan.",
                "task_count",
                1,
            );
        }
        Accepted::None => {
            return status(
                "not_started",
                "Publish a Plan to create Production's required units.",
            );
        }
        Accepted::Ready {
            remaining_units, ..
        } => *remaining_units,
    };
    let p = &f.production;
    if p.failed_jobs > 0 {
        return counted(
            "needs_attention",
            format!(
                "{} printer {} need attention.",
                p.failed_jobs,
                plural(p.failed_jobs, "job")
            ),
            "task_count",
            p.failed_jobs,
        );
    }
    let active = p.queued_jobs + p.sending_jobs + p.printing_jobs;
    if active > 0 {
        return counted(
            "in_progress",
            format!("{active} Production {} active.", plural(active, "job")),
            "active_count",
            active,
        );
    }
    if remaining == 0 {
        return status("complete", "All required units have completed Production.");
    }
    match p.plate_state {
        PlateState::Error => counted("error", "Production preparation failed.", "task_count", 1),
        PlateState::Stale => counted(
            "stale",
            "Prepared plates do not match the saved Plan.",
            "task_count",
            1,
        ),
        PlateState::Preparing => counted(
            "in_progress",
            "Production plates are being prepared.",
            "active_count",
            1,
        ),
        PlateState::Ready => status("ready", "Production plates are ready."),
        PlateState::NotStarted => status(
            "ready",
            format!(
                "{remaining} required {} ready for Production.",
                plural(remaining, "unit")
            ),
        ),
    }
}
fn checkoff_status(f: &Facts) -> Value {
    let (total, remaining) = match &f.accepted_plan {
        Accepted::Unavailable { .. } => {
            return counted(
                "error",
                "Checkoff cannot read the saved Plan.",
                "task_count",
                1,
            );
        }
        Accepted::None => {
            return status(
                "not_started",
                "Publish a Plan to define the units Checkoff will verify.",
            );
        }
        Accepted::Ready {
            total_units,
            remaining_units,
            ..
        } => (*total_units, *remaining_units),
    };
    let c = &f.checkoff;
    let p = &f.production;
    if c.failed_verifications > 0 {
        let n = c.failed_verifications;
        return counted(
            "needs_attention",
            format!("{n} failed print {} need review.", plural(n, "result")),
            "task_count",
            n,
        );
    }
    if c.awaiting_verification > 0 {
        let n = c.awaiting_verification;
        return counted(
            "needs_attention",
            format!("{n} print {} await verification.", plural(n, "result")),
            "task_count",
            n,
        );
    }
    if p.printing_jobs > 0 {
        let n = p.printing_jobs;
        return counted(
            "in_progress",
            format!("{n} print {} in progress.", plural(n, "job")),
            "active_count",
            n,
        );
    }
    if remaining == 0 {
        return status("complete", "Every required unit is checked off.");
    }
    if remaining < total {
        let done = total - remaining;
        return counted(
            "in_progress",
            format!("{done} of {total} required units checked off."),
            "active_count",
            done,
        );
    }
    status("not_started", "Waiting for print results.")
}
fn action(kind: &str, stage: &str, label: impl Into<String>, reason: impl Into<String>) -> Value {
    json!({"kind":kind,"stage_id":stage,"label":label.into(),"reason":reason.into()})
}
fn item_action(kind: &str, stage: &str, label: &str, reason: String, count: u64) -> Value {
    let mut a = action(kind, stage, label, reason);
    a["item_count"] = json!(count);
    a
}
fn next(f: &Facts) -> Value {
    let c = &f.checkoff;
    let p = &f.production;
    if c.failed_verifications > 0 {
        let n = c.failed_verifications;
        return item_action(
            "review_failed_prints",
            "checkoff",
            "Review failed print results",
            format!("{n} failed print {} need review.", plural(n, "result")),
            n,
        );
    }
    if p.failed_jobs > 0 {
        let n = p.failed_jobs;
        return item_action(
            "recover_printer_jobs",
            "production",
            "Recover printer jobs",
            format!("{n} printer {} failed.", plural(n, "job")),
            n,
        );
    }
    if c.awaiting_verification > 0 {
        let n = c.awaiting_verification;
        return item_action(
            "verify_prints",
            "checkoff",
            "Verify print results",
            format!(
                "{n} print {} {} waiting for verification.",
                plural(n, "result"),
                if n == 1 { "is" } else { "are" }
            ),
            n,
        );
    }
    let monitored = p.sending_jobs + p.printing_jobs;
    if monitored > 0 {
        return item_action(
            "monitor_production",
            "production",
            "Monitor Production",
            format!(
                "{monitored} Production {} {} active.",
                plural(monitored, "job"),
                if monitored == 1 { "is" } else { "are" }
            ),
            monitored,
        );
    }
    if p.queued_jobs > 0 {
        let n = p.queued_jobs;
        return item_action(
            "review_production_queue",
            "production",
            "Review Production queue",
            format!(
                "{n} printer {} {} queued.",
                plural(n, "job"),
                if n == 1 { "is" } else { "are" }
            ),
            n,
        );
    }
    if let Accepted::Unavailable { reason } = &f.accepted_plan {
        return action("review_plan_status", "plan", "Review Plan status", reason);
    }
    if matches!(f.sources, Sources::Empty) {
        return action(
            "attach_sources",
            "sources",
            "Attach Sources",
            "This Build has no Sources yet.",
        );
    }
    match &f.working_plan {
        Working::NeedsAttention {
            draft_id,
            issue_count,
            ..
        } => {
            let mut a = action(
                "resolve_plan_issues",
                "plan",
                format!(
                    "Review {issue_count} Plan {}",
                    plural(*issue_count, "choice")
                ),
                "Complete these choices so the Plan can save for Production.",
            );
            a["draft_id"] = json!(draft_id);
            a["issue_count"] = json!(issue_count);
            return a;
        }
        Working::Stale { draft_id, .. } => {
            let mut a = action(
                "refresh_working_plan",
                "plan",
                "Refresh Plan",
                "Open Plan to refresh changes against the current saved revision.",
            );
            a["draft_id"] = json!(draft_id);
            return a;
        }
        Working::Ready { draft_id, .. } => {
            let mut a = action(
                "accept_working_plan",
                "plan",
                "Review Plan changes",
                "Open Plan to review changes. Valid changes save automatically for Production and Checkoff.",
            );
            a["draft_id"] = json!(draft_id);
            return a;
        }
        Working::None => {}
    }
    if matches!(f.accepted_plan, Accepted::None) {
        if let Sources::Stale { issue_count, .. } = f.sources {
            let mut a = action(
                "review_source_changes",
                "sources",
                "Review Source changes",
                "Sources have changed. Open Sources to review the files for this Build.",
            );
            a["issue_count"] = json!(issue_count);
            return a;
        }
        return action(
            "create_working_plan",
            "plan",
            "Open Plan",
            "Sources are ready. Open Plan to choose files, quantities, and colors. Changes save automatically.",
        );
    }
    if let Accepted::Ready {
        remaining_units, ..
    } = f.accepted_plan
        && remaining_units > 0
    {
        let mut a = action(
            "prepare_production",
            "production",
            "Prepare Production",
            format!(
                "{remaining_units} required {} remain in the Accepted Plan.",
                plural(remaining_units, "unit")
            ),
        );
        a["unit_count"] = json!(remaining_units);
        return a;
    }
    action(
        "view_completed_build",
        "checkoff",
        "View completed Build",
        "Every required unit in the saved Plan is checked off.",
    )
}
pub fn resolve(f: &Facts) -> anyhow::Result<Value> {
    use anyhow::ensure;
    const MAX: u64 = 9_007_199_254_740_991;
    ensure!(
        f.build.id > 0
            && f.build.id as u64 <= MAX
            && !f.build.name.is_empty()
            && f.build.name.encode_utf16().count() <= 500,
        "Invalid workflow Build"
    );
    let counts = [
        f.production.queued_jobs,
        f.production.sending_jobs,
        f.production.printing_jobs,
        f.production.failed_jobs,
        f.checkoff.awaiting_verification,
        f.checkoff.failed_verifications,
    ];
    ensure!(
        counts.iter().all(|n| *n <= MAX)
            && counts
                .iter()
                .try_fold(0u64, |sum, n| sum.checked_add(*n))
                .is_some_and(|n| n <= MAX),
        "Invalid workflow counts"
    );
    match &f.sources {
        Sources::Empty => {}
        Sources::Ready { attached_count } => ensure!(
            *attached_count > 0 && *attached_count <= MAX,
            "Invalid workflow Sources"
        ),
        Sources::Stale {
            attached_count,
            issue_count,
        } => ensure!(
            *attached_count > 0
                && *attached_count <= MAX
                && *issue_count > 0
                && *issue_count <= MAX,
            "Invalid workflow Sources"
        ),
    }
    match &f.accepted_plan {
        Accepted::None => {}
        Accepted::Ready {
            revision_id,
            plan_version,
            total_units,
            remaining_units,
        } => ensure!(
            *revision_id > 0
                && *revision_id as u64 <= MAX
                && *plan_version > 0
                && *plan_version as u64 <= MAX
                && *total_units <= MAX
                && remaining_units <= total_units,
            "Invalid workflow accepted Plan"
        ),
        Accepted::Unavailable { reason } => ensure!(
            !reason.is_empty() && reason.encode_utf16().count() <= 500,
            "Invalid workflow reason"
        ),
    }
    match &f.working_plan {
        Working::None => {}
        Working::Ready {
            draft_id,
            change_count,
        } => ensure!(
            *draft_id > 0 && *draft_id as u64 <= MAX && *change_count <= MAX,
            "Invalid workflow Working Plan"
        ),
        Working::NeedsAttention {
            draft_id,
            change_count,
            issue_count,
        }
        | Working::Stale {
            draft_id,
            change_count,
            issue_count,
        } => ensure!(
            *draft_id > 0
                && *draft_id as u64 <= MAX
                && *change_count <= MAX
                && *issue_count > 0
                && *issue_count <= MAX,
            "Invalid workflow Working Plan"
        ),
    }

    let sources = match f.sources {
        Sources::Empty => json!({"kind":"empty"}),
        Sources::Ready { attached_count } => {
            json!({"kind":"ready","attached_count":attached_count})
        }
        Sources::Stale {
            attached_count,
            issue_count,
        } => json!({"kind":"stale","attached_count":attached_count,"issue_count":issue_count}),
    };
    let (accepted, total, remaining) = match &f.accepted_plan {
        Accepted::None => (json!({"kind":"none"}), 0, 0),
        Accepted::Unavailable { reason } => (json!({"kind":"unavailable","reason":reason}), 0, 0),
        Accepted::Ready {
            revision_id,
            plan_version,
            total_units,
            remaining_units,
        } => (
            json!({"kind":"ready","revision_id":revision_id,"plan_version":plan_version,"total_units":total_units,"remaining_units":remaining_units}),
            *total_units,
            *remaining_units,
        ),
    };
    let working = match f.working_plan {
        Working::None => json!({"kind":"none"}),
        Working::Ready {
            draft_id,
            change_count,
        } => json!({"kind":"ready","draft_id":draft_id,"change_count":change_count}),
        Working::Stale {
            draft_id,
            change_count,
            issue_count,
        } => {
            json!({"kind":"stale","draft_id":draft_id,"change_count":change_count,"issue_count":issue_count})
        }
        Working::NeedsAttention {
            draft_id,
            change_count,
            issue_count,
        } => {
            json!({"kind":"needs_attention","draft_id":draft_id,"change_count":change_count,"issue_count":issue_count})
        }
    };
    Ok(
        json!({"build":f.build,"sources":sources,"accepted_plan":accepted,"working_plan":working,"stages":[{"id":"sources","group":"prepare","label":"Sources","status":source_status(&f.sources)},{"id":"plan","group":"prepare","label":"Plan","status":plan_status(f)},{"id":"production","group":"make","label":"Production","status":production_status(f)},{"id":"checkoff","group":"make","label":"Checkoff","status":checkoff_status(f)}],"next_action":next(f),"active_work":{"queued_jobs":f.production.queued_jobs,"sending_jobs":f.production.sending_jobs,"printing_jobs":f.production.printing_jobs,"failed_jobs":f.production.failed_jobs,"awaiting_verification":f.checkoff.awaiting_verification,"failed_verifications":f.checkoff.failed_verifications,"total_units":total,"remaining_units":remaining}}),
    )
}
