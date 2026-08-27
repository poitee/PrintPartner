import type { AppRepository } from "../db/repository.js";
import {
  AcceptedPlanOperationalIntegrityError,
  type ReadAcceptedPlanOperationalSnapshotResult,
} from "../db/accepted-plan-operational.js";

export type AssistantAcceptedPlanReadResult =
  | {
      readonly kind: "read";
      readonly identity: {
        readonly id: number;
        readonly name: string;
        readonly archivedAt: string | null;
      };
      readonly accepted: ReadAcceptedPlanOperationalSnapshotResult;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "failure"; readonly detail: string };

export function readAcceptedPlanForAssistant(
  repo: AppRepository,
  profileId: number,
): AssistantAcceptedPlanReadResult {
  try {
    const identity = repo.getOwnedProfileIdentity(profileId);
    if (!identity) return { kind: "missing" };
    return {
      kind: "read",
      identity,
      accepted: repo.readAcceptedPlanOperationalSnapshot(profileId),
    };
  } catch (error) {
    return {
      kind: "failure",
      detail:
        error instanceof AcceptedPlanOperationalIntegrityError
          ? "Accepted Plan data is inconsistent"
          : "Internal Server Error",
    };
  }
}
