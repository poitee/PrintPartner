import { useCallback, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HealthResponse, PlanFeatures } from "@print-partner/contracts";
import { spoolmanWorkflowAccess } from "../lib/spoolmanWorkflowAccess";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";
import { usePlanFeaturesQuery } from "../queries/planFeatures";

export function useSpoolmanWorkflowAccess(profileId: number | null | undefined) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const access = spoolmanWorkflowAccess({
    profileId,
    health,
    plan: client.getQueryState<PlanFeatures>(queryKeys.planFeatures(profileId ?? 0)),
  });
  usePlanFeaturesQuery(profileId ?? 0, access.gated);
  const scope = useRef<{ profileId: typeof profileId } | null>(null);

  useLayoutEffect(() => {
    scope.current = { profileId };
    return () => { scope.current = null; };
  }, [profileId]);

  const currentAccessAllowed = useCallback(() => {
    return spoolmanWorkflowAccess({
      profileId,
      health: client.getQueryState<HealthResponse>(queryKeys.health),
      plan: client.getQueryState<PlanFeatures>(queryKeys.planFeatures(profileId ?? 0)),
    }).allowed;
  }, [client, profileId]);

  const beginAction = useCallback(() => {
    const target = scope.current;
    const isCurrent = () => target !== null && scope.current === target;
    return { isCurrent };
  }, []);

  return { ...access, currentAccessAllowed, beginAction };
}
