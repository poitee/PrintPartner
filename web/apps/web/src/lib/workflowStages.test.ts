import type { BuildWorkflowWorkspace } from "@print-partner/contracts";
import { describe, expect, it } from "vitest";
import { buildWorkflowStages, stageIdFromPath } from "./workflowStages";

const workspace = {
  build: { id: 7, name: "Voron" },
  sources: { kind: "ready", attached_count: 2 },
  accepted_plan: { kind: "none" },
  working_plan: { kind: "ready", draft_id: 9, change_count: 4 },
  stages: [
    {
      id: "sources",
      group: "prepare",
      label: "Sources",
      status: { kind: "complete", summary: "2 Sources attached." },
    },
    {
      id: "plan",
      group: "prepare",
      label: "Plan",
      status: { kind: "ready", summary: "Working Plan has 4 changes to review." },
    },
    {
      id: "production",
      group: "make",
      label: "Production",
      status: {
        kind: "not_started",
        summary: "Accept a Working Plan before Production.",
      },
    },
    {
      id: "checkoff",
      group: "make",
      label: "Checkoff",
      status: {
        kind: "not_started",
        summary: "Accept a Working Plan before Checkoff.",
      },
    },
  ],
  next_action: {
    kind: "accept_working_plan",
    stage_id: "plan",
    draft_id: 9,
    label: "Review and accept Working Plan",
    reason: "The Working Plan is ready for acceptance.",
  },
  active_work: {
    queued_jobs: 0,
    sending_jobs: 0,
    printing_jobs: 0,
    failed_jobs: 0,
    awaiting_verification: 0,
    failed_verifications: 0,
    total_units: 0,
    remaining_units: 0,
  },
} satisfies BuildWorkflowWorkspace;

describe("buildWorkflowStages", () => {
  it("adapts the shared Prepare and Make projection to Build routes", () => {
    const stages = buildWorkflowStages(workspace, 7);

    expect(stages.map((stage) => stage.id)).toEqual([
      "sources",
      "plan",
      "production",
      "checkoff",
    ]);
    expect(stages.map((stage) => stage.status.kind)).toEqual([
      "complete",
      "ready",
      "not_started",
      "not_started",
    ]);
    expect(stages.map((stage) => stage.to)).toEqual([
      "/sources?profile=7",
      "/plan?profile=7",
      "/export?profile=7",
      "/progress?profile=7",
    ]);
  });

  it("keeps the same destinations visible before a Build is selected", () => {
    expect(buildWorkflowStages(null, null).map((stage) => stage.label)).toEqual([
      "Sources",
      "Plan",
      "Production",
      "Checkoff",
    ]);
  });
});

describe("stageIdFromPath", () => {
  it("maps current and legacy Build paths onto the accepted destinations", () => {
    expect(stageIdFromPath("/sources")).toBe("sources");
    expect(stageIdFromPath("/build")).toBe("sources");
    expect(stageIdFromPath("/plan")).toBe("plan");
    expect(stageIdFromPath("/parts")).toBe("plan");
    expect(stageIdFromPath("/export")).toBe("production");
    expect(stageIdFromPath("/progress")).toBe("checkoff");
    expect(stageIdFromPath("/production")).toBeNull();
    expect(stageIdFromPath("/library")).toBeNull();
    expect(stageIdFromPath("/builds")).toBeNull();
  });
});
