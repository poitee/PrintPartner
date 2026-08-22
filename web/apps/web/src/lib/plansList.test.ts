import { describe, expect, it } from "vitest";
import {
  canArchiveAcceptedPlan,
  filterPlansList,
  planProgressLabel,
  planStatusLabel,
  type PlansListRow,
} from "./plansList";

function row(
  partial: Partial<PlansListRow> & Pick<PlansListRow, "id" | "name">,
): PlansListRow {
  return {
      archived_at: null,
    part_count: 0,
    accepted_progress: { kind: "empty" },
    build_stale: false,
    last_used_at: null,
    ...partial,
  };
}

describe("filterPlansList", () => {
  it("filters Active / Archived / All and sorts by name", () => {
    const plans = [
      row({ id: 1, name: "Zebra", archived_at: null }),
      row({ id: 2, name: "Alpha", archived_at: "2026-08-01T00:00:00Z" }),
      row({ id: 3, name: "Beta", archived_at: null }),
    ];
    expect(filterPlansList(plans, "active").map((p) => p.name)).toEqual([
      "Beta",
      "Zebra",
    ]);
    expect(filterPlansList(plans, "archived").map((p) => p.name)).toEqual([
      "Alpha",
    ]);
    expect(filterPlansList(plans, "all").map((p) => p.name)).toEqual([
      "Alpha",
      "Beta",
      "Zebra",
    ]);
  });

  it("does not cap the list", () => {
    const plans = Array.from({ length: 21 }, (_, i) =>
      row({ id: i + 1, name: `Plan ${String(i).padStart(2, "0")}` }),
    );
    expect(filterPlansList(plans, "all")).toHaveLength(21);
  });

  it("filters by name search", () => {
    const plans = [
      row({ id: 1, name: "Voron Trident" }),
      row({ id: 2, name: "A1 Mini" }),
      row({ id: 3, name: "Voron 0.2" }),
    ];
    expect(filterPlansList(plans, "all", "voron").map((p) => p.name)).toEqual([
      "Voron 0.2",
      "Voron Trident",
    ]);
  });

  it("sorts by recent last-used when asked", () => {
    const plans = [
      row({ id: 1, name: "Alpha", last_used_at: "2026-08-01T00:00:00Z" }),
      row({ id: 2, name: "Beta", last_used_at: "2026-08-20T00:00:00Z" }),
      row({ id: 3, name: "Gamma", last_used_at: null }),
    ];
    expect(filterPlansList(plans, "all", "", "recent").map((p) => p.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });
});

describe("planStatusLabel", () => {
  it("labels archived vs active", () => {
    expect(planStatusLabel({ archived_at: null })).toBe("Active");
    expect(planStatusLabel({ archived_at: "2026-08-14T00:00:00Z" })).toBe(
      "Archived",
    );
  });
});

describe("accepted Progress display", () => {
  it("labels every Progress state", () => {
    expect(planProgressLabel({ kind: "ready", total_units: 5, remaining_units: 2 })).toBe(
      "2 remaining",
    );
    expect(planProgressLabel({ kind: "ready", total_units: 0, remaining_units: 0 })).toBe(
      "No required units",
    );
    expect(planProgressLabel({ kind: "empty" })).toBe("Not applied");
    for (const reason of [
      "compatibility_dirty",
      "uninitialized",
      "integrity",
      "concurrent_update",
    ] as const) {
      expect(planProgressLabel({ kind: "unavailable", reason })).toBe(
        "Checkoff unavailable",
      );
    }
  });

  it("allows archive only for active complete Plans with required units", () => {
    expect(
      canArchiveAcceptedPlan({
        archived_at: null,
        accepted_progress: { kind: "ready", total_units: 5, remaining_units: 0 },
      }),
    ).toBe(true);
    for (const accepted_progress of [
      { kind: "ready", total_units: 0, remaining_units: 0 } as const,
      { kind: "ready", total_units: 5, remaining_units: 1 } as const,
      { kind: "empty" } as const,
      { kind: "unavailable", reason: "uninitialized" } as const,
    ]) {
      expect(canArchiveAcceptedPlan({ archived_at: null, accepted_progress })).toBe(false);
    }
    expect(
      canArchiveAcceptedPlan({
        archived_at: "2026-08-21T12:00:00.000Z",
        accepted_progress: { kind: "ready", total_units: 5, remaining_units: 0 },
      }),
    ).toBe(false);
  });
});
