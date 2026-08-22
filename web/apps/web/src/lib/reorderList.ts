/** Immutable array move (same semantics as @dnd-kit/sortable arrayMove). */
export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items;
  }
  const next = items.slice();
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed!);
  return next;
}

/** Move by identity when items are primitives or unique by ===. */
export function moveItemById<T>(items: T[], activeId: T, overId: T): T[] {
  const fromIndex = items.indexOf(activeId);
  const toIndex = items.indexOf(overId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;
  return moveItem(items, fromIndex, toIndex);
}

/**
 * Apply a preferred id order to a list. Unknown ids keep relative order at the end
 * (stable by original index).
 */
export function sortByPreferredOrder<T>(
  items: T[],
  preferredOrder: ReadonlyArray<number | string>,
  getId: (item: T) => number | string,
): T[] {
  if (!preferredOrder.length || items.length <= 1) return items;
  const rank = new Map(preferredOrder.map((id, i) => [id, i]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ai = rank.get(getId(a.item));
      const bi = rank.get(getId(b.item));
      const aRank = ai === undefined ? Number.POSITIVE_INFINITY : ai;
      const bRank = bi === undefined ? Number.POSITIVE_INFINITY : bi;
      if (aRank !== bRank) return aRank - bRank;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * After reordering a filtered/visible subset, splice that new sequence back into
 * the full order while leaving non-visible ids in place.
 */
export function mergeVisibleReorder<T extends number | string>(
  fullOrder: ReadonlyArray<T>,
  visibleBefore: ReadonlyArray<T>,
  visibleAfter: ReadonlyArray<T>,
): T[] {
  if (
    visibleBefore.length !== visibleAfter.length ||
    visibleBefore.length === 0
  ) {
    return [...fullOrder];
  }
  const visibleSet = new Set(visibleBefore);
  let i = 0;
  const merged = fullOrder.map((id) =>
    visibleSet.has(id) ? (visibleAfter[i++] as T) : id,
  );
  // Append any visible ids that were missing from fullOrder.
  if (i < visibleAfter.length) {
    return [...merged, ...visibleAfter.slice(i)];
  }
  return merged;
}

/** Ensure every known id appears exactly once; drop stale; append new at end. */
export function reconcileOrder<T extends number | string>(
  preferred: ReadonlyArray<T>,
  knownIds: ReadonlyArray<T>,
): T[] {
  const known = new Set(knownIds);
  const seen = new Set<T>();
  const out: T[] = [];
  for (const id of preferred) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of knownIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
