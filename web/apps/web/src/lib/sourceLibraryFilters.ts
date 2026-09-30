import type { SourceSummary } from "@print-partner/contracts";
import { sourceSyncIssue } from "./sourceMonitoring";
import { matchesSourceCategoryFilter } from "./sourceCategoryAssignment";

type SourceLibrarySyncFilter = "all" | "synced" | "unsynced" | "updates";

type SourceLibraryFilters = {
  search: string;
  categoryFilter: string;
  syncFilter: SourceLibrarySyncFilter;
  platformFilter: string;
};

export function matchesSourceLibraryFilters(
  source: SourceSummary,
  filters: SourceLibraryFilters,
): boolean {
  const q = filters.search.trim().toLowerCase();
  if (q) {
    const hay = `${source.name} ${source.url}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (!matchesSourceCategoryFilter(source.category, filters.categoryFilter)) {
    return false;
  }
  const synced = Boolean(source.last_synced_at) && sourceSyncIssue(source) === null;
  if (filters.syncFilter === "synced" && !synced) return false;
  if (filters.syncFilter === "unsynced" && synced) return false;
  if (filters.syncFilter === "updates" && source.update_status !== "updates_available") {
    return false;
  }
  if (filters.platformFilter !== "all" && source.source_kind !== filters.platformFilter) {
    return false;
  }
  return true;
}

export function filterSourceLibrary(
  sources: SourceSummary[],
  filters: SourceLibraryFilters,
): SourceSummary[] {
  return sources.filter((source) => matchesSourceLibraryFilters(source, filters));
}
