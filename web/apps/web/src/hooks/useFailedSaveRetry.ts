import { useCallback } from "react";
import { useFlushBuildPageSaves, useRetryBuildPageSaves } from "../context/BuildSaveFlushContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import {
  retryFailedAuxiliarySaves,
  useFailedAuxiliarySaveMessage,
} from "../lib/planAuxiliarySaveIntent";

/**
 * The selected Build's failed Save and its deliberate Retry, shared by the Plan page and the
 * command palette. Retry resends only retained intents, then settles the mounted Build editors,
 * also when the resend is refused. retryPlanSave runs only for a failed ordinary Save: with
 * nothing retained it prepares a new Plan.
 */
export function useFailedSaveRetry(): { error: string | null; retry: () => Promise<void> } {
  const { selectedProfileId } = useProfileSelection();
  const { draftError, retryPlanSave } = usePlanWorkspace();
  const flushBuildSaves = useFlushBuildPageSaves();
  const retryBuildSaves = useRetryBuildPageSaves();
  const auxiliaryError = useFailedAuxiliarySaveMessage(selectedProfileId);

  const retry = useCallback(async () => {
    try {
      // retryPlanSave also resends the retained special-request and manifest saves.
      if (draftError != null) await retryPlanSave();
      else if (selectedProfileId != null) await retryFailedAuxiliarySaves(selectedProfileId);
    } catch (error) {
      // An ordinary flush settles the other editors without resending what this Retry just sent.
      await flushBuildSaves().catch(() => {});
      throw error;
    }
    await retryBuildSaves();
  }, [draftError, flushBuildSaves, retryBuildSaves, retryPlanSave, selectedProfileId]);

  return { error: draftError ?? auxiliaryError, retry };
}
