import type {
  BuildWorkflowWorkspace,
} from "@print-partner/contracts";

/** The one-line print progress summary shown on every stage page. */
export type BuildSummaryLine = Readonly<{
  /** Ordered fragments, joined by a separator in the view. */
  facts: readonly string[];
}>;

export type BuildActiveWorkChip = Readonly<{
  id: string;
  label: string;
  tone: "info" | "warning" | "error" | "neutral";
}>;

function plural(count: number, singular: string, many = `${singular}s`): string {
  return count === 1 ? singular : many;
}

export function buildSummaryLine(workspace: BuildWorkflowWorkspace): BuildSummaryLine {
  const { total_units: total, remaining_units: remaining } = workspace.active_work;
  return {
    facts: total > 0 ? [`${total - remaining} of ${total} printed`, `${remaining} remaining`] : [],
  };
}

/**
 * Background and printer work that explains why the Build is not idle. Each chip
 * carries its own text, so tone never carries the meaning alone.
 */
export function buildActiveWorkChips(
  workspace: BuildWorkflowWorkspace,
): readonly BuildActiveWorkChip[] {
  const work = workspace.active_work;
  const chips: BuildActiveWorkChip[] = [];

  if (work.failed_verifications > 0) {
    chips.push({
      id: "failed_verifications",
      label: `${work.failed_verifications} failed ${plural(work.failed_verifications, "print")}`,
      tone: "error",
    });
  }
  if (work.failed_jobs > 0) {
    chips.push({
      id: "failed_jobs",
      label: `${work.failed_jobs} failed ${plural(work.failed_jobs, "job")}`,
      tone: "error",
    });
  }
  if (work.awaiting_verification > 0) {
    chips.push({
      id: "awaiting_verification",
      label: `${work.awaiting_verification} awaiting verification`,
      tone: "warning",
    });
  }
  if (work.printing_jobs > 0) {
    chips.push({
      id: "printing_jobs",
      label: `${work.printing_jobs} printing`,
      tone: "info",
    });
  }
  if (work.sending_jobs > 0) {
    chips.push({
      id: "sending_jobs",
      label: `${work.sending_jobs} sending`,
      tone: "info",
    });
  }
  if (work.queued_jobs > 0) {
    chips.push({
      id: "queued_jobs",
      label: `${work.queued_jobs} queued`,
      tone: "neutral",
    });
  }
  return chips;
}
