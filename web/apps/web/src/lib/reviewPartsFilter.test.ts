import { describe, expect, it } from "vitest";
import type { PlanReview, ReviewPart } from "../api/engine";
import { filterReviewParts } from "./reviewPartsFilter";

function part(overrides: Partial<ReviewPart> & { id: number }): ReviewPart {
  return {
    match_key: "k",
    relative_path: "folder/a.stl",
    filename: "a.stl",
    source_layer: "base:main",
    status: "ok",
    role: "primary",
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 2,
    print_units: [true, false],
    printed_count: 1,
    missing: true,
    filament_display: "PLA Red",
    ...overrides,
  };
}

const emptyReview: PlanReview = {
  profile_id: 1,
  accepted_basis: null,
  plan_name: "T",
  layers: [],
  totals: {
    included_parts: 1,
    total_print_units: 2,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [],
};

describe("filterReviewParts", () => {
  const parts = [
    part({
      id: 1,
      filename: "a.stl",
      print_units: [true, false],
      printed_count: 1,
      missing: true,
    }),
    part({
      id: 2,
      filename: "b.stl",
      included: false,
      quantity_effective: 1,
      print_units: [false],
      printed_count: 0,
      missing: true,
    }),
    part({
      id: 3,
      filename: "c.stl",
      print_units: [true, true],
      printed_count: 2,
      missing: false,
      quantity_effective: 2,
    }),
  ];

  it("filters by print status missing and partial", () => {
    const missing = filterReviewParts(parts, emptyReview, {
      search: "",
      printFilter: "missing",
      includedFilter: "all",
      sourceLayer: null,
      folder: null,
      role: null,
      filament: null,
      issuesOnly: false,
      sort: "filename",
      functionalFilter: "all",
    });
    expect(missing.map((p) => p.id)).toEqual([2]);

    const partial = filterReviewParts(parts, emptyReview, {
      search: "",
      printFilter: "partial",
      includedFilter: "all",
      sourceLayer: null,
      folder: null,
      role: null,
      filament: null,
      issuesOnly: false,
      sort: "filename",
      functionalFilter: "all",
    });
    expect(partial.map((p) => p.id)).toEqual([1]);
  });

  it("filters by included only", () => {
    const out = filterReviewParts(parts, emptyReview, {
      search: "",
      printFilter: "all",
      includedFilter: "included",
      sourceLayer: null,
      folder: null,
      role: null,
      filament: null,
      issuesOnly: false,
      sort: "filename",
      functionalFilter: "all",
    });
    expect(out.map((p) => p.id)).toEqual([1, 3]);
  });

  it("matches search on filament display", () => {
    const out = filterReviewParts(parts, emptyReview, {
      search: "pla red",
      printFilter: "all",
      includedFilter: "all",
      sourceLayer: null,
      folder: null,
      role: null,
      filament: null,
      issuesOnly: false,
      sort: "filename",
      functionalFilter: "all",
    });
    expect(out.map((p) => p.id)).toEqual([1, 2, 3]);
  });
});
