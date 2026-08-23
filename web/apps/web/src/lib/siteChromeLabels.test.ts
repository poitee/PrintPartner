import { describe, expect, it } from "vitest";
import { buildWorkflowStages } from "./workflowStages";
import { spineUtilityNavItems } from "./spineUtilityNav";
import { BUILD_SECTIONS, GLOBAL_SECTIONS } from "./siteMap";

describe("site chrome labels", () => {
  it("labels the global sections and Build destinations", () => {
    expect([...GLOBAL_SECTIONS]).toEqual(["builds", "production", "printers", "settings"]);
    expect([...BUILD_SECTIONS]).toEqual(["sources", "plan", "checkoff", "production"]);
    expect(spineUtilityNavItems(null).map((item) => item.label)).toEqual([
      "Builds",
      "Source Library",
      "All Production",
      "Printers",
      "Settings",
      "Help",
    ]);
    expect(
      buildWorkflowStages({
        pathname: "/plan",
        sourcesCount: 1,
        profiles: [],
        selectedProfileId: null,
      }).map((stage) => stage.label),
    ).toEqual(["Sources", "Plan", "Checkoff", "Production"]);
  });
});
