import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FeatureKey, PlanFeatures } from "@print-partner/contracts";
import {
  fetchPlanFeatures,
  patchPlanFeatures,
} from "../api/endpoints/planFeatures";
import { queryKeys } from "./keys";

export function usePlanFeaturesQuery(
  profileId: number,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.planFeatures(profileId),
    queryFn: () => fetchPlanFeatures(profileId),
    enabled,
    staleTime: 30_000,
    notifyOnChangeProps: "all",
  });
}

export function usePatchPlanFeaturesMutation(
  profileId: number,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Record<FeatureKey, boolean | null>>) =>
      patchPlanFeatures(profileId, patch),
    onSuccess: (updated) => {
      qc.setQueryData<PlanFeatures>(queryKeys.planFeatures(updated.profile_id), updated);
    },
  });
}
