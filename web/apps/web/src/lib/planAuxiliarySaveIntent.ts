export type AuxiliarySaveKind = "special_request" | "manifest";

type FailedAuxiliarySave = Readonly<{
  kind: AuxiliarySaveKind;
  retry: () => Promise<void>;
}>;

const failedByProfile = new Map<number, Map<AuxiliarySaveKind, FailedAuxiliarySave>>();

export function retainFailedAuxiliarySave(
  profileId: number,
  kind: AuxiliarySaveKind,
  retry: () => Promise<void>,
): void {
  const profileFailures = failedByProfile.get(profileId) ?? new Map<AuxiliarySaveKind, FailedAuxiliarySave>();
  profileFailures.set(kind, { kind, retry });
  failedByProfile.set(profileId, profileFailures);
}

export function clearFailedAuxiliarySave(profileId: number, kind: AuxiliarySaveKind): void {
  const profileFailures = failedByProfile.get(profileId);
  if (!profileFailures) return;
  profileFailures.delete(kind);
  if (profileFailures.size === 0) failedByProfile.delete(profileId);
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
}
