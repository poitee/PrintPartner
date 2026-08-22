import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { SortableDragHandle } from "../dnd/SortableDragHandle";
import { cn } from "../../lib/utils";

type Props = {
  label: string;
  busy?: boolean;
  compact?: boolean;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    disabled?: boolean;
  };
};

/**
 * Quiet free-text bag/sort bar on Progress remaining list.
 * This-plan labeling only — not shop stock bins.
 */
export default function ProgressBagBarRow({
  label,
  busy = false,
  compact = false,
  onLabelChange,
  onRemove,
  dragHandle,
}: Props) {
  const handle = dragHandle ? (
    <SortableDragHandle
      attributes={dragHandle.attributes}
      listeners={dragHandle.listeners}
      disabled={dragHandle.disabled || busy}
      label={`Reorder ${label.trim() || "bag bar"}`}
      className={compact ? "size-10" : "size-7"}
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
      <input
        type="text"
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent font-medium text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0",
          compact ? "text-sm" : "text-[13px]",
        )}
        value={label}
        placeholder="Bag 1"
        aria-label="Bag or sort label"
        disabled={busy}
        onChange={(e) => onLabelChange(e.target.value)}
      />
      <button
        type="button"
        className="shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={busy}
        aria-label="Remove bag bar"
        onClick={onRemove}
      >
        Remove
      </button>
    </article>
  );
}
