import type { PlanReview, ReviewPart } from "../api/engine";

/** Auto-start / banner triggers for GRE-235 (not Progress ticks / Library no-plan). */
export type StlAutoSyncTrigger =
  | "plan_select"
  | "parts_open"
  | "compose_apply"
  | "progress_tick"
  | "library_no_plan"
  | "manual";

export type StlSyncBannerMode =
  | { kind: "hidden" }
  | { kind: "running" }
  | { kind: "missing"; count: number }
  | { kind: "failed" };

/** Included parts whose STL is absent on disk. */
export function countMissingStls(parts: ReviewPart[]): number {
  return parts.reduce(
    (n, p) => n + (p.included && isStlMissing(p) ? 1 : 0),
    0,
  );
}

export function isStlMissing(part: ReviewPart): boolean {
  return Boolean(part.stl_missing);
}

export function isThumbEmpty(part: ReviewPart): boolean {
  return Boolean(part.included && part.thumb_empty && !part.stl_missing);
}

export function countEmptyThumbs(parts: ReviewPart[]): number {
  return parts.reduce((n, p) => n + (isThumbEmpty(p) ? 1 : 0), 0);
}

export function missingStlPartIds(parts: ReviewPart[]): number[] {
  return parts.filter((p) => p.included && isStlMissing(p)).map((p) => p.id);
}

export function emptyThumbPartIds(parts: ReviewPart[]): number[] {
  return parts.filter((p) => isThumbEmpty(p)).map((p) => p.id);
}

/** Stable key so plan-select + Parts-open in the same breath share one attempt. */
export function stlAutoSyncWorkKey(
  profileId: number,
  missingIds: number[],
  emptyThumbIds: number[],
): string {
  const m = [...missingIds].sort((a, b) => a - b).join(",");
  const t = [...emptyThumbIds].sort((a, b) => a - b).join(",");
  return `${profileId}|m:${m}|t:${t}`;
}

export function reviewNeedsStlAutoSync(review: PlanReview | null | undefined): boolean {
  if (!review) return false;
  const parts = review.part_groups.flatMap((g) => g.parts);
  return countMissingStls(parts) > 0 || countEmptyThumbs(parts) > 0;
}

export function projectIdsForStlSync(review: PlanReview): number[] {
  return [
    ...new Set(
      review.layers
        .map((l) => l.project_id)
        .filter((id): id is number => id != null),
    ),
  ];
}

/**
 * Whether to auto-start the coordinated sync+thumbs job.
 * Manual Sync always bypasses via force on the runner.
 */
export function shouldAutoStartStlSync(opts: {
  profileId: number | null;
  trigger: StlAutoSyncTrigger;
  missingStlCount: number;
  emptyThumbCount: number;
  alreadyRunning: boolean;
  attemptedWorkKey: string | null;
  workKey: string;
}): boolean {
  if (opts.trigger === "progress_tick" || opts.trigger === "library_no_plan") {
    return false;
  }
  if (opts.trigger === "manual") return true;
  if (opts.profileId == null) return false;
  if (opts.alreadyRunning) return false;
  if (opts.missingStlCount <= 0 && opts.emptyThumbCount <= 0) return false;
  if (opts.attemptedWorkKey === opts.workKey) return false;
  return true;
}

/** Parts banner state machine (GRE-235 design lock). */
export function stlSyncBannerMode(opts: {
  running: boolean;
  failed: boolean;
  missingCount: number;
}): StlSyncBannerMode {
  if (opts.running) return { kind: "running" };
  if (opts.failed) return { kind: "failed" };
  if (opts.missingCount > 0) return { kind: "missing", count: opts.missingCount };
  return { kind: "hidden" };
}
