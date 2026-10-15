import { describe, expect, it } from "vitest";
import type { acceptedPlateUnits } from "./db/schema.js";
import { chargeOwnershipPlateComparisons, OwnershipPlateComparisonBudgetError } from "./ownership-plate-history.js";

type Placement = typeof acceptedPlateUnits.$inferSelect.placement;
const units = (revisionId: number, plateId: string, count: number, placement: Placement = "auto") =>
  Array.from({ length: count }, () => ({ revisionId, plateId, placement }));
function refusal(operation: () => unknown) {
  try { operation(); } catch (error) {
    if (error instanceof OwnershipPlateComparisonBudgetError) return { message: error.message, limit: error.limit, charged: error.charged };
    throw error;
  }
  throw new Error("Expected comparison budget refusal");
}

describe("chargeOwnershipPlateComparisons", () => {
  it("charges legacy and current pair attempts below and at the limit", () => {
    expect(chargeOwnershipPlateComparisons(units(1, "plate", 3), 7)).toBe(6);
    expect(chargeOwnershipPlateComparisons(units(1, "plate", 3), 6)).toBe(6);
  });

  it("refuses one Plate over the limit with a typed error", () => {
    expect(refusal(() => chargeOwnershipPlateComparisons(units(1, "plate", 3), 5)))
      .toEqual({ message: "Unsafe accepted Plate history: comparison budget", limit: 5, charged: 6 });
  });

  it("aggregates individually admitted Plates across revisions", () => {
    const history = [...units(1, "plate", 3), ...units(2, "plate", 3, "manual")];
    expect(chargeOwnershipPlateComparisons(history, 12)).toBe(12);
    expect(refusal(() => chargeOwnershipPlateComparisons(history, 11)))
      .toEqual({ message: "Unsafe accepted Plate history: comparison budget", limit: 11, charged: 12 });
  });

  it("aggregates interleaved Plates within one revision", () => {
    const history = Array.from({ length: 3 }, () => [...units(1, "left", 1), ...units(1, "right", 1)]).flat();
    expect(chargeOwnershipPlateComparisons(history, 12)).toBe(12);
    expect(refusal(() => chargeOwnershipPlateComparisons(history, 11)))
      .toEqual({ message: "Unsafe accepted Plate history: comparison budget", limit: 11, charged: 12 });
  });

  it("keeps revision and Plate identities distinct", () => {
    expect(chargeOwnershipPlateComparisons([...units(1, "2p", 2), ...units(12, "p", 2)], 4)).toBe(4);
  });

  it("does not charge unplaced units", () => {
    expect(chargeOwnershipPlateComparisons([...units(1, "plate", 5, "unplaced"), ...units(1, "plate", 3, "manual")], 6)).toBe(6);
    expect(chargeOwnershipPlateComparisons(units(1, "plate", 10, "unplaced"), 0)).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid or raised limit %s", limit => {
    expect(() => chargeOwnershipPlateComparisons([], limit)).toThrow(RangeError);
  });

  it("reserves both attempts even when a single attempt would fit", () => {
    expect(refusal(() => chargeOwnershipPlateComparisons(units(1, "plate", 4), 6)))
      .toEqual({ message: "Unsafe accepted Plate history: comparison budget", limit: 6, charged: 12 });
  });

  it("stops at the first unit that crosses the limit", () => {
    function* history() {
      yield* units(1, "plate", 2);
      throw new Error("Read beyond the budget refusal");
    }
    expect(refusal(() => chargeOwnershipPlateComparisons(history(), 1)))
      .toEqual({ message: "Unsafe accepted Plate history: comparison budget", limit: 1, charged: 2 });
  });
});
