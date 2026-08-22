import { useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  BuildRecipe,
  PlanDecision,
  PlanSnapshotSummary,
} from "@print-partner/contracts";
import {
  fetchPlanDecisions,
  fetchPlanRecipe,
  fetchPlanSnapshots,
} from "../api/engine";
import { queryKeys } from "./keys";

export type PlanRecipeBundle = {
  recipe: BuildRecipe;
  decisions: PlanDecision[];
  snapshots: PlanSnapshotSummary[];
};

async function fetchPlanRecipeBundle(profileId: number): Promise<PlanRecipeBundle> {
  const [recipe, decisions, snapshots] = await Promise.all([
    fetchPlanRecipe(profileId),
    fetchPlanDecisions(profileId),
    fetchPlanSnapshots(profileId),
  ]);
  return {
    recipe,
    decisions: decisions.decisions ?? [],
    snapshots: snapshots.snapshots ?? [],
  };
}

export function usePlanRecipeQuery(profileId: number) {
  return useQuery({
    queryKey: queryKeys.planRecipeBundle(profileId),
    queryFn: () => fetchPlanRecipeBundle(profileId),
    enabled: profileId > 0,
  });
}

export function invalidatePlanRecipe(queryClient: QueryClient, profileId: number) {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.planRecipeBundle(profileId),
  });
}
