/** Unprinted parts/units for checkoff (ported from Python checkoff_missing.py). */

import type { MergePart } from "./merge.js";
import { quantityEffective } from "./merge.js";

export type PartCopy = {
  part: MergePart;
  unit: number;
};

export function isFullyPrinted(row: {
  quantity_effective?: number;
  quantityEffective?: number;
  printed_count?: number;
}): boolean {
  const qty = Math.max(1, row.quantity_effective ?? row.quantityEffective ?? 1);
  const printed = Math.min(qty, row.printed_count ?? 0);
  return printed >= qty;
}

export function filterPrintChecklistRows<T extends { included?: boolean }>(rows: T[]): T[] {
  return rows.filter((r) => r.included !== false);
}

export function unprintedCopies(
  mergeParts: MergePart[],
  completedByMatchKey: Record<string, boolean[]>,
  existsFn: (path: string | null) => boolean = (p) => p != null && p.length > 0,
): PartCopy[] {
  const copies: PartCopy[] = [];
  for (const part of mergeParts) {
    if (!part.included) continue;
    if (!existsFn(part.absolutePath)) continue;
    const qty = Math.max(1, quantityEffective(part));
    let units = completedByMatchKey[part.matchKey];
    if (!units) units = Array(qty).fill(false);
    for (let unit = 1; unit <= qty; unit++) {
      const idx = unit - 1;
      if (idx < units.length && units[idx]) continue;
      copies.push({ part, unit });
    }
  }
  return copies;
}

export function countUnprintedUnits(
  rows: Array<{
    included?: boolean;
    quantity_effective?: number;
    quantityEffective?: number;
    printed_count?: number;
  }>,
  includedOnly = true,
): number {
  const pool = includedOnly ? filterPrintChecklistRows(rows) : rows;
  let unprinted = 0;
  for (const row of pool) {
    const qty = Math.max(1, row.quantity_effective ?? row.quantityEffective ?? 1);
    const printed = Math.min(qty, row.printed_count ?? 0);
    unprinted += Math.max(0, qty - printed);
  }
  return unprinted;
}

export function filterCheckoffDisplayRows<T extends { included?: boolean; quantity_effective?: number; quantityEffective?: number; printed_count?: number }>(
  rows: T[],
  mode: "all" | "missing" | "done",
): T[] {
  const included = filterPrintChecklistRows(rows) as T[];
  if (mode === "missing") return included.filter((r) => !isFullyPrinted(r));
  if (mode === "done") return included.filter((r) => isFullyPrinted(r));
  return included;
}
