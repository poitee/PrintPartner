import type {
  BuildWorkflowStage,
  BuildWorkflowStageStatus,
  BuildWorkflowWorkspace,
} from "@print-partner/contracts";
import type { PlanReview } from "../api/endpoints/planManifests";
import {
  buildSourcesRoute,
  planRoute,
  productionRoute,
  progressRoute,
} from "./routes";

export type WorkflowStageId = BuildWorkflowStage["id"];
export type WorkflowStage = BuildWorkflowStage & Readonly<{ to: string }>;

const FALLBACK_STAGES = [
  {
    id: "sources",
    group: "prepare",
    label: "Sources",
    status: { kind: "not_started", summary: "Select a Build to view Sources." },
  },
  {
    id: "plan",
    group: "prepare",
    label: "Plan",
    status: { kind: "not_started", summary: "Select a Build to view its Plan." },
  },
  {
    id: "production",
    group: "make",
    label: "Production",
    status: { kind: "not_started", summary: "Select a Build to view Production." },
  },
  {
    id: "checkoff",
    group: "make",
    label: "Checkoff",
    status: { kind: "not_started", summary: "Select a Build to view Checkoff." },
  },
] satisfies readonly BuildWorkflowStage[];

function stageRoute(
  stageId: WorkflowStageId,
  buildId: number | null,
): string {
  switch (stageId) {
    case "sources":
      return buildSourcesRoute(buildId);
    case "plan":
      return planRoute(buildId);
    case "production":
      return productionRoute(buildId);
    case "checkoff":
      return progressRoute(buildId);
  }
}

export function buildWorkflowStages(
  workspace: BuildWorkflowWorkspace | null,
  selectedBuildId: number | null,
): WorkflowStage[] {
  const stages = workspace?.stages ?? FALLBACK_STAGES;
  return stages.map(
    (stage): WorkflowStage => ({
      ...stage,
      to: stageRoute(stage.id, selectedBuildId),
    }),
  );
}

export function workflowStatusLabel(
  kind: BuildWorkflowStageStatus["kind"],
): string {
  switch (kind) {
    case "not_started":
      return "Not started";
    case "ready":
      return "Ready";
    case "in_progress":
      return "In progress";
    case "needs_attention":
      return "Needs attention";
    case "complete":
      return "Complete";
    case "stale":
      return "Needs refresh";
    case "error":
      return "Error";
  }
}

export function stageIdFromPath(pathname: string): WorkflowStageId | null {
  if (pathname === "/sources" || pathname === "/build") return "sources";
  if (pathname === "/plan" || pathname === "/parts" || pathname === "/review") return "plan";
  if (pathname === "/export") return "production";
  if (pathname === "/progress" || pathname === "/checkoff") return "checkoff";
  return null;
}

function printedProgress(review: PlanReview | null | undefined): {
  pct: number;
  printedUnits: number;
  totalUnits: number;
  partCount: number;
  warnCount: number;
} {
  if (!review) {
    return { pct: 0, printedUnits: 0, totalUnits: 0, partCount: 0, warnCount: 0 };
  }
  const parts = review.part_groups.flatMap((group) => group.parts).filter((part) => part.included);
  const totalUnits = parts.reduce(
    (sum, part) => sum + Math.max(1, part.quantity_effective),
    0,
  );
  const printedUnits = parts.reduce((sum, part) => sum + part.printed_count, 0);
  const pct = totalUnits > 0
    ? Math.min(100, Math.round((printedUnits / totalUnits) * 100))
    : 0;
  const issueWarnCount = review.issues?.filter(
    (issue) => issue.severity === "warning" || issue.severity === "blocker",
  ).length ?? 0;
  const warnCount = issueWarnCount + parts.filter((part) => part.missing).length;
  return {
    pct,
    printedUnits,
    totalUnits,
    partCount: parts.length,
    warnCount,
  };
}

/** Shared printed-unit totals for the Plan tray. */
export function planPrintTotals(review: PlanReview | null | undefined) {
  return printedProgress(review);
}
