import type { BuildRecipe, PlanSnapshot, PlanSnapshotSummary } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export async function fetchPlanRecipe(planId: number): Promise<BuildRecipe> {
  return engineFetch(`/plans/${planId}/recipe`);
}

export async function fetchPlanSnapshots(planId: number): Promise<{ snapshots: PlanSnapshotSummary[] }> {
  return engineFetch(`/plans/${planId}/snapshots`);
}

export async function createPlanSnapshotApi(
  planId: number,
  body: { name?: string; source?: string } = {},
): Promise<PlanSnapshot> {
  return engineFetch(`/plans/${planId}/snapshots`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function restorePlanSnapshotApi(
  planId: number,
  snapshotId: number,
): Promise<{ ok: boolean; needs_sync?: boolean; detail?: string }> {
  return engineFetch(`/plans/${planId}/snapshots/${snapshotId}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
