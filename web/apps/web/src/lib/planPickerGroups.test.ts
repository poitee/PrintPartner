import { describe, expect, it } from "vitest";
import {
  canArchivePlan,
  partitionPlanPickerGroups,
  RECENT_PLAN_LIMIT,
  type PlanPickerRow,
} from "./planPickerGroups";

function row(
  partial: Partial<PlanPickerRow> & Pick<PlanPickerRow, "id" | "name">,
): PlanPickerRow {
  return {
    archived_at: null,
    last_used_at: null,
    ...partial,
  };
}

describe("partitionPlanPickerGroups", () => {
  it("puts current under Active, other non-archived under Recent, archived under Archived", () => {
    const plans = [
      row({ id: 1, name: "Current", last_used_at: "2026-08-14T10:00:00Z" }),
      row({ id: 2, name: "Older", last_used_at: "2026-08-13T10:00:00Z" }),
      row({
        id: 3,
        name: "Template",
        archived_at: "2026-08-01T00:00:00Z",
        last_used_at: "2026-07-01T00:00:00Z",
      }),
    ];
    const groups = partitionPlanPickerGroups(plans, 1, { search: "" });
    expect(groups.active.map((p) => p.id)).toEqual([1]);
    expect(groups.recent.map((p) => p.id)).toEqual([2]);
    expect(groups.archived.map((p) => p.id)).toEqual([3]);
  });

  it("sorts Recent by last_used_at desc and caps when not searching", () => {
    const plans = Array.from({ length: RECENT_PLAN_LIMIT + 3 }, (_, i) =>
      row({
        id: i + 1,
        name: `P${i}`,
        last_used_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const currentId = RECENT_PLAN_LIMIT + 3;
    const groups = partitionPlanPickerGroups(plans, currentId, { search: "" });
    expect(groups.recent).toHaveLength(RECENT_PLAN_LIMIT);
    expect(groups.recent[0]?.id).toBe(RECENT_PLAN_LIMIT + 2);
  });

  it("search reaches all plans including beyond Recent cap and archived", () => {
    const plans = [
      ...Array.from({ length: RECENT_PLAN_LIMIT + 2 }, (_, i) =>
        row({
          id: i + 1,
          name: `Keep ${i}`,
          last_used_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      ),
      row({
        id: 99,
        name: "Needle archived",
        archived_at: "2026-01-01T00:00:00Z",
      }),
    ];
    const groups = partitionPlanPickerGroups(plans, 1, { search: "needle" });
    expect(groups.active).toEqual([]);
    expect(groups.recent).toEqual([]);
    expect(groups.archived.map((p) => p.id)).toEqual([99]);
  });

  it("keeps archived current only in Active (not duplicated in Archived)", () => {
    const plans = [
      row({
        id: 1,
        name: "Done kit",
        archived_at: "2026-08-14T00:00:00Z",
      }),
      row({
        id: 2,
        name: "Other archived",
        archived_at: "2026-08-13T00:00:00Z",
      }),
    ];
    const groups = partitionPlanPickerGroups(plans, 1, { search: "" });
    expect(groups.active.map((p) => p.id)).toEqual([1]);
    expect(groups.archived.map((p) => p.id)).toEqual([2]);
  });
});

describe("canArchivePlan", () => {
  it("allows archive only when not archived, has units, and remaining is 0", () => {
    expect(
      canArchivePlan({
        archived: false,
        totalUnits: 10,
        remainingUnits: 0,
      }),
    ).toBe(true);
    expect(
      canArchivePlan({
        archived: true,
        totalUnits: 10,
        remainingUnits: 0,
      }),
    ).toBe(false);
    expect(
      canArchivePlan({
        archived: false,
        totalUnits: 10,
        remainingUnits: 1,
      }),
    ).toBe(false);
    expect(
      canArchivePlan({
        archived: false,
        totalUnits: 0,
        remainingUnits: 0,
      }),
    ).toBe(false);
  });
});
