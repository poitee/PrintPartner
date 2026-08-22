import { describe, expect, it } from "vitest";
import {
  dedupeProgressRows,
  ensureProgressRows,
  getAssembledUnits,
  setAssembledUnit,
  setPrintedUnitCount,
  toggleCheckoffUnit,
  type ProgressRow,
} from "./print-progress.js";

const rows = (...specs: Array<[number, boolean, boolean?]>): ProgressRow[] =>
  specs.map(([unitIndex, completed, assembled], i) => ({
    id: i + 1,
    partId: 1,
    unitIndex,
    completed,
    ...(assembled === undefined ? {} : { assembled }),
  }));

describe("assembled field on print_progress rows", () => {
  it("defaults to false for newly materialised units", () => {
    const ensured = ensureProgressRows([], 1, 3);
    expect(ensured).toHaveLength(3);
    expect(ensured.every((r) => r.assembled === false)).toBe(true);
    expect(getAssembledUnits(ensured, 3)).toEqual([false, false, false]);
  });

  it("reports a unit assembled only when it is also completed", () => {
    // assembled=true on an unprinted unit must not count — printed is a
    // precondition for installed.
    expect(getAssembledUnits(rows([0, false, true], [1, true, true]), 2)).toEqual([false, true]);
  });

  it("sets and clears the flag on a completed unit", () => {
    const start = ensureProgressRows(rows([0, true], [1, true]), 1, 2);
    const on = setAssembledUnit(start, 1, 2, 0, true);
    expect(getAssembledUnits(on, 2)).toEqual([true, false]);

    const off = setAssembledUnit(on, 1, 2, 0, false);
    expect(getAssembledUnits(off, 2)).toEqual([false, false]);
  });

  it("refuses to assemble a unit that is not printed", () => {
    const start = ensureProgressRows(rows([0, false]), 1, 1);
    const out = setAssembledUnit(start, 1, 1, 0, true);
    expect(getAssembledUnits(out, 1)).toEqual([false]);
    expect(out[0].assembled).toBe(false);
  });

  it("ignores an out-of-range unit index", () => {
    const start = ensureProgressRows(rows([0, true]), 1, 1);
    expect(setAssembledUnit(start, 1, 1, 5, true)).toBe(start);
    expect(setAssembledUnit(start, 1, 1, -1, true)).toBe(start);
  });

  it("leaves other parts' rows untouched", () => {
    const other: ProgressRow = { id: 9, partId: 2, unitIndex: 0, completed: true, assembled: true };
    const out = setAssembledUnit([...ensureProgressRows([], 1, 1), other], 1, 1, 0, false);
    expect(out.find((r) => r.partId === 2)).toEqual(other);
  });

  it("clears assembled when a unit is un-printed", () => {
    const assembled = setAssembledUnit(ensureProgressRows(rows([0, true]), 1, 1), 1, 1, 0, true);
    expect(getAssembledUnits(assembled, 1)).toEqual([true]);

    // Uncheck the print — the stale assembled flag must not survive to
    // resurrect when the unit is re-checked.
    const unprinted = toggleCheckoffUnit(assembled, 1, 1, 0, false);
    expect(unprinted.find((r) => r.unitIndex === 0)?.assembled).toBe(false);

    const reprinted = toggleCheckoffUnit(unprinted, 1, 1, 0, true);
    expect(getAssembledUnits(reprinted, 1)).toEqual([false]);
  });

  it("preserves assembled on units that stay printed when the count changes", () => {
    const base = setAssembledUnit(ensureProgressRows(rows([0, true], [1, true]), 1, 2), 1, 2, 0, true);
    // Drop from 2 printed to 1: unit 0 keeps its flag, unit 1 is cleared.
    const shrunk = setPrintedUnitCount(base, 1, 2, 1);
    expect(getAssembledUnits(shrunk, 2)).toEqual([true, false]);
  });

  it("OR-merges the flag across duplicate rows for one unit", () => {
    const deduped = dedupeProgressRows(rows([0, true, false], [0, true, true]));
    expect(deduped).toHaveLength(1);
    expect(deduped[0].assembled).toBe(true);
  });
});
