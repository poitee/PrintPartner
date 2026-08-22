/** Basenames that appear more than once among checked STL paths (overlapping import rules). */
export function findDuplicateBasenames(checkedPaths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of checkedPaths) {
    const base = path.split("/").pop()?.trim() || path;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}
