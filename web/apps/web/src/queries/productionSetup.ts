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
    /**
     * The patch is merged over the record in the cache, read at call time so a
     * queued save cannot revert a field it never knew about. A caller changing
     * the route does not restate the selection, the printer assignments and the
     * rules, and cannot blank them by forgetting one.
     */
    mutationFn: (patch: Partial<ProductionSetupInput>) => {
      const current = queryClient.getQueryData<ProductionSetup>(productionSetupKey(profileId));
      if (profileId == null || current == null) {
        return Promise.reject(new Error("Production setup has not loaded yet."));
      }
      return saveProductionSetup(profileId, {
        preferred_slicer_instance_id: current.preferred_slicer_instance_id,
        selection: current.selection,
        printer_assignments: current.printer_assignments,
        route: current.route,
        rules: current.rules,
        ...patch,
      });
    },
    onSuccess: (saved) => queryClient.setQueryData(productionSetupKey(profileId), saved),
  });

  const save = (patch: Partial<ProductionSetupInput>): Promise<ProductionSetup> =>
    mutation.mutateAsync(patch);

  return { ...query, save, saving: mutation.isPending, saveError: mutation.error };
}
