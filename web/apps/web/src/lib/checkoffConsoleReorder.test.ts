import { describe, expect, it } from "vitest";
import {
  canMoveCheckoffRow,
  checkoffRowIndex,
  checkoffRowPositionOptions,
  describeCheckoffRowPosition,
  moveCheckoffRow,
  moveCheckoffRowToPosition,
} from "./checkoffConsoleReorder";
import type { ProgressRowRef } from "./progressListOrder";

const rows: ProgressRowRef[] = [
  { kind: "part", id: 1 },
  { kind: "bag", id: "bag-a", label: "Bag 1" },
  { kind: "part", id: 2 },
  { kind: "part", id: 3 },
];

const ids = (list: ProgressRowRef[]) =>
  list.map((row) => (row.kind === "part" ? `part:${row.id}` : `bag:${row.id}`));

describe("checkoffRowIndex", () => {
  it("finds parts and bags by sortable id", () => {
    expect(checkoffRowIndex(rows, "part:2")).toBe(2);
    expect(checkoffRowIndex(rows, "bag:bag-a")).toBe(1);
    expect(checkoffRowIndex(rows, "part:99")).toBe(-1);
  });
});

describe("canMoveCheckoffRow", () => {
  it("blocks the ends of the list", () => {
    expect(canMoveCheckoffRow(rows, "part:1", "up")).toBe(false);
    expect(canMoveCheckoffRow(rows, "part:1", "down")).toBe(true);
    expect(canMoveCheckoffRow(rows, "part:3", "down")).toBe(false);
    expect(canMoveCheckoffRow(rows, "part:99", "up")).toBe(false);
  });
});

describe("moveCheckoffRow", () => {
  it("moves a row up one place", () => {
    expect(ids(moveCheckoffRow(rows, "part:2", "up"))).toEqual([
      "part:1",
      "part:2",
      "bag:bag-a",
      "part:3",
    ]);
  });

  it("moves a row down one place", () => {
    expect(ids(moveCheckoffRow(rows, "bag:bag-a", "down"))).toEqual([
      "part:1",
      "part:2",
      "bag:bag-a",
      "part:3",
    ]);
  });

  it("leaves the list alone at the ends and for unknown rows", () => {
    expect(ids(moveCheckoffRow(rows, "part:1", "up"))).toEqual(ids(rows));
    expect(ids(moveCheckoffRow(rows, "part:3", "down"))).toEqual(ids(rows));
    expect(ids(moveCheckoffRow(rows, "part:99", "down"))).toEqual(ids(rows));
  });
});

describe("moveCheckoffRowToPosition", () => {
  it("uses the 1-based position the operator reads", () => {
    expect(ids(moveCheckoffRowToPosition(rows, "part:3", 1))).toEqual([
      "part:3",
      "part:1",
      "bag:bag-a",
      "part:2",
    ]);
  });

  it("clamps out-of-range positions", () => {
    expect(ids(moveCheckoffRowToPosition(rows, "part:1", 99))).toEqual([
      "bag:bag-a",
      "part:2",
      "part:3",
      "part:1",
    ]);
    expect(ids(moveCheckoffRowToPosition(rows, "part:3", -4))).toEqual([
      "part:3",
      "part:1",
      "bag:bag-a",
      "part:2",
    ]);
  });

  it("does nothing when the row is already there", () => {
    expect(ids(moveCheckoffRowToPosition(rows, "part:1", 1))).toEqual(ids(rows));
    expect(ids(moveCheckoffRowToPosition(rows, "part:1", Number.NaN))).toEqual(ids(rows));
    expect(ids(moveCheckoffRowToPosition(rows, "part:99", 2))).toEqual(ids(rows));
  });
});

describe("position helpers", () => {
  it("lists every landing position", () => {
    expect(checkoffRowPositionOptions(3)).toEqual([
      { value: 1, label: "Position 1" },
      { value: 2, label: "Position 2" },
      { value: 3, label: "Position 3" },
    ]);
    expect(checkoffRowPositionOptions(-1)).toEqual([]);
  });

  it("describes where a row sits", () => {
    expect(describeCheckoffRowPosition(0, 4)).toBe("Position 1 of 4");
    expect(describeCheckoffRowPosition(-1, 4)).toBe("Not in the list");
  });
});
