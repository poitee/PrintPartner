import type { PlanReview, ProfileSummary } from "../api/engine";
import {
  buildSourcesRoute,
  planRoute,
  productionRoute,
  progressRoute,
} from "./routes";

export type WorkflowStageId = "sources" | "plan" | "checkoff" | "production";

export const SPINE_FILL_STAGE_IDS: ReadonlySet<WorkflowStageId> = new Set([
  "sources",
  "plan",
  "checkoff",
]);

export type WorkflowStage = {
  id: WorkflowStageId;
  label: string;
  to: string;
  /** Mono meta shown in the rail / mobile bar (count, %, sources). */
  meta: string;
  warn: boolean;
  done: boolean;
  dim: boolean;
};

export type WorkflowStageInput = {
  pathname: string;
  sourcesCount: number;
  profiles: ProfileSummary[];
  selectedProfileId: number | null;
  /** Attached source count for the active plan when known. */
  attachedSourceCount?: number | null;
  review?: PlanReview | null;
};

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
  const parts = review.part_groups.flatMap((g) => g.parts).filter((p) => p.included);
  const totalUnits = parts.reduce((sum, p) => sum + Math.max(1, p.quantity_effective), 0);
  const printedUnits = parts.reduce((sum, p) => sum + p.printed_count, 0);
  const pct =
    totalUnits > 0
      ? Math.min(100, Math.round((printedUnits / totalUnits) * 100))
      : 0;
  const issueWarnCount =
    review.issues?.filter(
      (i) => i.severity === "warning" || i.severity === "blocker",
    ).length ?? 0;
  const warnCount = issueWarnCount + parts.filter((p) => p.missing).length;
  return {
    pct,
    printedUnits,
    totalUnits,
    partCount: parts.length,
    warnCount,
  };
}

export function buildWorkflowStages(input: WorkflowStageInput): WorkflowStage[] {
  const {
    profiles,
    selectedProfileId,
    attachedSourceCount,
    review,
  } = input;
  const selected = profiles.find((p) => p.id === selectedProfileId);
  const hasPlan = profiles.length > 0;
  const buildStale = selected?.build_stale ?? false;
  const partCount = selected?.part_count ?? review?.totals.included_parts ?? 0;
  const hasParts = partCount > 0;
  const progress = printedProgress(review);
  const layersAttached =
    review?.layers?.filter((l) => l.project_id != null).length ?? 0;
  const attached =
    attachedSourceCount ?? (layersAttached > 0 ? layersAttached : null);
  const productionMetaCount = progress.partCount || partCount;

  const sourcesMeta =
    attached != null && attached > 0
      ? `${attached} source${attached === 1 ? "" : "s"}`
      : hasPlan
        ? hasParts
          ? `${partCount}`
          : "—"
        : "";

  const planWarn =
    buildStale ||
    (review?.has_blockers ?? false) ||
    (progress.warnCount > 0 && hasParts);

  return [
    {
      id: "sources",
      label: "Sources",
      to: buildSourcesRoute(selectedProfileId),
      meta: sourcesMeta,
      warn: hasPlan && (buildStale || !hasParts),
      done: hasPlan && hasParts && !buildStale,
      dim: !hasPlan,
    },
    {
      id: "plan",
      label: "Plan",
      to: planRoute(selectedProfileId),
      meta: hasParts ? String(progress.partCount || partCount) : "",
      warn: planWarn && hasParts,
      done: hasParts && !buildStale && !(review?.has_blockers ?? false),
      dim: !hasParts,
    },
    {
      id: "checkoff",
      label: "Checkoff",
      to: progressRoute(selectedProfileId),
      meta: hasParts ? `${progress.pct}%` : "",
      warn: false,
      done: hasParts && progress.pct >= 100,
      dim: !hasParts || progress.pct === 0,
    },
    {
      id: "production",
      label: "Production",
      to: productionRoute(selectedProfileId),
      meta: hasParts ? String(productionMetaCount) : "",
      warn: false,
      done: hasParts,
      dim: !hasParts,
    },
  ];
}

export function spineFillIndex(stages: WorkflowStage[], activeId: WorkflowStageId | null): number {
  const fillStages = stages.filter((s) => SPINE_FILL_STAGE_IDS.has(s.id));
  const fillActive =
    activeId && SPINE_FILL_STAGE_IDS.has(activeId) ? activeId : null;
  if (fillActive) {
    const activeIdx = fillStages.findIndex((s) => s.id === fillActive);
    if (activeIdx >= 0) return activeIdx;
  }
  let lastDone = -1;
  for (let i = 0; i < fillStages.length; i++) {
    if (fillStages[i]?.done) lastDone = i;
  }
  return Math.max(0, lastDone);
}

export function spineFillStageCount(stages: WorkflowStage[]): number {
  return stages.filter((s) => SPINE_FILL_STAGE_IDS.has(s.id)).length;
}

export function stageIdFromPath(pathname: string): WorkflowStageId | null {
  if (pathname === "/sources" || pathname === "/build") return "sources";
  if (pathname === "/plan" || pathname === "/parts" || pathname === "/review") return "plan";
  if (pathname === "/progress" || pathname === "/checkoff") return "checkoff";
  if (pathname === "/export") return "production";
  return null;
}

/** Shared printed-unit totals for the plan tray. */
export function planPrintTotals(review: PlanReview | null | undefined) {
  return printedProgress(review);
}
