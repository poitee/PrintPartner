import type { SourceViewMode, SyncFilter } from "../components/sources/SourcesToolbar";

export const SOURCES_UI_STORAGE_KEY = "print-partner.sources.ui.v1";

export type PersistedSourcesUi = {
  viewMode: SourceViewMode;
  categoryFilter: string;
  syncFilter: SyncFilter;
  platformFilter: string;
  search: string;
};

const DEFAULT: PersistedSourcesUi = {
  viewMode: "grid",
  categoryFilter: "all",
  syncFilter: "all",
  platformFilter: "all",
  search: "",
};

function isViewMode(value: unknown): value is SourceViewMode {
  return value === "grid" || value === "list";
}

function isSyncFilter(value: unknown): value is SyncFilter {
  return value === "all" || value === "synced" || value === "unsynced";
}

export function parsePersistedSourcesUi(raw: string | null): PersistedSourcesUi {
  if (!raw) return { ...DEFAULT };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSourcesUi>;
    return {
      viewMode: isViewMode(parsed.viewMode) ? parsed.viewMode : DEFAULT.viewMode,
      categoryFilter:
        typeof parsed.categoryFilter === "string"
          ? parsed.categoryFilter
          : DEFAULT.categoryFilter,
      syncFilter: isSyncFilter(parsed.syncFilter)
        ? parsed.syncFilter
        : DEFAULT.syncFilter,
      platformFilter:
        typeof parsed.platformFilter === "string"
          ? parsed.platformFilter
          : DEFAULT.platformFilter,
      search: typeof parsed.search === "string" ? parsed.search : DEFAULT.search,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function serializePersistedSourcesUi(state: PersistedSourcesUi): string {
  return JSON.stringify({
    viewMode: state.viewMode,
    categoryFilter: state.categoryFilter,
    syncFilter: state.syncFilter,
    platformFilter: state.platformFilter,
    search: state.search,
  });
}

export function loadPersistedSourcesUi(): PersistedSourcesUi {
  if (typeof localStorage === "undefined") return { ...DEFAULT };
  return parsePersistedSourcesUi(localStorage.getItem(SOURCES_UI_STORAGE_KEY));
}

export function savePersistedSourcesUi(patch: Partial<PersistedSourcesUi>): void {
  if (typeof localStorage === "undefined") return;
  const merged = { ...loadPersistedSourcesUi(), ...patch };
  localStorage.setItem(SOURCES_UI_STORAGE_KEY, serializePersistedSourcesUi(merged));
}
