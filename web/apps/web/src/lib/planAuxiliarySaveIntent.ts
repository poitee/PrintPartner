import { useSyncExternalStore } from "react";

export type AuxiliarySaveKind = "special_request" | "manifest";

type FailedAuxiliarySave = Readonly<{
  kind: AuxiliarySaveKind;
  /** The refusal shown wherever the Build offers its deliberate Retry. */
  message: string;
  retry: () => Promise<void>;
}>;

const failedByProfile = new Map<number, Map<AuxiliarySaveKind, FailedAuxiliarySave>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function retainFailedAuxiliarySave(
  profileId: number,
  kind: AuxiliarySaveKind,
  message: string,
  retry: () => Promise<void>,
): void {
  const profileFailures = failedByProfile.get(profileId) ?? new Map<AuxiliarySaveKind, FailedAuxiliarySave>();
  profileFailures.set(kind, { kind, message, retry });
  failedByProfile.set(profileId, profileFailures);
  notify();
}

export function clearFailedAuxiliarySave(profileId: number, kind: AuxiliarySaveKind): void {
  const profileFailures = failedByProfile.get(profileId);
  if (!profileFailures?.delete(kind)) return;
  if (profileFailures.size === 0) failedByProfile.delete(profileId);
  notify();
}

function firstFailedAuxiliarySaveMessage(profileId: number | null): string | null {
  if (profileId == null) return null;
  const first = failedByProfile.get(profileId)?.values().next();
  return first && !first.done ? first.value.message : null;
}

/** The first retained special-request or manifest refusal for a Build, or null when none is retained. */
export function useFailedAuxiliarySaveMessage(profileId: number | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => firstFailedAuxiliarySaveMessage(profileId),
    () => null,
  );
}

export function hasFailedAuxiliarySave(profileId: number, kind: AuxiliarySaveKind): boolean {
  return failedByProfile.get(profileId)?.has(kind) ?? false;
}

/**
 * Retries failed special-request and manifest saves in the order they first failed.
 * A failed retry does not stop the rest; the first failure is rethrown after all ran.
 */
export async function retryFailedAuxiliarySaves(profileId: number): Promise<void> {
  const profileFailures = failedByProfile.get(profileId);
  if (!profileFailures || profileFailures.size === 0) return;
  const errors: unknown[] = [];
  // Map insertion order matches first-failure order (updates keep the original key slot).
  for (const failure of [...profileFailures.values()]) {
    try {
      await failure.retry();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

export function resetAuxiliarySaveIntentForTests(): void {
  failedByProfile.clear();
  notify();
}
