import type { PlanReviewIssue } from "../api/engine";

const MERGE_CONFLICT_FILENAME = /Merge conflict for (.+?) —/;

/** Group merge_conflict issues by filename for compact UI. */
export function groupMergeConflictsByFilename(
  issues: PlanReviewIssue[],
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (issue.code !== "merge_conflict") continue;
    const match = issue.message.match(MERGE_CONFLICT_FILENAME);
    const filename = match?.[1]?.trim() ?? issue.message;
    counts.set(filename, (counts.get(filename) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}
