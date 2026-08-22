import { UNCategorized_FILTER } from "../components/sources/sourceLabels";

/** Bucket key used by Library counts / Uncategorised filter (`null` = uncategorised). */
export function sourceCategoryBucket(
  category: string | null | undefined,
): string | null {
  const trimmed = category?.trim();
  return trimmed ? trimmed : null;
}

/** True when a source belongs in the active Library category filter. */
export function matchesSourceCategoryFilter(
  category: string | null | undefined,
  categoryFilter: string,
): boolean {
  const bucket = sourceCategoryBucket(category);
  if (categoryFilter === UNCategorized_FILTER) return bucket == null;
  if (categoryFilter !== "all" && bucket !== categoryFilter) return false;
  return true;
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

/** Label for display; empty/null → Uncategorised. */
export function sourceCategoryLabel(
  category: string | null | undefined,
  uncategorisedLabel = "Uncategorised",
): string {
  return sourceCategoryBucket(category) ?? uncategorisedLabel;
}
