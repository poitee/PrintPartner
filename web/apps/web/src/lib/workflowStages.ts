import type {
  BuildWorkflowStage,
  BuildWorkflowWorkspace,
} from "@print-partner/contracts";
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
      status: {
        ...stage.status,
        summary: selectedBuildId == null ? stage.status.summary : {
          sources: "Add projects from the Library.",
          plan: "Choose files, quantities, and colors.",
          production: "Prepare and send prints.",
          checkoff: "Record finished parts.",
        }[stage.id],
      },
      to: stageRoute(stage.id, selectedBuildId),
    }),
  );
}

export function stageIdFromPath(pathname: string): WorkflowStageId | null {
  if (pathname === "/sources" || pathname === "/build") return "sources";
  if (pathname === "/plan" || pathname === "/parts" || pathname === "/review") return "plan";
  if (pathname === "/export") return "production";
  if (pathname === "/progress" || pathname === "/checkoff") return "checkoff";
  return null;
}
