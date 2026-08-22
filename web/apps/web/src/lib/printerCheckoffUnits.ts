import type { ReviewPart } from "../api/engine";
import type { PrinterCheckoffUnit } from "../api/engine";

/** Incomplete Progress units for included missing parts (Export send mapping). */
export function incompleteUnitsForParts(parts: ReviewPart[]): PrinterCheckoffUnit[] {
  const out: PrinterCheckoffUnit[] = [];
  for (const part of parts) {
    if (!part.included || !part.missing) continue;
    const units = part.print_units ?? [];
    for (let i = 0; i < units.length; i++) {
      if (!units[i]) out.push({ part_id: part.id, unit_index: i });
    }
  }
  return out;
}

/** Units for a subset of part ids (still only incomplete slots). */
export function incompleteUnitsForSelectedParts(
  parts: ReviewPart[],
  selectedPartIds: Iterable<number>,
): PrinterCheckoffUnit[] {
  const selected = new Set(selectedPartIds);
  return incompleteUnitsForParts(parts.filter((p) => selected.has(p.id)));
}
