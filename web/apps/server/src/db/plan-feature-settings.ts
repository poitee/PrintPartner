import type { SettingSnapshot } from "./setting-compare-and-set.js";

export type OwnedPlanFeatureSnapshot = Readonly<{
  profileId: number;
  snapshot: SettingSnapshot;
}>;

export type OwnedPlanFeatureCompareAndSetInput = Readonly<{
  profileId: number;
  expected: SettingSnapshot;
  value: string;
}>;

export const planFeatureSettingPrefix = "feature_toggles:plan:";

export function planFeatureSettingKey(profileId: number): string {
  return `${planFeatureSettingPrefix}${profileId}`;
}
