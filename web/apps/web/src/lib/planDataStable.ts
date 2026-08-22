import type { PartRow, ProfileLayer } from "../api/engine";

/** Shallow compare fields that affect Kit Studio UI. */
export function partRowsEqual(a: PartRow[], b: PartRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.included !== y.included ||
      x.match_key !== y.match_key ||
      x.relative_path !== y.relative_path ||
      x.filename !== y.filename ||
      x.source_layer !== y.source_layer ||
      x.status !== y.status ||
      x.requirement !== y.requirement ||
      x.option_group_id !== y.option_group_id ||
      x.filament_color_id !== y.filament_color_id ||
      x.filament_custom_hex !== y.filament_custom_hex ||
      x.filament_display !== y.filament_display ||
      x.filament_hex !== y.filament_hex ||
      x.quantity_effective !== y.quantity_effective
    ) {
      return false;
    }
  }
  return true;
}

export function layersEqual(a: ProfileLayer[], b: ProfileLayer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.layer_type !== y.layer_type || x.project_id !== y.project_id) {
      return false;
    }
  }
  return true;
}

