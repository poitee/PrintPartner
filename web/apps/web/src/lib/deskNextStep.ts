/**
 * One next-step line per spine page (GRE-226). Exact copy; hide when done.
 */
export const DESK_NEXT_STEP = {
  library: "Add a source, then New Build.",
  plan: "Attach sources, pick files, assign colors.",
  parts: "Check qty. Conflicts: exclude on Plan.",
  progress: "Remaining is the work. Add bag/sort when you bag.",
  export: "Send remaining STLs to the slicer, then choose the .gcode here.",
} as const;

export type DeskNextStepPage = keyof typeof DESK_NEXT_STEP;

export type DeskNextStepState = {
  sourceCount?: number;
  attachedSourceCount?: number;
  partCount?: number;
  colorsUnset?: boolean;
  mergeConflictCount?: number;
  missingStlCount?: number;
  remainingUnits?: number;
};

export function deskNextStepVisible(
  page: DeskNextStepPage,
  state: DeskNextStepState,
): boolean {
  switch (page) {
    case "library":
      return (state.sourceCount ?? 0) === 0;
    case "plan":
      return (
        (state.attachedSourceCount ?? 0) === 0 ||
        (state.partCount ?? 0) === 0 ||
        Boolean(state.colorsUnset)
      );
    case "parts":
      // Hide when Parts desk work is clean (no conflicts / missing STLs).
      return (
        (state.partCount ?? 0) > 0 &&
        ((state.mergeConflictCount ?? 0) > 0 || (state.missingStlCount ?? 0) > 0)
      );
    case "progress":
      return (state.remainingUnits ?? 0) > 0;
    case "export":
      return (state.remainingUnits ?? 0) > 0;
    default:
      return false;
  }
}

export function deskNextStepLine(
  page: DeskNextStepPage,
  state: DeskNextStepState,
): string | null {
  return deskNextStepVisible(page, state) ? DESK_NEXT_STEP[page] : null;
}
