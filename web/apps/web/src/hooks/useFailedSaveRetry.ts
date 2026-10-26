import { useCallback } from "react";
import { useRetryBuildPageSaves } from "../context/BuildSaveFlushContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import {
  retryFailedAuxiliarySaves,
  useFailedAuxiliarySaveMessage,
} from "../lib/planAuxiliarySaveIntent";

/**
 * The selected Build's failed Save and its deliberate Retry, shared by the Plan page and the
 * command palette. Retry resends only retained intents, then settles the mounted Build editors.
 * retryPlanSave runs only for a failed ordinary Save: with nothing retained it prepares a new Plan.
 */
export function useFailedSaveRetry(): { error: string | null; retry: () => Promise<void> } {
  const { selectedProfileId } = useProfileSelection();
  const { draftError, retryPlanSave } = usePlanWorkspace();
  const retryBuildSaves = useRetryBuildPageSaves();
  const auxiliaryError = useFailedAuxiliarySaveMessage(selectedProfileId);

  const retry = useCallback(async () => {
    // retryPlanSave also resends the retained special-request and manifest saves.
    if (draftError != null) await retryPlanSave();
    else if (selectedProfileId != null) await retryFailedAuxiliarySaves(selectedProfileId);
    await retryBuildSaves();
  }, [draftError, retryBuildSaves, retryPlanSave, selectedProfileId]);

  return { error: draftError ?? auxiliaryError, retry };
}
