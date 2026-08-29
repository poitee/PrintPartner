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
  | "assign-colors";

/**
 * Work the page performs in place. The page maps each id to a real function,
 * so a task never names a state it cannot advance.
 */
export type SourcesSetupHandlerId =
  | "confirm_request"
  | "attach_source"
  | "sync_sources"
  | "resolve_differences"
  | "assign_colors";

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

export type SourcesSetupRoleFilament = {
  readonly role: string;
  readonly part_count: number;
  readonly filament_color_id?: string | null;
  readonly filament_custom_hex?: string | null;
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
  readonly mergeConflictCount: number;
  readonly roleFilaments: readonly SourcesSetupRoleFilament[];
  /** A source sync job is running now. */
  readonly syncing: boolean;
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
  const applies = input.mergeConflictCount > 0 || input.sources.length > 1;
  if (!applies) return null;

  if (input.mergeConflictCount > 0) {
    return {
      id: "resolve-differences",
      label: "Choose between overlapping files",
      hint: `${input.mergeConflictCount} ${plural(input.mergeConflictCount, "file")} with the same name come from more than one source. Pick which file wins.`,
      state: "needs_attention",
      statusLabel: `${input.mergeConflictCount} ${plural(input.mergeConflictCount, "choice")}`,
      action: { kind: "handler", label: "Choose files", handler: "resolve_differences" },
      needsAttention: true,
    };
  }
  return {
    id: "resolve-differences",
    label: "Compare attached sources",
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

/**
 * The ordered setup tasks and the one action the page may show as primary.
 *
 * Order follows the workspace's own dependencies: request, sources, sync,
 * differences, then materials. Plan owns the Working Plan lifecycle. Tasks that
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
        label: "Open Plan",
        reason: "Sources are ready. Create or review the Working Plan on Plan.",
        action: {
          kind: "route",
          label: "Open Plan",
          to: planRoute(input.buildId),
        },
      };

  return { tasks, primary, ready: blocking == null };
}
