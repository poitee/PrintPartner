import type { PrinterSendQueueItem } from "@print-partner/contracts";
import { z } from "zod";
import type { AppRepository } from "../db/repository.js";
import { planFeatureSettingKey } from "../db/plan-feature-settings.js";
import {
  desktopFeaturesEnabled,
  featureKeys,
  featurePatchSchema,
  parseFeatureLayer,
  resolveFeature,
  resolveFeatures,
  type FeatureChoices,
} from "../lib/feature-toggles.js";
import { listActivePrinterSendQueue } from "./printer-send-queue-store.js";

const profileIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const paramsSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(profileIdSchema),
}).strict();

type PlanFeatureView = {
  profile_id: number;
  overrides: FeatureChoices;
  effective: ReturnType<typeof resolveFeatures>;
};
export type PlanFeatureResult =
  | { kind: "ready"; view: PlanFeatureView }
  | { kind: "invalid_input" }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "invalid_storage" }
  | { kind: "conflict" };

type FarmSelection =
  | { kind: "allowed"; items: PrinterSendQueueItem[] }
  | { kind: "disabled" }
  | { kind: "invalid_storage" };

function view(profileId: number, user: FeatureChoices, plan: FeatureChoices): PlanFeatureView {
  return {
    profile_id: profileId,
    overrides: plan,
    effective: resolveFeatures(user, plan),
  };
}

export function readPlanFeatures(repo: AppRepository, params: unknown): PlanFeatureResult {
  if (!desktopFeaturesEnabled()) return { kind: "unavailable" };
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) return { kind: "invalid_input" };
  const { id } = parsed.data;
  if (!repo.getOwnedProfileIdentity(id)) return { kind: "not_found" };
  const user = parseFeatureLayer(repo.getSettingSnapshot("feature_toggles"));
  const plan = parseFeatureLayer(repo.getSettingSnapshot(planFeatureSettingKey(id)));
  if (!user || !plan) return { kind: "invalid_storage" };
  return { kind: "ready", view: view(id, user.choices, plan.choices) };
}

export function patchPlanFeatures(repo: AppRepository, params: unknown, body: unknown): PlanFeatureResult {
  if (!desktopFeaturesEnabled()) return { kind: "unavailable" };
  const parsed = paramsSchema.safeParse(params);
  const patch = featurePatchSchema.safeParse(body);
  if (!parsed.success || !patch.success) return { kind: "invalid_input" };
  const { id } = parsed.data;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!repo.getOwnedProfileIdentity(id)) return { kind: "not_found" };
    const user = parseFeatureLayer(repo.getSettingSnapshot("feature_toggles"));
    const snapshot = repo.getSettingSnapshot(planFeatureSettingKey(id));
    const plan = parseFeatureLayer(snapshot);
    if (!user || !plan) return { kind: "invalid_storage" };
    const raw = { ...plan.raw };
    const choices = { ...plan.choices };
    for (const key of featureKeys) {
      if (!Object.hasOwn(patch.data, key)) continue;
      const value = patch.data[key];
      if (value === null) {
        delete raw[key];
        delete choices[key];
      } else if (value !== undefined) {
        raw[key] = value;
        choices[key] = value;
      }
    }
    if (repo.compareAndSetOwnedPlanFeatures({ profileId: id, expected: snapshot, value: JSON.stringify(raw) })) {
      return { kind: "ready", view: view(id, user.choices, choices) };
    }
  }
  return { kind: "conflict" };
}

export function selectFarmSuggestionItems(repo: AppRepository): FarmSelection {
  if (!desktopFeaturesEnabled()) {
    return { kind: "allowed", items: listActivePrinterSendQueue(repo).filter((item) => item.state === "queued") };
  }
  const user = parseFeatureLayer(repo.getSettingSnapshot("feature_toggles"));
  if (!user) return { kind: "invalid_storage" };
  const userEnabled = resolveFeature("farm", user.choices).enabled;
  const queued = listActivePrinterSendQueue(repo).filter((item) => item.state === "queued");
  const enabledPlans = new Map<number, boolean>();
  const profileIds = [...new Set(queued.flatMap((item) => item.profile_id != null
    && profileIdSchema.safeParse(item.profile_id).success ? [item.profile_id] : []))];
  for (const { profileId, snapshot } of repo.getOwnedPlanFeatureSnapshots(profileIds)) {
    const plan = parseFeatureLayer(snapshot);
    if (!plan) return { kind: "invalid_storage" };
    enabledPlans.set(profileId, resolveFeature("farm", user.choices, plan.choices).enabled);
  }
  const items: PrinterSendQueueItem[] = [];
  for (const item of queued) {
    if (item.profile_id == null) {
      if (userEnabled) items.push(item);
      continue;
    }
    const id = item.profile_id;
    if (enabledPlans.get(id)) items.push(item);
  }
  return userEnabled || items.length > 0 ? { kind: "allowed", items } : { kind: "disabled" };
}
