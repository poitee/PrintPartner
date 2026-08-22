import { describe, expect, it } from "vitest";
import {
  applyStackToggle,
  assembledEligibleUnitIndices,
  checkoffUnitTotals,
  formatCheckoffSummary,
  formatPrintedUnitsLine,
  isProgressRowBusy,
  lastCompletedUnit,
  nextUnitToComplete,
  partProgressPercent,
  partProgressTone,
  printedCountFromUnits,
} from "./checkoffProgress";

describe("applyStackToggle", () => {
  it("marks prefix through unit index when completing", () => {
    expect(applyStackToggle([false, false], 1, true)).toEqual([true, true]);
  });

  it("clears from unit index when uncompleting", () => {
    expect(applyStackToggle([true, true], 1, false)).toEqual([true, false]);
    expect(applyStackToggle([true, false], 0, false)).toEqual([false, false]);
  });
});

describe("printedCountFromUnits", () => {
  it("counts completed slots", () => {
    expect(printedCountFromUnits([true, false, true])).toBe(2);
  });
});

describe("checkoffUnitTotals", () => {
  it("sums units and percent", () => {
    expect(
      checkoffUnitTotals([
        { quantity_effective: 2, printed_count: 1, missing: true },
        { quantity_effective: 1, printed_count: 1, missing: false },
      ]),
    ).toEqual({
      printedUnits: 2,
      totalUnits: 3,
      remainingUnits: 1,
      percent: 66,
    });
  });

  it("handles empty", () => {
    expect(checkoffUnitTotals([])).toEqual({
      printedUnits: 0,
      totalUnits: 0,
      remainingUnits: 0,
      percent: 0,
    });
  });
});

describe("formatPrintedUnitsLine", () => {
  it("matches mock phrasing", () => {
    expect(
      formatPrintedUnitsLine([
        { quantity_effective: 2, printed_count: 1, missing: true },
        { quantity_effective: 1, printed_count: 1, missing: false },
      ]),
    ).toBe("2 of 3 printed");
  });
});

describe("formatCheckoffSummary", () => {
  it("sums only visible parts", () => {
    const text = formatCheckoffSummary([
      { quantity_effective: 1, printed_count: 1, missing: false },
      { quantity_effective: 2, printed_count: 1, missing: true },
    ]);
    expect(text).toBe("1/2 parts fully printed · 2/3 units");
  });

  it("handles empty list", () => {
    expect(formatCheckoffSummary([])).toBe(
      "0/0 parts fully printed · 0/0 units",
    );
  });
});

describe("partProgressTone / percent", () => {
  it("classifies empty / partial / done", () => {
    expect(partProgressTone(0, 2)).toBe("empty");
    expect(partProgressTone(1, 2)).toBe("partial");
    expect(partProgressTone(2, 2)).toBe("done");
    expect(partProgressPercent(1, 2)).toBe(50);
    expect(partProgressPercent(0, 0)).toBe(0);
  });
});

describe("unit steppers", () => {
  it("finds next and last completed indices", () => {
    expect(nextUnitToComplete([true, false, false])).toBe(1);
    expect(nextUnitToComplete([true, true])).toBe(-1);
    expect(lastCompletedUnit([true, true, false])).toBe(1);
    expect(lastCompletedUnit([false, false])).toBe(-1);
  });
});

describe("assembledEligibleUnitIndices", () => {
  it("returns only completed unit indices", () => {
    expect(assembledEligibleUnitIndices([true, false, true])).toEqual([0, 2]);
  });

  it("returns empty array when nothing is printed yet", () => {
    expect(assembledEligibleUnitIndices([false, false])).toEqual([]);
  });

  it("returns all indices when fully printed", () => {
    expect(assembledEligibleUnitIndices([true, true])).toEqual([0, 1]);
  });
});

describe("isProgressRowBusy", () => {
  it("marks only the row actually being saved as busy", () => {
    expect(isProgressRowBusy(7, 7)).toBe(true);
    expect(isProgressRowBusy(7, 8)).toBe(false);
  });

  it("leaves every row interactive when nothing is in flight", () => {
    expect(isProgressRowBusy(null, 7)).toBe(false);
  });

  it("does not lock the rest of a Voron-scale list while one part saves", () => {
    // 150 completed-but-not-assembled parts; toggling Assembled on one of them
    // must leave the other 149 rows clickable, not disable the whole list.
    const partIds = Array.from({ length: 150 }, (_, i) => i + 1);
    const busy = partIds.filter((id) => isProgressRowBusy(42, id));
    expect(busy).toEqual([42]);
  });
});
