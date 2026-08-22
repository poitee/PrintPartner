import type { SpoolmanSpoolRow } from "../api/engine";
import { parseSpoolmanFilamentId } from "./spoolmanIds";

export function formatSpoolOptionLabel(spool: SpoolmanSpoolRow): string {
  const grams = Math.round(spool.remaining_weight ?? 0);
  const location = (spool.location ?? "").trim();
  const base = location
    ? `#${spool.id} · ~${grams} g · ${location}`
    : `#${spool.id} · ~${grams} g`;
  return grams <= 0 ? `${base} (empty)` : base;
}

/** All spools for a Spoolman filament id, including zero-weight spools. */
export function filterFilamentSpools(
  spools: SpoolmanSpoolRow[],
  filamentId: number,
): SpoolmanSpoolRow[] {
  return spools
    .filter((s) => s.filament_id === filamentId)
    .sort((a, b) => a.id - b.id);
}

export type PartSpoolPickerVisibility =
  | { show: false; reason: "not_spoolman_filament" }
  | { show: true; kind: "loading"; reason: "spools_loading" }
  | { show: true; kind: "empty"; reason: "no_matching_spools" }
  | { show: true; kind: "picker"; spools: SpoolmanSpoolRow[] };

export function partSpoolPickerVisibility(
  filamentColorId: string | null | undefined,
  spools: SpoolmanSpoolRow[],
  options?: { spoolsLoading?: boolean },
): PartSpoolPickerVisibility {
  const filamentParsed = parseSpoolmanFilamentId(filamentColorId ?? "");
  if (!filamentParsed) {
    return { show: false, reason: "not_spoolman_filament" };
  }
  if (options?.spoolsLoading) {
    return { show: true, kind: "loading", reason: "spools_loading" };
  }
  const filamentSpools = filterFilamentSpools(spools, filamentParsed.filamentId);
  if (filamentSpools.length === 0) {
    return { show: true, kind: "empty", reason: "no_matching_spools" };
  }
  return { show: true, kind: "picker", spools: filamentSpools };
}

export function logPartSpoolPickerHidden(
  partId: number,
  visibility: PartSpoolPickerVisibility,
): void {
  if (!import.meta.env.DEV || visibility.show) return;
  console.debug(
    `[PartSpoolPicker] hidden for part ${partId}: ${visibility.reason}`,
  );
}
