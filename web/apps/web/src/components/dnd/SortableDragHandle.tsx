import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";

type Props = {
  listeners?: DraggableSyntheticListeners;
  attributes?: DraggableAttributes;
  disabled?: boolean;
  label: string;
  className?: string;
};

/** Accessible drag handle used by category and Progress sortable rows. */
export function SortableDragHandle({
  listeners,
  attributes,
  disabled,
  label,
  className,
}: Props) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-8 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground",
        "hover:bg-accent/70 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
      aria-label={label}
      disabled={disabled}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
}

type SortableShellProps = {
  style?: CSSProperties;
  isDragging?: boolean;
  className?: string;
  children: ReactNode;
};

export function SortableShell({
  style,
  isDragging,
  className,
  children,
}: SortableShellProps) {
  return (
    <div
      style={style}
      className={cn(
        isDragging && "z-10 opacity-90 shadow-md ring-1 ring-border",
        className,
      )}
    >
      {children}
    </div>
  );
}
