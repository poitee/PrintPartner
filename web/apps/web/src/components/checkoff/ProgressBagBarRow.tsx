import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { SortableDragHandle } from "../dnd/SortableDragHandle";
import CheckoffRowActionsMenu, {
  type CheckoffRowMoveControls,
} from "./CheckoffRowActionsMenu";
import CheckoffRowMoveButtons from "./CheckoffRowMoveButtons";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  busy?: boolean;
  compact?: boolean;
  moveControls?: CheckoffRowMoveControls;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    disabled?: boolean;
  };
};

/**
 * Quiet free-text bag/sort bar on the Checkoff worklist.
 * This-plan labeling only — not shop stock bins.
 */
export default function ProgressBagBarRow({
  label,
  busy = false,
  compact = false,
  moveControls,
  onLabelChange,
  onRemove,
  dragHandle,
}: Props) {
  const rowLabel = label.trim() || "bag bar";
  const handle =
    dragHandle && !compact ? (
      <SortableDragHandle
        attributes={dragHandle.attributes}
        listeners={dragHandle.listeners}
        disabled={dragHandle.disabled || busy}
        label={`Reorder ${rowLabel}`}
        className="size-7"
      />
    ) : null;

  return (
    <article
      className={cn(
        "flex items-center gap-2 border border-dashed border-border/80 bg-muted/20",
        compact ? "rounded-[10px] px-3 py-2.5" : "rounded-lg px-3 py-2",
      )}
    >
      {handle}
      {moveControls && !compact ? (
        <CheckoffRowMoveButtons rowLabel={rowLabel} move={moveControls} disabled={busy} />
      ) : null}
      <input
        type="text"
        className="min-w-0 flex-1 border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0"
        value={label}
        placeholder="Bag 1"
        aria-label="Bag or sort label"
        disabled={busy}
        onChange={(e) => onLabelChange(e.target.value)}
      />
      <CheckoffRowActionsMenu
        large={compact}
        rowLabel={rowLabel}
        move={moveControls}
        actions={[
          {
            id: "remove",
            label: "Remove this bag bar",
            disabled: busy,
            onSelect: onRemove,
          },
        ]}
        disabled={busy}
      />
    </article>
  );
}
