import { useCallback, useMemo, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { SuggestedPrinterClaim } from "../../lib/checkoffPrinterActivity";
import type { CheckoffCorrectionRecord } from "../../lib/checkoffConsoleCorrection";
import { formatCheckoffCorrection } from "../../lib/checkoffConsoleCorrection";
import {
  canMoveCheckoffRow,
  describeCheckoffRowPosition,
  moveCheckoffRow,
} from "../../lib/checkoffConsoleReorder";
import {
  getCheckoffRowError,
  checkoffRowErrorKey,
  type CheckoffRowErrors,
} from "../../lib/checkoffConsoleRowErrors";
import { isProgressRowBusy } from "../../lib/checkoffProgress";
import { moveItemById } from "../../lib/reorderList";
import {
  progressRowSortableId,
  type ProgressRowRef,
} from "../../lib/progressListOrder";
import SortableProgressPart from "./SortableProgressPart";
import type { CheckoffMoveTarget } from "./CheckoffMoveToDialog";

type Props = {
  /** Rows the operator can currently see, in display order. */
  rows: ProgressRowRef[];
  partsById: Map<number, ReviewPart>;
  mobile: boolean;
  busyPartId: number | null;
  toggleBusy: boolean;
  assemblyTrackingEnabled: boolean;
  printingPartIds: Map<number, string>;
  awaitingPartIds: Map<number, string>;
  suggestedPartIds: Map<number, SuggestedPrinterClaim>;
  rowErrors: CheckoffRowErrors;
  correctionsByPart: Map<number, CheckoffCorrectionRecord>;
  /** Reordering is allowed only where the whole list is visible and mutable. */
  reorderable: boolean;
  emptyState: ReactNode;
  onReorder: (nextRows: ProgressRowRef[]) => void;
  onMoveTo: (target: CheckoffMoveTarget) => void;
  onToggleUnit: (part: ReviewPart, unitIndex: number) => void;
  onIncrement: (part: ReviewPart) => void;
  onDecrement: (part: ReviewPart) => void;
  onPreview: (part: ReviewPart) => void;
  onClaim: (suggestion: SuggestedPrinterClaim) => void;
  onToggleAssembled: (part: ReviewPart, unitIndex: number) => void;
  onRetryRow: (partId: number) => void;
  onBagLabelChange: (bagId: string, label: string) => void;
  onRemoveBagBar: (bagId: string) => void;
};

/**
 * The Checkoff worklist: Required parts interleaved with bag or sort bars.
 *
 * Ordering works three ways — drag, Move up / Move down, and Move to position.
 * The last two are the accessible path, so no operator depends on a drag.
 */
export default function CheckoffWorklist({
  rows,
  partsById,
  mobile,
  busyPartId,
  toggleBusy,
  assemblyTrackingEnabled,
  printingPartIds,
  awaitingPartIds,
  suggestedPartIds,
  rowErrors,
  correctionsByPart,
  reorderable,
  emptyState,
  onReorder,
  onMoveTo,
  onToggleUnit,
  onIncrement,
  onDecrement,
  onPreview,
  onClaim,
  onToggleAssembled,
  onRetryRow,
  onBagLabelChange,
  onRemoveBagBar,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const ids = rows.map(progressRowSortableId);
      const movedIds = moveItemById(ids, String(active.id), String(over.id));
      if (movedIds === ids) return;
      const byId = new Map(rows.map((row) => [progressRowSortableId(row), row]));
      onReorder(
        movedIds
          .map((id) => byId.get(id))
          .filter((row): row is ProgressRowRef => row != null),
      );
    },
    [onReorder, rows],
  );

  const sortableIds = useMemo(() => rows.map(progressRowSortableId), [rows]);

  if (rows.length === 0) return <>{emptyState}</>;

  const moveControlsFor = (sortableId: string, label: string, index: number) => {
    if (!reorderable) return undefined;
    return {
      positionLabel: describeCheckoffRowPosition(index, rows.length),
      canMoveUp: canMoveCheckoffRow(rows, sortableId, "up"),
      canMoveDown: canMoveCheckoffRow(rows, sortableId, "down"),
      onMoveUp: () => onReorder(moveCheckoffRow(rows, sortableId, "up")),
      onMoveDown: () => onReorder(moveCheckoffRow(rows, sortableId, "down")),
      onMoveTo: () => onMoveTo({ sortableId, label, index, total: rows.length }),
    };
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="no-print flex flex-col gap-2" aria-label="Checkoff worklist">
          {rows.map((row, index) => {
            const sortableId = progressRowSortableId(row);
            if (row.kind === "bag") {
              return (
                <SortableProgressPart
                  key={sortableId}
                  kind="bag"
                  bagId={row.id}
                  label={row.label}
                  mobile={mobile}
                  busy={toggleBusy}
                  disabled={toggleBusy}
                  moveControls={moveControlsFor(
                    sortableId,
                    row.label.trim() || "bag bar",
                    index,
                  )}
                  onLabelChange={(label) => onBagLabelChange(row.id, label)}
                  onRemove={() => onRemoveBagBar(row.id)}
                />
              );
            }
            const part = partsById.get(row.id);
            if (!part) return null;
            const correction = correctionsByPart.get(part.id);
            return (
              <SortableProgressPart
                key={sortableId}
                kind="part"
                part={part}
                mobile={mobile}
                busy={isProgressRowBusy(busyPartId, part.id)}
                disabled={toggleBusy}
                printingOn={printingPartIds.get(part.id)}
                awaitingVerify={awaitingPartIds.get(part.id)}
                suggestedPrinter={suggestedPartIds.get(part.id)}
                assemblyTrackingEnabled={assemblyTrackingEnabled}
                moveControls={moveControlsFor(sortableId, part.filename, index)}
                rowError={getCheckoffRowError(rowErrors, checkoffRowErrorKey(part.id))}
                onRetry={() => onRetryRow(part.id)}
                correctionNote={correction ? formatCheckoffCorrection(correction) : undefined}
                onToggleUnit={onToggleUnit}
                onIncrement={onIncrement}
                onDecrement={onDecrement}
                onPreview={onPreview}
                onToggleAssembled={onToggleAssembled}
                onClaim={onClaim}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
