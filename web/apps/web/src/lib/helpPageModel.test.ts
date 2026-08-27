import { describe, expect, it } from "vitest";
import {
  LEGAL_TABS,
  WORKFLOW_STEPS,
  renderMarkdownLite,
  workflowStepPaths,
} from "./helpPageModel";

describe("helpPageModel", () => {
  it("defines legal tabs and workflow steps", () => {
    expect(LEGAL_TABS.map((tab) => tab.id)).toEqual([
      "summary",
      "license",
      "attribution",
      "third-party",
    ]);
    expect(WORKFLOW_STEPS.map((step) => step.label)).toEqual([
      "Sources",
      "Plan",
      "Production",
      "Checkoff",
    ]);
  });

  it("resolves workflow paths for the selected plan", () => {
    expect(workflowStepPaths(7)).toEqual([
      "/sources?profile=7",
      "/plan?profile=7",
      "/export?profile=7",
      "/progress?profile=7",
    ]);
  });

  it("renders basic markdown-like help content", () => {
    expect(renderMarkdownLite("# Title\n\n- **One**\n- Two")).toBe(
      "<h2>Title</h2></p><p><ul><li><strong>One</strong></li>\n<li>Two</li></ul>",
    );
  });
});
