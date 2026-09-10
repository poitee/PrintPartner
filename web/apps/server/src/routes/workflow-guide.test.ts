import { describe, expect, it } from "vitest";
import { workflowGuideForExternalAccess } from "./workflow-guide.js";

describe("workflow help", () => {
  it("describes autosave and reference sharing without a manual approval gate", () => {
    const guide = workflowGuideForExternalAccess("off");
    expect(guide).toContain("Changes save automatically");
    expect(guide).toContain("not model files");
    expect(guide).toContain("Manifest import is not yet available");
    expect(guide).not.toContain("Accept Working Plan");
    expect(guide).not.toContain("Build Working Plan");
    expect(guide).not.toContain("openapi.json");
  });

  it.each(["api", "api_and_mcp"] as const)("includes API help when %s is enabled", (mode) => {
    expect(workflowGuideForExternalAccess(mode)).toContain("/api/v1/openapi.json");
  });
});
