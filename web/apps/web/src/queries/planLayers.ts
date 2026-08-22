import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  addProfileAddonLayer,
  deleteProfileLayer,
  fetchPlanLayers,
  replaceProfileLayer,
  setProfileBaseLayer,
  type ProfileLayer,
} from "../api/engine";
import { queryKeys } from "./keys";
import { invalidatePlanReview } from "./planReview";
import { invalidateProfiles } from "./profiles";
import { invalidatePlanRecipe } from "./planRecipe";

function planLayerMutationScope(profileId: number) {
  return { id: `plan-layers:${profileId}` };
}

async function invalidateLayerDependents(
  queryClient: QueryClient,
  profileId: number,
): Promise<void> {
  await Promise.all([
    invalidatePlanReview(queryClient, profileId),
    invalidateProfiles(queryClient),
    invalidatePlanRecipe(queryClient, profileId),
  ]);
}

async function publishPlanLayers(
  queryClient: QueryClient,
  profileId: number,
  layers: ProfileLayer[],
): Promise<void> {
  queryClient.setQueryData(queryKeys.planLayers(profileId), layers);
  await invalidateLayerDependents(queryClient, profileId);
}

export async function invalidatePlanStructure(
  queryClient: QueryClient,
  profileId: number,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.planLayers(profileId) }),
    invalidateLayerDependents(queryClient, profileId),
  ]);
}

export function usePlanLayersQuery(profileId: number | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.planLayers(profileId ?? 0),
    queryFn: () => fetchPlanLayers(profileId!),
    enabled: enabled && profileId != null && profileId > 0,
  });
}

export function useSetPlanBaseLayerMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: planLayerMutationScope(profileId),
    mutationFn: (sourceId: number) => setProfileBaseLayer(profileId, sourceId),
    onSuccess: (layers) => publishPlanLayers(queryClient, profileId, layers),
  });
}

export function useAddPlanAddonLayerMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: planLayerMutationScope(profileId),
    mutationFn: (sourceId: number) => addProfileAddonLayer(profileId, sourceId),
    onSuccess: (layers) => publishPlanLayers(queryClient, profileId, layers),
  });
}

export function useReplacePlanLayerMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: planLayerMutationScope(profileId),
    mutationFn: ({ layerId, sourceId }: { layerId: number; sourceId: number }) =>
      replaceProfileLayer(profileId, layerId, sourceId),
    onSuccess: (layers) => publishPlanLayers(queryClient, profileId, layers),
  });
}

export function useDeletePlanLayerMutation(profileId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: planLayerMutationScope(profileId),
    mutationFn: (layerId: number) => deleteProfileLayer(profileId, layerId),
    onSuccess: () => invalidatePlanStructure(queryClient, profileId),
  });
}
