import {
  resolveBuildWorkflow,
  type BuildWorkflowAcceptedPlanFacts,
  type BuildWorkflowFacts,
  type BuildWorkflowProductionFacts,
  type BuildWorkflowSourceFacts,
  type BuildWorkflowWorkingPlanFacts,
} from "@print-partner/domain";
import type {
  AcceptedProfileSummary,
  AppRepository,
} from "../db/repository.js";
import { buildPlanningApplyBlockers } from "./build-planning.js";
import { PlanDraftWorkspaceService } from "./plan-draft-workspace.js";
import { loadPrinterCheckoffLinks } from "./printer-checkoff-store.js";
import { loadPrinterSendQueue } from "./printer-send-queue-store.js";

export type ReadBuildWorkflowWorkspaceResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "ready";
      workspace: ReturnType<typeof resolveBuildWorkflow>;
    }>;

function sourceFacts(
  summary: AcceptedProfileSummary,
  attachedCount: number,
): BuildWorkflowSourceFacts {
  if (attachedCount === 0) return { kind: "empty" };
  const freshness = summary.header.freshness;
  if (freshness.status === "stale") {
    const issueCount = freshness.reasons.length + freshness.untracked_sources.length;
    return { kind: "stale", attachedCount, issueCount: Math.max(1, issueCount) };
  }
  return { kind: "ready", attachedCount };
}

function acceptedPlanFailureReason(
  progress: Exclude<
    AcceptedProfileSummary["progress"],
    { readonly kind: "ready" } | { readonly kind: "empty" }
  >,
): string {
  switch (progress.kind) {
    case "unavailable":
      return progress.reason === "compatibility_dirty"
        ? "This Build's Accepted Plan cannot be read. Restart PrintPartner so it can repair the Plan data."
        : "The Accepted Plan has not been initialized.";
    case "integrity_failure":
      return "Accepted Plan data is inconsistent.";
    case "concurrent_update":
      return "The Accepted Plan changed while its status was being read.";
  }
}

function acceptedPlanFacts(
  repo: AppRepository,
  buildId: number,
  summary: AcceptedProfileSummary,
): BuildWorkflowAcceptedPlanFacts {
  switch (summary.progress.kind) {
    case "empty":
      return { kind: "none" };
    case "ready": {
      const revision = repo.getAcceptedPlanRevision(buildId);
      if (!revision) {
        return {
          kind: "unavailable",
          reason: "The Accepted Plan revision is unavailable.",
        };
      }
      return {
        kind: "ready",
        revisionId: revision.id,
        planVersion: revision.planVersion,
        totalUnits: summary.progress.totalUnits,
        remainingUnits: summary.progress.remainingUnits,
      };
    }
    case "unavailable":
    case "integrity_failure":
    case "concurrent_update":
      return {
        kind: "unavailable",
        reason: acceptedPlanFailureReason(summary.progress),
      };
  }
}

function latestOpenDraftId(
  service: PlanDraftWorkspaceService,
  buildId: number,
): number | null {
  const drafts = service.list(buildId);
  if (!drafts) return null;
  return [...drafts].reverse().find((draft) => draft.state === "open")?.draft_id
    ?? null;
}

function workingPlanFacts(
  repo: AppRepository,
  buildId: number,
): BuildWorkflowWorkingPlanFacts {
  const service = new PlanDraftWorkspaceService(repo);
  const draftId = latestOpenDraftId(service, buildId);
  if (draftId == null) return { kind: "none" };

  const result = service.read(buildId, draftId);
  if (result.kind !== "ready") {
    return {
      kind: "needs_attention",
      draftId,
      changeCount: 0,
      issueCount: 1,
    };
  }
  const { workspace } = result;
  const changeCount = workspace.diff.added.length
    + workspace.diff.changed.length
    + workspace.diff.removed.length;
  const reconciliationIssues = workspace.reconciliation.kind === "unresolved"
    ? workspace.reconciliation.conflicts.length
    : 0;
  const planningIssues = buildPlanningApplyBlockers(repo, buildId, draftId)?.length
    ?? 0;
  const issueCount = reconciliationIssues + planningIssues;

  if (!workspace.diff.base_is_current) {
    return {
      kind: "stale",
      draftId,
      changeCount,
      issueCount: Math.max(1, issueCount),
    };
  }
  if (issueCount > 0) {
    return {
      kind: "needs_attention",
      draftId,
      changeCount,
      issueCount,
    };
  }
  return { kind: "ready", draftId, changeCount };
}

function plateState(
  repo: AppRepository,
  buildId: number,
): BuildWorkflowProductionFacts["plateState"] {
  const plates = repo.readAcceptedPlates(buildId);
  switch (plates.kind) {
    case "ready":
      return "ready";
    case "empty":
    case "empty_plan":
      return "not_started";
    case "stale_accepted_plan":
      return "stale";
    case "accepted_state_unavailable":
    case "transaction_unavailable":
      return "error";
  }
}

function productionFacts(
  repo: AppRepository,
  buildId: number,
): BuildWorkflowFacts["production"] {
  const queue = loadPrinterSendQueue(repo).filter(
    (item) => item.profile_id === buildId,
  );
  const links = loadPrinterCheckoffLinks(repo).filter(
    (link) => link.profile_id === buildId,
  );
  return {
    plateState: plateState(repo, buildId),
    queuedJobs: queue.filter((item) => item.state === "queued").length,
    sendingJobs: queue.filter((item) => item.state === "sending").length,
    printingJobs: links.filter((link) => link.state === "watching").length,
    failedJobs: queue.filter((item) => item.state === "error").length,
  };
}

function checkoffFacts(
  repo: AppRepository,
  buildId: number,
): BuildWorkflowFacts["checkoff"] {
  const links = loadPrinterCheckoffLinks(repo).filter(
    (link) => link.profile_id === buildId,
  );
  return {
    awaitingVerification: links.filter(
      (link) => link.state === "awaiting_verify",
    ).length,
    failedVerifications: links.filter(
      (link) => link.state === "host_failed",
    ).length,
  };
}

export function readBuildWorkflowWorkspace(
  repo: AppRepository,
  buildId: number,
): ReadBuildWorkflowWorkspaceResult {
  const read = repo.readAcceptedProfileSummary(buildId);
  if (read.kind === "missing") return { kind: "missing" };

  const attachedCount = repo.getProfileLayers(buildId).filter(
    (layer) => layer.project_id != null,
  ).length;
  return {
    kind: "ready",
    workspace: resolveBuildWorkflow({
      build: { id: read.summary.header.id, name: read.summary.header.name },
      sources: sourceFacts(read.summary, attachedCount),
      acceptedPlan: acceptedPlanFacts(repo, buildId, read.summary),
      workingPlan: workingPlanFacts(repo, buildId),
      production: productionFacts(repo, buildId),
      checkoff: checkoffFacts(repo, buildId),
    }),
  };
}
