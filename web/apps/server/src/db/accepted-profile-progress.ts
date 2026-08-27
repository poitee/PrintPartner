import type { AcceptedPlanCorruptionCode } from "./accepted-plan-operational.js";
import type { AcceptedPlanProgressRead } from "./accepted-plan-progress-summary.js";

export type AcceptedProfileProgress =
  | {
      readonly kind: "ready";
      readonly totalUnits: number;
      readonly remainingUnits: number;
    }
  | { readonly kind: "empty" }
  | {
      readonly kind: "unavailable";
      readonly reason: "compatibility_dirty" | "uninitialized";
    }
  | {
      readonly kind: "integrity_failure";
      readonly code: AcceptedPlanCorruptionCode;
    }
  | { readonly kind: "concurrent_update" };

export function acceptedProfileProgress(
  read: Exclude<AcceptedPlanProgressRead, { kind: "missing" }>,
): AcceptedProfileProgress {
  switch (read.kind) {
    case "ready":
      return {
        kind: "ready",
        totalUnits: read.totalUnits,
        remainingUnits: read.remainingUnits,
      };
    case "empty":
      return { kind: "empty" };
    case "unavailable":
      return { kind: "unavailable", reason: read.reason };
    case "integrity_failure":
      return { kind: "integrity_failure", code: read.code };
    case "concurrent_update":
      return { kind: "concurrent_update" };
  }
}
