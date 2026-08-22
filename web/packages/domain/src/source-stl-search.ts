import { listStlRelativePaths } from "./scanner.js";

export const DEFAULT_STL_SEARCH_LIMIT = 50;
export const MAX_STL_SEARCH_LIMIT = 200;

export type StlSearchHit = {
  source_id: number;
  source_name: string;
  category: string | null;
  relative_path: string;
  filename: string;
};

function relevanceRank(queryLower: string, relativePath: string, filename: string): [number, string] {
  const fnLower = filename.toLowerCase();
  const pathLower = relativePath.toLowerCase();
  if (fnLower === queryLower) return [0, fnLower];
  if (fnLower.startsWith(queryLower)) return [1, fnLower];
  if (fnLower.includes(queryLower)) return [2, fnLower];
  if (pathLower.includes(queryLower)) return [3, fnLower];
  return [99, fnLower];
}

export function searchSourceStls(
  sources: Array<{
    id: number;
    name: string;
    localPath: string | null;
    category: string | null;
  }>,
  query: string,
  limit = DEFAULT_STL_SEARCH_LIMIT,
): { query: string; results: StlSearchHit[] } {
  const q = query.trim();
  const capped = Math.min(Math.max(1, limit), MAX_STL_SEARCH_LIMIT);
  if (!q) return { query: "", results: [] };

  const qLower = q.toLowerCase();
  const matches: Array<StlSearchHit & { _rank: [number, string] }> = [];

  for (const project of sources) {
    if (!project.localPath) continue;
    for (const rel of listStlRelativePaths(project.localPath)) {
      const filename = rel.split("/").pop() ?? rel;
      const relLower = rel.toLowerCase();
      const fnLower = filename.toLowerCase();
      if (!relLower.includes(qLower) && !fnLower.includes(qLower)) continue;
      matches.push({
        source_id: project.id,
        source_name: project.name,
        category: project.category,
        relative_path: rel,
        filename,
        _rank: relevanceRank(qLower, rel, filename),
      });
    }
  }

  matches.sort((a, b) => {
    const ra = a._rank[0] - b._rank[0];
    if (ra !== 0) return ra;
    return a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" });
  });

  return {
    query: q,
    results: matches.slice(0, capped).map(({ _rank: _, ...row }) => row),
  };
}
