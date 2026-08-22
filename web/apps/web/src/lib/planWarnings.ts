import type { PlanReview, ProfileSummary, SourceSummary } from "../api/engine";

/**
 * Desk-loop Plan warnings only (freshness, upstream changes, and review
 * blockers). Soft role/color “worth a look” noise stays out.
 */
export function buildPlanWarningLines(input: {
  buildStale: boolean;
  attachedSources: SourceSummary[];
  review: PlanReview | null | undefined;
  roleFilaments?: Array<{ role: string; part_count: number; filament_color_id: string | null; filament_custom_hex: string | null }>;
}): string[] {
  const lines: string[] = [];
  const { buildStale, attachedSources, review } = input;
  void input.roleFilaments;

  const upstream = attachedSources.filter((s) => s.update_status === "updates_available");
  if (upstream.length > 0) {
    lines.push(
      `${upstream.length} source${upstream.length === 1 ? "" : "s"} updated upstream. Review and rebuild the Plan`,
    );
  } else if (buildStale) {
    lines.push("Plan inputs changed. Review and rebuild the Plan");
  }

  for (const issue of review?.issues ?? []) {
    if (issue.severity !== "warning" && issue.severity !== "blocker") continue;
    if (issue.code === "unsynced_source" || issue.code === "layer_no_project") {
      lines.push(issue.message);
      continue;
    }
    if (issue.code === "no_included_parts") {
      lines.push(issue.message);
      continue;
    }
    if (issue.severity === "blocker") {
      lines.push(issue.message);
    }
  }

  const seen = new Set<string>();
  return lines.filter((t) => {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function planHeaderSubtitle(input: {
  profile: ProfileSummary | undefined;
  sourceCount: number;
  partCount: number;
}): string {
  const name = input.profile?.name?.trim();
  const bits: string[] = [];
  if (name) bits.push(name);
  if (input.sourceCount > 0) {
    bits.push(`${input.sourceCount} source${input.sourceCount === 1 ? "" : "s"}`);
  }
  if (input.partCount > 0) {
    bits.push(`${input.partCount} part${input.partCount === 1 ? "" : "s"}`);
  }
  return bits.join(" · ") || "Attach sources, pick files, set role colors.";
}
