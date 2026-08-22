import type { AppRepository, ProfileHeader } from "../db/repository.js";
import { loadKitCatalog } from "../services/kit-catalog.js";
import { loadKitManifest } from "../services/kit-manifest-store.js";
import { loadRoleFilamentDefaults } from "../services/role-filament-store.js";
import { aggregateFeedbackScores, collectCatalogFeedbackTokens } from "./history.js";

const MAX_EXAMPLE_PLANS = 5;
const MAX_EXAMPLE_CHARS = 4500;
const MAX_PER_PLAN_CHARS = 900;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…[truncated]`;
}

/** Infer a matching stack preset id from base + addon source names (best-effort). */
export function inferStackPresetId(
  catalog: Record<string, unknown>,
  baseSourceName: string | null,
  addonSourceNames: string[],
): string | null {
  const bases = (catalog.bases ?? {}) as Record<string, { source_name?: string }>;
  const presets = (catalog.stack_presets ?? {}) as Record<
    string,
    { base?: string; addon_sources?: string[] }
  >;
  let baseId: string | null = null;
  if (baseSourceName) {
    for (const [id, b] of Object.entries(bases)) {
      if (b.source_name === baseSourceName) {
        baseId = id;
        break;
      }
    }
  }
  if (!baseId) return null;
  const addonSet = new Set(addonSourceNames);
  let best: { id: string; score: number } | null = null;
  for (const [id, p] of Object.entries(presets)) {
    if (p.base !== baseId) continue;
    const wanted = p.addon_sources ?? [];
    let score = 0;
    for (const name of wanted) {
      if (addonSet.has(name)) score += 2;
      else score -= 1;
    }
    for (const name of addonSourceNames) {
      if (!wanted.includes(name)) score -= 1;
    }
    if (!best || score > best.score) best = { id, score };
  }
  return best && best.score > 0 ? best.id : null;
}

function summarizeOnePlan(
  repo: AppRepository,
  profile: ProfileHeader,
  catalog: Record<string, unknown>,
): string | null {
  const planId = profile.id;
  const layers = repo.getProfileLayers(planId);
  const kit = loadKitManifest(repo, planId);
  const base = layers.find((l) => l.layer_type === "base");
  const addons = layers.filter((l) => l.layer_type !== "base");
  const addonNames = addons.map((l) => l.project_name).filter(Boolean) as string[];
  const presetId = inferStackPresetId(catalog, base?.project_name ?? null, addonNames);
  const selectionEntries = Object.entries(kit.selections).slice(0, 12);
  const filaments = loadRoleFilamentDefaults(repo, planId);
  const filamentLines = Object.entries(filaments)
    .slice(0, 8)
    .map(([role, row]) => {
      const color = row.filament_color_id || row.filament_custom_hex || "unset";
      return `${role}=${color}`;
    });

  return truncate(
    [
      `### Example plan #${planId}: ${profile.name}`,
      `parts=${profile.part_count}; stale=${profile.build_stale ? "yes" : "no"}`,
      `base=${base?.project_name ?? "(none)"}`,
      `addons=[${addonNames.join(", ") || "none"}]`,
      presetId ? `inferred_stack_preset=${presetId}` : null,
      selectionEntries.length
        ? `kit_selections={${selectionEntries.map(([k, v]) => `${k}=${v}`).join(", ")}}`
        : "kit_selections={}",
      filamentLines.length ? `role_filaments={${filamentLines.join(", ")}}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    MAX_PER_PLAN_CHARS,
  );
}

export type ExampleBuildsOptions = {
  repo: AppRepository;
  /** Active plan to exclude from the example list. */
  excludePlanId?: number | null;
  catalog?: Record<string, unknown>;
  maxPlans?: number;
};

/**
 * Compact summaries of other tenant-accessible plans for few-shot *context*
 * (example data for the model). This is NOT model training or fine-tuning.
 */
export function summarizeOtherBuildsAsExamples(options: ExampleBuildsOptions): string | null {
  const catalog = options.catalog ?? loadKitCatalog();
  const maxPlans = options.maxPlans ?? MAX_EXAMPLE_PLANS;
  const knownTokens = collectCatalogFeedbackTokens(catalog);
  const feedback = aggregateFeedbackScores(options.repo, knownTokens);
  const profiles = options.repo
    .listProfileHeaders()
    .filter((p) => p.id !== options.excludePlanId)
    .sort((a, b) => {
      const scoreDiff =
        (feedback.byPlanId.get(b.id) ?? 0) - (feedback.byPlanId.get(a.id) ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return a.id - b.id;
    })
    .slice(0, maxPlans);
  if (profiles.length === 0) return null;

  const blocks: string[] = [
    "## Other builds as examples (few-shot context — NOT model training)",
    "These are summaries of plans this user can already access. Use them as concrete setup examples when advising; never invent STLs from them; never dump full part lists.",
  ];
  for (const p of profiles) {
    const block = summarizeOnePlan(options.repo, p, catalog);
    if (block) blocks.push(block);
  }
  return truncate(blocks.join("\n\n"), MAX_EXAMPLE_CHARS);
}
