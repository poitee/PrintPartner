export type AuxiliarySaveKind = "special_request" | "manifest";

type FailedAuxiliarySave = Readonly<{
  kind: AuxiliarySaveKind;
  order: number;
  retry: () => Promise<void>;
}>;

const failedByProfile = new Map<number, Map<AuxiliarySaveKind, FailedAuxiliarySave>>();
let nextOrder = 0;

export function retainFailedAuxiliarySave(
  profileId: number,
  kind: AuxiliarySaveKind,
  retry: () => Promise<void>,
): void {
  const profileFailures = failedByProfile.get(profileId) ?? new Map<AuxiliarySaveKind, FailedAuxiliarySave>();
  const existing = profileFailures.get(kind);
  profileFailures.set(kind, {
    kind,
    order: existing?.order ?? nextOrder++,
    retry,
  });
  failedByProfile.set(profileId, profileFailures);
}

export function clearFailedAuxiliarySave(profileId: number, kind: AuxiliarySaveKind): void {
  const profileFailures = failedByProfile.get(profileId);
  if (!profileFailures) return;
  profileFailures.delete(kind);
  if (profileFailures.size === 0) failedByProfile.delete(profileId);
}

/** Retries failed special-request and manifest saves in the order they first failed. */
export async function retryFailedAuxiliarySaves(profileId: number): Promise<void> {
  const profileFailures = failedByProfile.get(profileId);
  if (!profileFailures || profileFailures.size === 0) return;
  const ordered = [...profileFailures.values()].sort((left, right) => left.order - right.order);
  for (const failure of ordered) {
    await failure.retry();
  }
}

export function resetAuxiliarySaveIntentForTests(): void {
  failedByProfile.clear();
  nextOrder = 0;
}
