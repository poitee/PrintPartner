import type { PlanAcceptanceConfirmation } from "./planAcceptanceModel";

/**
 * A Plan acceptance receipt outlives the click that produced it.
 *
 * A toast disappears before the user has read it, and acceptance is the one
 * checkpoint the user must be able to trust later. The receipt is kept per
 * Build so returning to Plan still shows what happened.
 */

const KEY_PREFIX = "pp.plan-acceptance.";

export type StoredPlanAcceptance = PlanAcceptanceConfirmation & {
  readonly buildId: number;
  readonly acceptedAt: string;
};

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isStored(value: unknown): value is StoredPlanAcceptance {
  if (value == null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.buildId === "number" &&
    typeof row.planVersion === "number" &&
    typeof row.requiredUnits === "number" &&
    typeof row.verifiedUnits === "number" &&
    typeof row.remainingUnits === "number" &&
    Array.isArray(row.unmoved)
  );
}

export function readPlanAcceptance(
  buildId: number | null,
  storage?: Storage,
): StoredPlanAcceptance | null {
  const store = storageOrNull(storage);
  if (!store || buildId == null) return null;
  try {
    const raw = store.getItem(`${KEY_PREFIX}${buildId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStored(parsed) && parsed.buildId === buildId ? parsed : null;
  } catch {
    return null;
  }
}

export function writePlanAcceptance(
  value: StoredPlanAcceptance,
  storage?: Storage,
): void {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    store.setItem(`${KEY_PREFIX}${value.buildId}`, JSON.stringify(value));
  } catch {
    /* A full or blocked storage must not break acceptance itself. */
  }
}

export function clearPlanAcceptance(buildId: number | null, storage?: Storage): void {
  const store = storageOrNull(storage);
  if (!store || buildId == null) return;
  try {
    store.removeItem(`${KEY_PREFIX}${buildId}`);
  } catch {
    /* ignore */
  }
}
