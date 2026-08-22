
import type { AcceptedProgressSummary } from "@print-partner/contracts";

export type PlansListFilter = "active" | "archived" | "all";

export type PlansListSort = "name" | "recent";

export type PlansListRow = {
  id: number;
  name: string;
  archived_at: string | null;
  part_count: number;
  accepted_progress: AcceptedProgressSummary;
  build_stale: boolean;
  last_used_at: string | null;
};

function isArchived(plan: { archived_at: string | null }): boolean {
  return plan.archived_at != null && plan.archived_at !== "";
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

export function filterPlansList<T extends PlansListRow>(
  plans: T[],
  filter: PlansListFilter,
  query = "",
  sort: PlansListSort = "name",
): T[] {
  const needle = query.trim().toLowerCase();
  const filtered = plans.filter((p) => {
    if (filter === "active" && isArchived(p)) return false;
    if (filter === "archived" && !isArchived(p)) return false;
    if (needle && !p.name.toLowerCase().includes(needle)) return false;
    return true;
  });
  return [...filtered].sort((a, b) => {
    if (sort === "recent") {
      const at = a.last_used_at ?? "";
      const bt = b.last_used_at ?? "";
      if (at !== bt) return bt.localeCompare(at);
    }
    return byName(a, b);
  });
}

export function planStatusLabel(plan: {
  archived_at: string | null;
}): "Active" | "Archived" {
  return isArchived(plan) ? "Archived" : "Active";
}

export function planProgressLabel(progress: AcceptedProgressSummary): string {
  switch (progress.kind) {
    case "ready":
      return progress.total_units === 0
        ? "No required units"
        : `${progress.remaining_units} remaining`;
    case "empty":
      return "Not applied";
    case "unavailable":
      return "Checkoff unavailable";
  }
}

export function canArchiveAcceptedPlan(plan: {
  readonly archived_at: string | null;
  readonly accepted_progress: AcceptedProgressSummary;
}): boolean {
  const progress = plan.accepted_progress;
  return (
    !isArchived(plan) &&
    progress.kind === "ready" &&
    progress.total_units > 0 &&
    progress.remaining_units === 0
  );
}
