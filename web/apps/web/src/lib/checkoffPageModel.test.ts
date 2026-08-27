import { describe, expect, it } from "vitest";
import {
  checkoffProgressDescription,
  checkoffProgressEyebrow,
  checkoffProgressMeta,
  filterProgressRows,
  isSameLiveStripState,
  orderedPartsFromRows,
  searchCheckoffParts,
} from "./checkoffPageModel";
import type { ReviewPart } from "../api/endpoints/planManifests";

function part(overrides: Partial<ReviewPart>): ReviewPart {
  return {
    id: overrides.id ?? 1,
    match_key: overrides.match_key ?? "part.stl",
    relative_path: overrides.relative_path ?? "folder/part.stl",
    filename: overrides.filename ?? "part.stl",
    source_layer: null,
    status: "active",
    role: "part",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    print_units: [false],
    printed_count: 0,
    missing: true,
    filament_display: "Red PLA",
    ...overrides,
  };
}

describe("checkoffPageModel", () => {
  it("compares live strip state by ids regardless of order", () => {
    expect(isSameLiveStripState(
      { anyPrinting: true, hostCount: 2, activeIntegrationIds: ["a"], idleIntegrationIds: ["b"] },
      { anyPrinting: true, hostCount: 2, activeIntegrationIds: ["b"], idleIntegrationIds: ["a"] },
    )).toBe(false);
    expect(isSameLiveStripState(
      { anyPrinting: true, hostCount: 2, activeIntegrationIds: ["a"], idleIntegrationIds: ["b"] },
      { anyPrinting: true, hostCount: 2, activeIntegrationIds: ["a"], idleIntegrationIds: ["b"] },
    )).toBe(true);
  });

  it("formats progress header copy", () => {
    const meta = checkoffProgressMeta({ selectedProfileId: 7, planName: "Build", includedPartCount: 2 });
    expect(meta).toBe("Build · 2 parts");
    expect(checkoffProgressEyebrow(meta)).toBe("Make · Build · 2 parts");
    expect(checkoffProgressDescription(0)).toContain("shop floor");
    expect(checkoffProgressDescription(1)).toContain("Verify");
  });

  it("searches parts and keeps bag bars that match", () => {
    const parts = [
      part({ id: 1, filename: "gear.stl", missing: true }),
      part({ id: 2, filename: "cover.stl", missing: false, filament_display: "Blue PLA" }),
    ];
    expect(searchCheckoffParts({ parts, search: "  " }).map((row) => row.id)).toEqual([1, 2]);
    const filtered = searchCheckoffParts({ parts, search: "blue" });
    expect(filtered.map((row) => row.id)).toEqual([2]);

    const visibleRows = filterProgressRows({
      rows: [{ kind: "bag", id: "bag", label: "Blue bag" }, { kind: "part", id: 1 }, { kind: "part", id: 2 }],
      visiblePartIds: new Set(filtered.map((row) => row.id)),
      search: "blue",
    });
    expect(visibleRows).toEqual([{ kind: "bag", id: "bag", label: "Blue bag" }, { kind: "part", id: 2 }]);
    expect(orderedPartsFromRows({ rows: visibleRows, partsById: new Map(parts.map((row) => [row.id, row])) }).map((row) => row.id)).toEqual([2]);
  });
});
