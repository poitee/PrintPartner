import type {
  BuildWorkflowAcceptedPlan,
  BuildWorkflowWorkingPlan,
  BuildWorkflowWorkspace,
} from "@print-partner/contracts";
import type { StatusTone } from "./statusTone";

/**
 * The one-line current-state summary shown on every stage page.
 *
 * It is a state summary, not a second stepper. It answers "what Build and which
 * accepted revision am I using, and what is happening right now" so the user
 * never has to open another page to find out.
 */
export type BuildSummaryLine = Readonly<{
  /** Ordered fragments, joined by a separator in the view. */
  facts: readonly string[];
  /** True when working changes exist that Production and Checkoff do not use. */
  hasUnacceptedChanges: boolean;
}>;

export type BuildActiveWorkChip = Readonly<{
  id: string;
  label: string;
  /** Coloured by `lib/statusTone`; a chip never picks its own classes. */
  tone: Extract<StatusTone, "info" | "warning" | "error" | "neutral">;
}>;

function plural(count: number, singular: string, many = `${singular}s`): string {
  return count === 1 ? singular : many;
}

function acceptedPlanFact(plan: BuildWorkflowAcceptedPlan): string {
  switch (plan.kind) {
    case "none":
      return "No accepted Plan revision";
    case "unavailable":
      return "Accepted Plan unavailable";
    case "ready":
      return `Plan revision ${plan.plan_version} accepted`;
  }
}

function workingPlanFact(plan: BuildWorkflowWorkingPlan): string | null {
  switch (plan.kind) {
    case "none":
      return null;
    case "ready":
      return `${plan.change_count} working ${plural(plan.change_count, "change")} not yet accepted`;
    case "needs_attention":
      return `${plan.issue_count} working Plan ${plural(plan.issue_count, "issue")} to resolve`;
    case "stale":
      return "Working Plan is based on an older Accepted Plan";
  }
}

/**
 * Builds the summary facts for a Build. When working changes exist they replace
 * the unit counts, because the counts describe the Accepted Plan and would
 * otherwise imply the working changes are already in effect.
 */
export function buildSummaryLine(
  workspace: BuildWorkflowWorkspace,
): BuildSummaryLine {
  const facts: string[] = [acceptedPlanFact(workspace.accepted_plan)];
  const working = workingPlanFact(workspace.working_plan);

  if (working) {
    facts.push(working);
    return { facts, hasUnacceptedChanges: workspace.working_plan.kind === "ready" };
  }

  const { total_units: total, remaining_units: remaining } = workspace.active_work;
  if (total > 0) {
    facts.push(`${total} Required ${plural(total, "unit")}`);
    facts.push(`${total - remaining} verified`);
  }
  return { facts, hasUnacceptedChanges: false };
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
  if (workspace.sources.kind === "stale") {
    chips.push({
      id: "source_changes",
      label: "Sources changed since acceptance",
      tone: "warning",
    });
  }
  return chips;
}
