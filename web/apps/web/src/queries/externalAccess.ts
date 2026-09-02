import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExternalAccessSettings } from "@print-partner/contracts";
import {
  fetchExternalAccessSettings,
  saveExternalAccessSettings,
} from "../api/endpoints/settings";
import { queryKeys } from "./keys";

export function useExternalAccessSettingsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.externalAccessSettings,
    queryFn: fetchExternalAccessSettings,
    enabled,
    staleTime: 30_000,
  });
}

export function useSaveExternalAccessSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveExternalAccessSettings,
    onSuccess: (settings) => {
      queryClient.setQueryData<ExternalAccessSettings>(
        queryKeys.externalAccessSettings,
        settings,
      );
    },
  });
}
