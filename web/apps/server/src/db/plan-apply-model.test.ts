import { describe, expect, it } from "vitest";
import {
  applyJsonRecord,
  applySettingArray,
  assessCheckoffRemap,
  planApplyRequestDigest,
  positiveSafeId,
} from "./plan-apply-model.js";

describe("positiveSafeId", () => {
  it("accepts positive safe integers", () => {
    expect(positiveSafeId(7, "Build ID")).toBe(7);
  });

  it("rejects zero, negative, and unsafe ids", () => {
    expect(() => positiveSafeId(0, "Build ID")).toThrow("Build ID is invalid");
    expect(() => positiveSafeId(-1, "Build ID")).toThrow("Build ID is invalid");
    expect(() => positiveSafeId(Number.MAX_SAFE_INTEGER + 1, "Build ID")).toThrow(
      "Build ID is invalid",
    );
  });
});

describe("planApplyRequestDigest", () => {
  it("changes when an apply precondition changes", () => {
    const base = {
      profileId: 1,
      draftId: 2,
      expectedSnapshotDigest: "a".repeat(64),
      expectedLifecycleVersion: 3,
      expectedBaseRevisionId: 4,
      expectedBasePlanVersion: 5,
    };

    expect(planApplyRequestDigest(base)).toHaveLength(64);
    expect(planApplyRequestDigest(base)).not.toBe(
      planApplyRequestDigest({ ...base, expectedBasePlanVersion: 6 }),
    );
  });
});

describe("apply JSON helpers", () => {
  it("parses setting arrays", () => {
    expect(applySettingArray('[{"id":"one"}]', "Setting")).toEqual([{ id: "one" }]);
    expect(applySettingArray(null, "Setting")).toEqual([]);
  });

  it("rejects corrupt values", () => {
    expect(() => applySettingArray("{}", "Setting")).toThrow("Setting is corrupt");
    expect(() => applySettingArray("nope", "Setting")).toThrow("Setting is corrupt");
    expect(() => applyJsonRecord([], "Row")).toThrow("Row is corrupt");
  });
});

describe("assessCheckoffRemap", () => {
  const oldPartMatchKeyById = new Map([[10, "frame/a.stl"]]);
  const partProfileIdById = new Map([[10, 7]]);
  const newPartByMatchKey = new Map([
    ["frame/a.stl", { draftPartId: 42, quantityEffective: 2 }],
  ]);

  it("remaps checkoff and queue units by old part id and unit index", () => {
    const result = assessCheckoffRemap({
      profileId: 7,
      checkoffLinksRaw: JSON.stringify([
        { id: "link-one", profile_id: 7, filename: "a.stl", units: [{ part_id: 10, unit_index: 0 }] },
      ]),
      sendQueueRaw: JSON.stringify([
        { id: "queue-one", filename: "a.gcode", checkoff_units: [{ part_id: 10, unit_index: 1 }] },
      ]),
      oldPartMatchKeyById,
      partProfileIdById,
      newPartByMatchKey,
    });

    expect(result.kind).toBe("safe");
    if (result.kind === "safe") {
      expect([...result.remapByDraftPart.entries()]).toEqual([
        ["10:0", 42],
        ["10:1", 42],
      ]);
    }
  });

  it("reports unsafe remaps when the new quantity no longer has the checked unit", () => {
    const result = assessCheckoffRemap({
      profileId: 7,
      checkoffLinksRaw: JSON.stringify([
        { id: "link-one", profile_id: 7, filename: "a.stl", units: [{ part_id: 10, unit_index: 2 }] },
      ]),
      sendQueueRaw: null,
      oldPartMatchKeyById,
      partProfileIdById,
      newPartByMatchKey,
    });

    expect(result).toMatchObject({
      kind: "unsafe",
      unmappable: [
        {
          linkId: "link-one",
          filename: "a.stl",
          reason: 'Checked-off unit index 2 exceeds the new quantity (2) for "a.stl"',
        },
      ],
    });
  });

  it("ignores queue items that clearly belong to another plan", () => {
    const result = assessCheckoffRemap({
      profileId: 7,
      checkoffLinksRaw: null,
      sendQueueRaw: JSON.stringify([
        { id: "queue-other", filename: "b.gcode", checkoff_units: [{ part_id: 99, unit_index: 0 }] },
      ]),
      oldPartMatchKeyById,
      partProfileIdById: new Map([[99, 8]]),
      newPartByMatchKey,
    });

    expect(result.kind).toBe("safe");
    if (result.kind === "safe") expect(result.remapByDraftPart.size).toBe(0);
  });
});
