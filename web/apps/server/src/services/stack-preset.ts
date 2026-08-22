import type { AppRepository } from "../db/repository.js";
import { loadKitCatalog } from "./kit-catalog.js";

type StackPreset = {
  base: string;
  /** Optional GitHub tag to set on the base source when applying (e.g. VTr2 for R2). */
  base_tag?: string | null;
  /** Optional GitHub branch to set on the base source when applying. */
  base_branch?: string | null;
  addon_sources: string[];
  default_selections: Record<string, string>;
};

type CatalogBase = { source_name: string };
type CatalogAddonCategory = { rule?: string; sources: Array<{ name: string }> };

/** Map invented / alias preset ids (e.g. voron_trident_r2) onto catalog keys. */
export function resolveStackPresetId(
  raw: string,
  presets: Record<string, { label?: string } | StackPreset>,
): string | null {
  const needle = raw.trim();
  if (!needle) return null;
  if (presets[needle]) return needle;
  const aliases: Record<string, string> = {
    voron_trident_r2: "ldo_trident_r2",
    trident_r2: "ldo_trident_r2",
    ldo_voron_trident_r2: "ldo_trident_r2",
  };
  const alias = aliases[needle.toLowerCase()];
  if (alias && presets[alias]) return alias;

  const compact = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const want = compact(needle);
  for (const [id, preset] of Object.entries(presets)) {
    if (compact(id) === want) return id;
    const label = "label" in preset ? preset.label : undefined;
    if (label && compact(label) === want) return id;
    if (label && compact(label).includes(want)) return id;
    if (want.includes(compact(id))) return id;
  }
  // Prefer LDO Trident R2 when the model invents a Trident R2 id
  if (/trident.*r2|r2.*trident/i.test(needle) && presets.ldo_trident_r2) {
    return "ldo_trident_r2";
  }
  return null;
}

/** Read optional base git ref from a catalog stack preset. */
export function stackPresetBaseRef(preset: {
  base_tag?: string | null;
  base_branch?: string | null;
}): { tag?: string; branch?: string } {
  const tag =
    typeof preset.base_tag === "string" && preset.base_tag.trim()
      ? preset.base_tag.trim()
      : undefined;
  const branch =
    typeof preset.base_branch === "string" && preset.base_branch.trim()
      ? preset.base_branch.trim()
      : undefined;
  if (tag) return { tag };
  if (branch) return { branch };
  return {};
}

function catalogCategoryForSource(
  catalog: Record<string, unknown>,
  sourceName: string,
): string | null {
  const cats = catalog.addon_categories as Record<string, CatalogAddonCategory> | undefined;
  if (!cats) return null;
  for (const [catId, cat] of Object.entries(cats)) {
    if (cat.sources?.some((s) => s.name === sourceName)) return catId;
  }
  return null;
}

function projectIdByName(repo: AppRepository, name: string): number | null {
  const source = repo.listSources().find((s) => s.name === name);
  return source?.id ?? null;
}

export function applyStackPresetToProfile(
  repo: AppRepository,
  profileId: number,
  presetId: string,
): {
  profile_id: number;
  preset_id: string;
  missing_sources: string[];
  layers: ReturnType<AppRepository["getProfileLayers"]>;
  selections: Record<string, string>;
  base_source_name: string;
  tag: string | null;
  branch: string | null;
  needs_sync: boolean;
} {
  const catalog = loadKitCatalog() as Record<string, unknown>;
  const presets = catalog.stack_presets as Record<string, StackPreset> | undefined;
  const resolvedId =
    presets != null ? resolveStackPresetId(presetId, presets) : null;
  const preset = resolvedId != null ? presets?.[resolvedId] : undefined;
  if (!preset || resolvedId == null) throw new Error(`Unknown stack preset: ${presetId}`);

  const bases = catalog.bases as Record<string, CatalogBase> | undefined;
  const baseDef = bases?.[preset.base];
  if (!baseDef) throw new Error(`Unknown catalog base: ${preset.base}`);

  const missing: string[] = [];
  const baseProjectId = projectIdByName(repo, baseDef.source_name);
  if (baseProjectId == null) {
    throw new Error(`Sync ${baseDef.source_name} on Sources before applying this preset.`);
  }

  const ref = stackPresetBaseRef(preset);
  let needsSync = false;
  if (ref.tag || ref.branch) {
    const before = repo.getSource(baseProjectId);
    const tagChanged = Boolean(ref.tag && ref.tag !== (before?.tag ?? ""));
    const branchChanged = Boolean(
      ref.branch && !ref.tag && ref.branch !== (before?.branch ?? ""),
    );
    if (tagChanged || branchChanged) {
      const patch: { tag?: string | null; branch?: string } = {};
      if (ref.tag) {
        patch.tag = ref.tag;
      } else if (ref.branch) {
        patch.branch = ref.branch;
        patch.tag = null;
      }
      repo.updateSource(baseProjectId, patch);
      needsSync = true;
    }
  }

  repo.setBaseLayer(profileId, baseProjectId);
  let layers = repo.getProfileLayers(profileId);
  const addonLayers = () => layers.filter((l) => l.layer_type !== "base");

  for (const sourceName of preset.addon_sources) {
    const projectId = projectIdByName(repo, sourceName);
    if (projectId == null) {
      missing.push(sourceName);
      continue;
    }
    const categoryId = catalogCategoryForSource(catalog, sourceName);
    if (categoryId) {
      const cats = catalog.addon_categories as Record<string, CatalogAddonCategory>;
      const catRule = cats[categoryId]?.rule ?? "pick_one";
      const names = new Set(cats[categoryId]?.sources.map((s) => s.name) ?? []);
      const existing = addonLayers().find(
        (l) => l.project_name && names.has(l.project_name),
      );
      if (catRule === "pick_one") {
        let keeperId = existing?.id;
        if (existing) {
          if (existing.project_id !== projectId) {
            repo.replaceLayer(existing.id, projectId);
            layers = repo.getProfileLayers(profileId);
          }
        } else {
          repo.addAddonLayer(profileId, projectId);
          layers = repo.getProfileLayers(profileId);
          keeperId = layers.find((l) => l.project_id === projectId)?.id;
        }
        for (const layer of addonLayers()) {
          if (keeperId != null && layer.id === keeperId) continue;
          if (layer.project_name && names.has(layer.project_name)) {
            repo.removeLayer(layer.id);
            layers = repo.getProfileLayers(profileId);
          }
        }
      } else if (!addonLayers().some((l) => l.project_id === projectId)) {
        repo.addAddonLayer(profileId, projectId);
        layers = repo.getProfileLayers(profileId);
      }
    } else if (!addonLayers().some((l) => l.project_id === projectId)) {
      repo.addAddonLayer(profileId, projectId);
      layers = repo.getProfileLayers(profileId);
    }
  }

  const refreshed = repo.getSource(baseProjectId);
  return {
    profile_id: profileId,
    preset_id: resolvedId,
    missing_sources: missing,
    layers,
    selections: { ...preset.default_selections },
    base_source_name: baseDef.source_name,
    tag: refreshed?.tag ?? null,
    branch: refreshed?.branch ?? null,
    needs_sync: needsSync,
  };
}
