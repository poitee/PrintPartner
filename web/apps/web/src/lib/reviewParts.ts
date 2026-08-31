import type { PartRow, PlanDraftPartView, PlanDraftWorkspace } from "@print-partner/contracts";
import type { PlanReview, PlanReviewPartGroup, ReviewPart } from "../api/endpoints/planManifests";

/** Human-readable source name from `base:repo-name` / `addon:repo-name` layer labels. */
export function sourceLabelFromLayer(sourceLayer: string | null | undefined): string {
  if (!sourceLayer) return "Other";
  const colon = sourceLayer.indexOf(":");
  return colon >= 0 ? sourceLayer.slice(colon + 1) : sourceLayer;
}

export function flattenReviewParts(groups: PlanReviewPartGroup[]): ReviewPart[] {
  return groups.flatMap((g) => g.parts);
}

function only<T>(values: readonly T[]): T | null {
  return values.length === 1 ? values[0]! : null;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "");
}

function acceptedPartForDraft(
  acceptedParts: readonly ReviewPart[],
  draftPart: PlanDraftPartView,
  usedAcceptedIds: ReadonlySet<number>,
): ReviewPart | null {
  const available = acceptedParts.filter((part) => !usedAcceptedIds.has(part.id));
  const byKey = available.filter((part) => part.match_key === draftPart.part_key);
  const exactKey = only(byKey);
  if (exactKey) return exactKey;

  const candidates = byKey.length > 0 ? byKey : available;
  const draftPath = normalizedPath(draftPart.relative_path);
  const byLayerAndPath = only(candidates.filter((part) => (
    part.source_layer === draftPart.source_layer &&
    normalizedPath(part.relative_path) === draftPath
  )));
  if (byLayerAndPath) return byLayerAndPath;

  return only(candidates.filter((part) => normalizedPath(part.relative_path) === draftPath));
}

function progressForQuantity(part: ReviewPart | null, quantity: number): {
  readonly printUnits: boolean[];
  readonly printedCount: number;
} {
  const printUnits = Array.from(
    { length: quantity },
    (_, index) => part?.print_units[index] ?? false,
  );
  return {
    printUnits,
    printedCount: printUnits.filter(Boolean).length,
  };
}

/**
 * Project the editable Working Plan through the sheet used by Plan.
 *
 * Accepted rows contribute media, filament, and carried progress when they
 * exist. New rows use negative display-only IDs so they cannot be mistaken
 * for Accepted Plan identities before publication.
 */
export function workingPlanReviewParts(
  acceptedParts: readonly ReviewPart[],
  workspace: PlanDraftWorkspace,
): ReviewPart[] {
  const usedAcceptedIds = new Set<number>();
  return workspace.parts.map((draftPart) => {
    const accepted = acceptedPartForDraft(acceptedParts, draftPart, usedAcceptedIds);
    if (accepted) usedAcceptedIds.add(accepted.id);
    const { printUnits, printedCount } = progressForQuantity(
      accepted,
      draftPart.quantity_effective,
    );
    const planningFields = {
      match_key: draftPart.part_key,
      relative_path: draftPart.relative_path,
      filename: draftPart.filename,
      source_layer: draftPart.source_layer,
      role: draftPart.role,
      included: draftPart.included,
      quantity_auto: draftPart.quantity_inferred,
      quantity_override: draftPart.quantity_override,
      quantity_effective: draftPart.quantity_effective,
      print_units: printUnits,
      printed_count: printedCount,
      missing: draftPart.included && printedCount < draftPart.quantity_effective,
    };
    if (accepted) return { ...accepted, ...planningFields };
    return {
      id: -draftPart.draft_part_id,
      status: "working",
      requirement: null,
      option_group_id: null,
      filament_color_id: null,
      filament_custom_hex: null,
      spoolman_spool_id: null,
      filament_display: "",
      ...planningFields,
    };
  });
}

/** Merge a partial patch into a review part row (keeps print progress fields). */
export function mergeReviewPartPatch(
  part: ReviewPart,
  patch: Partial<ReviewPart> & Partial<PartRow>,
): ReviewPart {
  return { ...part, ...patch };
}

export function partitionIncludedParts(parts: PartRow[]): {
  included: PartRow[];
  excluded: PartRow[];
} {
  const included: PartRow[] = [];
  const excluded: PartRow[] = [];
  for (const p of parts) {
    if (p.included) included.push(p);
    else excluded.push(p);
  }
  const byName = (a: PartRow, b: PartRow) => a.filename.localeCompare(b.filename);
  included.sort(byName);
  excluded.sort(byName);
  return { included, excluded };
}

export function filterPartsByQuery(parts: PartRow[], query: string): PartRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return parts;
  return parts.filter((p) => {
    const hay = [
      p.filename,
      p.relative_path,
      p.role ?? "",
      sourceLabelFromLayer(p.source_layer),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Apply a PATCH response into review payload (totals omit filament breakdown). */
export function mergePartIntoReview(review: PlanReview, updated: ReviewPart | PartRow): PlanReview {
  const part_groups = review.part_groups.map((g) => ({
    ...g,
    parts: g.parts.map((p) =>
      p.id === updated.id ? mergeReviewPartPatch(p, updated) : p,
    ),
  }));
  const all = flattenReviewParts(part_groups);
  const included = all.filter((p) => p.included);
  const by_role: Record<string, number> = {};
  let print_units = 0;
  for (const p of included) {
    const role = p.role || "primary";
    by_role[role] = (by_role[role] ?? 0) + 1;
    print_units += Math.max(1, p.quantity_effective);
  }
  return {
    ...review,
    part_groups,
    totals: {
      ...review.totals,
      included_parts: included.length,
      total_print_units: print_units,
      by_role,
    },
  };
}

export function mergeProgressIntoReview(
  review: PlanReview,
  partId: number,
  progress: {
    printed_count: number;
    print_units: boolean[];
    missing: boolean;
    assembled_units?: boolean[];
  },
): PlanReview {
  const part_groups = review.part_groups.map((g) => ({
    ...g,
    parts: g.parts.map((p) => {
      if (p.id !== partId) return p;
      // A unit that is no longer printed cannot be assembled. The server
      // enforces this in the domain layer, so mirror it in the cache: without
      // this, un-printing a unit leaves a stale assembled=true that reappears
      // as a checked "Assembled" toggle the moment the unit is re-checked.
      const assembled_units =
        progress.assembled_units ??
        (p.assembled_units
          ? p.assembled_units.map((a, i) => (progress.print_units[i] ? a : false))
          : p.assembled_units);
      return mergeReviewPartPatch(p, { ...progress, assembled_units });
    }),
  }));
  return { ...review, part_groups };
}

/** Apply an assembled-units PATCH response into review payload (assembly tracking). */
export function mergeAssembledIntoReview(
  review: PlanReview,
  partId: number,
  progress: { assembled_units: boolean[] },
): PlanReview {
  const part_groups = review.part_groups.map((g) => ({
    ...g,
    parts: g.parts.map((p) =>
      p.id === partId ? mergeReviewPartPatch(p, progress) : p,
    ),
  }));
  return { ...review, part_groups };
}
