/**
 * Library source categories and their subcategories.
 *
 * Categories are stored (and sent over the wire) as a flat, ordered list of
 * "/"-separated paths — `["Printers", "Printers/Frame", "Mods"]`. The nested tree
 * is derived from that list, never persisted, so:
 *
 * - a flat list from before subcategories existed loads unchanged,
 * - a source keeps a single `metadata.category` string (now a full path),
 * - clients that only understand `string[]` still render every category.
 *
 * Ancestors are implied: normalizing `["Printers/Frame"]` yields
 * `["Printers", "Printers/Frame"]` so a parent row always exists for its children.
 */

export const CATEGORY_PATH_SEPARATOR = "/";

/** Safety valve on pathological input; deep enough that real libraries never hit it. */
export const MAX_CATEGORY_DEPTH = 8;

export type SourceCategoryNode = {
  /** Full path, e.g. `"Printers/Frame"`. */
  path: string;
  /** Last segment only, e.g. `"Frame"`. */
  name: string;
  /** 0 for a top-level category. */
  depth: number;
  /** Parent path, or `null` at the top level. */
  parent: string | null;
  children: SourceCategoryNode[];
};

/** Split a path into trimmed, non-empty segments. */
export function categoryPathSegments(path: string | null | undefined): string[] {
  if (!path) return [];
  return path
    .split(CATEGORY_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Join segments back into a path, dropping blanks. */
export function joinCategoryPath(segments: readonly string[]): string {
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(CATEGORY_PATH_SEPARATOR);
}

/** Canonical form of a single path (`" Printers / Frame "` → `"Printers/Frame"`); `""` when blank. */
export function normalizeCategoryPath(path: string | null | undefined): string {
  return joinCategoryPath(categoryPathSegments(path));
}

/** Leaf segment of a path, for display in rails and menus. */
export function categoryLeafName(path: string): string {
  const segments = categoryPathSegments(path);
  return segments.length ? segments[segments.length - 1]! : "";
}

/** Parent path, or `null` for a top-level category. */
export function categoryParentPath(path: string): string | null {
  const segments = categoryPathSegments(path);
  if (segments.length <= 1) return null;
  return joinCategoryPath(segments.slice(0, -1));
}

/** Every ancestor path, outermost first; excludes the path itself. */
export function categoryAncestorPaths(path: string): string[] {
  const segments = categoryPathSegments(path);
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(joinCategoryPath(segments.slice(0, i)));
  }
  return out;
}

/** Depth of a path: 0 for top level, 1 for a subcategory, and so on. */
export function categoryDepth(path: string): number {
  return Math.max(0, categoryPathSegments(path).length - 1);
}

/**
 * True when `path` is `ancestor` or nested under it. Comparison is
 * case-insensitive per segment, and `"Printers 2"` never matches `"Printers"`.
 */
export function isCategoryPathWithin(
  path: string | null | undefined,
  ancestor: string | null | undefined,
): boolean {
  const child = categoryPathSegments(path);
  const parent = categoryPathSegments(ancestor);
  if (!parent.length) return false;
  if (child.length < parent.length) return false;
  return parent.every((segment, i) => segment.toLowerCase() === child[i]!.toLowerCase());
}

/** Case-insensitive equality on two paths. */
export function sameCategoryPath(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return normalizeCategoryPath(left).toLowerCase() === normalizeCategoryPath(right).toLowerCase();
}

/**
 * Rewrite `path` when `from` (or one of its ancestors) moves to `to`.
 * Returns `null` when the subtree is being deleted (`to === null`), or
 * `undefined` when `path` is not inside `from`.
 */
export function rewriteCategoryPath(
  path: string,
  from: string,
  to: string | null,
): string | null | undefined {
  if (!isCategoryPathWithin(path, from)) return undefined;
  if (to === null) return null;
  const remainder = categoryPathSegments(path).slice(categoryPathSegments(from).length);
  return joinCategoryPath([...categoryPathSegments(to), ...remainder]);
}

/**
 * Clean a raw category list: trim segments, drop blanks and paths deeper than
 * {@link MAX_CATEGORY_DEPTH}, insert missing ancestors immediately before their
 * first child, and drop case-insensitive duplicates while keeping first order.
 */
export function normalizeSourceCategoryPaths(paths: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (path: string) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };

  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const segments = categoryPathSegments(raw);
    if (!segments.length) continue;
    if (segments.length - 1 > MAX_CATEGORY_DEPTH) continue;
    for (const ancestor of categoryAncestorPaths(joinCategoryPath(segments))) {
      push(ancestor);
    }
    push(joinCategoryPath(segments));
  }

  return out;
}

/** Build the nested tree for a normalized path list, preserving list order. */
export function buildSourceCategoryTree(paths: readonly string[]): SourceCategoryNode[] {
  const roots: SourceCategoryNode[] = [];
  const byKey = new Map<string, SourceCategoryNode>();

  for (const path of normalizeSourceCategoryPaths(paths)) {
    const parent = categoryParentPath(path);
    const node: SourceCategoryNode = {
      path,
      name: categoryLeafName(path),
      depth: categoryDepth(path),
      parent,
      children: [],
    };
    byKey.set(path.toLowerCase(), node);
    if (parent) {
      // Ancestors are inserted first by normalizeSourceCategoryPaths, so the
      // parent is always present by the time a child is reached.
      byKey.get(parent.toLowerCase())?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/** Depth-first flattening of a tree — the inverse of {@link buildSourceCategoryTree}. */
export function flattenSourceCategoryTree(
  nodes: readonly SourceCategoryNode[],
): SourceCategoryNode[] {
  const out: SourceCategoryNode[] = [];
  const walk = (list: readonly SourceCategoryNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Every path in `paths` that is `path` itself or nested under it. */
export function categorySubtreePaths(
  paths: readonly string[],
  path: string,
): string[] {
  return paths.filter((candidate) => isCategoryPathWithin(candidate, path));
}
