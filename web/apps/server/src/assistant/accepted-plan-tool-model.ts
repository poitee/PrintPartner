import type { AcceptedProfileProgress } from "../db/repository.js";
import type { AcceptedPlanBasis } from "../db/accepted-plan-progress.js";

const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type PrintStatsAcceptedProgress =
  | {
      readonly kind: "ready";
      readonly total_units: number;
      readonly remaining_units: number;
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized" | "integrity" | "concurrent_update";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function printStatsAcceptedProgress(progress: AcceptedProfileProgress): PrintStatsAcceptedProgress {
  switch (progress.kind) {
    case "ready":
      return {
        kind: "ready",
        total_units: progress.totalUnits,
        remaining_units: progress.remainingUnits,
      };
    case "empty":
      return { kind: "empty" };
    case "unavailable":
      return { kind: "unavailable", reason: progress.reason };
    case "integrity_failure":
      return { kind: "unavailable", reason: "integrity" };
    case "concurrent_update":
      return { kind: "unavailable", reason: "concurrent_update" };
  }
}

export function parseAcceptedPlanBasis(value: unknown): AcceptedPlanBasis | null {
  if (!isRecord(value)) return null;
  const profileId = value.profileId;
  const planVersion = value.planVersion;
  const revisionId = value.revisionId;
  const revisionDigest = value.revisionDigest;
  const requiredUnitMappingDigest = value.requiredUnitMappingDigest;
  if (
    typeof profileId !== "number" ||
    !Number.isSafeInteger(profileId) ||
    profileId <= 0 ||
    typeof planVersion !== "number" ||
    !Number.isSafeInteger(planVersion) ||
    planVersion <= 0 ||
    typeof revisionId !== "number" ||
    !Number.isSafeInteger(revisionId) ||
    revisionId <= 0 ||
    typeof revisionDigest !== "string" ||
    !SHA256_DIGEST_PATTERN.test(revisionDigest) ||
    typeof requiredUnitMappingDigest !== "string" ||
    !SHA256_DIGEST_PATTERN.test(requiredUnitMappingDigest)
  ) {
    return null;
  }
  return {
    profileId,
    planVersion,
    revisionId,
    revisionDigest,
    requiredUnitMappingDigest,
  };
}
