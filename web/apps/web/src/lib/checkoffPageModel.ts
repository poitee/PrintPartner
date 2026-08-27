import type { ReviewPart } from "../api/endpoints/planManifests";
import type { PrinterLiveStripState } from "../components/checkoff/PrinterLiveStrip";
import type { ProgressRowRef } from "./progressListOrder";

function haveSameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export function isSameLiveStripState(
  current: PrinterLiveStripState,
  next: PrinterLiveStripState,
): boolean {
  return (
    current.anyPrinting === next.anyPrinting &&
    current.hostCount === next.hostCount &&
    haveSameIds(current.activeIntegrationIds, next.activeIntegrationIds) &&
    haveSameIds(current.idleIntegrationIds, next.idleIntegrationIds)
  );
}

export function checkoffProgressMeta(input: {
  selectedProfileId: number | null | undefined;
  planName: string;
  includedPartCount: number;
}): string | null {
  if (input.selectedProfileId == null) return null;
  if (input.includedPartCount > 0) {
    return `${input.planName} · ${input.includedPartCount} part${input.includedPartCount === 1 ? "" : "s"}`;
  }
  return input.planName;
}

export function checkoffProgressEyebrow(progressMeta: string | null): string {
  return progressMeta ? `Make · ${progressMeta}` : "Make";
}

export function checkoffProgressDescription(includedPartCount: number): string {
  return includedPartCount === 0
    ? "Mark each unit as you finish it on the shop floor."
    : "Verify what came off the printer.";
}

/**
 * Search within a view. The Checkoff console splits Remaining from Completed
 * with its own views, so search is the only filter left on a part list.
 */
export function searchCheckoffParts(input: {
  parts: ReviewPart[];
  search: string;
}): ReviewPart[] {
  const query = input.search.trim().toLowerCase();
  if (!query) return input.parts;
  return input.parts.filter(
    (part) =>
      part.filename.toLowerCase().includes(query) ||
      part.relative_path.toLowerCase().includes(query) ||
      (part.filament_display || "").toLowerCase().includes(query),
  );
}

/** Visible Progress rows: bags always show; parts respect Remaining/Done/search. */
export function filterProgressRows(input: {
  rows: ProgressRowRef[];
  visiblePartIds: Set<number>;
  search: string;
}): ProgressRowRef[] {
  const query = input.search.trim().toLowerCase();
  return input.rows.filter((row) => {
    if (row.kind === "part") return input.visiblePartIds.has(row.id);
    if (query) return row.label.toLowerCase().includes(query);
    return true;
  });
}

export function orderedPartsFromRows(input: {
  rows: ProgressRowRef[];
  partsById: Map<number, ReviewPart>;
}): ReviewPart[] {
  const out: ReviewPart[] = [];
  for (const row of input.rows) {
    if (row.kind !== "part") continue;
    const part = input.partsById.get(row.id);
    if (part) out.push(part);
  }
  return out;
}
