import type { BuildRecipe } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { loadKitCatalog } from "./kit-catalog.js";
import { loadKitManifest } from "./kit-manifest-store.js";
import { inferStackPresetId } from "../assistant/example-builds.js";
import { resolveStackPresetId, stackPresetBaseRef } from "./stack-preset.js";

function sourceRef(
  repo: AppRepository,
  projectId: number | null | undefined,
  fallbackName: string | null,
): { source_name: string | null; project_id: number | null; tag: string | null; branch: string | null } {
  if (projectId == null) {
    return { source_name: fallbackName, project_id: null, tag: null, branch: null };
  }
  const src = repo.getSource(projectId);
  return {
    source_name: src?.name ?? fallbackName,
    project_id: projectId,
    tag: src?.tag ?? null,
    branch: src?.branch ?? null,
  };
}

/** Derive a reproducible build recipe from current layers + kit manifest + decisions. */
export function deriveBuildRecipe(repo: AppRepository, planId: number): BuildRecipe | null {
  const profile = repo.getOwnedProfileIdentity(planId);
  if (!profile) return null;

  const layers = repo.getProfileLayers(planId);
  const kit = loadKitManifest(repo, planId);
  const catalog = loadKitCatalog();
  const decisions = repo.listPlanDecisions(planId);

  const baseLayer = layers.find((l) => l.layer_type === "base");
  const addonLayers = layers.filter((l) => l.layer_type !== "base");
  const base = sourceRef(repo, baseLayer?.project_id ?? null, baseLayer?.project_name ?? null);
  const addons = addonLayers
    .filter((l) => l.project_id != null)
    .map((l) => {
      const ref = sourceRef(repo, l.project_id, l.project_name);
      return {
        source_name: ref.source_name ?? l.project_name ?? `project-${l.project_id}`,
        project_id: l.project_id!,
        tag: ref.tag,
        branch: ref.branch,
      };
    });

  const addonNames = addons.map((a) => a.source_name);
  const stack_preset =
    inferStackPresetId(catalog, base.source_name, addonNames) ?? null;

  const mdLines = [
    `# Build recipe — ${profile.name} (#${planId})`,
    "",
    `## Base`,
    base.source_name
      ? `- ${base.source_name}${base.tag ? ` @ ${base.tag}` : base.branch ? ` @ ${base.branch}` : ""}`
      : "- (none)",
    "",
    `## Addons`,
    ...(addons.length
      ? addons.map(
          (a) =>
            `- ${a.source_name}${a.tag ? ` @ ${a.tag}` : a.branch ? ` @ ${a.branch}` : ""}`,
        )
      : ["- (none)"]),
    "",
    stack_preset ? `## Stack preset\n- \`${stack_preset}\`\n` : "",
    `## Kit selections`,
    ...(Object.keys(kit.selections).length
      ? Object.entries(kit.selections).map(([k, v]) => `- ${k}: ${v}`)
      : ["- (none)"]),
    "",
    `## Decisions (${decisions.length})`,
    ...(decisions.length
      ? decisions
          .slice(-12)
          .map(
            (d) =>
              `- [${d.kind}] ${d.label || d.action_type || "note"}${
                d.summary ? `: ${d.summary.slice(0, 120)}` : ""
              }`,
          )
      : ["- (none yet)"]),
  ].filter((line) => line !== "");

  return {
    plan_id: planId,
    plan_name: profile.name,
    base,
    addons,
    stack_preset,
    kit_selections: { ...kit.selections },
    include: [...(kit.include ?? [])],
    exclude: [...(kit.exclude ?? [])],
    decision_count: decisions.length,
    markdown: mdLines.join("\n"),
  };
}

export type RecipeReplayStep = {
  type: "set_base" | "add_addon" | "update_kit_selections" | "apply_stack_preset";
  params: Record<string, unknown>;
  label: string;
  summary: string;
};

/** Catalog base_tag/base_branch when the live recipe omitted a git ref. */
function catalogRefForPreset(presetId: string | null | undefined): {
  tag?: string;
  branch?: string;
} {
  if (!presetId) return {};
  const catalog = loadKitCatalog() as Record<string, unknown>;
  const presets = catalog.stack_presets as
    | Record<string, { base_tag?: string; base_branch?: string; label?: string }>
    | undefined;
  if (!presets) return {};
  const resolved = resolveStackPresetId(presetId, presets);
  if (!resolved) return {};
  return stackPresetBaseRef(presets[resolved] ?? {});
}

function pushBaseStep(steps: RecipeReplayStep[], recipe: BuildRecipe): void {
  if (!recipe.base.source_name) return;
  const catalogRef = catalogRefForPreset(recipe.stack_preset);
  const tag = recipe.base.tag ?? catalogRef.tag ?? null;
  const branch = recipe.base.branch ?? (!tag ? catalogRef.branch ?? null : null);
  const hasRef = Boolean(tag || branch);
  if (!hasRef && recipe.stack_preset) return;
  steps.push({
    type: "set_base",
    params: {
      source_name: recipe.base.source_name,
      ...(tag ? { tag } : {}),
      ...(branch && !tag ? { branch } : {}),
    },
    label: `Set base ${recipe.base.source_name}`,
    summary: `Set base to ${recipe.base.source_name}${
      tag ? ` @ ${tag}` : branch ? ` @ ${branch}` : ""
    }.`,
  });
}

function pushAddonSteps(steps: RecipeReplayStep[], recipe: BuildRecipe): void {
  for (const addon of recipe.addons) {
    steps.push({
      type: "add_addon",
      params: { source_name: addon.source_name },
      label: `Add addon ${addon.source_name}`,
      summary: `Add addon layer ${addon.source_name}.`,
    });
  }
}

function pushKitSteps(steps: RecipeReplayStep[], recipe: BuildRecipe): void {
  if (Object.keys(recipe.kit_selections).length === 0) return;
  steps.push({
    type: "update_kit_selections",
    params: { selections: recipe.kit_selections },
    label: "Apply kit selections",
    summary: `Merge ${Object.keys(recipe.kit_selections).length} kit selection(s).`,
  });
}

/**
 * Turn a recipe (or another plan's live state) into ordered mutate steps for propose/replay.
 * When a stack_preset is inferred, still append explicit tag / addon / kit steps so they
 * are not dropped by the preset-only early return. Catalog `base_tag` fills in when the
 * live recipe has no git ref yet (e.g. ldo_trident_r2 → VTr2).
 */
export function recipeToReplaySteps(recipe: BuildRecipe): RecipeReplayStep[] {
  const steps: RecipeReplayStep[] = [];

  if (recipe.stack_preset) {
    steps.push({
      type: "apply_stack_preset",
      params: { preset_id: recipe.stack_preset },
      label: `Apply stack preset ${recipe.stack_preset}`,
      summary: `Replay preset ${recipe.stack_preset} from recipe for ${recipe.plan_name}.`,
    });
    // Presets now set catalog base_tag on apply; still keep explicit set_base when a
    // tag/branch is known (live recipe or catalog) so Sync → Update stays targeted.
    pushBaseStep(steps, recipe);
    pushAddonSteps(steps, recipe);
    pushKitSteps(steps, recipe);
    return steps;
  }

  pushBaseStep(steps, recipe);
  pushAddonSteps(steps, recipe);
  pushKitSteps(steps, recipe);
  return steps;
}
