import { randomUUID } from "node:crypto";
import type { AssistantProposedAction } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { loadKitCatalog } from "../services/kit-catalog.js";
import { isDismissedFingerprint } from "./preferences-digest.js";
import { collectCatalogFeedbackTokens, scoreStackPreset } from "./history.js";

type CatalogBase = {
  source_name?: string;
  default_addons?: string[];
};

type CatalogPreset = {
  label?: string;
  base?: string;
  addon_sources?: string[];
};

/**
 * Soft end-of-turn suggestions: when the plan has a base but no addons,
 * propose apply_stack_preset / add_addon for known catalog stack addons.
 * Still confirm-to-apply — never mutates.
 */
export function suggestSoftStackActions(options: {
  repo: AppRepository;
  planId: number;
  catalog?: Record<string, unknown>;
  existingActions?: AssistantProposedAction[];
  maxActions?: number;
}): AssistantProposedAction[] {
  const { repo, planId } = options;
  const maxActions = options.maxActions ?? 2;
  const existing = options.existingActions ?? [];
  if (!repo.getOwnedProfileIdentity(planId)) return [];

  const layers = repo.getProfileLayers(planId);
  const base = layers.find((l) => l.layer_type === "base");
  const addons = layers.filter((l) => l.layer_type !== "base");
  if (!base?.project_name || addons.length > 0) return [];

  // Skip if the turn already proposed stack/addon mutations.
  if (
    existing.some(
      (a) =>
        a.type === "apply_stack_preset" ||
        a.type === "add_addon" ||
        a.type === "apply_build_recipe",
    )
  ) {
    return [];
  }

  const catalog = options.catalog ?? loadKitCatalog();
  const bases = (catalog.bases ?? {}) as Record<string, CatalogBase>;
  const presets = (catalog.stack_presets ?? {}) as Record<string, CatalogPreset>;
  const knownTokens = collectCatalogFeedbackTokens(catalog);

  let baseId: string | null = null;
  let baseDef: CatalogBase | null = null;
  for (const [id, b] of Object.entries(bases)) {
    if (b.source_name === base.project_name) {
      baseId = id;
      baseDef = b;
      break;
    }
  }
  if (!baseId || !baseDef) return [];

  const matchingPresets = Object.entries(presets)
    .filter(([, p]) => p.base === baseId && (p.addon_sources?.length ?? 0) > 0)
    .map(([id, p]) => ({
      id,
      preset: p,
      score: scoreStackPreset(repo, id, knownTokens) + (p.addon_sources?.length ?? 0) * 0.01,
    }))
    .sort((a, b) => b.score - a.score);

  const out: AssistantProposedAction[] = [];
  const alreadyTyped = new Set<string>();

  const tryPush = (action: AssistantProposedAction) => {
    if (out.length >= maxActions) return;
    const key = `${action.type}:${JSON.stringify(action.params)}`;
    if (alreadyTyped.has(key)) return;
    if (isDismissedFingerprint(repo, planId, action.type, action.params)) return;
    alreadyTyped.add(key);
    out.push(action);
  };

  const best = matchingPresets[0];
  if (best) {
    tryPush({
      id: randomUUID(),
      type: "apply_stack_preset",
      plan_id: planId,
      label: `Apply stack preset “${best.id}”`,
      summary: `Plan has base “${base.project_name}” but no addons. Catalog preset ${best.id} adds ${(best.preset.addon_sources ?? []).join(", ")}. Confirm to apply.`,
      params: { preset_id: best.id },
    });
    return out;
  }

  const missing = baseDef.default_addons ?? [];
  for (const sourceName of missing) {
    if (out.length >= maxActions) break;
    tryPush({
      id: randomUUID(),
      type: "add_addon",
      plan_id: planId,
      label: `Add addon ${sourceName}`,
      summary: `Suggest adding known stack addon “${sourceName}” for base “${base.project_name}”. Confirm to apply.`,
      params: { source_name: sourceName },
    });
  }

  return out;
}
