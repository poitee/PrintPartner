import { describe, expect, it } from "vitest";
import type { PlanReview, ReviewPart } from "../api/engine";
import {
  countNonMissingPartWarnings,
  countPartWarnings,
  filenameImpliedQty,
  hasPartWarning,
  partWarningNote,
  partWarnings,
} from "./partWarnings";

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
    quantity_effective: 1,
    print_units: [false],
    printed_count: 0,
    missing: false,
    stl_missing: false,
    thumb_empty: false,
    filament_display: "PLA",
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
    total_print_units: 1,
    by_role: {},
    by_filament: {},
  },
  issues: [],
  has_blockers: false,
  part_groups: [],
};

describe("filenameImpliedQty", () => {
  it("reads trailing _xN markers", () => {
    expect(filenameImpliedQty("[a]_feet_x4.stl")).toBe(4);
    expect(filenameImpliedQty("bracket-x2.stl")).toBe(2);
  });

  it("returns null when no marker", () => {
    expect(filenameImpliedQty("bracket.stl")).toBeNull();
  });
});

describe("partWarnings", () => {
  it("flags missing, no role, and unparsed qty", () => {
    const p = part({
      id: 1,
      filename: "[a]_feet_x4.stl",
      role: null,
      stl_missing: true,
      quantity_auto: 1,
      quantity_effective: 1,
    });
    const kinds = partWarnings(p, emptyReview).map((w) => w.kind);
    expect(kinds).toEqual(["missing", "no_role", "qty_unparsed"]);
    // Card notes skip STL missing — desk-loop banner owns that CTA.
    expect(partWarningNote(p, emptyReview)).toBe("no role assigned");
  });

  it("does not treat checkoff missing as STL missing", () => {
    const p = part({ id: 9, missing: true, stl_missing: false });
    expect(partWarnings(p, emptyReview).map((w) => w.kind)).not.toContain("missing");
  });

  it("ignores qty when override is set or auto matches", () => {
    expect(
      hasPartWarning(
        part({
          id: 2,
          filename: "feet_x4.stl",
          quantity_auto: 4,
          quantity_effective: 4,
        }),
      ),
    ).toBe(false);
    expect(
      hasPartWarning(
        part({
          id: 3,
          filename: "feet_x4.stl",
          quantity_auto: 1,
          quantity_override: 4,
          quantity_effective: 4,
        }),
      ),
    ).toBe(false);
  });

  it("counts merge conflicts from review issues", () => {
    const review: PlanReview = {
      ...emptyReview,
      issues: [
        {
          severity: "warning",
          code: "merge_conflict",
          message: "Merge conflict for dup.stl — exclude duplicates on the Plan source cards.",
          link_hint: "build",
        },
      ],
    };
    const p = part({ id: 4, filename: "dup.stl" });
    expect(partWarnings(p, review).map((w) => w.kind)).toContain("merge_conflict");
    expect(countPartWarnings([p], review)).toBe(1);
  });
});

describe("countNonMissingPartWarnings", () => {
  it("ignores parts whose only issue is STL missing", () => {
    const parts = [
      part({ id: 1, stl_missing: true }),
      part({ id: 2, stl_missing: true, filename: "b.stl" }),
    ];
    expect(countPartWarnings(parts, emptyReview)).toBe(2);
    expect(countNonMissingPartWarnings(parts, emptyReview)).toBe(0);
  });

  it("counts parts with real (non-missing) warnings", () => {
    const parts = [
      part({ id: 1, stl_missing: true }),
      part({ id: 2, role: null, filename: "b.stl" }),
      part({ id: 3, stl_missing: true, role: null, filename: "c.stl" }),
    ];
    expect(countNonMissingPartWarnings(parts, emptyReview)).toBe(2);
  });
});
