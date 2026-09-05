/** Pure helpers for active-plan selection (testable without React). */

/**
 * After the Build list or URL changes, decide whether to keep, clear, or
 * replace the selected Build ID.
 *
 * Returns `undefined` to leave selection unchanged (including when a newly
 * created Build is selected before it appears in the fetched list).
 */
export function reconcileSelectedProfileId(
  profileIds: readonly number[],
  selectedProfileId: number | null,
  previousProfileIds: readonly number[],
  urlProfileId: number | null = null,
  pendingSelectionId: number | null = null,
): number | null | undefined {
  if (
    urlProfileId != null &&
    profileIds.includes(urlProfileId) &&
    !shouldBlockUrlProfileSync(urlProfileId, pendingSelectionId, selectedProfileId)
  ) {
    return selectedProfileId === urlProfileId ? undefined : urlProfileId;
  }
  if (profileIds.length === 0) {
    return selectedProfileId == null ? undefined : null;
  }
  if (selectedProfileId == null) {
    return profileIds[0];
  }
  if (profileIds.includes(selectedProfileId)) {
    return undefined;
  }
  // Missing from the list: auto-correct only when the id was previously known
  // (deleted) or on first hydrate with a stale/unknown stored id.
  const wasKnown = previousProfileIds.includes(selectedProfileId);
  if (wasKnown || previousProfileIds.length === 0) {
    return profileIds[0];
  }
  return undefined;
}

/**
 * Whether URL → state sync should skip applying `urlId` because a local
 * selection is still ahead of the address bar (create/switch race).
 */
export function shouldBlockUrlProfileSync(
  urlId: number | null,
  pendingSelectionId: number | null,
  selectedProfileId: number | null,
): boolean {
  if (pendingSelectionId == null) return false;
  if (urlId === pendingSelectionId) return false;
  return selectedProfileId === pendingSelectionId;
}
