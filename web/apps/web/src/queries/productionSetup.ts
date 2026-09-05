import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ProductionSetup, ProductionSetupCommand } from "@print-partner/contracts";
import {
  applyProductionSetupCommand,
  fetchProductionSetup,
} from "../api/endpoints/productionSetup";

export const productionSetupKey = (profileId: number | null) =>
  ["production-setup", profileId] as const;

export const productionSetupMutationKey = (profileId: number | null) =>
  ["production-setup-command", profileId] as const;

export const productionSetupMutationScope = (profileId: number | null) => ({
  id: `production-setup:${profileId ?? "none"}`,
});

export function useProductionSetup(profileId: number | null, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: productionSetupKey(profileId),
    queryFn: () => fetchProductionSetup(profileId!),
    enabled: enabled && profileId != null,
  });
  const mutation = useMutation({
    mutationKey: productionSetupMutationKey(profileId),
    scope: productionSetupMutationScope(profileId),
    retry: false,
    mutationFn: (command: ProductionSetupCommand) => {
      if (profileId == null) {
        return Promise.reject(new Error("Production setup has not loaded yet."));
      }
      return applyProductionSetupCommand(profileId, command);
    },
    onMutate: () => queryClient.cancelQueries({ queryKey: productionSetupKey(profileId) }),
    onSuccess: (saved) => queryClient.setQueryData(productionSetupKey(profileId), saved),
  });
  const saving = useIsMutating({
    mutationKey: productionSetupMutationKey(profileId),
    exact: true,
  }) > 0;

  const save = (command: ProductionSetupCommand): Promise<ProductionSetup> => {
    if (profileId == null || query.data == null) {
      return Promise.reject(new Error("Production setup has not loaded yet."));
    }
    return mutation.mutateAsync(command);
  };

  return { ...query, save, saving, saveError: mutation.error };
}
