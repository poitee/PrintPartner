import type { PartRow, PlanRevisionInput } from "@print-partner/contracts";

export type PartDbRowModel = {
  id: number;
  matchKey: string;
  relativePath: string;
  filename: string;
  sourceLayer: string | null;
  status: string;
  role: string | null;
  requirement: string | null;
  optionGroupId: string | null;
  included: boolean;
  filamentColorId: string | null;
  filamentCustomHex: string | null;
  spoolmanSpoolId: string | null;
  quantityAuto: number;
  quantityOverride: number | null;
  quantityEffective: number;
};

export type AcceptedRevisionPartRowModel = Omit<PartDbRowModel, "id" | "matchKey" | "role" | "quantityAuto" | "quantityEffective"> & {
  projectionPartId: number | null;
  partKey: string;
  effectiveRole: string;
  quantityInferred: number;
  effectiveQuantity: number;
};

export function planInputTrackingKind(value: string): PlanRevisionInput["tracking_kind"] {
  return value === "untracked" ? "untracked" : "revision";
}

export function partRow(row: PartDbRowModel): PartRow {
  return {
    id: row.id,
    match_key: row.matchKey,
    relative_path: row.relativePath,
    filename: row.filename,
    source_layer: row.sourceLayer,
    status: row.status,
    role: row.role,
    requirement: row.requirement,
    option_group_id: row.optionGroupId,
    included: row.included,
    filament_color_id: row.filamentColorId,
    filament_custom_hex: row.filamentCustomHex,
    spoolman_spool_id: row.spoolmanSpoolId,
    filament_display: "",
    filament_hex: row.filamentCustomHex,
    quantity_auto: row.quantityAuto,
    quantity_override: row.quantityOverride,
    quantity_effective: row.quantityEffective,
  };
}

export function acceptedRevisionPartRow(row: AcceptedRevisionPartRowModel): PartRow {
  if (row.projectionPartId == null) {
    throw new Error("Accepted Plan revision Part has no compatibility projection ID");
  }
  return {
    id: row.projectionPartId,
    match_key: row.partKey,
    relative_path: row.relativePath,
    filename: row.filename,
    source_layer: row.sourceLayer,
    status: row.status,
    role: row.effectiveRole,
    requirement: row.requirement,
    option_group_id: row.optionGroupId,
    included: row.included,
    filament_color_id: row.filamentColorId,
    filament_custom_hex: row.filamentCustomHex,
    spoolman_spool_id: row.spoolmanSpoolId,
    filament_display: "",
    filament_hex: row.filamentCustomHex,
    quantity_auto: row.quantityInferred,
    quantity_override: row.quantityOverride,
    quantity_effective: row.effectiveQuantity,
  };
}
