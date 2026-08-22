/** Pure helpers for ?profile= URL sync (testable without React). */

export function parseProfileParam(raw: string | null): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** When URL profile differs from selection, return the id to apply; else undefined. */
export function profileIdFromUrl(
  urlId: number | null,
  validIds: readonly number[],
  selectedProfileId: number | null,
): number | undefined {
  if (urlId == null) return undefined;
  if (!validIds.includes(urlId)) return undefined;
  if (selectedProfileId === urlId) return undefined;
  return urlId;
}

/** Merge selected plan into search params; return undefined when unchanged. */
export function searchParamsWithProfile(
  prev: URLSearchParams,
  selectedProfileId: number | null,
): URLSearchParams | undefined {
  const current = prev.get("profile");
  if (selectedProfileId == null) {
    if (current == null) return undefined;
    const next = new URLSearchParams(prev);
    next.delete("profile");
    return next;
  }
  const expected = String(selectedProfileId);
  if (current === expected) return undefined;
  const next = new URLSearchParams(prev);
  next.set("profile", expected);
  return next;
}
