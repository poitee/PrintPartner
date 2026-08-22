import { describe, expect, it } from "vitest";
import {
  countUnprintedUnits,
  filterCheckoffDisplayRows,
  unprintedCopies,
} from "./checkoff-missing.js";
import type { MergePart } from "./merge.js";

function mergePart(key: string, opts?: Partial<MergePart>): MergePart {
  return {
    matchKey: key,
    relativePath: key,
    filename: key.split("/").pop() ?? key,
    sourceLayer: "base:test",
    status: "base",
    role: "primary",
    quantityAuto: 1,
    partSlug: key,
    included: true,
    quantityOverride: null,
    notes: "",
    geometrySame: null,
    absolutePath: `/tmp/${key}`,
    ...opts,
  };
}

describe("checkoff-missing", () => {
  it("unprinted copies respect per-unit flags", () => {
    const parts = [mergePart("a.stl", { quantityAuto: 3, quantityOverride: 3 })];
    const copies = unprintedCopies(parts, { "a.stl": [true, false, false] });
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((c) => c.unit))).toEqual(new Set([2, 3]));
  });

  it("skips excluded and missing stl", () => {
    const parts = [
      mergePart("ok.stl"),
      mergePart("no.stl", { absolutePath: null }),
      mergePart("off.stl", { included: false }),
    ];
    expect(unprintedCopies(parts, {})).toHaveLength(1);
  });

  it("counts unprinted units and filters", () => {
    const rows = [
      { included: true, quantity_effective: 2, printed_count: 1 },
      { included: true, quantity_effective: 1, printed_count: 1 },
      { included: false, quantity_effective: 5, printed_count: 0 },
    ];
    expect(countUnprintedUnits(rows)).toBe(1);
    expect(filterCheckoffDisplayRows(rows, "missing")).toHaveLength(1);
    expect(filterCheckoffDisplayRows(rows, "done")).toHaveLength(1);
  });
});
