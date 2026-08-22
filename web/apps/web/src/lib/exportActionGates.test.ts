import { describe, expect, it } from "vitest";
import { slicerExportGates } from "./exportActionGates";

describe("slicerExportGates", () => {
  const ready = {
    profileSelected: true,
    engineOk: true,
    hasReview: true,
  };

  it("enables Export STLs / remaining on a just-composed plan with unprinted units", () => {
    const gates = slicerExportGates({
      ...ready,
      includedCount: 12,
      remainingUnits: 40,
    });
    expect(gates.canExportParts).toBe(true);
    expect(gates.canExportRemaining).toBe(true);
  });

  it("disables Export remaining when remainingUnits is 0 (empty or fully printed)", () => {
    expect(
      slicerExportGates({ ...ready, includedCount: 0, remainingUnits: 0 }).canExportRemaining,
    ).toBe(false);
    expect(
      slicerExportGates({ ...ready, includedCount: 3, remainingUnits: 0 }).canExportRemaining,
    ).toBe(false);
  });

  it("still enables Export STLs when included parts exist (blockers are not a gate)", () => {
    // Fresh multi-source compose often has has_blockers from one missing STL;
    // that must not hard-disable the Export cards — server warns and packs the rest.
    const gates = slicerExportGates({
      ...ready,
      includedCount: 10,
      remainingUnits: 10,
    });
    expect(gates.canExportParts).toBe(true);
    expect(gates.canExportRemaining).toBe(true);
  });
});
