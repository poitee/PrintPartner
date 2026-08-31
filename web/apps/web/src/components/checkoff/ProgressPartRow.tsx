import { memo } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { Minus, Plus } from "lucide-react";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { SuggestedPrinterClaim } from "../../lib/checkoffPrinterActivity";
import type { CheckoffRowError } from "../../lib/checkoffConsoleRowErrors";
import {
  lastCompletedUnit,
  nextUnitToComplete,
  partProgressPercent,
  partProgressTone,
} from "../../lib/checkoffProgress";
import { folderKeyFromRelativePath } from "../../lib/checkoffGroups";
import { sourceLabelFromLayer } from "../../lib/reviewParts";
import { cn } from "@/lib/utils";
import { SortableDragHandle } from "../dnd/SortableDragHandle";
import PartThumbExpandButton from "../parts/PartThumbExpandButton";
import { Button } from "../ui/button";
import CheckoffRowActionsMenu, {
  type CheckoffRowAction,
  type CheckoffRowMoveControls,
} from "./CheckoffRowActionsMenu";
import { AssembledToggles, StatusBadges } from "./CheckoffRowStatus";
import CheckoffRowMoveButtons from "./CheckoffRowMoveButtons";
import CheckoffRowErrorNotice from "./CheckoffRowErrorNotice";

type Props = {
  part: ReviewPart;
  busy: boolean;
  /** Dense phone layout: one large primary action, rare actions in a menu. */
  compact?: boolean;
  /** Printer host name if this part is currently being printed. */
  printingOn?: string;
  /** Printer host name if this part's print has finished and awaits verify. */
  awaitingVerify?: string;
  /** Suggested printer from an unattributed print candidate. */
  suggestedPrinter?: SuggestedPrinterClaim;
  /** Global "Enable assembly tracking" setting (Settings > Build Tracking). */
  assemblyTrackingEnabled?: boolean;
  /** Non-drag ordering controls (WCAG 2.2 dragging movements). */
  moveControls?: CheckoffRowMoveControls;
  /** Persistent failure from the last progress mutation on this row. */
  rowError?: CheckoffRowError | null;
  onRetry?: () => void;
  /** Provenance for a corrected row, shown in the Completed view. */
  correctionNote?: string;
  onIncrement: (part: ReviewPart) => void;
  onDecrement: (part: ReviewPart) => void;
  onPreview: (part: ReviewPart) => void;
  /** Called when user clicks Claim on a suggested printer. */
  onClaim?: (suggestion: SuggestedPrinterClaim) => void;
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

/** Text state for the row. Never rely on the colour alone. */
function unitStateLabel(printed: number, quantity: number): string {
  if (quantity <= 0) return "No units required";
  if (printed <= 0) return `0 of ${quantity} printed`;
  if (printed >= quantity) return `Complete, ${printed} of ${quantity} printed`;
  return `${printed} of ${quantity} printed`;
}

/**
 * One Required part on the Checkoff worklist.
 *
 * The phone layout leads with what the operator holds: the part image, the
 * filename, the current state in words, and one large primary action. Rare
 * actions (take a unit back off, reorder, preview) move into a menu, so the
 * row stays usable one-handed beside a running printer.
 *
 * Memoised so checking off one unit only re-renders the affected row.
 */
const ProgressPartRow = memo(function ProgressPartRow({
  part,
  busy,
  compact = false,
  printingOn,
  awaitingVerify,
  suggestedPrinter,
  assemblyTrackingEnabled,
  moveControls,
  rowError,
  onRetry,
  correctionNote,
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
  const stateLabel = unitStateLabel(part.printed_count, qty);

  const menuActions: CheckoffRowAction[] = [
    {
      id: "decrement",
      label: "Take one off the printed count",
      disabled: busy || !canDec,
      onSelect: () => onDecrement(part),
    },
    {
      id: "preview",
      label: "Preview the 3D model",
      onSelect: () => onPreview(part),
    },
  ];

  const handle = dragHandle ? (
    <SortableDragHandle
      attributes={dragHandle.attributes}
      listeners={dragHandle.listeners}
      disabled={dragHandle.disabled || busy}
      label={`Reorder ${part.filename}`}
      className="size-7"
    />
  ) : null;

  const errorNotice =
    rowError && onRetry ? (
      <CheckoffRowErrorNotice error={rowError} onRetry={onRetry} busy={busy} />
    ) : null;

  if (compact) {
    return (
      <article
        className={cn(
          "flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3 shadow-sm",
          tone === "done" && "border-success/40 bg-success/5",
          awaitingVerify && "border-success/30 bg-success-soft",
          rowError && "border-destructive/50",
        )}
      >
        {/* Filename first: it is what the operator reads off the part. */}
        <span
          className="truncate font-mono text-sm text-foreground"
          title={part.relative_path || part.filename}
        >
          {part.filename}
        </span>
        <div className="flex items-center gap-2">
          <PartThumbExpandButton part={part} sizePx={52} onExpand={onPreview} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2">
              {part.filament_hex ? (
                <span
                  className="size-2.5 shrink-0 rounded-sm border border-black/15"
                  style={{ background: part.filament_hex }}
                  title={part.filament_display || undefined}
                />
              ) : null}
              <span className={cn("text-xs font-medium tabular-nums", toneCountClass[tone])}>
                {stateLabel}
              </span>
            </span>
            <StatusBadges
              inCompact
              printingOn={printingOn}
              awaitingVerify={awaitingVerify}
              suggestedPrinter={suggestedPrinter}
              busy={busy}
              onClaim={onClaim}
            />
          </div>
          <Button
            type="button"
            className="h-12 min-w-[4.5rem] shrink-0 gap-1 rounded-[10px] px-3 text-sm"
            disabled={busy || !canInc}
            aria-label={`Mark one ${part.filename} printed. ${stateLabel}`}
            onClick={() => onIncrement(part)}
          >
            <Plus className="size-5" aria-hidden />
            Printed
          </Button>
          <CheckoffRowActionsMenu
            large
            rowLabel={part.filename}
            move={moveControls}
            actions={menuActions}
            disabled={busy}
          />
        </div>
        {correctionNote ? (
          <p className="text-micro text-muted-foreground">{correctionNote}</p>
        ) : null}
        {assemblyTrackingEnabled && onToggleAssembled && (
          <AssembledToggles part={part} busy={busy} onToggleAssembled={onToggleAssembled} />
        )}
        {errorNotice}
      </article>
    );
  }

  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm",
        tone === "done" && "border-success/40 bg-success/5",
        awaitingVerify && "border-success/30 bg-success-soft",
        rowError && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-3">
        {handle}
        {moveControls ? (
          <CheckoffRowMoveButtons
            rowLabel={part.filename}
            move={moveControls}
            disabled={busy}
          />
        ) : null}
        <PartThumbExpandButton part={part} sizePx={72} onExpand={onPreview} />
        <div className="flex w-[min(100%,20rem)] min-w-0 flex-col gap-0.5 self-center">
          <span
            className="truncate font-mono text-xs"
            title={part.relative_path || part.filename}
          >
            {part.filename}
          </span>
          <span className="truncate text-micro text-muted-foreground">{sourceLine(part)}</span>
          <StatusBadges
            inCompact={false}
            printingOn={printingOn}
            awaitingVerify={awaitingVerify}
            suggestedPrinter={suggestedPrinter}
            busy={busy}
            onClaim={onClaim}
          />
          {correctionNote ? (
            <span className="text-micro text-muted-foreground">{correctionNote}</span>
          ) : null}
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
            className="size-9 rounded-md"
            disabled={busy || !canDec}
            aria-label={`Take one off the printed count for ${part.filename}`}
            onClick={() => onDecrement(part)}
          >
            <Minus className="size-4" aria-hidden />
          </Button>
          <span
            className={cn(
              "w-[3.25rem] text-center font-mono text-sm font-medium tabular-nums",
              toneCountClass[tone],
            )}
          >
            {countLabel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9 rounded-md border-primary bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
            disabled={busy || !canInc}
            aria-label={`Mark one ${part.filename} printed. ${stateLabel}`}
            onClick={() => onIncrement(part)}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
          <CheckoffRowActionsMenu
            rowLabel={part.filename}
            move={moveControls}
            actions={menuActions}
            disabled={busy}
          />
        </div>
      </div>
      {errorNotice}
    </article>
  );
});

export default ProgressPartRow;
