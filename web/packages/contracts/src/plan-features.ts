import { z } from "zod";
import {
  effectiveFeaturesSchema,
  featureChoicesSchema,
} from "./tenant-features.js";

export const planFeaturesSchema = z.object({
  profile_id: z.number().int().positive(),
  overrides: featureChoicesSchema,
  effective: effectiveFeaturesSchema,
});

export type PlanFeatures = z.infer<typeof planFeaturesSchema>;

export const planFeatureChoiceSchema = z.enum(["inherit", "enabled", "disabled"]);
export type PlanFeatureChoice = z.infer<typeof planFeatureChoiceSchema>;

export function overrideToChoice(override: boolean | undefined): PlanFeatureChoice {
  if (override === true) return "enabled";
  if (override === false) return "disabled";
  return "inherit";
}

export function choiceToOverridePatch(choice: PlanFeatureChoice): boolean | null {
  if (choice === "enabled") return true;
  if (choice === "disabled") return false;
  return null;
}
