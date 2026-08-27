import { describe, expect, it } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import type { ProfileLayer } from "../api/endpoints/plans";
import {
  addonPlanLayers,
  attachedPlanSourceIds,
  basePlanLayer,
  buildSourceLayerRows,
  sourceSelectOptions,
  unattachedSources,
} from "./buildSourceLayers";

function layer(overrides: Partial<ProfileLayer>): ProfileLayer {
  return {
    id: overrides.id ?? 1,
    layer_order: overrides.layer_order ?? 0,
    layer_type: overrides.layer_type ?? "addon",
    project_id: overrides.project_id ?? null,
    project_name: overrides.project_name ?? null,
  };
}

function source(id: number, name = `Source ${id}`): SourceSummary {
  return {
    id,
    name,
    url: "https://example.test",
    source_kind: "github",
    source_type: "git",
    role: "",
    category: null,
    branch: "main",
    tag: null,
    local_path: null,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
  };
}

describe("build source layers", () => {
  it("splits base and addon layers", () => {
    const layers = [layer({ id: 1, layer_type: "addon" }), layer({ id: 2, layer_type: "base" })];

    expect(basePlanLayer(layers)?.id).toBe(2);
    expect(addonPlanLayers(layers).map((item) => item.id)).toEqual([1]);
  });

  it("builds attached source ids and unattached source options", () => {
    const attachedIds = attachedPlanSourceIds([
      layer({ project_id: 1 }),
      layer({ project_id: null }),
      layer({ project_id: 3 }),
    ]);

    expect([...attachedIds]).toEqual([1, 3]);
    expect(unattachedSources([source(1), source(2), source(3)], attachedIds).map((item) => item.id)).toEqual([2]);
    expect(sourceSelectOptions([source(2, "Mods")])).toEqual([{ value: "2", label: "Mods" }]);
  });

  it("builds source card rows in base-then-addon order", () => {
    expect(
      buildSourceLayerRows([
        layer({ id: 9, layer_type: "addon", project_id: 20, project_name: "Toolhead" }),
        layer({ id: 2, layer_type: "base", project_id: 10, project_name: "Base" }),
        layer({ id: 10, layer_type: "addon", project_id: null }),
      ]).map((row) => ({ key: row.key, sourceId: row.sourceId, sourceName: row.sourceName, layerType: row.layerType })),
    ).toEqual([
      { key: "base-2", sourceId: 10, sourceName: "Base", layerType: "base" },
      { key: "addon-9", sourceId: 20, sourceName: "Toolhead", layerType: "addon" },
    ]);
  });
});
