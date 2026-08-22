import { memo } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { Minus, Plus } from "lucide-react";
import type { ReviewPart } from "../../api/engine";
import {
  assembledEligibleUnitIndices,
  lastCompletedUnit,
  nextUnitToComplete,
  partProgressPercent,
  partProgressTone,
} from "../../lib/checkoffProgress";
import { folderKeyFromRelativePath } from "../../lib/checkoffGroups";
import { sourceLabelFromLayer } from "../../lib/reviewParts";
import { cn } from "../../lib/utils";
import { SortableDragHandle } from "../dnd/SortableDragHandle";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

type Props = {
  part: ReviewPart;
  busy: boolean;
  /** Dense phone layout: larger steppers, no inline bar. */
  compact?: boolean;
  /** Printer host name if this part is currently being printed. */
  printingOn?: string;
  /** Printer host name if this part's print has finished and awaits verify. */
  awaitingVerify?: string;
  /** Suggested printer from an unattributed print candidate. */
  suggestedPrinter?: { hostName: string; printId: string; filename: string };
  /** Global "Enable assembly tracking" setting (Settings > Build Tracking). */
  assemblyTrackingEnabled?: boolean;
  onIncrement: (part: ReviewPart) => void;
  onDecrement: (part: ReviewPart) => void;
  onPreview: (part: ReviewPart) => void;
  /** Called when user clicks Claim on a suggested printer. */
  onClaim?: (printId: string) => void;
  /** Called when the user toggles the Assembled switch for a completed unit. */
  onToggleAssembled?: (part: ReviewPart, unitIndex: number) => void;
  /** When set, shows a grip handle for Progress list reorder. */
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    disabled?: boolean;
  };
};

function sourceLine(part: ReviewPart): string {
  const repo = sourceLabelFromLayer(part.source_layer);
  const folder = folderKeyFromRelativePath(part.relative_path);
  if (!folder || folder === "(root)") return repo;
  return `${repo} / ${folder}`;
}

const toneCountClass: Record<ReturnType<typeof partProgressTone>, string> = {
  empty: "text-destructive",
  partial: "text-warning",
  done: "text-success",
};

const toneBarClass: Record<ReturnType<typeof partProgressTone>, string> = {
  empty: "bg-muted",
  partial: "bg-warning",
  done: "bg-success",
};

function truncateFilename(name: string, maxLen = 20): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + "…";
}

/**
 * Assembled toggles — one per completed unit, only rendered when the global
 * Assembled Tracking setting is on. Hidden entirely when there is nothing
 * completed yet, since "assembled" tracks installed-but-already-printed state.
 */
function AssembledToggles({
  part,
  busy,
  onToggleAssembled,
}: {
  part: ReviewPart;
  busy: boolean;
  onToggleAssembled: (part: ReviewPart, unitIndex: number) => void;
}) {
  const assembledUnits = part.assembled_units ?? [];
  const completedIndices = assembledEligibleUnitIndices(part.print_units);
  if (completedIndices.length === 0) return null;
  const showUnitNumber = part.print_units.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="assembled-toggles">
      {completedIndices.map((idx) => {
        const isAssembled = assembledUnits[idx] ?? false;
        const label = showUnitNumber ? `Assembled #${idx + 1}` : "Assembled";
        return (
          <label
            key={idx}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground",
              isAssembled && "border-success/40 bg-success/10 text-success",
            )}
          >
            <Switch
              checked={isAssembled}
              disabled={busy}
              onCheckedChange={() => onToggleAssembled(part, idx)}
              aria-label={`${label} for ${part.filename}`}
              className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
            />
            <span>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** Status badges rendered under the filename. At most one printing/awaiting badge shows. */
function StatusBadges({
  inCompact,
  printingOn,
  awaitingVerify,
  suggestedPrinter,
  busy,
  onClaim,
}: {
  inCompact: boolean;
  printingOn?: string;
  awaitingVerify?: string;
  suggestedPrinter?: { hostName: string; printId: string; filename: string };
  busy: boolean;
  onClaim?: (printId: string) => void;
}) {
  return (
    <>
      {/* Awaiting verify (green) — takes precedence over printing */}
      {awaitingVerify && (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          <span aria-hidden>✓</span> Finished on {awaitingVerify} — verify
        </span>
      )}

      {/* Actively printing (sky) — only when not already awaiting verify */}
      {!awaitingVerify && printingOn && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
          <span
            className="inline-block h-2 w-2 rounded-full bg-sky-500 animate-pulse"
            aria-hidden
          />
          Printing on {printingOn}
        </span>
      )}

      {/* Suggested printer from unattributed print (amber) */}
      {suggestedPrinter && !printingOn && !awaitingVerify && (
        <span className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <span aria-hidden>⚡</span>
          <span>
            Possibly on {suggestedPrinter.hostName} [{truncateFilename(suggestedPrinter.filename)}]
          </span>
          <button
            type="button"
            className={cn(
              "rounded border border-amber-500/50 bg-amber-500/20 px-1.5 py-0 text-[10px] font-semibold text-amber-800 hover:bg-amber-500/30 dark:text-amber-200",
              inCompact ? "h-5" : "h-4",
            )}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onClaim?.(suggestedPrinter.printId);
            }}
          >
            Claim
          </button>
        </span>
      )}
    </>
  );
}

/**
 * Screen Progress row — thumb, path, filament swatch, bar, −/+ steppers
 * (matches Workflow mock Progress / phone checkoff density).
 *
 * Memoised so checking off one unit only re-renders the affected row,
 * not all 145 rows in the list.
 */
const ProgressPartRow = memo(function ProgressPartRow({
  part,
  busy,
  compact = false,
  printingOn,
  awaitingVerify,
  suggestedPrinter,
  assemblyTrackingEnabled,
  onIncrement,
  onDecrement,
  onPreview,
  onClaim,
  onToggleAssembled,
  dragHandle,
}: Props) {
  const qty = part.quantity_effective;
  const tone = partProgressTone(part.printed_count, qty);
  const pct = partProgressPercent(part.printed_count, qty);
  const canInc = nextUnitToComplete(part.print_units) >= 0;
  const canDec = lastCompletedUnit(part.print_units) >= 0;
  const countLabel = `${part.printed_count} of ${qty}`;

  const handle = dragHandle ? (
    <SortableDragHandle
      attributes={dragHandle.attributes}
      listeners={dragHandle.listeners}
      disabled={dragHandle.disabled || busy}
      label={`Reorder ${part.filename}`}
      className={compact ? "size-10" : "size-7"}
    />
  ) : null;

  if (compact) {
    return (
      <article
        className={cn(
          "flex items-center gap-3 rounded-[10px] border border-border bg-card p-3 shadow-sm",
          tone === "done" && "border-success/40 bg-success/5",
          awaitingVerify && "border-emerald-500/30 bg-emerald-500/5",
        )}
      >
        {handle}
        <PartThumbExpandButton part={part} sizePx={72} onExpand={onPreview} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className="truncate font-mono text-xs"
            title={part.relative_path || part.filename}
          >
            {part.filename}
          </span>
          <StatusBadges
            inCompact
            printingOn={printingOn}
            awaitingVerify={awaitingVerify}
            suggestedPrinter={suggestedPrinter}
            busy={busy}
            onClaim={onClaim}
          />
          <div className="flex items-center gap-2">
            {part.filament_hex ? (
              <span
                className="size-2.5 shrink-0 rounded-sm border border-black/15"
                style={{ background: part.filament_hex }}
                title={part.filament_display || undefined}
              />
            ) : null}
            <span className={cn("font-mono text-xs font-medium tabular-nums", toneCountClass[tone])}>
              {countLabel}
            </span>
          </div>
          {assemblyTrackingEnabled && onToggleAssembled && (
            <AssembledToggles part={part} busy={busy} onToggleAssembled={onToggleAssembled} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11 rounded-[10px]"
            disabled={busy || !canDec}
            aria-label={`Decrease printed count for ${part.filename}`}
            onClick={() => onDecrement(part)}
          >
            <Minus className="size-5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11 rounded-[10px] border-primary bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            disabled={busy || !canInc}
            aria-label={`Increase printed count for ${part.filename}`}
            onClick={() => onIncrement(part)}
          >
            <Plus className="size-5" />
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm",
        tone === "done" && "border-success/40 bg-success/5",
        awaitingVerify && "border-emerald-500/30 bg-emerald-500/5",
      )}
    >
      {handle}
      <PartThumbExpandButton part={part} sizePx={72} onExpand={onPreview} />
      <div className="flex w-[min(100%,20rem)] min-w-0 flex-col gap-0.5 self-center">
        <span
          className="truncate font-mono text-xs"
          title={part.relative_path || part.filename}
        >
          {part.filename}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{sourceLine(part)}</span>
        <StatusBadges
          inCompact={false}
          printingOn={printingOn}
          awaitingVerify={awaitingVerify}
          suggestedPrinter={suggestedPrinter}
          busy={busy}
          onClaim={onClaim}
        />
        {assemblyTrackingEnabled && onToggleAssembled && (
          <AssembledToggles part={part} busy={busy} onToggleAssembled={onToggleAssembled} />
        )}
      </div>
      {part.filament_hex ? (
        <span
          className="size-3.5 shrink-0 rounded border border-black/15"
          style={{ background: part.filament_hex }}
          title={part.filament_display || undefined}
        />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <span
        className="hidden h-1.5 max-w-[14rem] flex-1 overflow-hidden rounded-full bg-muted sm:block"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${part.filename} ${pct}% printed`}
      >
        <span
          className={cn("block h-full rounded-full transition-[width]", toneBarClass[tone])}
          style={{ width: `${pct}%` }}
        />
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7 rounded-md"
          disabled={busy || !canDec}
          aria-label={`Decrease printed count for ${part.filename}`}
          onClick={() => onDecrement(part)}
        >
          <Minus className="size-3.5" />
        </Button>
        <span
          className={cn(
            "w-[3.25rem] text-center font-mono text-[13px] font-medium tabular-nums",
            toneCountClass[tone],
          )}
        >
          {countLabel}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7 rounded-md border-primary bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
          disabled={busy || !canInc}
          aria-label={`Increase printed count for ${part.filename}`}
          onClick={() => onIncrement(part)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
    </article>
  );
});

export default ProgressPartRow;
