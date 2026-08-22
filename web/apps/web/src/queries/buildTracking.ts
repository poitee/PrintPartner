import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  fetchBuildTrackingSettings,
  saveBuildTrackingSettings,
  type BuildTrackingSettings,
} from "../api/engine";
import { queryKeys } from "./keys";

/**
 * Global Assembled Tracking setting (Settings > Build Tracking).
 * Shared via react-query cache so the Checkoff page's gate on the
 * "Assembled" toggle stays in sync with Settings without a page reload.
 */
export function useBuildTrackingSettingsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.buildTrackingSettings,
    queryFn: fetchBuildTrackingSettings,
    enabled,
    staleTime: 30_000,
  });
}

export function useSaveBuildTrackingSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: Partial<BuildTrackingSettings>) =>
      saveBuildTrackingSettings(settings),
    onSuccess: (updated) => {
      qc.setQueryData<BuildTrackingSettings>(queryKeys.buildTrackingSettings, updated);
    },
  });
}

export type { BuildTrackingSettings };
