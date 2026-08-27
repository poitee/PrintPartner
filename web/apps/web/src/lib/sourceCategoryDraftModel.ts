import { CATEGORY_PATH_SEPARATOR } from "@print-partner/contracts";

/**
 * Editable Source category row. `parentId` is the row id of its parent, so a
 * parent rename carries children without rewriting their state. `originalPath`
 * remembers where the row's sources currently live.
 */
export type DraftCategory = {
  id: string;
  parentId: string | null;
  originalPath: string | null;
  name: string;
};

export function sameCategories(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Split a saved path list into parent-linked rows, preserving list order. */
export function categoryRows(categories: readonly string[]): DraftCategory[] {
  const rows: DraftCategory[] = [];
  const idByPath = new Map<string, string>();
  categories.forEach((path, index) => {
    const segments = path.split(CATEGORY_PATH_SEPARATOR);
    const name = segments[segments.length - 1] ?? path;
    const parentPath = segments.slice(0, -1).join(CATEGORY_PATH_SEPARATOR);
    const id = `saved-${index}`;
    idByPath.set(path, id);
    rows.push({
      id,
      parentId: parentPath ? idByPath.get(parentPath) ?? null : null,
      originalPath: path,
      name,
    });
  });
  return rows;
}

/** Depth-first row order — children immediately after their parent. */
export function orderedRows(draft: readonly DraftCategory[]): DraftCategory[] {
  const out: DraftCategory[] = [];
  const walk = (parentId: string | null) => {
    for (const row of draft) {
      if (row.parentId !== parentId) continue;
      out.push(row);
      walk(row.id);
    }
  };
  walk(null);
  return out;
}

export function rowDepth(draft: readonly DraftCategory[], row: DraftCategory): number {
  let depth = 0;
  let current = row;
  while (current.parentId) {
    const parent = draft.find((candidate) => candidate.id === current.parentId);
    if (!parent) break;
    current = parent;
    depth += 1;
  }
  return depth;
}

/** Current path of a row, from the names its ancestors hold right now. */
export function rowPath(draft: readonly DraftCategory[], row: DraftCategory): string {
  const segments = [row.name.trim()];
  let current = row;
  while (current.parentId) {
    const parent = draft.find((candidate) => candidate.id === current.parentId);
    if (!parent) break;
    segments.unshift(parent.name.trim());
    current = parent;
  }
  return segments.filter(Boolean).join(CATEGORY_PATH_SEPARATOR);
}

/** Flat path list in display order — exactly what the API stores. */
export function draftPaths(draft: readonly DraftCategory[]): string[] {
  return orderedRows(draft).map((row) => rowPath(draft, row));
}

export function descendantIds(draft: readonly DraftCategory[], id: string): string[] {
  const out: string[] = [];
  const walk = (parentId: string) => {
    for (const row of draft) {
      if (row.parentId !== parentId) continue;
      out.push(row.id);
      walk(row.id);
    }
  };
  walk(id);
  return out;
}
