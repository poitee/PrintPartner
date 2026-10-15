import {
  featurePatchSchema,
  planFeaturesSchema,
  type FeatureKey,
  type PlanFeatures,
} from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export async function fetchPlanFeatures(profileId: number): Promise<PlanFeatures> {
  const value = await engineFetch<unknown>(`/plans/${profileId}/features`);
  return planFeaturesSchema.parse(value);
}

export async function patchPlanFeatures(
  profileId: number,
  patch: Partial<Record<FeatureKey, boolean | null>>,
): Promise<PlanFeatures> {
  const payload = featurePatchSchema.parse(patch);
  const value = await engineFetch<unknown>(`/plans/${profileId}/features`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return planFeaturesSchema.parse(value);
}
