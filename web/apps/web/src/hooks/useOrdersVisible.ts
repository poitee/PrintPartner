import { useQueryClient } from "@tanstack/react-query";
import { planWorkflowAccess, spoolmanWorkflowGated } from "../lib/spoolmanWorkflowAccess";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";
import { usePlanFeaturesQuery } from "../queries/planFeatures";

/** Whether the Plan's customer request (Orders) should be shown. Hidden while gated features load. */
export function useOrdersVisible(profileId: number | null | undefined) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const gated = spoolmanWorkflowGated({ profileId, health });
  const plan = usePlanFeaturesQuery(profileId ?? 0, gated);
  const planState = client.getQueryState(queryKeys.planFeatures(profileId ?? 0));
  return planWorkflowAccess("orders", {
    profileId,
    health,
    plan: { status: plan.status, data: plan.data, isInvalidated: planState?.isInvalidated ?? false },
  }).allowed;
}
