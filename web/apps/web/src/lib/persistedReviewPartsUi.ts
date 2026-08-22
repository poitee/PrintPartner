export const REVIEW_PARTS_UI_STORAGE_KEY = "print-partner.review.parts.ui.v1";

export type ReviewPrintFilter = "all" | "missing" | "partial" | "complete";
export type ReviewIncludedFilter = "included" | "excluded" | "all";
export type ReviewSortKey = "folder" | "filename" | "qty";
export type ReviewViewMode = "edit" | "print";
export type ReviewFunctionalFilter = "all" | "functional" | "cosmetic";
/** Parts stage: group sections by filament role or by source/folder. */
export type PartsGroupMode = "role" | "source";
/** Parts stage: card grid vs sheet table (edit/print still apply inside table). */
export type PartsLayoutMode = "grid" | "table";

export type PersistedReviewPartsUi = {
  search: string;
  printFilter: ReviewPrintFilter;
  includedFilter: ReviewIncludedFilter;
  sourceLayer: string | null;
  folder: string | null;
  role: string | null;
  filament: string | null;
  issuesOnly: boolean;
  sort: ReviewSortKey;
  viewMode: ReviewViewMode;
  compactMode: boolean;
  groupMode: PartsGroupMode;
  layoutMode: PartsLayoutMode;
  functionalFilter: ReviewFunctionalFilter;
};

const DEFAULT: PersistedReviewPartsUi = {
  search: "",
  printFilter: "all",
  includedFilter: "included",
  sourceLayer: null,
  folder: null,
  role: null,
  filament: null,
  issuesOnly: false,
  sort: "folder",
  viewMode: "edit",
  compactMode: false,
  groupMode: "role",
  layoutMode: "grid",
  functionalFilter: "all",
};

function isPrintFilter(v: unknown): v is ReviewPrintFilter {
  return v === "all" || v === "missing" || v === "partial" || v === "complete";
}

function isIncludedFilter(v: unknown): v is ReviewIncludedFilter {
  return v === "included" || v === "excluded" || v === "all";
}

function isSortKey(v: unknown): v is ReviewSortKey {
  return v === "folder" || v === "filename" || v === "qty";
}

function isViewMode(v: unknown): v is ReviewViewMode {
  return v === "edit" || v === "print";
}

function isGroupMode(v: unknown): v is PartsGroupMode {
  return v === "role" || v === "source";
}

function isLayoutMode(v: unknown): v is PartsLayoutMode {
  return v === "grid" || v === "table";
}

function isFunctionalFilter(v: unknown): v is ReviewFunctionalFilter {
  return v === "all" || v === "functional" || v === "cosmetic";
}

export function parsePersistedReviewPartsUi(raw: string | null): PersistedReviewPartsUi {
  if (!raw) return { ...DEFAULT };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedReviewPartsUi>;
    return {
      search: typeof parsed.search === "string" ? parsed.search : DEFAULT.search,
      printFilter: isPrintFilter(parsed.printFilter) ? parsed.printFilter : DEFAULT.printFilter,
      includedFilter: isIncludedFilter(parsed.includedFilter)
        ? parsed.includedFilter
        : DEFAULT.includedFilter,
      sourceLayer:
        parsed.sourceLayer === null || typeof parsed.sourceLayer === "string"
          ? parsed.sourceLayer ?? null
          : DEFAULT.sourceLayer,
      folder:
        parsed.folder === null || typeof parsed.folder === "string"
          ? parsed.folder ?? null
          : DEFAULT.folder,
      role:
        parsed.role === null || typeof parsed.role === "string"
          ? parsed.role ?? null
          : DEFAULT.role,
      filament:
        parsed.filament === null || typeof parsed.filament === "string"
          ? parsed.filament ?? null
          : DEFAULT.filament,
      issuesOnly:
        typeof parsed.issuesOnly === "boolean" ? parsed.issuesOnly : DEFAULT.issuesOnly,
      sort: isSortKey(parsed.sort) ? parsed.sort : DEFAULT.sort,
      viewMode: isViewMode(parsed.viewMode) ? parsed.viewMode : DEFAULT.viewMode,
      compactMode:
        typeof parsed.compactMode === "boolean" ? parsed.compactMode : DEFAULT.compactMode,
      groupMode: isGroupMode(parsed.groupMode) ? parsed.groupMode : DEFAULT.groupMode,
      layoutMode: isLayoutMode(parsed.layoutMode) ? parsed.layoutMode : DEFAULT.layoutMode,
      functionalFilter: isFunctionalFilter(parsed.functionalFilter)
        ? parsed.functionalFilter
        : DEFAULT.functionalFilter,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function serializePersistedReviewPartsUi(state: PersistedReviewPartsUi): string {
  return JSON.stringify(state);
}

export function loadPersistedReviewPartsUi(): PersistedReviewPartsUi {
  if (typeof localStorage === "undefined") return { ...DEFAULT };
  return parsePersistedReviewPartsUi(localStorage.getItem(REVIEW_PARTS_UI_STORAGE_KEY));
}

export function savePersistedReviewPartsUi(state: PersistedReviewPartsUi): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(REVIEW_PARTS_UI_STORAGE_KEY, serializePersistedReviewPartsUi(state));
}
