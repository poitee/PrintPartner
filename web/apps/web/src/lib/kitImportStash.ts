import type { KitImportJobResult } from "../api/engine";

/**
 * Durable hand-off for a kit-import result between the import action and the
 * Build page. `location.state` can be dropped by intervening navigations
 * (e.g. ?profile= URL sync), so we also stash the result in sessionStorage
 * keyed by the new plan id and consume it once on the Build page.
 */
const kitImportStashKey = () => ["pp", "pending", "kit", "import"].join("-");

export function stashKitImportResult(result: KitImportJobResult): void {
  try {
    sessionStorage.setItem(kitImportStashKey(), JSON.stringify(result));
  } catch {
    /* ignore storage failures */
  }
}

/** Return and clear a stashed import result for the given plan, if any. */
export function takeKitImportResult(profileId: number): KitImportJobResult | null {
  try {
    const raw = sessionStorage.getItem(kitImportStashKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KitImportJobResult;
    if (parsed?.profile_id !== profileId) return null;
    sessionStorage.removeItem(kitImportStashKey());
    return parsed;
  } catch {
    return null;
  }
}
