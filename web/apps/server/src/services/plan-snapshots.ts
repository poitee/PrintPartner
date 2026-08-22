import type { PlanSnapshot, PlanSnapshotSource, PlanSnapshotSummary } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { loadKitManifest, saveKitManifest } from "./kit-manifest-store.js";
import { deriveBuildRecipe } from "./build-recipe.js";

export type PlanSnapshotPayload = {
  layers: Array<{
    layer_type: string;
    project_id: number | null;
    source_name: string | null;
    tag: string | null;
    branch: string | null;
    order: number;
  }>;
  kit_manifest: {
    name: string | null;
    selections: Record<string, string>;
    include: string[];
    exclude: string[];
    replacements: Record<string, string>;
    base_source_id: string | null;
    addon_source_ids: string[];
  };
  recipe_summary: string | null;
  captured_at: string;
};

export function capturePlanSnapshotPayload(repo: AppRepository, planId: number): PlanSnapshotPayload {
  const layers = repo.getProfileLayers(planId);
  const kit = loadKitManifest(repo, planId);
  const recipe = deriveBuildRecipe(repo, planId);

  return {
    layers: layers.map((l) => {
      const src = l.project_id != null ? repo.getSource(l.project_id) : null;
      return {
        layer_type: l.layer_type,
        project_id: l.project_id,
        source_name: l.project_name ?? src?.name ?? null,
        tag: src?.tag ?? null,
        branch: src?.branch ?? null,
        order: l.layer_order,
      };
    }),
    kit_manifest: {
      name: kit.name,
      selections: { ...kit.selections },
      include: [...(kit.include ?? [])],
      exclude: [...(kit.exclude ?? [])],
      replacements: { ...(kit.replacements ?? {}) },
      base_source_id: kit.base_source_id,
      addon_source_ids: [...(kit.addon_source_ids ?? [])],
    },
    recipe_summary: recipe?.markdown.slice(0, 2000) ?? null,
    captured_at: new Date().toISOString(),
  };
}

export function createPlanSnapshot(
  repo: AppRepository,
  planId: number,
  opts: { name?: string; source?: PlanSnapshotSource } = {},
): PlanSnapshot {
  const payload = capturePlanSnapshotPayload(repo, planId);
  return repo.createPlanSnapshot({
    planId,
    name: opts.name?.trim() || `Snapshot ${new Date().toISOString().slice(0, 16)}`,
    source: opts.source ?? "user",
    payload,
  });
}

export function listPlanSnapshots(repo: AppRepository, planId: number): PlanSnapshotSummary[] {
  return repo.listPlanSnapshots(planId);
}

export function getPlanSnapshot(repo: AppRepository, snapshotId: number): PlanSnapshot | null {
  return repo.getPlanSnapshot(snapshotId);
}

/**
 * Restore layers + kit selections from a snapshot payload.
 * Does not re-clone STLs; sets tags/branches when present and remaps by source name.
 */
export function restorePlanSnapshotPayload(
  repo: AppRepository,
  planId: number,
  payload: PlanSnapshotPayload | Record<string, unknown>,
): { ok: boolean; detail?: string; needs_sync?: boolean; layers?: unknown } {
  const layersRaw = Array.isArray(payload.layers) ? payload.layers : [];
  const kitRaw =
    payload.kit_manifest && typeof payload.kit_manifest === "object"
      ? (payload.kit_manifest as PlanSnapshotPayload["kit_manifest"])
      : null;

  // Resolve sources by name (ids may differ across tenants/imports).
  const resolved: Array<{
    layer_type: string;
    project_id: number;
    tag: string | null;
    branch: string | null;
  }> = [];
  let needsSync = false;

  for (const layer of layersRaw as PlanSnapshotPayload["layers"]) {
    const name = layer.source_name;
    if (!name) continue;
    const sources = repo.listSources();
    const src =
      sources.find((s) => s.name === name) ??
      sources.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!src) {
      return { ok: false, detail: `Source not found for snapshot layer: ${name}` };
    }
    const tag = typeof layer.tag === "string" ? layer.tag : null;
    const branch = typeof layer.branch === "string" ? layer.branch : null;
    const patch: { tag?: string | null; branch?: string } = {};
    if (tag != null && tag !== (src.tag ?? null)) {
      patch.tag = tag;
      needsSync = true;
    }
    if (branch && branch !== src.branch) {
      patch.branch = branch;
      needsSync = true;
    }
    if (Object.keys(patch).length) {
      repo.updateSource(src.id, patch);
    }
    resolved.push({
      layer_type: layer.layer_type === "base" ? "base" : "addon",
      project_id: src.id,
      tag,
      branch,
    });
  }

  const base = resolved.find((l) => l.layer_type === "base");
  if (base) {
    if (!(repo.getSource(base.project_id)?.local_path && repo.getSource(base.project_id)?.last_synced_at)) {
      return {
        ok: false,
        detail: `Base source must be synced before restore.`,
        needs_sync: true,
      };
    }
    repo.setBaseLayer(planId, base.project_id);
  }

  // Remove existing addons then re-add from snapshot order.
  const current = repo.getProfileLayers(planId);
  for (const layer of current) {
    if (layer.layer_type !== "base") {
      repo.removeLayer(layer.id);
    }
  }
  for (const layer of resolved) {
    if (layer.layer_type === "base") continue;
    const src = repo.getSource(layer.project_id);
    if (!(src?.local_path && src.last_synced_at)) {
      return {
        ok: false,
        detail: `Addon “${src?.name ?? layer.project_id}” is not synced.`,
        needs_sync: true,
      };
    }
    repo.addAddonLayer(planId, layer.project_id);
  }

  if (kitRaw) {
    const currentKit = loadKitManifest(repo, planId);
    saveKitManifest(repo, planId, {
      ...currentKit,
      name: (kitRaw.name ?? currentKit.name) as typeof currentKit.name,
      selections: { ...(kitRaw.selections ?? {}) },
      include: [...(kitRaw.include ?? [])],
      exclude: [...(kitRaw.exclude ?? [])],
      replacements: { ...(kitRaw.replacements ?? {}) },
      base_source_id: (kitRaw.base_source_id ??
        currentKit.base_source_id) as typeof currentKit.base_source_id,
      addon_source_ids: [...(kitRaw.addon_source_ids ?? [])],
    });
  }

  return {
    ok: true,
    needs_sync: needsSync,
    layers: repo.getProfileLayers(planId),
  };
}
