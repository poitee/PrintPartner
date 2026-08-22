import { describe, expect, it } from "vitest";
import { DESK_NEXT_STEP, deskNextStepLine, deskNextStepVisible } from "./deskNextStep";

describe("deskNextStep", () => {
  it("keeps exact copy", () => {
    expect(DESK_NEXT_STEP.library).toBe("Add a source, then New Build.");
    expect(DESK_NEXT_STEP.plan).toBe("Attach sources, pick files, assign colors.");
    expect(DESK_NEXT_STEP.parts).toBe("Check qty. Conflicts: exclude on Plan.");
    expect(DESK_NEXT_STEP.progress).toBe(
      "Remaining is the work. Add bag/sort when you bag.",
    );
    expect(DESK_NEXT_STEP.export).toBe(
      "Send remaining STLs to the slicer, then choose the .gcode here.",
    );
  });

  it("hides library when sources exist", () => {
    expect(deskNextStepVisible("library", { sourceCount: 0 })).toBe(true);
    expect(deskNextStepVisible("library", { sourceCount: 2 })).toBe(false);
  });

  it("shows plan until attach, parts, and colors are done", () => {
    expect(
      deskNextStepVisible("plan", {
        attachedSourceCount: 1,
        partCount: 10,
        colorsUnset: false,
      }),
    ).toBe(false);
    expect(
      deskNextStepLine("plan", {
        attachedSourceCount: 1,
        partCount: 10,
        colorsUnset: true,
      }),
    ).toBe(DESK_NEXT_STEP.plan);
  });

  it("hides parts next-step when no conflicts and no missing STLs", () => {
    expect(
      deskNextStepVisible("parts", {
        partCount: 10,
        mergeConflictCount: 0,
        missingStlCount: 0,
      }),
    ).toBe(false);
    expect(
      deskNextStepVisible("parts", {
        partCount: 10,
        mergeConflictCount: 0,
        missingStlCount: 2,
      }),
    ).toBe(true);
  });
});
