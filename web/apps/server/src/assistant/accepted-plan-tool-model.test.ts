import { describe, expect, it } from "vitest";
import { parseAcceptedPlanBasis, printStatsAcceptedProgress } from "./accepted-plan-tool-model.js";

const digest = "a".repeat(64);

describe("accepted plan tool model", () => {
  it("formats accepted progress for assistant print stats", () => {
    expect(printStatsAcceptedProgress({ kind: "ready", totalUnits: 12, remainingUnits: 3 })).toEqual({
      kind: "ready",
      total_units: 12,
      remaining_units: 3,
    });
    expect(printStatsAcceptedProgress({ kind: "empty" })).toEqual({ kind: "empty" });
    expect(printStatsAcceptedProgress({ kind: "integrity_failure", code: "progress" })).toEqual({
      kind: "unavailable",
      reason: "integrity",
    });
    expect(printStatsAcceptedProgress({ kind: "concurrent_update" })).toEqual({
      kind: "unavailable",
      reason: "concurrent_update",
    });
  });

  it("parses a valid accepted basis", () => {
    expect(
      parseAcceptedPlanBasis({
        profileId: 7,
        planVersion: 4,
        revisionId: 9,
        revisionDigest: digest,
        requiredUnitMappingDigest: digest,
      }),
    ).toEqual({
      profileId: 7,
      planVersion: 4,
      revisionId: 9,
      revisionDigest: digest,
      requiredUnitMappingDigest: digest,
    });
  });

  it("rejects invalid accepted basis input", () => {
    expect(parseAcceptedPlanBasis(null)).toBeNull();
    expect(parseAcceptedPlanBasis({ profileId: 0 })).toBeNull();
    expect(
      parseAcceptedPlanBasis({
        profileId: 7,
        planVersion: 4,
        revisionId: 9,
        revisionDigest: "bad",
        requiredUnitMappingDigest: digest,
      }),
    ).toBeNull();
  });
});
