import type { PartRow, PlanReview, PlanReviewPartGroup, ReviewPart } from "../api/engine";

/** Human-readable source name from `base:repo-name` / `addon:repo-name` layer labels. */
export function sourceLabelFromLayer(sourceLayer: string | null | undefined): string {
  if (!sourceLayer) return "Other";
  const colon = sourceLayer.indexOf(":");
  return colon >= 0 ? sourceLayer.slice(colon + 1) : sourceLayer;
}

export function flattenReviewParts(groups: PlanReviewPartGroup[]): ReviewPart[] {
  return groups.flatMap((g) => g.parts);
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
