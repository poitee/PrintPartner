/**
 * Operator choices that must survive leaving and returning to Checkoff.
 *
 * The shop floor interrupts people. When an operator walks to a printer and
 * comes back, the console reopens on the same view, with the same search, and
 * with the corrections they recorded still readable.
 *
 * Kept apart from the print-sheet preferences so the console can evolve
 * without rewriting the older stored shape.
 */

import {
  isCheckoffCorrectionReason,
  type CheckoffCorrectionRecord,
} from "./checkoffConsoleCorrection";
import { isCheckoffViewId, type CheckoffViewId } from "./checkoffConsoleModel";

export const CHECKOFF_CONSOLE_STORAGE_KEY = "print-partner.checkoff.console.v1";

/** Keeps one plan's history readable without letting storage grow forever. */
export const CHECKOFF_CORRECTION_LIMIT = 100;

export type CheckoffConsolePreferences = {
  view: CheckoffViewId | null;
  searchByPlanId: Record<string, string>;
  completedAtByPlanId: Record<string, string>;
  correctionsByPlanId: Record<string, CheckoffCorrectionRecord[]>;
};

export const EMPTY_CHECKOFF_CONSOLE_PREFERENCES: CheckoffConsolePreferences = {
  view: null,
  searchByPlanId: {},
  completedAtByPlanId: {},
  correctionsByPlanId: {},
};

function emptyPreferences(): CheckoffConsolePreferences {
  return {
    view: null,
    searchByPlanId: {},
    completedAtByPlanId: {},
    correctionsByPlanId: {},
  };
}

function parseStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof entry !== "string") continue;
    out[key] = entry;
  }
  return out;
}

function parseCorrection(value: unknown): CheckoffCorrectionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.partId !== "number" || !Number.isFinite(raw.partId)) return null;
  if (typeof raw.unitIndex !== "number" || !Number.isFinite(raw.unitIndex)) return null;
  if (!isCheckoffCorrectionReason(raw.reason)) return null;
  if (typeof raw.at !== "string" || !raw.at) return null;
  return {
    partId: raw.partId,
    unitIndex: raw.unitIndex,
    reason: raw.reason,
    note: typeof raw.note === "string" ? raw.note : "",
    at: raw.at,
  };
}

function parseCorrectionMap(
  value: unknown,
): Record<string, CheckoffCorrectionRecord[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, CheckoffCorrectionRecord[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !Array.isArray(entry)) continue;
    const records = entry
      .map(parseCorrection)
      .filter((record): record is CheckoffCorrectionRecord => record != null)
      .slice(0, CHECKOFF_CORRECTION_LIMIT);
    if (records.length) out[key] = records;
  }
  return out;
}

export function parseCheckoffConsolePreferences(
  raw: string | null,
): CheckoffConsolePreferences {
  if (!raw) return emptyPreferences();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      view: isCheckoffViewId(parsed.view) ? parsed.view : null,
      searchByPlanId: parseStringMap(parsed.searchByPlanId),
      completedAtByPlanId: parseStringMap(parsed.completedAtByPlanId),
      correctionsByPlanId: parseCorrectionMap(parsed.correctionsByPlanId),
    };
  } catch {
    return emptyPreferences();
  }
}

export function serializeCheckoffConsolePreferences(
  state: CheckoffConsolePreferences,
): string {
  return JSON.stringify(state);
}

export function loadCheckoffConsolePreferences(): CheckoffConsolePreferences {
  if (typeof localStorage === "undefined") return emptyPreferences();
  return parseCheckoffConsolePreferences(
    localStorage.getItem(CHECKOFF_CONSOLE_STORAGE_KEY),
  );
}

export function saveCheckoffConsolePreferences(
  state: CheckoffConsolePreferences,
): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    CHECKOFF_CONSOLE_STORAGE_KEY,
    serializeCheckoffConsolePreferences(state),
  );
}

function planKey(planId: number | null | undefined): string | null {
  if (planId == null || !Number.isFinite(planId)) return null;
  return String(planId);
}

export function getCheckoffSearch(
  state: CheckoffConsolePreferences,
  planId: number | null | undefined,
): string {
  const key = planKey(planId);
  if (!key) return "";
  return state.searchByPlanId[key] ?? "";
}

export function withCheckoffSearch(
  state: CheckoffConsolePreferences,
  planId: number,
  search: string,
): CheckoffConsolePreferences {
  const key = String(planId);
  const next = { ...state.searchByPlanId };
  if (search) next[key] = search;
  else delete next[key];
  return { ...state, searchByPlanId: next };
}

export function getCheckoffCompletedAt(
  state: CheckoffConsolePreferences,
  planId: number | null | undefined,
): string | null {
  const key = planKey(planId);
  if (!key) return null;
  return state.completedAtByPlanId[key] ?? null;
}

/** First completion wins: the receipt records when the work finished, not when it was reopened. */
export function withCheckoffCompletedAt(
  state: CheckoffConsolePreferences,
  planId: number,
  at: string | null,
): CheckoffConsolePreferences {
  const key = String(planId);
  const next = { ...state.completedAtByPlanId };
  if (at == null) delete next[key];
  else if (next[key] == null) next[key] = at;
  else return state;
  return { ...state, completedAtByPlanId: next };
}

export function getCheckoffCorrections(
  state: CheckoffConsolePreferences,
  planId: number | null | undefined,
): CheckoffCorrectionRecord[] {
  const key = planKey(planId);
  if (!key) return [];
  return state.correctionsByPlanId[key] ?? [];
}

export function withCheckoffCorrection(
  state: CheckoffConsolePreferences,
  planId: number,
  record: CheckoffCorrectionRecord,
): CheckoffConsolePreferences {
  const key = String(planId);
  const existing = state.correctionsByPlanId[key] ?? [];
  const records = [record, ...existing].slice(0, CHECKOFF_CORRECTION_LIMIT);
  return {
    ...state,
    correctionsByPlanId: { ...state.correctionsByPlanId, [key]: records },
  };
}

/** Latest correction per part, for row-level provenance in the Completed view. */
export function latestCorrectionsByPart(
  records: readonly CheckoffCorrectionRecord[],
): Map<number, CheckoffCorrectionRecord> {
  const out = new Map<number, CheckoffCorrectionRecord>();
  for (const record of records) {
    const current = out.get(record.partId);
    if (!current || current.at < record.at) out.set(record.partId, record);
  }
  return out;
}
