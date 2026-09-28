

export type SourcesSetupSource = {
  readonly id: number;
  readonly name: string;
  readonly layerType: "base" | "addon";
  readonly synced: boolean;
  readonly updatesAvailable: boolean;
};

type SourcesSetupPlanning = {
  readonly planning_phase:
    | { readonly kind: "preparing" }
    | { readonly kind: "draft"; readonly draft_id: number }
    | { readonly kind: "applied"; readonly draft_id: number; readonly revision_id: number | null }
    | { readonly kind: "abandoned"; readonly draft_id: number }
    | { readonly kind: "missing_draft"; readonly draft_id: number };
  readonly readiness: {
    readonly ready: boolean;
    readonly blockers: readonly { readonly code: string; readonly detail: string }[];
  };
  readonly grouped_difference_count: number;
};

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function joinList(parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  if (last == null) return "";
  if (parts.length === 1) return last;
  return `${parts.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * A human count of what the assistant proposed, e.g.
 * "2 source roles and 3 file choices". Never internal blocker codes.
 * Null when the assistant proposed nothing countable.
 */
export function assistantChangeSummary(
  planning: SourcesSetupPlanning,
): string | null {
  const blockers = planning.readiness.blockers;
  const roleCount = blockers.filter((blocker) => blocker.code.includes("role")).length;
  const requirementCount = blockers.filter((blocker) =>
    blocker.code.includes("requirement"),
  ).length;
  const otherCount = blockers.length - roleCount - requirementCount;
  const fileChoices = planning.grouped_difference_count;

  const parts: string[] = [];
  if (roleCount > 0) parts.push(`${roleCount} source ${plural(roleCount, "role")}`);
  if (fileChoices > 0) parts.push(`${fileChoices} file ${plural(fileChoices, "choice")}`);
  if (requirementCount > 0) {
    parts.push(`${requirementCount} ${plural(requirementCount, "requirement")} to confirm`);
  }
  if (otherCount > 0) parts.push(`${otherCount} other ${plural(otherCount, "decision")}`);
  return parts.length > 0 ? joinList(parts) : null;
}
