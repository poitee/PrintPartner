/**
 * PhaseProgressView.tsx
 * ---------------------
 * Replaces the flat parts list on CheckoffPage when a plan's source
 * repository exposes a pp-phases.json phase manifest.
 *
 * Layout:
 *   For each phase (sorted by order):
 *     ┌─ Phase N Name ───────────────────────────────────────────┐
 *     │  12/14 parts printed   ████████░░  86%                   │
 *     │  [BLOCKED] Waiting on: Gantry (2 unprinted parts)        │
 *     └────────────────────────────────────────────────────────────┘
 *     <collapsible parts list>
 *
 * Quick filter: "Show only blocking parts for next phase" renders a
 * filtered list of just the parts currently gating assembly progress.
 */

import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "../ui/button";
import ProgressPartRow from "./ProgressPartRow";
import type { ReviewPart } from "../../api/engine";
import type { PhaseProgress } from "../../lib/phaseManifest";
import { nextUnlockedPhase } from "../../lib/phaseManifest";
import { isProgressRowBusy } from "../../lib/checkoffProgress";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Phase header badge
// ---------------------------------------------------------------------------

function PhaseBadge({ color, name }: { color?: string; name: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs font-semibold text-white shadow-sm"
      style={{ background: color ?? "#6b7280" }}
    >
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline progress bar
// ---------------------------------------------------------------------------

function PhaseBar({ percent, blocked }: { percent: number; blocked: boolean }) {
  const barClass = blocked
    ? "bg-destructive"
    : percent >= 100
      ? "bg-success"
      : "bg-primary";
  return (
    <span
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        className={cn("block h-full rounded-full transition-[width]", barClass)}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single phase card
// ---------------------------------------------------------------------------

type PhaseCardProps = {
  phaseProgress: PhaseProgress;
  /** Part currently being saved, or null. Scoped per-row so one save doesn't lock the list. */
  busyPartId: number | null;
  showBlockingOnly: boolean;
  assemblyTrackingEnabled?: boolean;
  onIncrement: (part: ReviewPart) => void;
  onDecrement: (part: ReviewPart) => void;
  onPreview: (part: ReviewPart) => void;
  onToggleAssembled?: (part: ReviewPart, unitIndex: number) => void;
  printingPartIds: Map<number, string>;
  awaitingPartIds: Map<number, string>;
};

function PhaseCard({
  phaseProgress,
  busyPartId,
  showBlockingOnly,
  assemblyTrackingEnabled,
  onIncrement,
  onDecrement,
  onPreview,
  onToggleAssembled,
  printingPartIds,
  awaitingPartIds,
}: PhaseCardProps) {
  const { phase, parts, totals, partsPrinted, partsTotal, blocked, blockingPhases, blockingParts } =
    phaseProgress;

  const [expanded, setExpanded] = useState(!blocked);

  const allDone = totals.remainingUnits === 0 && partsTotal > 0;

  const visibleParts = useMemo(() => {
    if (showBlockingOnly) return blockingParts;
    return parts;
  }, [parts, blockingParts, showBlockingOnly]);

  const statusIcon = allDone ? (
    <CheckCircle2 className="size-4 shrink-0 text-success" />
  ) : blocked ? (
    <AlertTriangle className="size-4 shrink-0 text-destructive" />
  ) : (
    <Clock className="size-4 shrink-0 text-muted-foreground" />
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card shadow-sm",
        blocked && "border-destructive/40",
        allDone && "border-success/30 bg-success/5",
      )}
    >
      {/* Header — always visible */}
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}

        <PhaseBadge color={phase.color} name={phase.name} />

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            {statusIcon}
            <span className="font-mono text-sm font-medium tabular-nums">
              {partsPrinted}/{partsTotal} parts printed
            </span>
            {blocked && (
              <span className="ml-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">
                BLOCKED
              </span>
            )}
          </div>

          <PhaseBar percent={totals.percent} blocked={blocked} />

          <span className="font-mono text-[11px] text-muted-foreground">
            {totals.percent}% · {totals.remainingUnits} unit{totals.remainingUnits === 1 ? "" : "s"} remaining
          </span>
        </div>
      </button>

      {/* Blocked detail */}
      {blocked && (
        <div className="border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <span className="font-semibold">Waiting on: </span>
          {blockingPhases.map((dep, i) => {
            // Count missing parts in the dep phase — we don't have it here,
            // so we keep it simple: just show phase name
            return (
              <span key={dep}>
                {i > 0 && ", "}
                <span className="font-medium">{dep}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Collapsible parts list */}
      {expanded && visibleParts.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border p-2">
          {showBlockingOnly && blockingParts.length === 0 && (
            <p className="px-2 py-1 text-sm text-muted-foreground">
              No blocking parts in this phase.
            </p>
          )}
          {visibleParts.map((part) => (
            <ProgressPartRow
              key={part.id}
              part={part}
              busy={isProgressRowBusy(busyPartId, part.id)}
              printingOn={printingPartIds.get(part.id)}
              awaitingVerify={awaitingPartIds.get(part.id)}
              assemblyTrackingEnabled={assemblyTrackingEnabled}
              onIncrement={onIncrement}
              onDecrement={onDecrement}
              onPreview={onPreview}
              onToggleAssembled={onToggleAssembled}
            />
          ))}
        </div>
      )}

      {expanded && visibleParts.length === 0 && partsTotal === 0 && (
        <p className="border-t border-border px-3 py-2 text-sm text-muted-foreground">
          No parts assigned to this phase.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

type PhaseProgressViewProps = {
  phases: PhaseProgress[];
  /** Part currently being saved, or null. */
  busyPartId: number | null;
  assemblyTrackingEnabled?: boolean;
  onIncrement: (part: ReviewPart) => void;
  onDecrement: (part: ReviewPart) => void;
  onPreview: (part: ReviewPart) => void;
  onToggleAssembled?: (part: ReviewPart, unitIndex: number) => void;
  printingPartIds: Map<number, string>;
  awaitingPartIds: Map<number, string>;
};

export default function PhaseProgressView({
  phases,
  busyPartId,
  assemblyTrackingEnabled,
  onIncrement,
  onDecrement,
  onPreview,
  onToggleAssembled,
  printingPartIds,
  awaitingPartIds,
}: PhaseProgressViewProps) {
  const [showBlockingOnly, setShowBlockingOnly] = useState(false);

  const next = useMemo(() => nextUnlockedPhase(phases), [phases]);

  // Only show the quick filter when there IS a next phase with blocking parts
  const canFilter = next != null && next.blockingParts.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Quick filter bar */}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
        <span className="text-sm font-medium text-foreground">Phase view</span>
        {canFilter && (
          <Button
            type="button"
            variant={showBlockingOnly ? "default" : "outline"}
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={() => setShowBlockingOnly((v) => !v)}
          >
            {showBlockingOnly
              ? "Show all parts"
              : `Show blocking parts for ${next!.phase.name}`}
          </Button>
        )}
        {!canFilter && (
          <span className="ml-auto text-xs text-muted-foreground">
            {phases.every((ph) => ph.totals.remainingUnits === 0)
              ? "All phases complete"
              : "No cross-phase blockers"}
          </span>
        )}
      </div>

      {/* Phase cards */}
      {phases.map((ph) => (
        <PhaseCard
          key={ph.phase.name}
          phaseProgress={ph}
          busyPartId={busyPartId}
          showBlockingOnly={showBlockingOnly}
          assemblyTrackingEnabled={assemblyTrackingEnabled}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
          onPreview={onPreview}
          onToggleAssembled={onToggleAssembled}
          printingPartIds={printingPartIds}
          awaitingPartIds={awaitingPartIds}
        />
      ))}
    </div>
  );
}
