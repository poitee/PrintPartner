/** Pure enablement rules for Export slicer-input actions (STLs / remaining / 3MF). */

export type SlicerExportGateInput = {
  profileSelected: boolean;
  engineOk: boolean;
  hasReview: boolean;
  includedCount: number;
  remainingUnits: number;
};

export type SlicerExportGates = {
  canRun: boolean;
  canExportParts: boolean;
  canExportRemaining: boolean;
};

/**
 * Review blockers (missing STL on disk, unsynced source, etc.) must not disable
 * export — the pack/3MF jobs already skip missing files and surface warnings.
 * Aligns Export cards with Command Palette (busy / remaining-only gates).
 */
export function slicerExportGates(input: SlicerExportGateInput): SlicerExportGates {
  const canRun = input.profileSelected && input.engineOk && input.hasReview;
  const canExportParts = canRun && input.includedCount > 0;
  const canExportRemaining = canExportParts && input.remainingUnits > 0;
  return { canRun, canExportParts, canExportRemaining };
}
