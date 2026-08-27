import type { ReviewPart } from "../api/endpoints/planManifests";
import type { PrinterLiveStripState } from "../components/checkoff/PrinterLiveStrip";
import type { PrintVerifyQueueState } from "../components/checkoff/PrintVerifyPanel";
import type { CheckoffFilterMode } from "./persistedCheckoffUi";
import type { ProgressRowRef } from "./progressListOrder";

export const CHECKOFF_FILTER_MODES: readonly {
  mode: CheckoffFilterMode;
  label: string;
}[] = [
  { mode: "missing", label: "Remaining" },
  { mode: "done", label: "Done" },
  { mode: "all", label: "All" },
];

export function haveSameIds(left: readonly string[], right: readonly string[]): boolean {
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

/** Prefer verify when any finished job awaits; printing only when nothing needs confirmation. */
export function checkoffProgressMode(input: {
  liveStrip: Pick<PrinterLiveStripState, "anyPrinting">;
  verifyQueue: Pick<PrintVerifyQueueState, "awaitingCount" | "watchingCount">;
}): "printing" | "verify" | "idle" {
  if (input.verifyQueue.awaitingCount > 0) return "verify";
  if (input.liveStrip.anyPrinting || input.verifyQueue.watchingCount > 0) return "printing";
  return "idle";
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
  return progressMeta ? `Stage 3 of 4 · ${progressMeta}` : "Stage 3 of 4";
}

export function checkoffProgressDescription(includedPartCount: number): string {
  return includedPartCount === 0
    ? "Mark each unit as you finish it on the shop floor."
    : "Verify when a print finishes. Remaining parts stay below.";
}

export function filterCheckoffParts(input: {
  parts: ReviewPart[];
  filter: CheckoffFilterMode;
  search: string;
}): ReviewPart[] {
  let rows = input.parts;
  if (input.filter === "missing") rows = rows.filter((part) => part.missing);
  if (input.filter === "done") rows = rows.filter((part) => !part.missing);
  const query = input.search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(
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
