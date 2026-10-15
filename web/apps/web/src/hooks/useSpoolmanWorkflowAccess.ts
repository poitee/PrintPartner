import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type HealthResponse,
  type PlanFeatures,
} from "@print-partner/contracts";
import type { FilamentCatalog } from "../api/endpoints/filaments";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";
import { usePlanFeaturesQuery } from "../queries/planFeatures";

export function useSpoolmanWorkflowAccess(profileId: number) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const healthy = Boolean(health.isSuccess && health.data?.ok);
  const gated = Boolean(health.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));

  const plan = usePlanFeaturesQuery(profileId, healthy && gated);

  const planState = client.getQueryState(queryKeys.planFeatures(profileId));

  const allowed = healthy && (!gated || (
    plan.isSuccess && !planState?.isInvalidated && plan.data?.profile_id === profileId && plan.data.effective.spoolman.enabled === true
  ));

  const generation = useRef(0);
  const mounted = useRef(false);
  const scope = useRef({ profileId });

  const currentAccessAllowed = useCallback(() => {
    const currentHealth = client.getQueryState<HealthResponse>(queryKeys.health);
    if (
      scope.current.profileId !== profileId ||
      !currentHealth ||
      currentHealth.status !== "success" ||
      !currentHealth.data?.ok
    ) {
      return false;
    }
    if (!currentHealth.data.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY)) return true;
    const currentPlan = client.getQueryState<PlanFeatures>(queryKeys.planFeatures(profileId));
    return currentPlan?.status === "success" && !currentPlan.isInvalidated
      && currentPlan.data?.profile_id === profileId && currentPlan.data.effective.spoolman.enabled === true;
  }, [client, profileId]);

  useLayoutEffect(() => {
    scope.current = { profileId };
    mounted.current = true;
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if (!currentAccessAllowed()) generation.current += 1;
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [client, currentAccessAllowed, profileId]);

  const beginAction = useCallback(() => {
    const started = generation.current;
    const target = scope.current;
    const isCurrent = () => mounted.current && scope.current === target;
    return {
      isCurrent,
      isSpoolmanAllowed: () =>
        isCurrent() &&
        started === generation.current &&
        currentAccessAllowed(),
    };
  }, [currentAccessAllowed]);

  const prevAllowed = useRef(allowed);
  useEffect(() => {
    if (allowed) {
      const cached = client.getQueryData<FilamentCatalog>(queryKeys.filamentCatalog(profileId));
      if (!prevAllowed.current || cached?.spoolman_status === "disabled") {
        void client.invalidateQueries({ queryKey: queryKeys.filamentCatalog(profileId) });
      }
    }
    prevAllowed.current = allowed;
  }, [allowed, client, profileId]);

  return { allowed: Boolean(allowed), currentAccessAllowed, beginAction };
}
