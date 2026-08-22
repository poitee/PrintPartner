import { describe, expect, it } from "vitest";
import {
  mergeVisibleReorder,
  moveItem,
  moveItemById,
  reconcileOrder,
  sortByPreferredOrder,
} from "./reorderList";

describe("reorderList", () => {
  it("moveItem relocates an element", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("moveItem is a no-op for invalid indexes", () => {
    const items = ["a", "b"];
    expect(moveItem(items, -1, 0)).toBe(items);
    expect(moveItem(items, 0, 0)).toBe(items);
    expect(moveItem(items, 5, 0)).toBe(items);
  });

  it("moveItemById moves by identity", () => {
    expect(moveItemById([1, 2, 3, 4], 2, 4)).toEqual([1, 3, 4, 2]);
    expect(moveItemById([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
  });

  it("sortByPreferredOrder applies preferred ranks", () => {
    const items = [{ id: 3 }, { id: 1 }, { id: 2 }];
    expect(sortByPreferredOrder(items, [1, 2, 3], (x) => x.id).map((x) => x.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("sortByPreferredOrder keeps unknown ids after known, stable", () => {
    const items = [{ id: 9 }, { id: 1 }, { id: 8 }, { id: 2 }];
    expect(sortByPreferredOrder(items, [2, 1], (x) => x.id).map((x) => x.id)).toEqual([
      2, 1, 9, 8,
    ]);
  });

  it("mergeVisibleReorder splices filtered order into full order", () => {
    const full = [1, 2, 3, 4, 5];
    const visibleBefore = [2, 4];
    const visibleAfter = [4, 2];
    expect(mergeVisibleReorder(full, visibleBefore, visibleAfter)).toEqual([1, 4, 3, 2, 5]);
  });

  it("reconcileOrder drops stale and appends new", () => {
    expect(reconcileOrder([3, 1, 99, 1], [1, 2, 3])).toEqual([3, 1, 2]);
  });
});
