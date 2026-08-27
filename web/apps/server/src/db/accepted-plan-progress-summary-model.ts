import type { AcceptedPlanProgressRead } from "./accepted-plan-progress-summary.js";

export const MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH = 64;

export type AcceptedTerminalIdentity = {
  readonly acceptedPlanRevisionId: number | null;
  readonly acceptedPlanVersion: number | null;
  readonly acceptedInputSetId: number | null;
  readonly acceptedInputAcceptedAt: string | null;
  readonly requiredUnitMappingDigest: string | null;
};

export function canonicalProfileIds(profileIds: readonly number[]): readonly number[] {
  for (const profileId of profileIds) {
    if (!Number.isSafeInteger(profileId) || profileId <= 0) {
      throw new Error("Accepted Plan Progress profile IDs must be positive safe integers");
    }
  }
  const unique = [...new Set(profileIds)];
  if (unique.length > MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH) {
    throw new Error(
      `Accepted Plan Progress batches contain at most ${MAX_ACCEPTED_PROGRESS_SUMMARY_BATCH} Plans`,
    );
  }
  return unique;
}

export function terminalIdentityEqual(
  left: AcceptedTerminalIdentity,
  right: AcceptedTerminalIdentity,
): boolean {
  return (
    left.acceptedPlanRevisionId === right.acceptedPlanRevisionId &&
    left.acceptedPlanVersion === right.acceptedPlanVersion &&
    left.acceptedInputSetId === right.acceptedInputSetId &&
    left.acceptedInputAcceptedAt === right.acceptedInputAcceptedAt &&
    left.requiredUnitMappingDigest === right.requiredUnitMappingDigest
  );
}

export function appendGrouped<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

export function stableResults(input: {
  readonly profileIds: readonly number[];
  readonly before: ReadonlyMap<number, AcceptedTerminalIdentity>;
  readonly after: ReadonlyMap<number, AcceptedTerminalIdentity>;
  readonly reads: ReadonlyMap<number, AcceptedPlanProgressRead>;
}): {
  readonly stable: ReadonlyMap<number, AcceptedPlanProgressRead>;
  readonly changed: readonly number[];
} {
  const stable = new Map<number, AcceptedPlanProgressRead>();
  const changed: number[] = [];
  for (const profileId of input.profileIds) {
    if (terminalIdentityEqual(input.before.get(profileId)!, input.after.get(profileId)!)) {
      stable.set(profileId, input.reads.get(profileId)!);
    } else {
      changed.push(profileId);
    }
  }
  return { stable, changed };
}
