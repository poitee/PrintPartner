import { describe, expect, it } from "vitest";
import type { ReviewPart } from "../api/engine";
import {
  incompleteUnitsForParts,
  incompleteUnitsForSelectedParts,
} from "./printerCheckoffUnits";

function part(overrides: Partial<ReviewPart> & Pick<ReviewPart, "id">): ReviewPart {
  return {
    match_key: "k",
    relative_path: "a.stl",
    filename: "a.stl",
    source_layer: null,
    status: "ok",
    role: null,
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 2,
    quantity_override: null,
    quantity_effective: 2,
    print_units: [false, false],
    printed_count: 0,
    missing: true,
    filament_display: "",
    ...overrides,
  };
}

describe("printerCheckoffUnits", () => {
  it("collects incomplete units for missing included parts", () => {
    const parts = [
      part({ id: 1, print_units: [true, false], printed_count: 1, missing: true }),
      part({ id: 2, missing: false, print_units: [true, true], printed_count: 2 }),
      part({ id: 3, included: false, missing: true, print_units: [false] }),
    ];
    expect(incompleteUnitsForParts(parts)).toEqual([{ part_id: 1, unit_index: 1 }]);
  });

  it("filters by selected part ids", () => {
    const parts = [
      part({ id: 1 }),
      part({ id: 2, filename: "b.stl" }),
    ];
    expect(incompleteUnitsForSelectedParts(parts, [2])).toEqual([
      { part_id: 2, unit_index: 0 },
      { part_id: 2, unit_index: 1 },
    ]);
  });
});
