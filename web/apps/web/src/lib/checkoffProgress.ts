/** Client-side checkoff summary (matches backend progress_summary on included parts). */

export type CheckoffSummaryPart = {
  quantity_effective: number;
  printed_count: number;
  missing: boolean;
};

export type CheckoffUnitTotals = {
  printedUnits: number;
  totalUnits: number;
  remainingUnits: number;
  /** 0–100, floored; 0 when totalUnits is 0. */
  percent: number;
};

export type PartProgressTone = "empty" | "partial" | "done";

export function isPartFullyPrinted(part: CheckoffSummaryPart): boolean {
  const qty = Math.max(1, part.quantity_effective);
  return part.printed_count >= qty;
}

/** Mirror backend stack toggle: first N units printed (checkoff UX). */
export function applyStackToggle(
  units: boolean[],
  unitIndex: number,
  completed: boolean,
): boolean[] {
  const qty = Math.max(1, units.length);
  const count = completed ? unitIndex + 1 : unitIndex;
  const clamped = Math.max(0, Math.min(count, qty));
  return Array.from({ length: qty }, (_, i) => i < clamped);
}

export function printedCountFromUnits(units: boolean[]): number {
  return units.filter(Boolean).length;
}

export function checkoffUnitTotals(parts: CheckoffSummaryPart[]): CheckoffUnitTotals {
  const totalUnits = parts.reduce(
    (sum, p) => sum + Math.max(1, p.quantity_effective),
    0,
  );
  const printedUnits = parts.reduce((sum, p) => sum + p.printed_count, 0);
  const remainingUnits = Math.max(0, totalUnits - printedUnits);
  const percent =
    totalUnits === 0
      ? 0
      : Math.min(100, Math.max(0, Math.floor((printedUnits / totalUnits) * 100)));
  return { printedUnits, totalUnits, remainingUnits, percent };
}

/** Mock-style line: "137 of 359 printed". */
export function formatPrintedUnitsLine(parts: CheckoffSummaryPart[]): string {
  const { printedUnits, totalUnits } = checkoffUnitTotals(parts);
  return `${printedUnits} of ${totalUnits} printed`;
}

export function formatCheckoffSummary(parts: CheckoffSummaryPart[]): string {
  if (parts.length === 0) {
    return "0/0 parts fully printed · 0/0 units";
  }
  const partsDone = parts.filter((p) => isPartFullyPrinted(p)).length;
  const { printedUnits, totalUnits } = checkoffUnitTotals(parts);
  return (
    `${partsDone}/${parts.length} parts fully printed · ` +
    `${printedUnits}/${totalUnits} units`
  );
}

export function partProgressPercent(printed: number, quantity: number): number {
  const qty = Math.max(0, quantity);
  if (qty === 0) return 0;
  return Math.min(100, Math.floor((Math.max(0, printed) / qty) * 100));
}

export function partProgressTone(printed: number, quantity: number): PartProgressTone {
  const qty = Math.max(0, quantity);
  if (qty <= 0 || printed <= 0) return "empty";
  if (printed >= qty) return "done";
  return "partial";
}

/** Index of next unit to mark complete, or -1 when fully printed. */
export function nextUnitToComplete(units: boolean[]): number {
  return units.findIndex((u) => !u);
}

/** Index of last completed unit to undo, or -1 when none printed. */
export function lastCompletedUnit(units: boolean[]): number {
  for (let i = units.length - 1; i >= 0; i -= 1) {
    if (units[i]) return i;
  }
  return -1;
}

/**
 * Unit indices eligible for an Assembled toggle: only completed (printed) units.
 * Used by the checkoff UI to gate the per-unit Assembled switch — assembly
 * tracking only makes sense once a unit has actually been printed.
 */
export function assembledEligibleUnitIndices(printUnits: boolean[]): number[] {
  return printUnits
    .map((done, idx) => (done ? idx : -1))
    .filter((idx) => idx >= 0);
}

/**
 * Per-row busy state for the Progress list.
 *
 * Checkoff and assembled mutations are scoped to a single part on both the
 * client and the server, so only the row actually being saved should be
 * disabled. Returning a global "any save in flight" flag here would churn the
 * props of every memoised row on each toggle — on a Voron-scale plan (100+
 * parts, many completed-but-not-assembled units) that re-renders the whole
 * list twice per click and blocks the user from checking off the next part
 * while the previous request is still in flight.
 */
export function isProgressRowBusy(
  busyPartId: number | null,
  partId: number,
): boolean {
  return busyPartId === partId;
}
