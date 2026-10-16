import { useCallback, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type HealthResponse,
  type PlanFeatures,
} from "@print-partner/contracts";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";
import { usePlanFeaturesQuery } from "../queries/planFeatures";

export function useSpoolmanWorkflowAccess(profileId: number | null | undefined) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const gated = Boolean(profileId != null && health.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));
  const plan = usePlanFeaturesQuery(profileId ?? 0, gated);
  const planState = client.getQueryState(queryKeys.planFeatures(profileId ?? 0));
  const allowed = !gated || (health.isSuccess && health.data.ok && plan.isSuccess && !planState?.isInvalidated
    && plan.data.profile_id === profileId && plan.data.effective.spoolman.enabled);
  // Keep the same key while features first load, so discovery does not fetch twice.
  const queryAllowed = plan.isPending || allowed;
  const scope = useRef<{ profileId: typeof profileId } | null>(null);

  useLayoutEffect(() => {
    scope.current = { profileId };
    return () => { scope.current = null; };
  }, [profileId]);

  const currentAccessAllowed = useCallback(() => {
    const currentHealth = client.getQueryState<HealthResponse>(queryKeys.health);
    if (profileId == null || !currentHealth?.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY)) return true;
    if (currentHealth.status !== "success" || !currentHealth.data.ok) return false;
    const currentPlan = client.getQueryState<PlanFeatures>(queryKeys.planFeatures(profileId));
    return currentPlan?.status === "success" && !currentPlan.isInvalidated
      && currentPlan.data?.profile_id === profileId && currentPlan.data.effective.spoolman.enabled;
  }, [client, profileId]);

  const beginAction = useCallback(() => {
    const target = scope.current;
    const isCurrent = () => target !== null && scope.current === target;
    return {
      isCurrent,
      isSpoolmanAllowed: () => isCurrent() && currentAccessAllowed(),
    };
  }, [currentAccessAllowed]);

  return { allowed, queryAllowed, currentAccessAllowed, beginAction };
}
