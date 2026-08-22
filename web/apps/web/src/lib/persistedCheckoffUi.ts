export const CHECKOFF_UI_STORAGE_KEY = "print-partner.checkoff.ui.v1";

export type CheckoffFilterMode = "all" | "missing" | "done";

export type PersistedBagBar = {
  id: string;
  label: string;
};

export type PersistedProgressRow =
  | { kind: "part"; id: number }
  | { kind: "bag"; id: string; label: string };

export type PersistedCheckoffUi = {
  filter: CheckoffFilterMode;
  compactMode: boolean;
  /** When true, print uses continuous layout (fewer forced page breaks). */
  continuousPrintLayout: boolean;
  /**
   * Per-plan Progress row order (part ids). Legacy — migrated into
   * progressRowsByPlanId on read when the new field is absent.
   */
  partOrderByPlanId: Record<string, number[]>;
  /** Per-plan bag/sort bars (this-plan labels). */
  bagBarsByPlanId: Record<string, PersistedBagBar[]>;
  /**
   * Per-plan interleaved Progress rows (parts + bags). Local-only.
   * When present, wins over partOrderByPlanId + bagBarsByPlanId merge.
   */
  progressRowsByPlanId: Record<string, PersistedProgressRow[]>;
};

const DEFAULT: PersistedCheckoffUi = {
  /** Progress stage defaults to Remaining (unprinted checkoff units). */
  filter: "missing",
  compactMode: false,
  continuousPrintLayout: false,
  partOrderByPlanId: {},
  bagBarsByPlanId: {},
  progressRowsByPlanId: {},
};

function isFilter(value: unknown): value is CheckoffFilterMode {
  return value === "all" || value === "missing" || value === "done";
}

function parsePartOrderByPlanId(value: unknown): Record<string, number[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number[]> = {};
  for (const [planId, order] of Object.entries(value as Record<string, unknown>)) {
    if (!planId || !Array.isArray(order)) continue;
    const ids = order.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    if (ids.length) out[planId] = ids;
  }
  return out;
}

function parseBagBarsByPlanId(value: unknown): Record<string, PersistedBagBar[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, PersistedBagBar[]> = {};
  for (const [planId, bars] of Object.entries(value as Record<string, unknown>)) {
    if (!planId || !Array.isArray(bars)) continue;
    const parsed: PersistedBagBar[] = [];
    const seen = new Set<string>();
    for (const bar of bars) {
      if (!bar || typeof bar !== "object" || Array.isArray(bar)) continue;
      const id = typeof (bar as { id?: unknown }).id === "string"
        ? (bar as { id: string }).id.trim()
        : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label =
        typeof (bar as { label?: unknown }).label === "string"
          ? (bar as { label: string }).label
          : "";
      parsed.push({ id, label });
    }
    if (parsed.length) out[planId] = parsed;
  }
  return out;
}

function parseProgressRowsByPlanId(
  value: unknown,
): Record<string, PersistedProgressRow[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, PersistedProgressRow[]> = {};
  for (const [planId, rows] of Object.entries(value as Record<string, unknown>)) {
    if (!planId || !Array.isArray(rows)) continue;
    const parsed: PersistedProgressRow[] = [];
    const seenParts = new Set<number>();
    const seenBags = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const kind = (row as { kind?: unknown }).kind;
      if (kind === "part") {
        const id = (row as { id?: unknown }).id;
        if (typeof id !== "number" || !Number.isFinite(id) || seenParts.has(id)) continue;
        seenParts.add(id);
        parsed.push({ kind: "part", id });
        continue;
      }
      if (kind === "bag") {
        const id =
          typeof (row as { id?: unknown }).id === "string"
            ? (row as { id: string }).id.trim()
            : "";
        if (!id || seenBags.has(id)) continue;
        seenBags.add(id);
        const label =
          typeof (row as { label?: unknown }).label === "string"
            ? (row as { label: string }).label
            : "";
        parsed.push({ kind: "bag", id, label });
      }
    }
    if (parsed.length) out[planId] = parsed;
  }
  return out;
}

export function parsePersistedCheckoffUi(raw: string | null): PersistedCheckoffUi {
  if (!raw) {
    return {
      ...DEFAULT,
      partOrderByPlanId: {},
      bagBarsByPlanId: {},
      progressRowsByPlanId: {},
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCheckoffUi>;
    return {
      filter: isFilter(parsed.filter) ? parsed.filter : DEFAULT.filter,
      compactMode:
        typeof parsed.compactMode === "boolean"
          ? parsed.compactMode
          : DEFAULT.compactMode,
      continuousPrintLayout:
        typeof parsed.continuousPrintLayout === "boolean"
          ? parsed.continuousPrintLayout
          : DEFAULT.continuousPrintLayout,
      partOrderByPlanId: parsePartOrderByPlanId(parsed.partOrderByPlanId),
      bagBarsByPlanId: parseBagBarsByPlanId(parsed.bagBarsByPlanId),
      progressRowsByPlanId: parseProgressRowsByPlanId(parsed.progressRowsByPlanId),
    };
  } catch {
    return {
      ...DEFAULT,
      partOrderByPlanId: {},
      bagBarsByPlanId: {},
      progressRowsByPlanId: {},
    };
  }
}

export function serializePersistedCheckoffUi(state: PersistedCheckoffUi): string {
  return JSON.stringify(state);
}

export function loadPersistedCheckoffUi(): PersistedCheckoffUi {
  if (typeof localStorage === "undefined") {
    return {
      ...DEFAULT,
      partOrderByPlanId: {},
      bagBarsByPlanId: {},
      progressRowsByPlanId: {},
    };
  }
  return parsePersistedCheckoffUi(localStorage.getItem(CHECKOFF_UI_STORAGE_KEY));
}

export function savePersistedCheckoffUi(state: PersistedCheckoffUi): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CHECKOFF_UI_STORAGE_KEY, serializePersistedCheckoffUi(state));
}

export function getPartOrderForPlan(
  state: PersistedCheckoffUi,
  planId: number | null | undefined,
): number[] {
  if (planId == null) return [];
  return state.partOrderByPlanId[String(planId)] ?? [];
}

export function withPartOrderForPlan(
  state: PersistedCheckoffUi,
  planId: number,
  order: number[],
): PersistedCheckoffUi {
  return {
    ...state,
    partOrderByPlanId: {
      ...state.partOrderByPlanId,
      [String(planId)]: order,
    },
  };
}

export function getBagBarsForPlan(
  state: PersistedCheckoffUi,
  planId: number | null | undefined,
): PersistedBagBar[] {
  if (planId == null) return [];
  return state.bagBarsByPlanId[String(planId)] ?? [];
}

export function getProgressRowsForPlan(
  state: PersistedCheckoffUi,
  planId: number | null | undefined,
): PersistedProgressRow[] {
  if (planId == null) return [];
  const key = String(planId);
  const rows = state.progressRowsByPlanId[key];
  if (rows?.length) return rows;
  const parts = state.partOrderByPlanId[key] ?? [];
  const bags = state.bagBarsByPlanId[key] ?? [];
  if (!parts.length && !bags.length) return [];
  return [
    ...parts.map((id) => ({ kind: "part" as const, id })),
    ...bags.map((b) => ({ kind: "bag" as const, id: b.id, label: b.label })),
  ];
}

export function withProgressRowsForPlan(
  state: PersistedCheckoffUi,
  planId: number,
  rows: PersistedProgressRow[],
): PersistedCheckoffUi {
  const key = String(planId);
  const partIds = rows.filter((r) => r.kind === "part").map((r) => r.id);
  const bags = rows
    .filter((r): r is Extract<PersistedProgressRow, { kind: "bag" }> => r.kind === "bag")
    .map((r) => ({ id: r.id, label: r.label }));
  return {
    ...state,
    partOrderByPlanId: { ...state.partOrderByPlanId, [key]: partIds },
    bagBarsByPlanId: { ...state.bagBarsByPlanId, [key]: bags },
    progressRowsByPlanId: { ...state.progressRowsByPlanId, [key]: rows },
  };
}
