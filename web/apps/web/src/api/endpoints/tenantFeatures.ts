import {
  featurePatchSchema,
  featureSettingsSchema,
  type FeatureKey,
  type FeatureSettings,
} from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export async function fetchTenantFeatures(): Promise<FeatureSettings> {
  const value = await engineFetch<unknown>("/settings/features");
  return featureSettingsSchema.parse(value);
}

export async function patchTenantFeatures(
  patch: Partial<Record<FeatureKey, boolean | null>>,
): Promise<FeatureSettings> {
  const payload = featurePatchSchema.parse(patch);
  const value = await engineFetch<unknown>("/settings/features", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return featureSettingsSchema.parse(value);
}
