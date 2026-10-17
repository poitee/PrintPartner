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
  const oldTokenByCoordinate = new Map([
    ["10:0", "token-a"],
    ["10:1", "token-b"],
    ["10:2", "token-c"],
  ]);
  const identity = new Map([
    ["token-a", { draftPartId: 42, unitIndex: 0 }],
    ["token-b", { draftPartId: 42, unitIndex: 1 }],
  ]);
  const base = {
    profileId: 7,
    sendQueueRaw: null,
    oldPartMatchKeyById,
    partProfileIdById,
    newPartByMatchKey,
    oldTokenByCoordinate,
    newCoordinateByToken: identity,
  };
  const link = (units: unknown[], resolvedUnits?: unknown[]) =>
    JSON.stringify([
      { id: "link-one", profile_id: 7, filename: "a.stl", units, resolved_units: resolvedUnits },
    ]);

  it("remaps checkoff and queue units to the new coordinate of the same Required unit", () => {
    const result = assessCheckoffRemap({
      ...base,
      checkoffLinksRaw: link([{ part_id: 10, unit_index: 0 }]),
      sendQueueRaw: JSON.stringify([
        { id: "queue-one", filename: "a.gcode", checkoff_units: [{ part_id: 10, unit_index: 1 }] },
      ]),
    });

    expect(result.kind).toBe("safe");
    if (result.kind === "safe") {
      expect([...result.remapByCoordinate.entries()]).toEqual([
        ["10:0", { draftPartId: 42, unitIndex: 0 }],
        ["10:1", { draftPartId: 42, unitIndex: 1 }],
      ]);
    }
  });

  it("follows a kept unit to its new index when an earlier unit is dropped", () => {
    // Quantity 3 -> 2: token-a (index 0) is dropped, token-b and token-c move down one index.
    const result = assessCheckoffRemap({
      ...base,
      checkoffLinksRaw: link([{ part_id: 10, unit_index: 1 }]),
      newCoordinateByToken: new Map([
        ["token-b", { draftPartId: 42, unitIndex: 0 }],
        ["token-c", { draftPartId: 42, unitIndex: 1 }],
      ]),
    });

    expect(result.kind).toBe("safe");
    if (result.kind === "safe") {
      expect([...result.remapByCoordinate.entries()]).toEqual([
        ["10:1", { draftPartId: 42, unitIndex: 0 }],
      ]);
    }
  });

  it("refuses a coordinate whose Required unit is dropped, even when its index still exists", () => {
    const result = assessCheckoffRemap({
      ...base,
      checkoffLinksRaw: link([{ part_id: 10, unit_index: 0 }]),
      newCoordinateByToken: new Map([
        ["token-b", { draftPartId: 42, unitIndex: 0 }],
        ["token-c", { draftPartId: 42, unitIndex: 1 }],
      ]),
    });

    expect(result).toEqual({
      kind: "unsafe",
      unmappable: [
        {
          linkId: "link-one",
          filename: "a.stl",
          reason: "Required unit at Part 10 index 0 is absent or excluded in the selected Plan",
        },
      ],
    });
  });

  it("refuses a resolved-only coordinate whose Required unit is dropped", () => {
    const result = assessCheckoffRemap({
      ...base,
      checkoffLinksRaw: link([{ part_id: 10, unit_index: 1 }], [{ part_id: 10, unit_index: 0, result: "printed" }]),
      newCoordinateByToken: new Map([["token-b", { draftPartId: 42, unitIndex: 0 }]]),
    });

    expect(result).toMatchObject({
      kind: "unsafe",
      unmappable: [{ reason: "Required unit at Part 10 index 0 is absent or excluded in the selected Plan" }],
    });
  });

  it("reports unsafe remaps when the new quantity no longer has the checked unit", () => {
    const result = assessCheckoffRemap({
      ...base,
      checkoffLinksRaw: link([{ part_id: 10, unit_index: 2 }]),
    });

    expect(result).toEqual({
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
      ...base,
      checkoffLinksRaw: null,
      sendQueueRaw: JSON.stringify([
        { id: "queue-other", filename: "b.gcode", checkoff_units: [{ part_id: 99, unit_index: 0 }] },
      ]),
      partProfileIdById: new Map([[99, 8]]),
    });

    expect(result.kind).toBe("safe");
    if (result.kind === "safe") expect(result.remapByCoordinate.size).toBe(0);
  });
});
