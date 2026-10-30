import { TENANT_FEATURE_TOGGLES_CAPABILITY } from "@print-partner/contracts";
import { describe, expect, it } from "vitest";
import { desktopRebuildEnabled } from "./desktopRebuild";

/** The inline check JobContext, planReview and PlanWorkspaceContext each carried before GRE-621. */
function legacyCheck(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY) === true;
}

const inputs: Array<readonly string[] | undefined> = [
  undefined,
  [],
  ["jobs_ws"],
  ["jobs_ws", "logging", "mcp_http"],
  [TENANT_FEATURE_TOGGLES_CAPABILITY],
  ["kit_planning", TENANT_FEATURE_TOGGLES_CAPABILITY, "logging"],
  [TENANT_FEATURE_TOGGLES_CAPABILITY, TENANT_FEATURE_TOGGLES_CAPABILITY],
  ["TENANT_FEATURE_TOGGLES"],
  ["tenant_feature_toggles "],
  ["desktop_rebuild"],
];

describe("desktopRebuildEnabled", () => {
  it.each(inputs.map((input) => [JSON.stringify(input) ?? "undefined", input]))(
    "matches the legacy inline check for %s",
    (_name, input) => {
      expect(desktopRebuildEnabled(input)).toBe(legacyCheck(input));
    },
  );

  it("is on only for the exact capability", () => {
    expect(inputs.filter(desktopRebuildEnabled)).toHaveLength(3);
  });
});
