import type {
  PlanDraftWorkspace,
  PlanFreshness,
  PlanStaleReason,
  PlanUntrackedReason,
} from "@print-partner/contracts";
import type { BuildPlanningState, PlanReview } from "../api/endpoints/planManifests";
import { buildSourcesRoute, libraryRoute } from "./routes";

/**
 * The Plan acceptance checkpoint, as data.
 *
 * Plan answers two questions: "what will this revision require?" and "am I
 * ready to accept it?". Both answers are computed here so the page only has to
 * lay them out, and so the blocking rule can be tested without a browser.
 *
 * The rule for grouping: an issue is "Must resolve" when it stops the Plan
 * revision from being accepted. Everything else is "Review recommended", and
 * carries its own status text saying what it does affect.
 */

export type PlanIssueGroup = "must_resolve" | "review_recommended";

export type PlanIssueAction =
  | { readonly kind: "route"; readonly label: string; readonly to: string }
  | { readonly kind: "sync_sources"; readonly label: string }
  | { readonly kind: "refresh_working_plan"; readonly label: string }
  | { readonly kind: "required_unit_decision"; readonly draftPartId: number }
  | { readonly kind: "move_records"; readonly label: string };

export type PlanIssue = {
  /** Anchor target, so the issue summary can link to the control that fixes it. */
  readonly id: string;
  readonly group: PlanIssueGroup;
  readonly title: string;
  readonly detail: string | null;
  /** Names what the issue stops. Colour never carries this on its own. */
  readonly statusLabel: string;
  readonly tone: "error" | "warning";
  readonly action: PlanIssueAction | null;
};

/** A Checkoff or printer record that could not move to the new revision. */
export type PlanUnitOutcome = {
  readonly filename: string;
  readonly outcome: string;
};

export type PlanAcceptanceFailure =
  | {
      readonly kind: "linked_records";
      readonly checkoffLinkCount: number;
      readonly sendQueueItemCount: number;
    }
  | { readonly kind: "unsafe_records"; readonly units: readonly PlanUnitOutcome[] }
  | { readonly kind: "error"; readonly message: string };

export type PlanAcceptanceInput = {
  readonly review: PlanReview | null;
  readonly draft: PlanDraftWorkspace | null;
  readonly buildId: number | null;
  readonly failure?: PlanAcceptanceFailure | null;
  readonly freshness?: PlanFreshness | null;
  readonly planningBlockers?: readonly BuildPlanningBlocker[] | null;
};

type BuildPlanningBlocker = BuildPlanningState["readiness"]["blockers"][number];

export type AcceptedRevisionSummary = {
  readonly planVersion: number | null;
  readonly heading: string;
  readonly partCount: number;
  readonly requiredUnits: number;
  readonly verifiedUnits: number;
  readonly remainingUnits: number;
};

export type WorkingChangeSummary = {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unaffected: number;
  readonly total: number;
  readonly changeCount: number;
};

export type PlanRequiredUnitImpact =
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      /** Units that keep their identity, so printed and verified state carries. */
      readonly preservedUnits: number;
      readonly printAgainUnits: number;
      readonly retiredUnits: number;
      readonly requiredUnitsAfter: number;
    };

export type PlanAcceptanceDecision = {
  readonly label: string;
  readonly canAccept: boolean;
  readonly reason: string;
  readonly blockingCount: number;
};

export type PlanDownstreamLink = {
  readonly id: "production" | "checkoff";
  readonly label: string;
  /** Set while working changes are unaccepted, so the link states what it uses. */
  readonly qualifier: string | null;
};

export type PlanAcceptanceModel = {
  readonly accepted: AcceptedRevisionSummary;
  readonly working: WorkingChangeSummary | null;
  readonly issues: readonly PlanIssue[];
  readonly mustResolve: readonly PlanIssue[];
  readonly reviewRecommended: readonly PlanIssue[];
  readonly impact: PlanRequiredUnitImpact;
  readonly decision: PlanAcceptanceDecision;
  readonly headerSummary: string;
  readonly downstream: readonly PlanDownstreamLink[];
};

const ACCEPT_LABEL = "Accept Plan revision";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function includedReviewParts(review: PlanReview | null) {
  if (!review) return [];
  return review.part_groups.flatMap((group) => group.parts).filter((part) => part.included);
}

export function acceptedRevisionSummary(review: PlanReview | null): AcceptedRevisionSummary {
  const parts = includedReviewParts(review);
  const requiredUnits = parts.reduce((sum, part) => sum + Math.max(0, part.quantity_effective), 0);
  const verifiedUnits = parts.reduce((sum, part) => sum + Math.max(0, part.printed_count), 0);
  const planVersion = review?.accepted_basis?.plan_version ?? null;
  return {
    planVersion,
    heading:
      planVersion == null
        ? "No Plan revision accepted yet"
        : `Plan revision ${planVersion} accepted`,
    partCount: parts.length,
    requiredUnits,
    verifiedUnits,
    remainingUnits: Math.max(0, requiredUnits - verifiedUnits),
  };
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  quantityOverride: "quantity",
  quantityEffective: "quantity",
  quantityInferred: "quantity",
  included: "inclusion",
  filename: "file name",
  relativePath: "file path",
  role: "role",
  sourceLayer: "source",
  partKey: "identity",
};

/** Server field names are internal. The change table says what the user changed. */
export function workingChangeFieldLabels(fields: readonly string[]): string[] {
  const labels: string[] = [];
  for (const field of fields) {
    const label = FIELD_LABELS[field] ?? field;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function workingChangeSummary(
  draft: PlanDraftWorkspace | null,
): WorkingChangeSummary | null {
  if (!draft) return null;
  const added = draft.diff.added.length;
  const changed = draft.diff.changed.length;
  const removed = draft.diff.removed.length;
  return {
    added,
    changed,
    removed,
    unaffected: Math.max(0, draft.parts.length - added - changed),
    total: draft.parts.length,
    changeCount: added + changed + removed,
  };
}

/** Working Plan values win once a Working Plan exists: they are what acceptance writes. */
export function planHeaderSummary(input: {
  readonly review: PlanReview | null;
  readonly draft: PlanDraftWorkspace | null;
}): string {
  const accepted = acceptedRevisionSummary(input.review);
  const draft = input.draft;
  if (!draft) {
    if (accepted.partCount === 0) return "No parts yet. Build a Working Plan from Sources.";
    return [
      plural(accepted.partCount, "part", "parts"),
      `${plural(accepted.requiredUnits, "Required unit", "Required units")}`,
      `${accepted.verifiedUnits} verified`,
    ].join(" \u00b7 ");
  }
  const included = draft.parts.filter((part) => part.included);
  const units = included.reduce((sum, part) => sum + Math.max(0, part.quantity_effective), 0);
  return [
    `${plural(draft.parts.length, "part", "parts")} in the Working Plan`,
    `${included.length} included`,
    `${plural(units, "Required unit", "Required units")} when accepted`,
  ].join(" \u00b7 ");
}

/**
 * A Plan issue is about this Build's sources, so it routes to the Build's
 * Sources workspace. The shared Source Library is only useful when no Build is
 * selected, which is why "Go to Library" read as a wrong turn.
 */
function sourcesAction(buildId: number | null): PlanIssueAction {
  return buildId == null
    ? { kind: "route", label: "Open Source Library", to: libraryRoute() }
    : { kind: "route", label: "Open Sources", to: buildSourcesRoute(buildId) };
}

function requiredUnitIssues(draft: PlanDraftWorkspace): PlanIssue[] {
  if (draft.reconciliation.kind !== "unresolved") return [];
  const partById = new Map(draft.parts.map((part) => [part.draft_part_id, part]));
  return draft.reconciliation.conflicts.map((conflict) => {
    const part = partById.get(conflict.target_draft_part_id);
    const filename = part?.filename ?? `Part ${conflict.target_draft_part_id}`;
    return {
      id: `plan-issue-required-unit-${conflict.target_draft_part_id}`,
      group: "must_resolve" as const,
      title: `${filename}: choose what happens to units already printed`,
      detail:
        conflict.kind === "ambiguous_exact_match"
          ? "More than one accepted part matches this file. Pick the one whose printed units carry over."
          : "This file already has printed units. Keep them, or print the units again.",
      statusLabel: "Needs your decision",
      tone: "error" as const,
      action: { kind: "required_unit_decision" as const, draftPartId: conflict.target_draft_part_id },
    };
  });
}

function failureIssues(failure: PlanAcceptanceFailure): PlanIssue[] {
  switch (failure.kind) {
    case "linked_records":
      return [{
        id: "plan-issue-linked-records",
        group: "must_resolve",
        title: `${plural(failure.checkoffLinkCount, "Checkoff record", "Checkoff records")}${
          failure.sendQueueItemCount > 0
            ? ` and ${plural(failure.sendQueueItemCount, "queued print", "queued prints")}`
            : ""
        } still point at the Accepted Plan`,
        detail:
          "Acceptance stopped so that printed work is not lost. Move these records to the new revision, or finish them in Production first.",
        statusLabel: "Blocks acceptance",
        tone: "error",
        action: { kind: "move_records", label: "Move records and accept" },
      }];
    case "unsafe_records":
      return [{
        id: "plan-issue-unsafe-records",
        group: "must_resolve",
        title: `${plural(failure.units.length, "printed file", "printed files")} cannot move to the new revision`,
        detail: failure.units
          .map((unit) => `${unit.filename}: ${unit.outcome}`)
          .join(" \u2022 "),
        statusLabel: "Blocks acceptance",
        tone: "error",
        action: null,
      }];
    case "error":
      return [{
        id: "plan-issue-acceptance-error",
        group: "must_resolve",
        title: "Acceptance failed",
        detail: failure.message,
        statusLabel: "Retry available",
        tone: "error",
        action: null,
      }];
  }
}

function planningBlockerIssues(
  blockers: readonly BuildPlanningBlocker[],
  buildId: number | null,
): PlanIssue[] {
  return blockers.map((blocker, index) => {
    const isUnreviewedDraft = blocker.code === "draft_selection";
    return {
      id: `plan-issue-build-planning-${blocker.code.replaceAll("_", "-")}-${index}`,
      group: "must_resolve" as const,
      title: isUnreviewedDraft
        ? "This Working Plan has not been reviewed"
        : "Assistant planning is not ready",
      detail: isUnreviewedDraft
        ? "The assistant reviewed a different Working Plan. Rebuild it from the reviewed Build setup before accepting."
        : blocker.detail,
      statusLabel: "Blocks acceptance",
      tone: "error" as const,
      action: sourcesAction(buildId),
    };
  });
}

/** Plain sentences for a Plan whose source inputs moved or were never tracked. */
export function planStaleReasonText(reason: PlanStaleReason): string {
  switch (reason.kind) {
    case "source_revision_changed":
      return `${reason.source_name} has a newer synced revision.`;
    case "source_revision_unavailable":
      return `${reason.source_name}'s accepted revision is no longer available.`;
    case "naming_rules_changed":
      return `${reason.source_name}'s part naming rules changed.`;
    case "plan_inputs_invalid":
      return "The Plan has duplicate or missing Source assignments.";
    case "plan_configuration_changed":
      return "The Plan's source selection or file rules changed.";
  }
}

export function planUntrackedReasonText(reason: PlanUntrackedReason): string {
  switch (reason.kind) {
    case "no_accepted_inputs":
      return "This Plan has not recorded the source revisions used to build its parts yet.";
    case "source_revision_untracked":
      return `${reason.source_name} does not have a tracked source revision.`;
  }
}

export function planFreshnessMessages(freshness: PlanFreshness): string[] {
  if (freshness.status === "current") return [];
  if (freshness.status === "stale") {
    return [
      ...freshness.reasons.map(planStaleReasonText),
      ...freshness.untracked_sources.map(planUntrackedReasonText),
    ];
  }
  return freshness.reasons.map(planUntrackedReasonText);
}

export function planIssues(input: PlanAcceptanceInput): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const { review, draft, buildId } = input;

  if (draft && !draft.diff.base_is_current) {
    issues.push({
      id: "plan-issue-working-plan-behind",
      group: "must_resolve",
      title: "The Accepted Plan changed after these Working Plan changes were saved",
      detail: "Refresh the Working Plan so it compares against the current Accepted Plan.",
      statusLabel: "Blocks acceptance",
      tone: "error",
      action: { kind: "refresh_working_plan", label: "Refresh Working Plan" },
    });
  }
  if (draft) issues.push(...requiredUnitIssues(draft));
  if (input.planningBlockers) {
    issues.push(...planningBlockerIssues(input.planningBlockers, buildId));
  }
  if (input.failure) issues.push(...failureIssues(input.failure));

  const reviewIssues = review?.issues ?? [];
  const missingStl = reviewIssues.filter((issue) => issue.code === "missing_stl");
  const mergeConflicts = reviewIssues.filter((issue) => issue.code === "merge_conflict");

  for (const [index, issue] of reviewIssues.entries()) {
    if (issue.code === "missing_stl" || issue.code === "merge_conflict") continue;
    issues.push({
      id: `plan-issue-${issue.code}-${index}`,
      group: "review_recommended",
      title: issue.message,
      detail: null,
      statusLabel:
        issue.severity === "blocker" ? "Blocks Production" : "Check before you accept",
      tone: issue.severity === "blocker" ? "error" : "warning",
      action: issue.link_hint == null ? null : sourcesAction(buildId),
    });
  }

  if (missingStl.length > 0) {
    issues.push({
      id: "plan-issue-missing-stl",
      group: "review_recommended",
      title: `${plural(missingStl.length, "STL file is", "STL files are")} not on disk`,
      detail: missingStl
        .map((issue) => issue.message.replace(/^STL not found on disk:\s*/, ""))
        .join(", "),
      statusLabel: "Blocks Production",
      tone: "error",
      action: { kind: "sync_sources", label: "Sync sources" },
    });
  }

  const freshness = input.freshness;
  if (freshness && freshness.status !== "current") {
    issues.push({
      id: "plan-issue-source-freshness",
      group: "review_recommended",
      title:
        freshness.status === "stale"
          ? "The sources behind this Plan have moved on"
          : "This Plan's source revisions are not tracked",
      detail: planFreshnessMessages(freshness).join(" "),
      statusLabel: "Check before you accept",
      tone: "warning",
      action: sourcesAction(buildId),
    });
  }

  if (mergeConflicts.length > 0) {
    issues.push({
      id: "plan-issue-merge-conflict",
      group: "review_recommended",
      title: `Duplicate parts detected in ${plural(mergeConflicts.length, "file", "files")}`,
      detail: "Two sources give the same part. Choose which source wins in the Build's Sources workspace.",
      statusLabel: "Check before you accept",
      tone: "warning",
      action: sourcesAction(buildId),
    });
  }

  return issues;
}

export function requiredUnitImpact(
  draft: PlanDraftWorkspace | null,
): PlanRequiredUnitImpact {
  if (!draft) {
    return {
      kind: "unavailable",
      reason: "There are no Working Plan changes, so the Accepted Plan's Required units stay as they are.",
    };
  }
  if (draft.reconciliation.kind !== "ready") {
    return {
      kind: "unavailable",
      reason: "Answer the Required-unit decisions above to see what acceptance preserves.",
    };
  }
  const requiredUnitsAfter = draft.parts
    .filter((part) => part.included)
    .reduce((sum, part) => sum + Math.max(0, part.quantity_effective), 0);
  return {
    kind: "ready",
    preservedUnits: draft.reconciliation.reused_units,
    printAgainUnits: draft.reconciliation.new_units,
    retiredUnits: draft.reconciliation.surplus_units,
    requiredUnitsAfter,
  };
}

/**
 * Verified units that survive acceptance. A kept unit carries its checkoff
 * state, so the preserved count can never be more than what was verified before
 * or more than what was kept.
 */
export function preservedVerifiedUnits(input: {
  readonly accepted: AcceptedRevisionSummary;
  readonly draft: PlanDraftWorkspace | null;
}): number {
  if (!input.draft || input.draft.reconciliation.kind !== "ready") return 0;
  return Math.min(input.accepted.verifiedUnits, input.draft.reconciliation.reused_units);
}

export function acceptanceDecision(input: {
  readonly draft: PlanDraftWorkspace | null;
  readonly issues: readonly PlanIssue[];
  readonly accepted: AcceptedRevisionSummary;
}): PlanAcceptanceDecision {
  const blocking = input.issues.filter((issue) => issue.group === "must_resolve");
  if (!input.draft) {
    return {
      label: ACCEPT_LABEL,
      canAccept: false,
      reason: "There are no Working Plan changes to accept.",
      blockingCount: 0,
    };
  }
  if (blocking.length > 0) {
    return {
      label: ACCEPT_LABEL,
      canAccept: false,
      reason: `Acceptance is blocked. Resolve ${plural(blocking.length, "item", "items")} under "Must resolve" first.`,
      blockingCount: blocking.length,
    };
  }
  const next = (input.accepted.planVersion ?? 0) + 1;
  return {
    label: ACCEPT_LABEL,
    canAccept: true,
    reason: `Accepting saves these changes as Plan revision ${next}. Verified units that still match are kept.`,
    blockingCount: 0,
  };
}

export function downstreamLinks(input: {
  readonly draft: PlanDraftWorkspace | null;
  readonly accepted: AcceptedRevisionSummary;
}): PlanDownstreamLink[] {
  const qualifier =
    input.draft && input.accepted.planVersion != null
      ? `uses Accepted revision ${input.accepted.planVersion}`
      : input.draft
        ? "no accepted revision yet"
        : null;
  return [
    { id: "production", label: "Open Production", qualifier },
    { id: "checkoff", label: "Open Checkoff", qualifier },
  ];
}

export function planAcceptanceModel(input: PlanAcceptanceInput): PlanAcceptanceModel {
  const accepted = acceptedRevisionSummary(input.review);
  const issues = planIssues(input);
  return {
    accepted,
    working: workingChangeSummary(input.draft),
    issues,
    mustResolve: issues.filter((issue) => issue.group === "must_resolve"),
    reviewRecommended: issues.filter((issue) => issue.group === "review_recommended"),
    impact: requiredUnitImpact(input.draft),
    decision: acceptanceDecision({ draft: input.draft, issues, accepted }),
    headerSummary: planHeaderSummary({ review: input.review, draft: input.draft }),
    downstream: downstreamLinks({ draft: input.draft, accepted }),
  };
}

export type PlanAcceptanceConfirmation = {
  readonly planVersion: number;
  readonly requiredUnits: number;
  readonly verifiedUnits: number;
  readonly remainingUnits: number;
  readonly unmoved: readonly PlanUnitOutcome[];
};

export type PlanConfirmationCopy = {
  readonly heading: string;
  readonly detail: string;
  readonly prepareLabel: string | null;
  readonly checkoffLabel: string;
};

export function planConfirmationCopy(
  confirmation: PlanAcceptanceConfirmation,
): PlanConfirmationCopy {
  return {
    heading: `Plan revision ${confirmation.planVersion} accepted`,
    detail: `${plural(confirmation.requiredUnits, "Required unit is", "Required units are")} current. ${
      confirmation.verifiedUnits === 1
        ? "1 verified unit was preserved."
        : `${confirmation.verifiedUnits} verified units were preserved.`
    }`,
    prepareLabel:
      confirmation.remainingUnits > 0
        ? `Prepare ${plural(confirmation.remainingUnits, "remaining unit", "remaining units")}`
        : null,
    checkoffLabel: "View Checkoff",
  };
}
