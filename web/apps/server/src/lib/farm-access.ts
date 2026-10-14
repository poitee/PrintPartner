import { desktopFeaturesEnabled, parseFeatureLayer, resolveFeature } from "./feature-toggles.js";
import type { AppRepository } from "../db/repository.js";

type FarmAccess =
  | { kind: "allowed" }
  | {
      kind: "disabled";
      code: "FEATURE_DISABLED";
      error: "Feature farm is disabled.";
    }
  | {
      kind: "invalid";
      code: "FEATURE_TOGGLES_INVALID";
      error: "Stored feature toggles are invalid.";
    };

export function readFarmAccess(getRepo: () => AppRepository): FarmAccess {
  if (!desktopFeaturesEnabled()) {
    return { kind: "allowed" };
  }
  return resolveFarmAccess(getRepo().getSettingSnapshot("feature_toggles"));
}

function resolveFarmAccess(snapshot: ReturnType<AppRepository["getSettingSnapshot"]>): FarmAccess {
  const layer = parseFeatureLayer(snapshot);
  if (!layer) {
    return {
      kind: "invalid",
      code: "FEATURE_TOGGLES_INVALID",
      error: "Stored feature toggles are invalid.",
    };
  }
  if (resolveFeature("farm", layer.choices).enabled) return { kind: "allowed" };
  return { kind: "disabled", code: "FEATURE_DISABLED", error: "Feature farm is disabled." };
}
