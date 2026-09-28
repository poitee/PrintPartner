import type { PrinterCheckoffUnit } from "../api/endpoints/checkoff";
import type { ReviewPart } from "../api/endpoints/planManifests";

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
