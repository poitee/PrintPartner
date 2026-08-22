import { readFileSync } from "node:fs";
import type { AppRepository } from "../db/repository.js";
import { loadManifestYaml } from "./manifest-apply.js";
import { findEditableSourceManifestPath } from "./source-workspace.js";

export type VariantDimensionMap = Record<string, Array<string | number>>;

/** Setting key template for plan-level variant selections. */
export function planVariantSelectionKey(planId: number): string {
  return `plan_variant_selection_${planId}`;
}

/**
 * Load variant_dimensions declared in a project's manifest YAML.
 * Returns empty object if the project has no local path, no manifest, or no variant_dimensions.
 */
export function getSourceVariantDimensions(
  repo: AppRepository,
  sourceId: number,
): VariantDimensionMap {
  const proj = repo.getProjectRow(sourceId);
  if (!proj?.localPath) return {};
  const manifestPath = findEditableSourceManifestPath({
    reposDir: repo.reposDir,
    sourceId,
    contentRoot: proj.localPath,
  });
  if (!manifestPath) return {};
  try {
    const doc = loadManifestYaml(readFileSync(manifestPath, "utf8"));
    return doc.variant_dimensions ?? {};
  } catch {
    return {};
  }
}

/**
 * Load current variant selection stored on the plan.
 */
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

/**
 * Persist a variant selection on the plan and update the base project's import rules
 * so only matching subdirectories are included.
 *
 * For each dimension (e.g. size=300), the import rules are augmented with a rule
 * that matches paths containing `/${value}/` (e.g. `/300/`) within a subtree,
 * replacing any previous variant-dimension rules.
 *
 * If selection is empty, clears variant-dimension rules (reverts to full import).
 */
export function applyPlanVariantSelection(
  repo: AppRepository,
  planId: number,
  selection: Record<string, string>,
  sourceId: number,
): { rules: string[]; selection: Record<string, string> } {
  // Persist selection
  repo.setSetting(planVariantSelectionKey(planId), JSON.stringify(selection));

  // Derive import rules from selection
  // Each selected value becomes a path filter like `<value>/`
  const rules: string[] = Object.values(selection)
    .filter(Boolean)
    .map((val) => `${val}/`);

  // Apply to the project
  const result = repo.updateImportRules(sourceId, rules.length > 0 ? rules : []);

  return { rules: result.rules, selection };
}
