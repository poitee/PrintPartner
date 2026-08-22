import { describe, expect, it } from "vitest";
import type { PartRow, PlanReview } from "../api/engine";
import {
  filterPartsByQuery,
  mergeAssembledIntoReview,
  mergePartIntoReview,
  mergeProgressIntoReview,
  partitionIncludedParts,
  sourceLabelFromLayer,
} from "./reviewParts";

const samplePart = (overrides: Partial<PartRow> & { id: number }): PartRow & {
  print_units: boolean[];
  printed_count: number;
  missing: boolean;
  filament_display: string;
} => ({
  match_key: "k",
  relative_path: "a.stl",
  filename: "a.stl",
  source_layer: "base:main-kit",
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
  missing: true,
  filament_display: "",
  ...overrides,
});

describe("sourceLabelFromLayer", () => {
  it("extracts repo name after layer prefix", () => {
    expect(sourceLabelFromLayer("addon:extras")).toBe("extras");
    expect(sourceLabelFromLayer(null)).toBe("Other");
  });
});

describe("partitionIncludedParts", () => {
  it("splits and sorts by filename", () => {
    const { included, excluded } = partitionIncludedParts([
      samplePart({ id: 2, filename: "z.stl", included: false }),
      samplePart({ id: 1, filename: "a.stl", included: true }),
    ]);
    expect(included.map((p) => p.id)).toEqual([1]);
    expect(excluded.map((p) => p.id)).toEqual([2]);
  });
});

describe("filterPartsByQuery", () => {
  it("matches filename and source label", () => {
    const parts = [
      samplePart({ id: 1, filename: "bracket.stl" }),
      samplePart({ id: 2, filename: "wheel.stl", source_layer: "addon:wheels" }),
    ];
    expect(filterPartsByQuery(parts, "wheels").map((p) => p.id)).toEqual([2]);
    expect(filterPartsByQuery(parts, "bracket").map((p) => p.id)).toEqual([1]);
  });
});

describe("mergePartIntoReview", () => {
  it("updates totals when a part is excluded", () => {
    const review: PlanReview = {
      profile_id: 1,
      accepted_basis: null,
      plan_name: "Test",
      layers: [],
      totals: {
        included_parts: 1,
        total_print_units: 2,
        by_role: { primary: 1 },
        by_filament: {},
      },
      issues: [],
      has_blockers: false,
      part_groups: [
        {
          folder: "(root)",
          source_layer: "base:main-kit",
          parts: [samplePart({ id: 1, quantity_effective: 2 })],
        },
      ],
    };
    const next = mergePartIntoReview(
      review,
      samplePart({ id: 1, included: false, quantity_effective: 2 }),
    );
    expect(next.totals.included_parts).toBe(0);
    expect(next.totals.total_print_units).toBe(0);
  });
});

describe("mergeAssembledIntoReview", () => {
  const review: PlanReview = {
    profile_id: 1,
    accepted_basis: null,
    plan_name: "Test",
    layers: [],
    totals: {
      included_parts: 1,
      total_print_units: 1,
      by_role: { primary: 1 },
      by_filament: {},
    },
    issues: [],
    has_blockers: false,
    part_groups: [
      {
        folder: "(root)",
        source_layer: "base:main-kit",
        parts: [
          {
            ...samplePart({ id: 1 }),
            print_units: [true],
            printed_count: 1,
            missing: false,
          },
        ],
      },
    ],
  };

  it("sets assembled_units on the matching part without touching other fields", () => {
    const next = mergeAssembledIntoReview(review, 1, { assembled_units: [true] });
    const part = next.part_groups[0].parts[0];
    expect(part.assembled_units).toEqual([true]);
    // Unrelated print progress fields are untouched.
    expect(part.printed_count).toBe(1);
    expect(part.print_units).toEqual([true]);
  });

  it("leaves other parts unchanged", () => {
    const twoPartReview: PlanReview = {
      ...review,
      part_groups: [
        {
          ...review.part_groups[0],
          parts: [
            ...review.part_groups[0].parts,
            { ...samplePart({ id: 2 }), print_units: [true], printed_count: 1, missing: false },
          ],
        },
      ],
    };
    const next = mergeAssembledIntoReview(twoPartReview, 1, { assembled_units: [true] });
    const untouched = next.part_groups[0].parts.find((p) => p.id === 2);
    expect(untouched?.assembled_units).toBeUndefined();
  });
});

describe("mergeProgressIntoReview + assembly tracking", () => {
  /** A 2-unit part, both printed and both marked assembled. */
  const builtReview = (): PlanReview =>
    ({
      profile_id: 1,
      accepted_basis: null,
      plan_name: "Voron 2.4",
      layers: [],
      totals: { included_parts: 1, total_print_units: 2, by_role: {}, by_filament: {} },
      issues: [],
      has_blockers: false,
      part_groups: [
        {
          folder: "(root)",
          source_layer: "base:main-kit",
          parts: [
            {
              ...samplePart({ id: 1, quantity_effective: 2 }),
              print_units: [true, true],
              printed_count: 2,
              missing: false,
              assembled_units: [true, true],
            },
          ],
        },
      ],
    }) as unknown as PlanReview;

  it("clears assembled state for a unit that was just un-printed", () => {
    // Regression: without this, un-printing unit #2 left assembled=true behind,
    // so re-checking the print resurrected a phantom "Assembled" toggle.
    const next = mergeProgressIntoReview(builtReview(), 1, {
      printed_count: 1,
      print_units: [true, false],
      missing: true,
    });
    expect(next.part_groups[0].parts[0].assembled_units).toEqual([true, false]);
  });

  it("prefers the server's authoritative assembled_units when present", () => {
    const next = mergeProgressIntoReview(builtReview(), 1, {
      printed_count: 1,
      print_units: [true, false],
      missing: true,
      assembled_units: [false, false],
    });
    expect(next.part_groups[0].parts[0].assembled_units).toEqual([false, false]);
  });

  it("keeps assembled state on units that are still printed", () => {
    const next = mergeProgressIntoReview(builtReview(), 1, {
      printed_count: 2,
      print_units: [true, true],
      missing: false,
    });
    expect(next.part_groups[0].parts[0].assembled_units).toEqual([true, true]);
  });

  it("is a no-op for parts that never had assembly tracking data", () => {
    const review = builtReview();
    delete (review.part_groups[0].parts[0] as { assembled_units?: boolean[] }).assembled_units;
    const next = mergeProgressIntoReview(review, 1, {
      printed_count: 1,
      print_units: [true, false],
      missing: true,
    });
    expect(next.part_groups[0].parts[0].assembled_units).toBeUndefined();
    expect(next.part_groups[0].parts[0].printed_count).toBe(1);
  });
});
