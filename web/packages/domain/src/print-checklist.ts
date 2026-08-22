import { filterPrintChecklistRows, isFullyPrinted } from "./checkoff-missing.js";

function rowQty(row: {
  quantity_effective?: number;
  quantityEffective?: number;
}): number {
  return Math.max(1, row.quantity_effective ?? row.quantityEffective ?? 1);
}

export function progressSummary(
  rows: Array<{
    included?: boolean;
    quantity_effective?: number;
    quantityEffective?: number;
    printed_count?: number;
  }>,
  includedOnly = true,
): string {
  const pool = includedOnly ? filterPrintChecklistRows(rows) : rows;
  if (!pool.length) return "0/0 parts fully printed · 0/0 units";
  const partsDone = pool.filter((r) => isFullyPrinted(r)).length;
  const totalUnits = pool.reduce((n, r) => n + rowQty(r), 0);
  const printedUnits = pool.reduce(
    (n, r) => n + Math.min(rowQty(r), r.printed_count ?? 0),
    0,
  );
  return `${partsDone}/${pool.length} parts fully printed · ${printedUnits}/${totalUnits} units`;
}
