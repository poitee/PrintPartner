/**
 * Progress remaining list: parts interleaved with free-text bag/sort bars.
 * Local-only order (no server field). Bag bars are this-plan labels, not shop stock.
 */

export type ProgressBagBar = {
  id: string;
  label: string;
};

/** Sortable row id: part:<n> or bag:<id>. */
export type ProgressRowRef =
  | { kind: "part"; id: number }
  | { kind: "bag"; id: string; label: string };

export function partRowId(partId: number): string {
  return `part:${partId}`;
}

export function bagRowId(bagId: string): string {
  return `bag:${bagId}`;
}

export function parseProgressRowId(
  raw: string | number,
): { kind: "part"; id: number } | { kind: "bag"; id: string } | null {
  const s = String(raw);
  if (s.startsWith("part:")) {
    const id = Number(s.slice(5));
    return Number.isFinite(id) ? { kind: "part", id } : null;
  }
  if (s.startsWith("bag:")) {
    const id = s.slice(4);
    return id ? { kind: "bag", id } : null;
  }
  // Legacy bare part id from older DnD.
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { kind: "part", id: raw };
  }
  const asNum = Number(s);
  if (Number.isFinite(asNum) && String(asNum) === s) {
    return { kind: "part", id: asNum };
  }
  return null;
}

export function progressRowSortableId(row: ProgressRowRef): string {
  return row.kind === "part" ? partRowId(row.id) : bagRowId(row.id);
}

/**
 * Build a full ordered list from preferred refs + known part ids + bag bars.
 * Drops stale parts/bags; appends new parts at end; keeps bag labels.
 */
export function reconcileProgressRows(
  preferred: ReadonlyArray<ProgressRowRef>,
  knownPartIds: ReadonlyArray<number>,
  bags: ReadonlyArray<ProgressBagBar>,
): ProgressRowRef[] {
  const knownParts = new Set(knownPartIds);
  const bagById = new Map(bags.map((b) => [b.id, b]));
  const seenParts = new Set<number>();
  const seenBags = new Set<string>();
  const out: ProgressRowRef[] = [];

  for (const row of preferred) {
    if (row.kind === "part") {
      if (!knownParts.has(row.id) || seenParts.has(row.id)) continue;
      seenParts.add(row.id);
      out.push({ kind: "part", id: row.id });
      continue;
    }
    const bag = bagById.get(row.id);
    if (!bag || seenBags.has(row.id)) continue;
    seenBags.add(row.id);
    out.push({ kind: "bag", id: bag.id, label: bag.label });
  }

  for (const id of knownPartIds) {
    if (seenParts.has(id)) continue;
    seenParts.add(id);
    out.push({ kind: "part", id });
  }

  for (const bag of bags) {
    if (seenBags.has(bag.id)) continue;
    seenBags.add(bag.id);
    out.push({ kind: "bag", id: bag.id, label: bag.label });
  }

  return out;
}

/** Migrate legacy part-id order into ProgressRowRef[]. */
export function rowsFromLegacyPartOrder(
  partIds: ReadonlyArray<number>,
  bags: ReadonlyArray<ProgressBagBar> = [],
): ProgressRowRef[] {
  const rows: ProgressRowRef[] = partIds.map((id) => ({ kind: "part" as const, id }));
  for (const bag of bags) {
    rows.push({ kind: "bag", id: bag.id, label: bag.label });
  }
  return rows;
}

/**
 * After reordering a visible subset, splice that sequence back into the full
 * order while leaving non-visible refs in place.
 */
export function mergeVisibleProgressReorder(
  fullOrder: ReadonlyArray<ProgressRowRef>,
  visibleBefore: ReadonlyArray<ProgressRowRef>,
  visibleAfter: ReadonlyArray<ProgressRowRef>,
): ProgressRowRef[] {
  if (
    visibleBefore.length !== visibleAfter.length ||
    visibleBefore.length === 0
  ) {
    return [...fullOrder];
  }
  const key = (r: ProgressRowRef) => progressRowSortableId(r);
  const visibleSet = new Set(visibleBefore.map(key));
  let i = 0;
  const merged = fullOrder.map((row) =>
    visibleSet.has(key(row)) ? (visibleAfter[i++] as ProgressRowRef) : row,
  );
  if (i < visibleAfter.length) {
    return [...merged, ...visibleAfter.slice(i)];
  }
  return merged;
}

export function newBagBarId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Default label for a newly added bag/sort bar (Bag 1, Bag 2, …). */
export function defaultBagBarLabel(existingBagCount: number): string {
  return `Bag ${Math.max(0, existingBagCount) + 1}`;
}
