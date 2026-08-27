import type {
  BuildWorkflowAcceptedPlan,
  BuildWorkflowNextAction,
  BuildWorkflowSourceState,
  BuildWorkflowStageStatus,
  BuildWorkflowWorkingPlan,
  BuildWorkflowWorkspace,
} from "@print-partner/contracts";

export type BuildWorkflowSourceFacts =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "ready"; attachedCount: number }>
  | Readonly<{
      kind: "stale";
      attachedCount: number;
      issueCount: number;
    }>;

export type BuildWorkflowAcceptedPlanFacts =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "ready";
      revisionId: number;
      planVersion: number;
      totalUnits: number;
      remainingUnits: number;
    }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type BuildWorkflowWorkingPlanFacts =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "ready"; draftId: number; changeCount: number }>
  | Readonly<{
      kind: "needs_attention";
      draftId: number;
      changeCount: number;
      issueCount: number;
    }>
  | Readonly<{
      kind: "stale";
      draftId: number;
      changeCount: number;
      issueCount: number;
    }>;

export type BuildWorkflowProductionFacts = Readonly<{
  plateState: "not_started" | "preparing" | "ready" | "stale" | "error";
  queuedJobs: number;
  sendingJobs: number;
  printingJobs: number;
  failedJobs: number;
}>;

export type BuildWorkflowCheckoffFacts = Readonly<{
  awaitingVerification: number;
  failedVerifications: number;
}>;

export type BuildWorkflowFacts = Readonly<{
  build: Readonly<{ id: number; name: string }>;
  sources: BuildWorkflowSourceFacts;
  acceptedPlan: BuildWorkflowAcceptedPlanFacts;
  workingPlan: BuildWorkflowWorkingPlanFacts;
  production: BuildWorkflowProductionFacts;
  checkoff: BuildWorkflowCheckoffFacts;
}>;

function assertNever(value: never): never {
  throw new Error(`Unsupported Build Workflow state: ${JSON.stringify(value)}`);
}

function pluralized(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}

function sourceState(
  facts: BuildWorkflowSourceFacts,
): BuildWorkflowSourceState {
  switch (facts.kind) {
    case "empty":
      return { kind: "empty" };
    case "ready":
      return { kind: "ready", attached_count: facts.attachedCount };
    case "stale":
      return {
        kind: "stale",
        attached_count: facts.attachedCount,
        issue_count: facts.issueCount,
      };
    default:
      return assertNever(facts);
  }
}

function acceptedPlanState(
  facts: BuildWorkflowAcceptedPlanFacts,
): BuildWorkflowAcceptedPlan {
  switch (facts.kind) {
    case "none":
      return { kind: "none" };
    case "ready":
      return {
        kind: "ready",
        revision_id: facts.revisionId,
        plan_version: facts.planVersion,
        total_units: facts.totalUnits,
        remaining_units: facts.remainingUnits,
      };
    case "unavailable":
      return { kind: "unavailable", reason: facts.reason };
    default:
      return assertNever(facts);
  }
}

function workingPlanState(
  facts: BuildWorkflowWorkingPlanFacts,
): BuildWorkflowWorkingPlan {
  switch (facts.kind) {
    case "none":
      return { kind: "none" };
    case "ready":
      return {
        kind: "ready",
        draft_id: facts.draftId,
        change_count: facts.changeCount,
      };
    case "needs_attention":
    case "stale":
      return {
        kind: facts.kind,
        draft_id: facts.draftId,
        change_count: facts.changeCount,
        issue_count: facts.issueCount,
      };
    default:
      return assertNever(facts);
  }
}

function sourceStageStatus(
  facts: BuildWorkflowSourceFacts,
): BuildWorkflowStageStatus {
  switch (facts.kind) {
    case "empty":
      return { kind: "not_started", summary: "No Sources attached." };
    case "ready":
      return {
        kind: "complete",
        summary: `${facts.attachedCount} ${pluralized(facts.attachedCount, "Source")} attached.`,
      };
    case "stale":
      return {
        kind: "stale",
        summary: `${facts.issueCount} Source ${pluralized(facts.issueCount, "change")} need review.`,
        task_count: facts.issueCount,
      };
    default:
      return assertNever(facts);
  }
}

function planStageStatus(
  sources: BuildWorkflowSourceFacts,
  acceptedPlan: BuildWorkflowAcceptedPlanFacts,
  workingPlan: BuildWorkflowWorkingPlanFacts,
): BuildWorkflowStageStatus {
  if (acceptedPlan.kind === "unavailable") {
    return {
      kind: "error",
      summary: acceptedPlan.reason,
      task_count: 1,
    };
  }

  switch (workingPlan.kind) {
    case "ready":
      return {
        kind: "ready",
        summary: `Working Plan has ${workingPlan.changeCount} ${pluralized(workingPlan.changeCount, "change")} to review.`,
      };
    case "needs_attention":
      return {
        kind: "needs_attention",
        summary: `${workingPlan.issueCount} Working Plan ${pluralized(workingPlan.issueCount, "issue")} need attention.`,
        task_count: workingPlan.issueCount,
      };
    case "stale":
      return {
        kind: "stale",
        summary: "The Working Plan is based on an older Accepted Plan.",
        task_count: workingPlan.issueCount,
      };
    case "none":
      if (acceptedPlan.kind === "ready") {
        return {
          kind: "complete",
          summary: `Plan revision ${acceptedPlan.planVersion} accepted.`,
        };
      }
      if (sources.kind === "ready") {
        return {
          kind: "ready",
          summary: "Ready to create a Working Plan.",
        };
      }
      return {
        kind: "not_started",
        summary: "Prepare Sources before creating a Working Plan.",
      };
    default:
      return assertNever(workingPlan);
  }
}

function productionStageStatus(
  acceptedPlan: BuildWorkflowAcceptedPlanFacts,
  production: BuildWorkflowProductionFacts,
): BuildWorkflowStageStatus {
  if (acceptedPlan.kind === "unavailable") {
    return {
      kind: "error",
      summary: "Production cannot read the Accepted Plan.",
      task_count: 1,
    };
  }
  if (acceptedPlan.kind === "none") {
    return {
      kind: "not_started",
      summary: "Accept a Working Plan before Production.",
    };
  }
  if (production.failedJobs > 0) {
    return {
      kind: "needs_attention",
      summary: `${production.failedJobs} printer ${pluralized(production.failedJobs, "job")} need attention.`,
      task_count: production.failedJobs,
    };
  }

  const activeJobs = production.queuedJobs
    + production.sendingJobs
    + production.printingJobs;
  if (activeJobs > 0) {
    return {
      kind: "in_progress",
      summary: `${activeJobs} Production ${pluralized(activeJobs, "job")} active.`,
      active_count: activeJobs,
    };
  }
  if (acceptedPlan.remainingUnits === 0) {
    return {
      kind: "complete",
      summary: "All required units have completed Production.",
    };
  }

  switch (production.plateState) {
    case "error":
      return {
        kind: "error",
        summary: "Production preparation failed.",
        task_count: 1,
      };
    case "stale":
      return {
        kind: "stale",
        summary: "Prepared plates do not match the Accepted Plan.",
        task_count: 1,
      };
    case "preparing":
      return {
        kind: "in_progress",
        summary: "Production plates are being prepared.",
        active_count: 1,
      };
    case "ready":
      return {
        kind: "ready",
        summary: "Production plates are ready.",
      };
    case "not_started":
      return {
        kind: "ready",
        summary: `${acceptedPlan.remainingUnits} required ${pluralized(acceptedPlan.remainingUnits, "unit")} ready for Production.`,
      };
    default:
      return assertNever(production.plateState);
  }
}

function checkoffStageStatus(
  acceptedPlan: BuildWorkflowAcceptedPlanFacts,
  production: BuildWorkflowProductionFacts,
  checkoff: BuildWorkflowCheckoffFacts,
): BuildWorkflowStageStatus {
  if (acceptedPlan.kind === "unavailable") {
    return {
      kind: "error",
      summary: "Checkoff cannot read the Accepted Plan.",
      task_count: 1,
    };
  }
  if (acceptedPlan.kind === "none") {
    return {
      kind: "not_started",
      summary: "Accept a Working Plan before Checkoff.",
    };
  }
  if (checkoff.failedVerifications > 0) {
    return {
      kind: "needs_attention",
      summary: `${checkoff.failedVerifications} failed print ${pluralized(checkoff.failedVerifications, "result")} need review.`,
      task_count: checkoff.failedVerifications,
    };
  }
  if (checkoff.awaitingVerification > 0) {
    return {
      kind: "needs_attention",
      summary: `${checkoff.awaitingVerification} print ${pluralized(checkoff.awaitingVerification, "result")} await verification.`,
      task_count: checkoff.awaitingVerification,
    };
  }
  if (production.printingJobs > 0) {
    return {
      kind: "in_progress",
      summary: `${production.printingJobs} print ${pluralized(production.printingJobs, "job")} in progress.`,
      active_count: production.printingJobs,
    };
  }
  if (acceptedPlan.remainingUnits === 0) {
    return {
      kind: "complete",
      summary: "Every required unit is checked off.",
    };
  }
  if (acceptedPlan.remainingUnits < acceptedPlan.totalUnits) {
    const completedUnits = acceptedPlan.totalUnits - acceptedPlan.remainingUnits;
    return {
      kind: "in_progress",
      summary: `${completedUnits} of ${acceptedPlan.totalUnits} required units checked off.`,
      active_count: completedUnits,
    };
  }
  return {
    kind: "not_started",
    summary: "Waiting for print results.",
  };
}

function nextAction(facts: BuildWorkflowFacts): BuildWorkflowNextAction {
  if (facts.checkoff.failedVerifications > 0) {
    const count = facts.checkoff.failedVerifications;
    return {
      kind: "review_failed_prints",
      stage_id: "checkoff",
      item_count: count,
      label: "Review failed print results",
      reason: `${count} failed print ${pluralized(count, "result")} need review.`,
    };
  }
  if (facts.production.failedJobs > 0) {
    const count = facts.production.failedJobs;
    return {
      kind: "recover_printer_jobs",
      stage_id: "production",
      item_count: count,
      label: "Recover printer jobs",
      reason: `${count} printer ${pluralized(count, "job")} failed.`,
    };
  }
  if (facts.checkoff.awaitingVerification > 0) {
    const count = facts.checkoff.awaitingVerification;
    return {
      kind: "verify_prints",
      stage_id: "checkoff",
      item_count: count,
      label: "Verify print results",
      reason: `${count} print ${pluralized(count, "result")} ${count === 1 ? "is" : "are"} waiting for verification.`,
    };
  }

  const monitoredJobs = facts.production.sendingJobs + facts.production.printingJobs;
  if (monitoredJobs > 0) {
    return {
      kind: "monitor_production",
      stage_id: "production",
      item_count: monitoredJobs,
      label: "Monitor Production",
      reason: `${monitoredJobs} Production ${pluralized(monitoredJobs, "job")} ${monitoredJobs === 1 ? "is" : "are"} active.`,
    };
  }
  if (facts.production.queuedJobs > 0) {
    const count = facts.production.queuedJobs;
    return {
      kind: "review_production_queue",
      stage_id: "production",
      item_count: count,
      label: "Review Production queue",
      reason: `${count} printer ${pluralized(count, "job")} ${count === 1 ? "is" : "are"} queued.`,
    };
  }
  if (facts.acceptedPlan.kind === "unavailable") {
    return {
      kind: "review_plan_status",
      stage_id: "plan",
      label: "Review Plan status",
      reason: facts.acceptedPlan.reason,
    };
  }
  if (
    facts.sources.kind === "stale"
    && facts.workingPlan.kind === "none"
  ) {
    return {
      kind: "review_source_changes",
      stage_id: "sources",
      issue_count: facts.sources.issueCount,
      label: "Review Source changes",
      reason: `${facts.sources.issueCount} Source ${pluralized(facts.sources.issueCount, "change")} need review.`,
    };
  }
  if (facts.sources.kind === "empty") {
    return {
      kind: "attach_sources",
      stage_id: "sources",
      label: "Attach Sources",
      reason: "This Build has no Sources yet.",
    };
  }

  switch (facts.workingPlan.kind) {
    case "needs_attention":
      return {
        kind: "resolve_plan_issues",
        stage_id: "plan",
        draft_id: facts.workingPlan.draftId,
        issue_count: facts.workingPlan.issueCount,
        label: "Resolve Working Plan issues",
        reason: `${facts.workingPlan.issueCount} ${pluralized(facts.workingPlan.issueCount, "issue")} block Plan acceptance.`,
      };
    case "stale":
      return {
        kind: "refresh_working_plan",
        stage_id: "plan",
        draft_id: facts.workingPlan.draftId,
        label: "Refresh Working Plan",
        reason: "The Working Plan is based on an older Accepted Plan.",
      };
    case "ready":
      return {
        kind: "accept_working_plan",
        stage_id: "plan",
        draft_id: facts.workingPlan.draftId,
        label: "Review and accept Working Plan",
        reason: "The Working Plan is ready for acceptance.",
      };
    case "none":
      break;
    default:
      return assertNever(facts.workingPlan);
  }

  if (facts.acceptedPlan.kind === "none") {
    return {
      kind: "create_working_plan",
      stage_id: "plan",
      label: "Create Working Plan",
      reason: "Sources are ready, but this Build has no Accepted Plan.",
    };
  }
  if (facts.acceptedPlan.remainingUnits > 0) {
    const count = facts.acceptedPlan.remainingUnits;
    return {
      kind: "prepare_production",
      stage_id: "production",
      unit_count: count,
      label: "Prepare Production",
      reason: `${count} required ${pluralized(count, "unit")} remain in the Accepted Plan.`,
    };
  }
  return {
    kind: "view_completed_build",
    stage_id: "checkoff",
    label: "View completed Build",
    reason: "Every required unit in the Accepted Plan is checked off.",
  };
}

export function resolveBuildWorkflow(
  facts: BuildWorkflowFacts,
): BuildWorkflowWorkspace {
  const acceptedPlan = acceptedPlanState(facts.acceptedPlan);
  const totalUnits = acceptedPlan.kind === "ready" ? acceptedPlan.total_units : 0;
  const remainingUnits = acceptedPlan.kind === "ready"
    ? acceptedPlan.remaining_units
    : 0;

  return {
    build: facts.build,
    sources: sourceState(facts.sources),
    accepted_plan: acceptedPlan,
    working_plan: workingPlanState(facts.workingPlan),
    stages: [
      {
        id: "sources",
        group: "prepare",
        label: "Sources",
        status: sourceStageStatus(facts.sources),
      },
      {
        id: "plan",
        group: "prepare",
        label: "Plan",
        status: planStageStatus(
          facts.sources,
          facts.acceptedPlan,
          facts.workingPlan,
        ),
      },
      {
        id: "production",
        group: "make",
        label: "Production",
        status: productionStageStatus(facts.acceptedPlan, facts.production),
      },
      {
        id: "checkoff",
        group: "make",
        label: "Checkoff",
        status: checkoffStageStatus(
          facts.acceptedPlan,
          facts.production,
          facts.checkoff,
        ),
      },
    ],
    next_action: nextAction(facts),
    active_work: {
      queued_jobs: facts.production.queuedJobs,
      sending_jobs: facts.production.sendingJobs,
      printing_jobs: facts.production.printingJobs,
      failed_jobs: facts.production.failedJobs,
      awaiting_verification: facts.checkoff.awaitingVerification,
      failed_verifications: facts.checkoff.failedVerifications,
      total_units: totalUnits,
      remaining_units: remainingUnits,
    },
  };
}
