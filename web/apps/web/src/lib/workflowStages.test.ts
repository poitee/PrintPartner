import { describe, expect, it } from "vitest";
import type { ProfileSummary } from "../api/engine";
import { buildWorkflowStages, stageIdFromPath } from "./workflowStages";

const voron = {
  id: 7,
  name: "Voron",
  archived_at: null,
  part_count: 4,
  build_stale: false,
} as ProfileSummary;

describe("buildWorkflowStages", () => {
  it("exposes Sources, Plan, Checkoff, and Production for the selected Build", () => {
    const stages = buildWorkflowStages({
      pathname: "/parts",
      sourcesCount: 2,
      profiles: [voron],
      selectedProfileId: 7,
    });

    expect(stages.map((stage) => stage.id)).toEqual([
      "sources",
      "plan",
      "checkoff",
      "production",
    ]);
    expect(stages.map((stage) => stage.label)).toEqual([
      "Sources",
      "Plan",
      "Checkoff",
      "Production",
    ]);
    expect(stages.find((stage) => stage.id === "sources")?.to).toBe("/sources?profile=7");
    expect(stages.find((stage) => stage.id === "plan")?.to).toBe("/plan?profile=7");
    expect(stages.find((stage) => stage.id === "checkoff")?.to).toBe("/progress?profile=7");
    expect(stages.find((stage) => stage.id === "production")?.to).toBe("/export?profile=7");
  });
});

describe("stageIdFromPath", () => {
  it("maps current and legacy Build paths onto the accepted destinations", () => {
    expect(stageIdFromPath("/sources")).toBe("sources");
    expect(stageIdFromPath("/build")).toBe("sources");
    expect(stageIdFromPath("/plan")).toBe("plan");
    expect(stageIdFromPath("/parts")).toBe("plan");
    expect(stageIdFromPath("/progress")).toBe("checkoff");
    expect(stageIdFromPath("/production")).toBeNull();
    expect(stageIdFromPath("/export")).toBe("production");
    expect(stageIdFromPath("/library")).toBeNull();
    expect(stageIdFromPath("/builds")).toBeNull();
  });
});
