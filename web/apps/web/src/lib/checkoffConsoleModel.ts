/**
 * Checkoff operator console: which view is showing, what belongs in it, and
 * what the operator is being asked to do.
 *
 * Checkoff answers one question beside the printer: "What physical result
 * needs my attention?". The console splits that into three views so a
 * finished printer job never competes with the manual worklist:
 *
 * - attention: completed printer jobs awaiting verification, failed jobs,
 *   and printer activity that matched no Required unit.
 * - remaining: the manual worklist of Required units still to produce.
 * - completed: verified units, assembly state, and correction controls.
 *
 * Everything here is pure so the page stays composition only.
 */

export type CheckoffViewId = "attention" | "remaining" | "completed";

export const CHECKOFF_VIEWS: readonly {
  id: CheckoffViewId;
  label: string;
}[] = [
  { id: "attention", label: "Needs attention" },
  { id: "remaining", label: "Remaining" },
  { id: "completed", label: "Completed" },
];

export function isCheckoffViewId(value: unknown): value is CheckoffViewId {
  return value === "attention" || value === "remaining" || value === "completed";
}

export type CheckoffAttentionKind =
  | "awaiting_verification"
  | "failed_print"
  | "unmatched_activity";

/** Owner + state text for one attention row. Colour never carries the meaning. */
export type CheckoffAttentionItem = {
  id: string;
  kind: CheckoffAttentionKind;
  /** Sliced file or printer job name. */
  title: string;
  hostName: string;
  statusLabel: string;
  hint: string;
  unitCount: number;
};

type AttentionLink = {
  id: string;
  host_name: string;
  filename: string;
  host_outcome?: string;
  units: { part_id: number; unit_index: number }[];
  resolved_units?: { part_id: number; unit_index: number }[];
};

type AttentionPrint = {
  id: string;
  host_name: string;
  filename: string;
  candidates?: { matching_filenames?: string[] }[] | null;
};

function unitKey(partId: number, unitIndex: number): string {
  return `${partId}:${unitIndex}`;
}

/** Units on a printer link that no operator decision has resolved yet. */
export function pendingLinkUnitCount(link: AttentionLink): number {
  const resolved = new Set(
    (link.resolved_units ?? []).map((unit) => unitKey(unit.part_id, unit.unit_index)),
  );
  return link.units.filter((unit) => !resolved.has(unitKey(unit.part_id, unit.unit_index)))
    .length;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Attention rows in operator priority: verify finished work first, then repair
 * failures, then attribute printer activity nobody claimed.
 */
export function buildCheckoffAttentionItems(input: {
  awaitingLinks: readonly AttentionLink[];
  failedLinks: readonly AttentionLink[];
  unattributedPrints: readonly AttentionPrint[];
}): CheckoffAttentionItem[] {
  const items: CheckoffAttentionItem[] = [];

  for (const link of input.awaitingLinks) {
    const units = pendingLinkUnitCount(link);
    items.push({
      id: `awaiting:${link.id}`,
      kind: "awaiting_verification",
      title: link.filename,
      hostName: link.host_name,
      statusLabel: "Needs verification",
      hint: `${link.host_name} finished ${units} ${plural(units, "unit", "units")}. Confirm or reject them.`,
      unitCount: units,
    });
  }

  for (const link of input.failedLinks) {
    const units = pendingLinkUnitCount(link);
    const outcome = link.host_outcome === "cancelled" ? "cancelled" : "failed";
    items.push({
      id: `failed:${link.id}`,
      kind: "failed_print",
      title: link.filename,
      hostName: link.host_name,
      statusLabel: outcome === "cancelled" ? "Cancelled, retry available" : "Failed, retry available",
      hint: `${link.host_name} ${outcome} this job. ${units} ${plural(units, "unit stays", "units stay")} remaining.`,
      unitCount: units,
    });
  }

  for (const print of input.unattributedPrints) {
    const matches = (print.candidates ?? []).reduce(
      (sum, candidate) => sum + (candidate.matching_filenames?.length ?? 0),
      0,
    );
    items.push({
      id: `unmatched:${print.id}`,
      kind: "unmatched_activity",
      title: print.filename,
      hostName: print.host_name,
      statusLabel: "Needs your decision",
      hint:
        matches > 0
          ? `${print.host_name} printed something that matches ${matches} ${plural(matches, "part", "parts")} in this Build.`
          : `${print.host_name} printed something no Required unit claims.`,
      unitCount: matches,
    });
  }

  return items;
}

export type CheckoffConsolePart = {
  id: number;
  missing: boolean;
};

export type CheckoffViewCounts = {
  attention: number;
  remaining: number;
  completed: number;
};

export function checkoffViewCounts(input: {
  attentionItems: readonly { id: string }[];
  parts: readonly CheckoffConsolePart[];
}): CheckoffViewCounts {
  let remaining = 0;
  let completed = 0;
  for (const part of input.parts) {
    if (part.missing) remaining += 1;
    else completed += 1;
  }
  return { attention: input.attentionItems.length, remaining, completed };
}

export function checkoffViewCount(
  counts: CheckoffViewCounts,
  view: CheckoffViewId,
): number {
  return counts[view];
}

/** Parts belonging to a view. The attention view is job-led, not part-led. */
export function partsForCheckoffView<T extends CheckoffConsolePart>(input: {
  parts: readonly T[];
  view: CheckoffViewId;
}): T[] {
  if (input.view === "remaining") return input.parts.filter((part) => part.missing);
  if (input.view === "completed") return input.parts.filter((part) => !part.missing);
  return [...input.parts];
}

/**
 * Which view to open on arrival. Work that needs a decision wins; otherwise the
 * operator's own last choice wins; a finished Build lands on Completed.
 */
export function resolveCheckoffView(input: {
  requested: CheckoffViewId | null;
  counts: CheckoffViewCounts;
}): CheckoffViewId {
  if (input.counts.attention > 0 && input.requested == null) return "attention";
  if (input.requested != null) return input.requested;
  if (input.counts.remaining === 0 && input.counts.completed > 0) return "completed";
  return "remaining";
}

/** Short state line for the console header. Names the state and its owner. */
export function checkoffConsoleHeadline(input: {
  counts: CheckoffViewCounts;
  printingJobs: number;
  remainingUnits: number;
}): string {
  if (input.counts.attention > 0) {
    return `${input.counts.attention} ${plural(input.counts.attention, "result needs", "results need")} your attention`;
  }
  if (input.printingJobs > 0) {
    return `${input.printingJobs} ${plural(input.printingJobs, "job is", "jobs are")} printing. Nothing to verify yet.`;
  }
  if (input.remainingUnits > 0) {
    return `${input.remainingUnits} ${plural(input.remainingUnits, "unit is", "units are")} still to produce.`;
  }
  return "Every Required unit is verified.";
}

export type CheckoffCompletion =
  | { kind: "in_progress"; remainingUnits: number }
  | {
      kind: "complete";
      totalUnits: number;
      partCount: number;
      completedAt: string | null;
      planVersion: number | null;
      revisionId: number | null;
    };

/**
 * A Build is only complete when the Accepted Plan has Required units and every
 * one of them is verified. Zero parts is an empty Build, not a finished one.
 */
export function resolveCheckoffCompletion(input: {
  totalUnits: number;
  printedUnits: number;
  partCount: number;
  completedAt: string | null;
  planVersion: number | null;
  revisionId: number | null;
}): CheckoffCompletion {
  const remainingUnits = Math.max(0, input.totalUnits - input.printedUnits);
  if (input.totalUnits === 0 || remainingUnits > 0) {
    return { kind: "in_progress", remainingUnits };
  }
  return {
    kind: "complete",
    totalUnits: input.totalUnits,
    partCount: input.partCount,
    completedAt: input.completedAt,
    planVersion: input.planVersion,
    revisionId: input.revisionId,
  };
}

/** "Plan revision 4 accepted" style provenance line for the completion state. */
export function formatAcceptedRevisionLine(input: {
  planVersion: number | null;
  revisionId: number | null;
}): string {
  if (input.planVersion == null) return "Accepted Plan revision unknown";
  return `Plan revision ${input.planVersion} accepted`;
}

export function formatCompletedAt(value: string | null): string {
  if (!value) return "Completion time not recorded";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "Completion time not recorded";
  return `Completed ${at.toLocaleString()}`;
}

/** Read-only printer status summary. Dispatch controls live in Production. */
export type CheckoffPrinterSummary = {
  printingLabel: string;
  queuedLabel: string;
  failedLabel: string | null;
};

export function checkoffPrinterSummary(input: {
  printingJobs: number;
  queuedJobs: number;
  failedJobs: number;
}): CheckoffPrinterSummary {
  return {
    printingLabel:
      input.printingJobs === 0
        ? "Printing now: none"
        : `Printing now: ${input.printingJobs} ${plural(input.printingJobs, "job", "jobs")}`,
    queuedLabel:
      input.queuedJobs === 0
        ? "Queued: none"
        : `Queued: ${input.queuedJobs} ${plural(input.queuedJobs, "job", "jobs")}`,
    failedLabel:
      input.failedJobs === 0
        ? null
        : `Failed: ${input.failedJobs} ${plural(input.failedJobs, "job", "jobs")}`,
  };
}
