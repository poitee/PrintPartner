import { readFileSync } from "node:fs";
import type { AppRepository } from "../db/repository.js";
import { loadManifestYaml } from "./manifest-apply.js";
import { findSourceManifestPath } from "./source-workspace.js";

type VariantDimensionMap = Record<string, Array<string | number>>;

function planVariantSelectionKey(planId: number): string {
  return `plan_variant_selection_${planId}`;
}

export function getSourceVariantDimensions(
  repo: AppRepository,
  sourceId: number,
): VariantDimensionMap {
  const proj = repo.getProjectRow(sourceId);
  if (!proj?.localPath) return {};
  const manifestPath = findSourceManifestPath(proj.localPath);
  if (!manifestPath) return {};
  try {
    const doc = loadManifestYaml(readFileSync(manifestPath, "utf8"));
    return doc.variant_dimensions ?? {};
  } catch {
    return {};
  }
}

export function getPlanVariantSelection(
  repo: AppRepository,
  planId: number,
): Record<string, string> {
  const raw = repo.getSetting(planVariantSelectionKey(planId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function applyPlanVariantSelection(
  repo: AppRepository,
  planId: number,
  selection: Record<string, string>,
  sourceId: number,
): { rules: string[]; selection: Record<string, string> } {
  if (!repo.getOwnedProfileIdentity(planId)) throw new Error("Profile not found");
  const baseSourceId = repo.getProfileLayers(planId).find((layer) => layer.layer_type === "base")?.project_id;
  if (baseSourceId == null) throw new Error("No base source on plan");
  if (sourceId !== baseSourceId) throw new Error("Source must match the plan's base source");

  const dimensions = getSourceVariantDimensions(repo, baseSourceId);
  for (const [dimension, value] of Object.entries(selection)) {
    if (!Object.hasOwn(dimensions, dimension)) {
      throw new Error(`Unknown variant dimension: ${dimension}`);
    }
    if (!dimensions[dimension].some((option) => String(option) === value)) {
      throw new Error(`Unsupported option for variant dimension: ${dimension}`);
    }
  }

  const result = repo.savePlanVariantSelection(planId, baseSourceId, selection);
  return { rules: result.rules, selection };
}
