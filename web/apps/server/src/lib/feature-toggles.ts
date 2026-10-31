import { z } from "zod";
import type { AppRepository } from "../db/repository.js";
import {
  featureChoicesSchema as choicesSchema,
  effectiveFeaturesSchema as effectiveSchema,
  featureKeys,
  type FeatureChoices,
  type FeatureKey,
} from "@print-partner/contracts";
export { featureKeys, featurePatchSchema } from "@print-partner/contracts";
export type { FeatureChoices, FeatureKey } from "@print-partner/contracts";

type FeatureLayer = { readonly choices: FeatureChoices; readonly raw: Record<string, unknown> };
const storedObjectSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const losslessJsonSchema = z.object({
  rawJSON: z.function({ input: [z.string()], output: z.unknown() }),
});
const numberSourceSchema = z.object({ source: z.string() });

export function desktopFeaturesEnabled(): boolean {
  return process.env.PP_DESKTOP_REBUILD === "1" || process.env.PP_DESKTOP_REBUILD === "true";
}

export function parseFeatureLayer(
  snapshot: ReturnType<AppRepository["getSettingSnapshot"]>,
): FeatureLayer | null {
  if (snapshot.kind === "missing") return { choices: {}, raw: {} };
  try {
    const { rawJSON } = losslessJsonSchema.parse(JSON);
    const stored: unknown = JSON.parse(
      snapshot.value,
      (_key: string, value: unknown, context?: unknown) =>
        typeof value === "number" ? rawJSON(numberSourceSchema.parse(context).source) : value,
    );
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
  return effectiveSchema.parse(
    Object.fromEntries(featureKeys.map((key) => [key, resolveFeature(key, user, plan)])),
  );
}
