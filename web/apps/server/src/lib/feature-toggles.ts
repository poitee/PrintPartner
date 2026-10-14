import { z } from "zod";
import type { AppRepository } from "../db/repository.js";

const featuresSchema = z.object({
  farm: z.boolean(),
  orders: z.boolean(),
  bambu: z.boolean(),
  spoolman: z.boolean(),
});
const effectiveSchema = z.record(featuresSchema.keyof(), z.object({
  enabled: z.boolean(),
  source: z.enum(["plan", "user", "default"]),
}));
const choicesSchema = featuresSchema.partial();
export const featureKeys = featuresSchema.keyof().options;
export const featurePatchSchema = z.partialRecord(featuresSchema.keyof(), z.boolean().nullable());
export type FeatureChoices = z.infer<typeof choicesSchema>;
type FeatureKey = keyof FeatureChoices;
type FeatureLayer = { readonly choices: FeatureChoices; readonly raw: Record<string, unknown> };
const storedObjectSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

export function desktopFeaturesEnabled(): boolean {
  return process.env.PP_DESKTOP_REBUILD === "1" || process.env.PP_DESKTOP_REBUILD === "true";
}

export function parseFeatureLayer(
  snapshot: ReturnType<AppRepository["getSettingSnapshot"]>,
): FeatureLayer | null {
  if (snapshot.kind === "missing") return { choices: {}, raw: {} };
  try {
    const stored: unknown = JSON.parse(snapshot.value);
    const raw = storedObjectSchema.parse(stored);
    return { choices: choicesSchema.parse(raw), raw };
  } catch {
    return null;
  }
}

export function resolveFeature(
  key: FeatureKey,
  user: FeatureChoices,
  plan: FeatureChoices = {},
): { enabled: boolean; source: "plan" | "user" | "default" } {
  if (Object.hasOwn(plan, key)) return { enabled: plan[key] === true, source: "plan" };
  if (Object.hasOwn(user, key)) return { enabled: user[key] === true, source: "user" };
  return { enabled: false, source: "default" };
}

export function resolveFeatures(user: FeatureChoices, plan: FeatureChoices) {
  return effectiveSchema.parse(Object.fromEntries(
    featureKeys.map((key) => [key, resolveFeature(key, user, plan)]),
  ));
}
