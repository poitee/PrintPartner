/** Print progress helpers (ported from Python print_progress.py — pure logic). */

export type ProgressRow = {
  id?: number;
  partId: number;
  unitIndex: number;
  completed: boolean;
  /** Assembly tracking: true when this printed unit has been physically installed. */
  assembled?: boolean;
};

export function dedupeProgressRows(rows: ProgressRow[]): ProgressRow[] {
  const byIndex = new Map<number, ProgressRow[]>();
  for (const row of rows) {
    const group = byIndex.get(row.unitIndex) ?? [];
    group.push(row);
    byIndex.set(row.unitIndex, group);
  }
  const out: ProgressRow[] = [];
  for (const group of byIndex.values()) {
    if (group.length <= 1) {
      out.push(...group);
      continue;
    }
    const completed = group.some((r) => r.completed);
    // Assembly tracking: like `completed`, assembled is OR-merged across duplicate
    // rows for the same unit so a dedupe pass never silently drops the flag.
    const assembled = group.some((r) => r.assembled === true);
    const keep = group.reduce((a, b) => ((a.id ?? 0) > (b.id ?? 0) ? a : b));
    out.push({ ...keep, completed, assembled });
  }
  return out;
}

export function getPrintUnits(rows: ProgressRow[], qty: number): boolean[] {
  const flags: Record<number, boolean> = {};
  for (const r of rows) {
    flags[r.unitIndex] = flags[r.unitIndex] || r.completed;
  }
  const n = Math.max(1, qty);
  return Array.from({ length: n }, (_, i) => flags[i] ?? false);
}

/** Returns an array of length qty where each entry is true if that unit is both completed AND assembled. */
export function getAssembledUnits(rows: ProgressRow[], qty: number): boolean[] {
  const flags: Record<number, boolean> = {};
  for (const r of rows) {
    if (r.completed && r.assembled) flags[r.unitIndex] = true;
  }
  const n = Math.max(1, qty);
  return Array.from({ length: n }, (_, i) => flags[i] ?? false);
}

export function ensureProgressRows(rows: ProgressRow[], partId: number, qty: number): ProgressRow[] {
  const deduped = dedupeProgressRows(rows.filter((r) => r.partId === partId));
  const n = Math.max(1, qty);
  const byIndex = new Map(deduped.map((r) => [r.unitIndex, r]));
  const out: ProgressRow[] = [];
  for (let unitIndex = 0; unitIndex < n; unitIndex++) {
    const existing = byIndex.get(unitIndex);
    out.push(
      // New units are explicitly not-assembled rather than leaving the field
      // undefined, so a freshly materialised row round-trips as assembled=false.
      existing ?? { partId, unitIndex, completed: false, assembled: false },
    );
  }
  return out;
}

/**
 * Set the assembled flag on a single unit of a part.
 *
 * A unit that is not printed cannot be installed into the build, so setting
 * assembled=true on an incomplete unit is a no-op. Returns a new row array.
 */
export function setAssembledUnit(
  rows: ProgressRow[],
  partId: number,
  qty: number,
  unitIndex: number,
  assembled: boolean,
): ProgressRow[] {
  const n = Math.max(1, qty);
  if (unitIndex >= n || unitIndex < 0) return rows;
  const others = rows.filter((r) => r.partId !== partId);
  const ensured = ensureProgressRows(rows, partId, n);
  const updated = ensured.map((r) => {
    if (r.unitIndex !== unitIndex) return r;
    if (assembled && !r.completed) return { ...r, assembled: false };
    return { ...r, assembled };
  });
  return [...others, ...updated];
}

export function setPrintedUnitCount(rows: ProgressRow[], partId: number, qty: number, completedCount: number): ProgressRow[] {
  const n = Math.max(1, qty);
  const count = Math.max(0, Math.min(completedCount, n));
  const ensured = ensureProgressRows(rows, partId, n);
  const others = rows.filter((r) => r.partId !== partId);
  const updated = ensured.map((r) => {
    const completed = r.unitIndex < count;
    // Un-printing a unit also un-assembles it: a part that is no longer printed
    // cannot be installed in the build. Without this the stale flag would
    // resurrect the moment the unit is re-checked.
    return { ...r, completed, assembled: completed ? r.assembled === true : false };
  });
  return [...others, ...updated];
}

export function toggleCheckoffUnit(
  rows: ProgressRow[],
  partId: number,
  qty: number,
  unitIndex: number,
  completed: boolean,
): ProgressRow[] {
  const n = Math.max(1, qty);
  if (unitIndex >= n) return rows;
  const target = completed ? unitIndex + 1 : unitIndex;
  return setPrintedUnitCount(rows, partId, n, target);
}

export function getPrintedCounts(
  parts: Array<{ id: number; quantityEffective: number }>,
  allRows: ProgressRow[],
): Map<number, [number, number]> {
  const counts = new Map<number, [number, number]>();
  for (const part of parts) {
    const partRows = allRows.filter((r) => r.partId === part.id);
    const total = Math.max(1, part.quantityEffective);
    const completed = partRows.filter((r) => r.completed).length;
    counts.set(part.id, [completed, total]);
  }
  return counts;
}
