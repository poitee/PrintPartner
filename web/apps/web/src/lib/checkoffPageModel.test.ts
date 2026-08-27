import { describe, expect, it } from "vitest";
import {
  CHECKOFF_FILTER_MODES,
  checkoffProgressDescription,
  checkoffProgressEyebrow,
  checkoffProgressMeta,
  checkoffProgressMode,
  filterCheckoffParts,
  filterProgressRows,
  haveSameIds,
  isSameLiveStripState,
  orderedPartsFromRows,
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
  it("defines the page filter labels in display order", () => {
    expect(CHECKOFF_FILTER_MODES).toEqual([
      { mode: "missing", label: "Remaining" },
      { mode: "done", label: "Done" },
      { mode: "all", label: "All" },
    ]);
  });


  it("compares live strip state by ids regardless of order", () => {
    expect(haveSameIds(["a", "b"], ["b", "a"])).toBe(true);
    expect(isSameLiveStripState(
      { anyPrinting: true, hostCount: 2, activeIntegrationIds: ["a"], idleIntegrationIds: ["b"] },
      { anyPrinting: true, hostCount: 2, activeIntegrationIds: ["a"], idleIntegrationIds: ["b"] },
    )).toBe(true);
  });

  it("keeps verify-first progress mode", () => {
    expect(checkoffProgressMode({ liveStrip: { anyPrinting: true }, verifyQueue: { awaitingCount: 1, watchingCount: 0 } })).toBe("verify");
    expect(checkoffProgressMode({ liveStrip: { anyPrinting: true }, verifyQueue: { awaitingCount: 0, watchingCount: 0 } })).toBe("printing");
    expect(checkoffProgressMode({ liveStrip: { anyPrinting: false }, verifyQueue: { awaitingCount: 0, watchingCount: 0 } })).toBe("idle");
  });

  it("formats progress header copy", () => {
    const meta = checkoffProgressMeta({ selectedProfileId: 7, planName: "Build", includedPartCount: 2 });
    expect(meta).toBe("Build · 2 parts");
    expect(checkoffProgressEyebrow(meta)).toBe("Stage 3 of 4 · Build · 2 parts");
    expect(checkoffProgressDescription(0)).toContain("shop floor");
    expect(checkoffProgressDescription(1)).toContain("Verify");
  });

  it("filters parts and progress rows", () => {
    const parts = [
      part({ id: 1, filename: "gear.stl", missing: true }),
      part({ id: 2, filename: "cover.stl", missing: false, filament_display: "Blue PLA" }),
    ];
    const filtered = filterCheckoffParts({ parts, filter: "done", search: "blue" });
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
