import type { PrinterSendQueueItem } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

/** Filament color ids referenced by queued Progress units (when known). */
export function wantedFilamentIdsForQueueItem(
  repo: AppRepository,
  item: PrinterSendQueueItem,
): Set<string> {
  const wanted = new Set<string>();
  if (!item.profile_id || !item.checkoff_units?.length) return wanted;
  const { parts } = repo.listParts(item.profile_id, 10_000, 0);
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const unit of item.checkoff_units) {
    const fid = byId.get(unit.part_id)?.filament_color_id?.trim();
    if (fid) wanted.add(fid);
  }
  return wanted;
}
