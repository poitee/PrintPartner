/** Source layer → repo display name (ported from parts_tree.py). */

export function repoNameFromSourceLayer(sourceLayer: string): string {
  const layer = sourceLayer || "";
  const idx = layer.indexOf(":");
  if (idx >= 0) return layer.slice(idx + 1);
  return layer || "unknown";
}
