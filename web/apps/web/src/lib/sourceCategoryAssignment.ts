import { isCategoryPathWithin, normalizeCategoryPath } from "@print-partner/contracts";
import { UNCATEGORISED_FILTER } from "../components/sources/sourceLabels";

export function reconcileSourceCategoryFilter(
  categoryFilter: string,
  categories: readonly string[],
): string {
  if (categoryFilter === "all" || categoryFilter === UNCATEGORISED_FILTER) {
    return categoryFilter;
  }
  return categories.includes(categoryFilter) ? categoryFilter : "all";
}

/** Bucket key used by Library counts / Uncategorised filter (`null` = uncategorised). */
export function sourceCategoryBucket(
  category: string | null | undefined,
): string | null {
  const path = normalizeCategoryPath(category);
  return path ? path : null;
}

/**
 * True when a source belongs in the active Library category filter.
 * Selecting a category includes everything in its subcategories, so filtering
 * on "Printers" also shows Sources filed under "Printers/Frame".
 */
export function matchesSourceCategoryFilter(
  category: string | null | undefined,
  categoryFilter: string,
): boolean {
  const bucket = sourceCategoryBucket(category);
  if (categoryFilter === UNCATEGORISED_FILTER) return bucket == null;
  if (categoryFilter === "all") return true;
  return bucket != null && isCategoryPathWithin(bucket, categoryFilter);
}

/** Count sources per category name; `null` key is Uncategorised. */
export function countSourcesByCategory(
  sources: Array<{ category: string | null }>,
): Map<string | null, number> {
  const map = new Map<string | null, number>();
  for (const s of sources) {
    const key = sourceCategoryBucket(s.category);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/**
 * Sources filed at `path` plus everything in its subcategories, from the exact
 * per-path counts returned by {@link countSourcesByCategory}.
 */
export function rollupCategoryCount(
  counts: ReadonlyMap<string | null, number>,
  path: string,
): number {
  let total = 0;
  for (const [category, count] of counts) {
    if (category != null && isCategoryPathWithin(category, path)) total += count;
  }
  return total;
}

/** Label for display; empty/null → Uncategorised. */
export function sourceCategoryLabel(
  category: string | null | undefined,
  uncategorisedLabel = "Uncategorised",
): string {
  return sourceCategoryBucket(category) ?? uncategorisedLabel;
}
