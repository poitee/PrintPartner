import type { PlanReview, ReviewPart } from "../api/engine";
import { isStlMissing } from "./stlAutoSync";

export type PartWarningKind =
  | "missing"
  | "no_role"
  | "qty_unparsed"
  | "merge_conflict";

export type PartWarning = {
  kind: PartWarningKind;
  label: string;
};

/** Filename / path qty markers like `_x4`, `-x2`, trailing `x8`. */
export function filenameImpliedQty(pathOrName: string): number | null {
  const base = pathOrName.replace(/\\/g, "/").split("/").pop() ?? pathOrName;
  const stem = base.replace(/\.[^.]+$/, "");
  const m =
    stem.match(/(?:^|[_\-\s])x(\d+)$/i) ||
    stem.match(/(?:^|[_\-\s])×(\d+)$/i) ||
    stem.match(/_(\d+)x$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isQtyUnparsed(part: ReviewPart): boolean {
  if (part.quantity_override != null) return false;
  const implied =
    filenameImpliedQty(part.filename) ?? filenameImpliedQty(part.relative_path);
  if (implied == null || implied === 1) return false;
  return part.quantity_auto === 1;
}

function mergeConflictFilenames(review: PlanReview | null | undefined): Set<string> {
  const files = new Set<string>();
  if (!review) return files;
  for (const issue of review.issues) {
    if (issue.code !== "merge_conflict") continue;
    const m = issue.message.match(/for\s+(.+?)\s+—/i) ?? issue.message.match(/:\s*(.+)$/);
    const name = m?.[1]?.trim();
    if (name) files.add(name);
  }
  return files;
}

/** Per-part warnings for Parts grid notes and the “Warnings only” filter. */
export function partWarnings(
  part: ReviewPart,
  review?: PlanReview | null,
): PartWarning[] {
  const out: PartWarning[] = [];
  if (isStlMissing(part)) {
    out.push({ kind: "missing", label: "STL missing" });
  }
  if (!part.role) {
    out.push({ kind: "no_role", label: "no role assigned" });
  }
  if (isQtyUnparsed(part)) {
    out.push({ kind: "qty_unparsed", label: "quantity unparsed" });
  }
  if (mergeConflictFilenames(review).has(part.filename)) {
    out.push({ kind: "merge_conflict", label: "duplicate part" });
  }
  return out;
}

export function hasPartWarning(part: ReviewPart, review?: PlanReview | null): boolean {
  return partWarnings(part, review).length > 0;
}

/**
 * Card / row note — skips STL missing (shown once as a desk-loop warning with Sync CTA).
 */
export function partWarningNote(
  part: ReviewPart,
  review?: PlanReview | null,
): string | null {
  return (
    partWarnings(part, review).find((w) => w.kind !== "missing")?.label ?? null
  );
}

/** Included parts with missing STL files (desk-loop aggregate). */
export { countMissingStls } from "./stlAutoSync";

export function countPartWarnings(
  parts: ReviewPart[],
  review?: PlanReview | null,
): number {
  return parts.reduce((n, p) => n + (hasPartWarning(p, review) ? 1 : 0), 0);
}

/**
 * Parts header summary — excludes STL-missing-only (desk-loop banner + tray).
 * Still counts parts that have any non-missing warning.
 */
export function countNonMissingPartWarnings(
  parts: ReviewPart[],
  review?: PlanReview | null,
): number {
  return parts.reduce(
    (n, p) => n + (partWarningNote(p, review) != null ? 1 : 0),
    0,
  );
}
