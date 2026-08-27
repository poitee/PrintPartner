import type { SourceSummary } from "@print-partner/contracts";
import type { ProfileLayer } from "../api/endpoints/plans";

export type BuildSourceLayerRow = {
  key: string;
  layer: ProfileLayer;
  sourceId: number;
  sourceName: string;
  layerType: "base" | "addon";
};

export function basePlanLayer(layers: readonly ProfileLayer[]): ProfileLayer | null {
  return layers.find((layer) => layer.layer_type === "base") ?? null;
}

export function addonPlanLayers(layers: readonly ProfileLayer[]): ProfileLayer[] {
  return layers.filter((layer) => layer.layer_type !== "base");
}

export function attachedPlanSourceIds(layers: readonly ProfileLayer[]): Set<number> {
  const ids = new Set<number>();
  for (const layer of layers) {
    if (layer.project_id != null) ids.add(layer.project_id);
  }
  return ids;
}

export function unattachedSources(
  sources: readonly SourceSummary[],
  attachedIds: ReadonlySet<number>,
): SourceSummary[] {
  return sources.filter((source) => !attachedIds.has(source.id));
}

export function sourceSelectOptions(sources: readonly SourceSummary[]): Array<{ value: string; label: string }> {
  return sources.map((source) => ({ value: String(source.id), label: source.name }));
}

export function buildSourceLayerRows(layers: readonly ProfileLayer[]): BuildSourceLayerRow[] {
  const baseLayer = basePlanLayer(layers);
  const addonLayers = addonPlanLayers(layers);
  const rows: BuildSourceLayerRow[] = [];
  if (baseLayer?.project_id != null) {
    rows.push({
      key: `base-${baseLayer.id}`,
      layer: baseLayer,
      sourceId: baseLayer.project_id,
      sourceName: baseLayer.project_name ?? "base",
      layerType: "base",
    });
  }
  for (const layer of addonLayers) {
    if (layer.project_id == null) continue;
    rows.push({
      key: `addon-${layer.id}`,
      layer,
      sourceId: layer.project_id,
      sourceName: layer.project_name ?? "addon",
      layerType: "addon",
    });
  }
  return rows;
}
