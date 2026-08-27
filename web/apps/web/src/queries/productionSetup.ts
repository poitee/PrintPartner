import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProductionSetup, ProductionSetupInput } from "@print-partner/contracts";
import { fetchProductionSetup, saveProductionSetup } from "../api/endpoints/productionSetup";

export const productionSetupKey = (profileId: number | null) =>
  ["production-setup", profileId] as const;

export function useProductionSetup(profileId: number | null, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: productionSetupKey(profileId),
    queryFn: () => fetchProductionSetup(profileId!),
    enabled: enabled && profileId != null,
  });
  const mutation = useMutation({
    mutationFn: (input: ProductionSetupInput) => saveProductionSetup(profileId!, input),
    onSuccess: (saved) => queryClient.setQueryData(productionSetupKey(profileId), saved),
  });

  const save = (input: ProductionSetupInput): Promise<ProductionSetup> =>
    mutation.mutateAsync(input);

  return { ...query, save, saving: mutation.isPending, saveError: mutation.error };
}
