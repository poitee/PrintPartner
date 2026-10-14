import type { AppRepository } from "../db/repository.js";
import { desktopFeaturesEnabled, parseFeatureLayer, resolveFeature, type FeatureKey } from "./feature-toggles.js";

type FeatureAccess =
  | { kind: "allowed" }
  | { kind: "disabled"; code: "FEATURE_DISABLED"; error: string }
  | { kind: "invalid"; code: "FEATURE_TOGGLES_INVALID"; error: string };

export function readFeatureAccess(getRepo: () => AppRepository, feature: FeatureKey): FeatureAccess {
  if (!desktopFeaturesEnabled()) return { kind: "allowed" };
  const layer = parseFeatureLayer(getRepo().getSettingSnapshot("feature_toggles"));
  if (!layer) {
    return { kind: "invalid", code: "FEATURE_TOGGLES_INVALID", error: "Stored feature toggles are invalid." };
  }
  if (resolveFeature(feature, layer.choices).enabled) return { kind: "allowed" };
  return { kind: "disabled", code: "FEATURE_DISABLED", error: `Feature ${feature} is disabled.` };
}
