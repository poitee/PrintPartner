import { describe, expect, it } from "vitest";
import {
  bagRowId,
  defaultBagBarLabel,
  mergeVisibleProgressReorder,
  newBagBarId,
  parseProgressRowId,
  partRowId,
  reconcileProgressRows,
  rowsFromLegacyPartOrder,
  type ProgressRowRef,
} from "./progressListOrder";

describe("progressListOrder", () => {
  it("parses part and bag row ids", () => {
    expect(parseProgressRowId(partRowId(12))).toEqual({ kind: "part", id: 12 });
    expect(parseProgressRowId(bagRowId("abc"))).toEqual({ kind: "bag", id: "abc" });
    expect(parseProgressRowId(7)).toEqual({ kind: "part", id: 7 });
    expect(parseProgressRowId("nope")).toBeNull();
  });

  it("reconciles preferred order with bags and new parts", () => {
    const preferred: ProgressRowRef[] = [
      { kind: "bag", id: "b1", label: "Bag 1" },
      { kind: "part", id: 2 },
      { kind: "part", id: 99 },
      { kind: "bag", id: "gone", label: "x" },
    ];
    const next = reconcileProgressRows(
      preferred,
      [1, 2, 3],
      [
        { id: "b1", label: "Bag 1" },
        { id: "b2", label: "Bag 2" },
      ],
    );
    expect(next).toEqual([
      { kind: "bag", id: "b1", label: "Bag 1" },
      { kind: "part", id: 2 },
      { kind: "part", id: 1 },
      { kind: "part", id: 3 },
      { kind: "bag", id: "b2", label: "Bag 2" },
    ]);
  });

  it("migrates legacy part order", () => {
    expect(rowsFromLegacyPartOrder([3, 1], [{ id: "b", label: "Bag" }])).toEqual([
      { kind: "part", id: 3 },
      { kind: "part", id: 1 },
      { kind: "bag", id: "b", label: "Bag" },
    ]);
  });

  it("merges visible reorder across bags and parts", () => {
    const full: ProgressRowRef[] = [
      { kind: "part", id: 1 },
      { kind: "bag", id: "b1", label: "Bag 1" },
      { kind: "part", id: 2 },
      { kind: "part", id: 3 },
    ];
    const visibleBefore = [
      { kind: "bag" as const, id: "b1", label: "Bag 1" },
      { kind: "part" as const, id: 2 },
    ];
    const visibleAfter = [
      { kind: "part" as const, id: 2 },
      { kind: "bag" as const, id: "b1", label: "Bag 1" },
    ];
    expect(mergeVisibleProgressReorder(full, visibleBefore, visibleAfter)).toEqual([
      { kind: "part", id: 1 },
      { kind: "part", id: 2 },
      { kind: "bag", id: "b1", label: "Bag 1" },
      { kind: "part", id: 3 },
    ]);
  });

  it("creates bag ids", () => {
    expect(newBagBarId().length).toBeGreaterThan(4);
  });

  it("labels new bag/sort bars Bag 1, Bag 2, …", () => {
    expect(defaultBagBarLabel(0)).toBe("Bag 1");
    expect(defaultBagBarLabel(1)).toBe("Bag 2");
    expect(defaultBagBarLabel(3)).toBe("Bag 4");
  });
});
