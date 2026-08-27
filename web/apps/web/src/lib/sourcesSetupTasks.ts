import type { WorkflowTaskState } from "../components/layout/TaskList";
import { roleColorIsSet } from "./roleColorSet";
import { planRoute } from "./routes";

/**
 * Sources is a setup workspace. It answers one question: are the inputs ready
 * for a Plan? This module turns the raw Build state into that answer — an
 * ordered task list plus the single primary action the page may show.
 *
 * It is deliberately pure and free of React, routing, and query concerns so the
 * page stays a thin renderer and every status rule can be tested directly.
 */

export type SourcesSetupTaskId =
  | "confirm-request"
  | "attach-base"
  | "attach-optional"
  | "sync-sources"
  | "resolve-differences"
  | "assign-colors"
  | "review-assistant"
  | "update-working-plan";

/**
 * Work the page performs in place. The page maps each id to a real function,
 * so a task never names a state it cannot advance.
 */
export type SourcesSetupHandlerId =
  | "confirm_request"
  | "attach_source"
  | "sync_sources"
  | "resolve_differences"
  | "assign_colors"
  | "review_assistant"
  | "update_working_plan";

export type SourcesSetupAction =
  | { readonly kind: "route"; readonly label: string; readonly to: string }
  | { readonly kind: "handler"; readonly label: string; readonly handler: SourcesSetupHandlerId };

export type SourcesSetupTask = {
  readonly id: SourcesSetupTaskId;
  readonly label: string;
  readonly hint?: string;
  readonly state: WorkflowTaskState;
  /** Names the state and its owner, e.g. "Needs your decision". */
  readonly statusLabel: string;
  readonly action?: SourcesSetupAction;
  /** True when this task is what keeps the inputs from being ready. */
  readonly needsAttention: boolean;
};

export type SourcesSetupPrimaryAction = {
  readonly label: string;
  readonly reason: string;
  readonly action: SourcesSetupAction;
};

export type SourcesSetup = {
  readonly tasks: readonly SourcesSetupTask[];
  readonly primary: SourcesSetupPrimaryAction;
  /** True when no task needs attention, so Plan review is the next step. */
  readonly ready: boolean;
};

export type SourcesSetupSource = {
  readonly id: number;
  readonly name: string;
  readonly layerType: "base" | "addon";
  readonly synced: boolean;
  readonly updatesAvailable: boolean;
};

export type SourcesSetupIssue = {
  readonly code: string;
  readonly message: string;
  readonly severity: "blocker" | "warning";
};

export type SourcesSetupRoleFilament = {
  readonly role: string;
  readonly part_count: number;
  readonly filament_color_id?: string | null;
  readonly filament_custom_hex?: string | null;
};

export type SourcesSetupFreshness =
  | { readonly status: "current" }
  | {
      readonly status: "stale";
      readonly reasons: readonly { readonly kind: string; readonly source_name?: string }[];
      readonly untracked_sources: readonly { readonly kind: string; readonly source_name?: string }[];
    }
  | {
      readonly status: "untracked";
      readonly reasons: readonly { readonly kind: string; readonly source_name?: string }[];
    };

export type SourcesSetupPlanning = {
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

export type SourcesSetupInput = {
  readonly buildId: number;
  readonly specialRequest: string | null | undefined;
  readonly sources: readonly SourcesSetupSource[];
  readonly partCount: number;
  readonly reviewIssues: readonly SourcesSetupIssue[];
  readonly mergeConflictCount: number;
  readonly roleFilaments: readonly SourcesSetupRoleFilament[];
  readonly freshness: SourcesSetupFreshness | null;
  readonly planning: SourcesSetupPlanning | null;
  /** A source sync job is running now. */
  readonly syncing: boolean;
  /** The Working Plan is being rebuilt now. */
  readonly updatingWorkingPlan: boolean;
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

function names(sources: readonly SourcesSetupSource[]): string {
  return joinList(sources.map((source) => source.name));
}

/** One human line for why the Working Plan no longer matches its inputs. */
export function workingPlanUpdateReason(
  freshness: SourcesSetupFreshness | null,
): string | null {
  if (!freshness || freshness.status === "current") return null;
  const reasons =
    freshness.status === "stale"
      ? [...freshness.reasons, ...freshness.untracked_sources]
      : freshness.reasons;
  const changed = reasons
    .filter((reason) => reason.kind === "source_revision_changed")
    .map((reason) => reason.source_name)
    .filter((name): name is string => Boolean(name));
  if (changed.length > 0) {
    return `${joinList(changed)} ${plural(changed.length, "has", "have")} newer files.`;
  }
  const untracked = reasons
    .filter((reason) => reason.kind === "source_revision_untracked")
    .map((reason) => reason.source_name)
    .filter((name): name is string => Boolean(name));
  if (untracked.length > 0) {
    return `The Working Plan does not record which revision of ${joinList(untracked)} it used.`;
  }
  if (reasons.some((reason) => reason.kind === "source_revision_unavailable")) {
    return "A source revision the Working Plan used is no longer available.";
  }
  if (reasons.some((reason) => reason.kind === "naming_rules_changed")) {
    return "Part naming rules changed since the Working Plan was built.";
  }
  if (reasons.some((reason) => reason.kind === "plan_inputs_invalid")) {
    return "The attached sources have duplicate or missing assignments.";
  }
  return "The attached sources changed since the Working Plan was built.";
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

function confirmRequestTask(input: SourcesSetupInput): SourcesSetupTask {
  const request = input.specialRequest?.trim() ?? "";
  if (request) {
    return {
      id: "confirm-request",
      label: "Confirm Build request",
      hint: request,
      state: "complete",
      statusLabel: "Confirmed",
      needsAttention: false,
    };
  }
  return {
    id: "confirm-request",
    label: "Confirm Build request",
    hint: "Note anything the person printing this Build must know. Optional.",
    state: "not_started",
    statusLabel: "Not set",
    action: { kind: "handler", label: "Write the request", handler: "confirm_request" },
    needsAttention: false,
  };
}

function attachBaseTask(base: SourcesSetupSource | undefined): SourcesSetupTask {
  if (base) {
    return {
      id: "attach-base",
      label: "Attach a base source",
      hint: base.name,
      state: "complete",
      statusLabel: "Attached",
      needsAttention: false,
    };
  }
  return {
    id: "attach-base",
    label: "Attach a base source",
    hint: "Pick the main kit this Build starts from.",
    state: "needs_attention",
    statusLabel: "Needs your decision",
    action: { kind: "handler", label: "Attach a base source", handler: "attach_source" },
    needsAttention: true,
  };
}

function attachOptionalTask(addons: readonly SourcesSetupSource[]): SourcesSetupTask {
  if (addons.length > 0) {
    return {
      id: "attach-optional",
      label: "Attach optional sources",
      hint: names(addons),
      state: "complete",
      statusLabel: `${addons.length} attached`,
      needsAttention: false,
    };
  }
  return {
    id: "attach-optional",
    label: "Attach optional sources",
    hint: "Mods and add-ons are optional. Attach them before you review the Plan.",
    state: "not_started",
    statusLabel: "None attached",
    action: { kind: "handler", label: "Attach another source", handler: "attach_source" },
    needsAttention: false,
  };
}

function syncSourcesTask(input: SourcesSetupInput): SourcesSetupTask {
  if (input.syncing) {
    return {
      id: "sync-sources",
      label: "Sync source revisions",
      hint: "PrintPartner is reading the latest files. You can keep working.",
      state: "in_progress",
      statusLabel: "Syncing sources",
      needsAttention: false,
    };
  }
  const unsynced = input.sources.filter((source) => !source.synced);
  if (unsynced.length > 0) {
    return {
      id: "sync-sources",
      label: "Sync source revisions",
      hint: `${names(unsynced)} ${plural(unsynced.length, "has", "have")} no local copy yet, so its files cannot be read.`,
      state: "needs_attention",
      statusLabel: "Not synced",
      action: { kind: "handler", label: "Sync sources", handler: "sync_sources" },
      needsAttention: true,
    };
  }
  const stale = input.sources.filter((source) => source.updatesAvailable);
  if (stale.length > 0) {
    return {
      id: "sync-sources",
      label: "Sync source revisions",
      hint: `${names(stale)} changed upstream.`,
      state: "needs_attention",
      statusLabel: "Updates available",
      action: { kind: "handler", label: "Sync sources", handler: "sync_sources" },
      needsAttention: true,
    };
  }
  return {
    id: "sync-sources",
    label: "Sync source revisions",
    hint: `${input.sources.length} ${plural(input.sources.length, "source")} up to date.`,
    state: "complete",
    statusLabel: "Up to date",
    needsAttention: false,
  };
}

function resolveDifferencesTask(input: SourcesSetupInput): SourcesSetupTask | null {
  const blockers = input.reviewIssues.filter(
    (issue) => issue.severity === "blocker" && issue.code !== "unsynced_source",
  );
  const applies =
    input.mergeConflictCount > 0 || blockers.length > 0 || input.sources.length > 1;
  if (!applies) return null;

  if (input.mergeConflictCount > 0) {
    return {
      id: "resolve-differences",
      label: "Resolve source roles and differences",
      hint: `${input.mergeConflictCount} ${plural(input.mergeConflictCount, "file")} with the same name come from more than one source. Pick which file wins.`,
      state: "needs_attention",
      statusLabel: "Needs your decision",
      action: { kind: "handler", label: "Review differences", handler: "resolve_differences" },
      needsAttention: true,
    };
  }
  const [firstBlocker, ...moreBlockers] = blockers;
  if (firstBlocker) {
    const extra = moreBlockers.length > 0 ? ` And ${moreBlockers.length} more.` : "";
    return {
      id: "resolve-differences",
      label: "Resolve source roles and differences",
      hint: `${firstBlocker.message}${extra}`,
      state: "needs_attention",
      statusLabel: `${blockers.length} ${plural(blockers.length, "file problem")}`,
      action: { kind: "handler", label: "Review file choices", handler: "resolve_differences" },
      needsAttention: true,
    };
  }
  return {
    id: "resolve-differences",
    label: "Resolve source roles and differences",
    hint: `${input.sources.length} sources agree on every file.`,
    state: "complete",
    statusLabel: "No conflicts",
    needsAttention: false,
  };
}

function assignColorsTask(input: SourcesSetupInput): SourcesSetupTask | null {
  const withParts = input.roleFilaments.filter((row) => row.part_count > 0);
  if (withParts.length === 0) return null;
  const unset = withParts.filter((row) => !roleColorIsSet(row));
  if (unset.length === 0) {
    return {
      id: "assign-colors",
      label: "Assign materials or colors",
      hint: `${withParts.length} ${plural(withParts.length, "role")} have a filament.`,
      state: "complete",
      statusLabel: "Assigned",
      needsAttention: false,
    };
  }
  return {
    id: "assign-colors",
    label: "Assign materials or colors",
    hint: `${joinList(unset.map((row) => row.role))} ${plural(unset.length, "has", "have")} no filament yet.`,
    state: "needs_attention",
    statusLabel: `${unset.length} ${plural(unset.length, "role")} unset`,
    action: { kind: "handler", label: "Assign colors", handler: "assign_colors" },
    needsAttention: true,
  };
}

function reviewAssistantTask(input: SourcesSetupInput): SourcesSetupTask | null {
  const planning = input.planning;
  if (!planning) return null;
  const summary = assistantChangeSummary(planning);
  const phase = planning.planning_phase;

  if (phase.kind === "applied") {
    return {
      id: "review-assistant",
      label: "Review assistant changes",
      hint: summary
        ? `${summary}. They are already in the Working Plan.`
        : "The assistant changes are already in the Working Plan.",
      state: "complete",
      statusLabel: "Applied",
      action: {
        kind: "route",
        label: "Open Plan",
        to: planRoute(input.buildId),
      },
      needsAttention: false,
    };
  }
  if (phase.kind === "missing_draft" || phase.kind === "abandoned") {
    return {
      id: "review-assistant",
      label: "Review assistant changes",
      hint:
        phase.kind === "missing_draft"
          ? "The Working Plan the assistant wrote is gone. Build it again from the attached sources."
          : "The assistant stopped before it finished. Build the Working Plan again when the sources are right.",
      state: phase.kind === "missing_draft" ? "error" : "not_started",
      statusLabel:
        phase.kind === "missing_draft" ? "Working Plan unavailable" : "Not finished",
      action: {
        kind: "handler",
        label: "Update Working Plan",
        handler: "update_working_plan",
      },
      needsAttention: phase.kind === "missing_draft",
    };
  }
  if (planning.readiness.blockers.length > 0) {
    return {
      id: "review-assistant",
      label: "Review assistant changes",
      hint: `${summary ?? "Assistant changes"} waiting for you.`,
      state: "needs_attention",
      statusLabel: "Needs your decision",
      action: {
        kind: "handler",
        label: "Review assistant changes",
        handler: "review_assistant",
      },
      needsAttention: true,
    };
  }
  if (phase.kind === "draft") {
    return {
      id: "review-assistant",
      label: "Review assistant changes",
      hint: summary
        ? `${summary}. They are in the Working Plan, ready for Plan review.`
        : "The assistant changes are in the Working Plan, ready for Plan review.",
      state: "complete",
      statusLabel: "Ready for Plan review",
      action: { kind: "route", label: "Open Plan", to: planRoute(input.buildId) },
      needsAttention: false,
    };
  }
  return {
    id: "review-assistant",
    label: "Review assistant changes",
    hint: summary ?? "The assistant is still gathering sources and requirements.",
    state: "in_progress",
    statusLabel: "Assistant is preparing",
    action: {
      kind: "handler",
      label: "Review assistant changes",
      handler: "review_assistant",
    },
    needsAttention: false,
  };
}

function updateWorkingPlanTask(input: SourcesSetupInput): SourcesSetupTask | null {
  const hasSources = input.sources.length > 0;
  if (!hasSources) return null;
  if (input.updatingWorkingPlan) {
    return {
      id: "update-working-plan",
      label: "Update Working Plan",
      hint: "PrintPartner is rebuilding the Working Plan from the attached sources.",
      state: "in_progress",
      statusLabel: "Updating",
      needsAttention: false,
    };
  }
  const reason = workingPlanUpdateReason(input.freshness);
  if (input.partCount === 0) {
    return {
      id: "update-working-plan",
      label: "Update Working Plan",
      hint: "The Working Plan has no parts yet. Build it from the attached sources.",
      state: "needs_attention",
      statusLabel: "No parts yet",
      action: {
        kind: "handler",
        label: "Update Working Plan",
        handler: "update_working_plan",
      },
      needsAttention: true,
    };
  }
  if (reason == null) return null;
  return {
    id: "update-working-plan",
    label: "Update Working Plan",
    hint: reason,
    state: "needs_attention",
    statusLabel:
      input.freshness?.status === "stale" ? "Out of date" : "Inputs not recorded",
    action: {
      kind: "handler",
      label: "Update Working Plan",
      handler: "update_working_plan",
    },
    needsAttention: true,
  };
}

/**
 * The ordered setup tasks and the one action the page may show as primary.
 *
 * Order follows the workspace's own dependencies: request, sources, sync,
 * differences, materials, assistant, then the Working Plan rebuild. Tasks that
 * do not apply to this Build are left out rather than shown as empty rows.
 */
export function sourcesSetupTasks(input: SourcesSetupInput): SourcesSetup {
  const base = input.sources.find((source) => source.layerType === "base");
  const addons = input.sources.filter((source) => source.layerType === "addon");

  const tasks: SourcesSetupTask[] = [confirmRequestTask(input), attachBaseTask(base)];
  if (base) tasks.push(attachOptionalTask(addons));
  if (input.sources.length > 0) tasks.push(syncSourcesTask(input));
  const differences = resolveDifferencesTask(input);
  if (differences) tasks.push(differences);
  const colors = assignColorsTask(input);
  if (colors) tasks.push(colors);
  const assistant = reviewAssistantTask(input);
  if (assistant) tasks.push(assistant);
  const workingPlan = updateWorkingPlanTask(input);
  if (workingPlan) tasks.push(workingPlan);

  let blocking: { task: SourcesSetupTask; action: SourcesSetupAction } | null = null;
  for (const task of tasks) {
    if (!task.needsAttention) continue;
    const action = task.action;
    if (!action) continue;
    blocking = { task, action };
    break;
  }

  const primary: SourcesSetupPrimaryAction = blocking
    ? {
        label: blocking.action.label,
        reason: blocking.task.hint ?? blocking.task.label,
        action: blocking.action,
      }
    : {
        label: "Review Working Plan",
        reason: "The inputs are ready. Review and accept the Plan.",
        action: {
          kind: "route",
          label: "Review Working Plan",
          to: planRoute(input.buildId),
        },
      };

  return { tasks, primary, ready: blocking == null };
}
