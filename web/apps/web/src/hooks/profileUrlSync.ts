/** Pure helpers for ?profile= URL sync (testable without React). */

export function parseProfileParam(raw: string | null): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Leave global Production and redirect-only routes in control of their URLs. */
export function shouldSyncProfileToPath(pathname: string): boolean {
  return pathname !== "/production" && !/^\/plans\/\d+\/studio$/.test(pathname);
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
