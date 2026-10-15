import { useCallback, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type HealthResponse, type PlanFeatures } from "@print-partner/contracts";
import { useHealthQuery } from "../queries/health";
import { usePlanFeaturesQuery } from "../queries/planFeatures";
import { useTenantFeaturesQuery } from "../queries/tenantFeatures";
import { queryKeys } from "../queries/keys";

export function useBambuWorkflowAccess({ profileId, engineReady }: {
  profileId: number | null;
  engineReady: boolean;
}) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const healthy = engineReady && health.isSuccess && health.data.ok;
  const gated = Boolean(health.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));
  const plan = usePlanFeaturesQuery(profileId ?? 0, healthy && gated && profileId != null);
  const account = useTenantFeaturesQuery(healthy && gated);
  const canHandoff = healthy && profileId != null && (!gated || (
    plan.isSuccess && !client.getQueryState(queryKeys.planFeatures(profileId))?.isInvalidated
    && plan.data.profile_id === profileId && plan.data.effective.bambu.enabled
  ));
  const canPollStatus = healthy && (!gated || (
    account.isSuccess && !client.getQueryState(queryKeys.tenantFeatures)?.isInvalidated
    && account.data.effective.bambu.enabled
  ));
  const generation = useRef(0);
  const mounted = useRef(false);
  const scope = useRef({ profileId, engineReady });

  const currentHandoffAllowed = useCallback(() => {
    const currentHealth = client.getQueryState<HealthResponse>(queryKeys.health);
    if (scope.current.profileId !== profileId || scope.current.engineReady !== engineReady
      || !engineReady || profileId == null || currentHealth?.status !== "success" || !currentHealth.data?.ok) return false;
    if (!currentHealth.data.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY)) return true;
    const currentPlan = client.getQueryState<PlanFeatures>(queryKeys.planFeatures(profileId));
    return currentPlan?.status === "success" && !currentPlan.isInvalidated
      && currentPlan.data?.profile_id === profileId && currentPlan.data.effective.bambu.enabled === true;
  }, [client, engineReady, profileId]);

  useLayoutEffect(() => {
    scope.current = { profileId, engineReady };
    mounted.current = true;
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if (!currentHandoffAllowed()) generation.current += 1;
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [client, currentHandoffAllowed, canHandoff, profileId, engineReady]);

  function beginHandoff() {
    if (!mounted.current || !canHandoff || !currentHandoffAllowed()) return null;
    const started = generation.current;
    return { isCurrent: () => mounted.current && started === generation.current && currentHandoffAllowed() };
  }

  return { canHandoff, canPollStatus, beginHandoff };
}
