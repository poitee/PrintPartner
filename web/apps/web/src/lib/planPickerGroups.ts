/** Pure grouping for the one-spine plan picker (GRE-218). */

export const RECENT_PLAN_LIMIT = 5;

export type PlanPickerRow = {
  id: number;
  name: string;
  archived_at: string | null;
  last_used_at: string | null;
};

export type PlanPickerGroups = {
  active: PlanPickerRow[];
  recent: PlanPickerRow[];
  archived: PlanPickerRow[];
};

function isArchived(plan: PlanPickerRow): boolean {
  return plan.archived_at != null && plan.archived_at !== "";
}

function matchesSearch(plan: PlanPickerRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return plan.name.toLowerCase().includes(q);
}

function byLastUsedDesc(a: PlanPickerRow, b: PlanPickerRow): number {
  const aAt = a.last_used_at ?? "";
  const bAt = b.last_used_at ?? "";
  if (aAt !== bAt) return bAt.localeCompare(aAt);
  return a.name.localeCompare(b.name);
}

function byName(a: PlanPickerRow, b: PlanPickerRow): number {
  return a.name.localeCompare(b.name);
}

/**
 * Active = current spine plan.
 * Recent = other non-archived, last-used (capped when not searching).
 * Archived = templates (excluding current when it is already under Active).
 * Search filters all sections and lifts the Recent cap.
 */
export function partitionPlanPickerGroups(
  plans: PlanPickerRow[],
  selectedId: number | null,
  options?: { search?: string },
): PlanPickerGroups {
  const search = options?.search ?? "";
  const searching = search.trim().length > 0;
  const visible = plans.filter((p) => matchesSearch(p, search));

  const active =
    selectedId == null
      ? []
      : visible.filter((p) => p.id === selectedId);

  const recent = visible
    .filter((p) => p.id !== selectedId && !isArchived(p))
    .sort(byLastUsedDesc);

  const archived = visible
    .filter((p) => p.id !== selectedId && isArchived(p))
    .sort(byName);

  return {
    active,
    recent: searching ? recent : recent.slice(0, RECENT_PLAN_LIMIT),
    archived,
  };
}

/** Archive is manual and only when print remaining = 0 on a real kit. */
export function canArchivePlan(input: {
  archived: boolean;
  totalUnits: number;
  remainingUnits: number;
}): boolean {
  if (input.archived) return false;
  if (input.totalUnits <= 0) return false;
  return input.remainingUnits === 0;
}
