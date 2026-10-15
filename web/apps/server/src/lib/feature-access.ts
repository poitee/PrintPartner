import type { AppRepository } from "../db/repository.js";
import { desktopFeaturesEnabled, parseFeatureLayer, resolveFeature, type FeatureKey } from "./feature-toggles.js";

type FeatureAccess =
  | { kind: "allowed" }
  | { kind: "disabled"; code: "FEATURE_DISABLED"; error: string }
  | { kind: "invalid"; code: "FEATURE_TOGGLES_INVALID"; error: string };

export function readFeatureAccess(getRepo: () => AppRepository, feature: FeatureKey, profileId?: number): FeatureAccess {
  if (!desktopFeaturesEnabled()) return { kind: "allowed" };
  const repo = getRepo();
  const layer = parseFeatureLayer(repo.getSettingSnapshot("feature_toggles"));
  const plan = parseFeatureLayer(profileId == null
    ? { kind: "missing" }
    : repo.getSettingSnapshot(`feature_toggles:plan:${profileId}`));
  if (!layer || !plan) {
    return { kind: "invalid", code: "FEATURE_TOGGLES_INVALID", error: "Stored feature toggles are invalid." };
  }
  if (resolveFeature(feature, layer.choices, plan.choices).enabled) return { kind: "allowed" };
  return { kind: "disabled", code: "FEATURE_DISABLED", error: `Feature ${feature} is disabled.` };
}
