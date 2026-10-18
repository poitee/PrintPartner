import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FeatureKey, FeatureSettings } from "@print-partner/contracts";
import {
  fetchTenantFeatures,
  patchTenantFeatures,
} from "../api/endpoints/tenantFeatures";
import { queryKeys } from "./keys";

export function useTenantFeaturesQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.tenantFeatures,
    queryFn: fetchTenantFeatures,
    enabled,
    staleTime: 30_000,
    notifyOnChangeProps: "all",
  });
}

export function usePatchTenantFeaturesMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Record<FeatureKey, boolean | null>>) =>
      patchTenantFeatures(patch),
    onSuccess: (updated) => {
      qc.setQueryData<FeatureSettings>(queryKeys.tenantFeatures, updated);
      void qc.invalidateQueries({ queryKey: ["planFeatures"] });
    },
  });
}
