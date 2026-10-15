import { z } from "zod";

export const TENANT_FEATURE_TOGGLES_CAPABILITY = "tenant_feature_toggles";

const featuresSchema = z.object({
  farm: z.boolean(),
  orders: z.boolean(),
  bambu: z.boolean(),
  spoolman: z.boolean(),
});
export const featureKeys = featuresSchema.keyof().options;
export const featureChoicesSchema = featuresSchema.partial();
export const featurePatchSchema = z.partialRecord(featuresSchema.keyof(), z.boolean().nullable());
export const effectiveFeaturesSchema = z.record(featuresSchema.keyof(), z.object({
  enabled: z.boolean(),
  source: z.enum(["plan", "user", "default"]),
}));
export const featureSettingsSchema = z.object({
  choices: featureChoicesSchema,
  effective: effectiveFeaturesSchema,
});
export type FeatureKey = keyof z.infer<typeof featuresSchema>;
export type FeatureChoices = z.infer<typeof featureChoicesSchema>;
export type FeatureSettings = z.infer<typeof featureSettingsSchema>;
