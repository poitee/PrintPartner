import { useQueryClient } from "@tanstack/react-query";
import { TENANT_FEATURE_TOGGLES_CAPABILITY } from "@print-partner/contracts";
import { planWorkflowAccess, spoolmanWorkflowGated } from "../lib/spoolmanWorkflowAccess";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";
import { usePlanFeaturesQuery } from "../queries/planFeatures";
import { useTenantFeaturesQuery } from "../queries/tenantFeatures";

/** Whether farm-only UI should show for the selected Plan's effective farm choice. */
export function useFarmVisible(profileId: number | null | undefined) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const capability = Boolean(health.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));
  const planGated = spoolmanWorkflowGated({ profileId, health });
  const plan = usePlanFeaturesQuery(profileId ?? 0, planGated);
  const account = useTenantFeaturesQuery(
    capability && profileId == null && health.status === "success" && health.data?.ok === true,
  );
  if (profileId != null) {
    const planState = client.getQueryState(queryKeys.planFeatures(profileId));
    return planWorkflowAccess("farm", {
      profileId,
      health,
      plan: { status: plan.status, data: plan.data, isInvalidated: planState?.isInvalidated ?? false },
    }).allowed;
  }
  if (!capability || health.status !== "success" || health.data?.ok !== true) return !capability;
  const accountState = client.getQueryState(queryKeys.tenantFeatures);
  return account.status === "success"
    && accountState?.isInvalidated !== true
    && account.data?.effective.farm.enabled === true;
}
