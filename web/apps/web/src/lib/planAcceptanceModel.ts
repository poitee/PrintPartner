import type {
  PlanDraftWorkspace,
  PlanFreshness,
  PlanStaleReason,
  PlanUntrackedReason,
} from "@print-partner/contracts";
import type { PlanReview } from "../api/endpoints/planManifests";
import { buildSourcesRoute, libraryRoute, productionRoute } from "./routes";
import type { WorkingPlanRecovery } from "./workingPlanChanged";

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

export type PlanSourceNotice =
  | Readonly<{
      kind: "updates_available";
      title: "Source updates available";
      detail: string;
      message: string;
      productionAction: Readonly<{ label: "Continue to Production"; to: string }>;
      reviewAction: Readonly<{ label: "Review Sources for the next Plan"; to: string }>;
    }>
  | Readonly<{
      kind: "tracking_unavailable";
      title: "Source update tracking unavailable";
      detail: string;
      message: string;
      productionAction: Readonly<{ label: "Continue to Production"; to: string }>;
      reviewAction: Readonly<{ label: "Review Sources for the next Plan"; to: string }>;
    }>;

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
  | { readonly kind: "working_plan_changed"; readonly recovery: WorkingPlanRecovery }
  | { readonly kind: "error"; readonly message: string };

export type PlanAcceptanceInput = {
  readonly review: PlanReview | null;
  readonly draft: PlanDraftWorkspace | null;
  readonly buildId: number | null;
  readonly failure?: PlanAcceptanceFailure | null;
  readonly freshness?: PlanFreshness | null;
};

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

export type PlanPublication =
  | Readonly<{
      kind: "no_working_plan";
      label: "Publish Plan for Production";
      reason: string;
    }>
  | Readonly<{
      kind: "waiting_for_choices";
      label: "Publish Plan for Production";
      reason: string;
      choiceCount: number;
    }>
  | Readonly<{
      kind: "ready";
      label: string;
      reason: string;
      nextRevision: number;
    }>;

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
  readonly sourceNotice: PlanSourceNotice | null;
  readonly impact: PlanRequiredUnitImpact;
  readonly publication: PlanPublication;
  readonly headerSummary: string;
  readonly downstream: readonly PlanDownstreamLink[];
};

const PUBLISH_LABEL = "Publish Plan for Production";

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
        ? "No Plan revision published yet"
        : `Plan revision ${planVersion} published`,
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
    if (accepted.partCount === 0) return "No Working Plan yet. Build one from Sources.";
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
    `${plural(units, "Required unit", "Required units")} when published`,
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

function sourceReviewRoute(buildId: number | null): string {
  return buildId == null ? libraryRoute() : buildSourcesRoute(buildId);
}

export function planSourceNotice(input: {
  readonly freshness: PlanFreshness | null | undefined;
  readonly accepted: AcceptedRevisionSummary;
  readonly buildId: number | null;
}): PlanSourceNotice | null {
  const freshness = input.freshness;
  const planVersion = input.accepted.planVersion;
  if (!freshness || freshness.status === "current" || planVersion == null) return null;

  const message =
    `Production and Checkoff continue using the files from published Plan revision ${planVersion}.`;
  const productionAction: PlanSourceNotice["productionAction"] = {
    label: "Continue to Production",
    to: productionRoute(input.buildId),
  };
  const reviewAction: PlanSourceNotice["reviewAction"] = {
    label: "Review Sources for the next Plan",
    to: sourceReviewRoute(input.buildId),
  };

  if (freshness.status === "stale") {
    return {
      kind: "updates_available",
      title: "Source updates available",
      detail: planFreshnessMessages(freshness).join(" "),
      message,
      productionAction,
      reviewAction,
    };
  }

  const reasons = freshness.reasons.filter((reason) => reason.kind !== "no_accepted_inputs");
  if (reasons.length === 0) return null;
  return {
    kind: "tracking_unavailable",
    title: "Source update tracking unavailable",
    detail: reasons.map(planUntrackedReasonText).join(" "),
    message,
    productionAction,
    reviewAction,
  };
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
          ? "More than one published part matches this file. Pick the one whose printed units carry over."
          : "This file already has printed units. Keep them, or print the units again.",
      statusLabel: "Choose before publishing",
      tone: "error" as const,
      action: { kind: "required_unit_decision" as const, draftPartId: conflict.target_draft_part_id },
    };
  });
}

function failureIssues(input: {
  readonly failure: PlanAcceptanceFailure;
}): PlanIssue[] {
  const failure = input.failure;
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
          "Publishing paused so that printed work is not lost. Move these records to the new revision, or finish them in Production first.",
        statusLabel: "Choose before publishing",
        tone: "error",
        action: { kind: "move_records", label: "Move records and publish" },
      }];
    case "unsafe_records":
      return [{
        id: "plan-issue-unsafe-records",
        group: "must_resolve",
        title: `${plural(failure.units.length, "printed file", "printed files")} cannot move to the new revision`,
        detail: failure.units
          .map((unit) => `${unit.filename}: ${unit.outcome}`)
          .join(" \u2022 "),
        statusLabel: "Finish before publishing",
        tone: "error",
        action: null,
      }];
    case "working_plan_changed":
      return [{
        id: "plan-issue-working-plan-changed",
        group: "review_recommended",
        title: failure.recovery === "rebuilt_from_sources"
          ? "Working Plan rebuilt from current Sources"
          : "Working Plan refreshed before publishing",
        detail: failure.recovery === "rebuilt_from_sources"
          ? "Review the updated parts and quantities, then publish again."
          : "Review the updated quantities and choices, then publish again.",
        statusLabel: "Review updated Plan",
        tone: "warning",
        action: null,
      }];
    case "error":
      return [{
        id: "plan-issue-acceptance-error",
        group: "must_resolve",
        title: "Publishing did not complete",
        detail: failure.message,
        statusLabel: "Retry available",
        tone: "error",
        action: null,
      }];
  }
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
      title: "The published Plan changed after these Working Plan changes were saved",
      detail: "Refresh the Working Plan so it compares against the current published revision.",
      statusLabel: "Refresh before publishing",
      tone: "error",
      action: { kind: "refresh_working_plan", label: "Refresh Working Plan" },
    });
  }
  if (draft) {
    issues.push(...requiredUnitIssues(draft));
  }
  if (input.failure) issues.push(...failureIssues({ failure: input.failure }));

  const reviewIssues = review?.issues ?? [];
  const missingStl = reviewIssues.filter((issue) => issue.code === "missing_stl");
  const mergeConflicts = reviewIssues.filter((issue) => issue.code === "merge_conflict");

  for (const [index, issue] of reviewIssues.entries()) {
    if (issue.code === "missing_stl" || issue.code === "merge_conflict") continue;
    if (issue.code === "no_included_parts") continue;
    issues.push({
      id: `plan-issue-${issue.code}-${index}`,
      group: "review_recommended",
      title: issue.message,
      detail: null,
      statusLabel:
        issue.severity === "blocker" ? "Needed for Production" : "Check before publishing",
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
      statusLabel: "Needed for Production",
      tone: "error",
      action: { kind: "sync_sources", label: "Sync sources" },
    });
  }

  if (mergeConflicts.length > 0) {
    issues.push({
      id: "plan-issue-merge-conflict",
      group: "review_recommended",
      title: `Duplicate parts detected in ${plural(mergeConflicts.length, "file", "files")}`,
      detail: "Two sources give the same part. Choose which source wins in the Build's Sources workspace.",
      statusLabel: "Check before publishing",
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
      reason: "There are no Working Plan changes, so the published revision's Required units stay as they are.",
    };
  }
  if (draft.reconciliation.kind !== "ready") {
    return {
      kind: "unavailable",
      reason: "Answer the Required-unit decisions above to see what publishing preserves.",
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

export function planPublication(input: {
  readonly draft: PlanDraftWorkspace | null;
  readonly issues: readonly PlanIssue[];
  readonly accepted: AcceptedRevisionSummary;
}): PlanPublication {
  const choices = input.issues.filter((issue) => issue.group === "must_resolve");
  if (!input.draft) {
    return {
      kind: "no_working_plan",
      label: PUBLISH_LABEL,
      reason: "Build a Working Plan from the current Sources, then review it here.",
    };
  }
  if (choices.length > 0) {
    return {
      kind: "waiting_for_choices",
      label: PUBLISH_LABEL,
      reason: `Complete ${plural(choices.length, "choice", "choices")} under "Before publishing" first.`,
      choiceCount: choices.length,
    };
  }
  const next = (input.accepted.planVersion ?? 0) + 1;
  const included = input.draft.parts.filter((part) => part.included);
  const requiredUnits = included.reduce(
    (sum, part) => sum + Math.max(0, part.quantity_effective),
    0,
  );
  return {
    kind: "ready",
    label: `Publish Plan revision ${next} for Production`,
    reason: `Publishes ${plural(included.length, "included part", "included parts")} as ${plural(requiredUnits, "required unit", "required units")}. Production and Checkoff will use this fixed revision.`,
    nextRevision: next,
  };
}

export function downstreamLinks(input: {
  readonly draft: PlanDraftWorkspace | null;
  readonly accepted: AcceptedRevisionSummary;
}): PlanDownstreamLink[] {
  const qualifier =
    input.draft && input.accepted.planVersion != null
      ? `uses published revision ${input.accepted.planVersion}`
      : input.draft
        ? "publish this Plan first"
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
    sourceNotice: planSourceNotice({
      freshness: input.freshness,
      accepted,
      buildId: input.buildId,
    }),
    impact: requiredUnitImpact(input.draft),
    publication: planPublication({
      draft: input.draft,
      issues,
      accepted,
    }),
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
    heading: `Plan revision ${confirmation.planVersion} published`,
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
