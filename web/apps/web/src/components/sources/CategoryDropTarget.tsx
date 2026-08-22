import type { DragEvent, ReactNode } from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import {
  categoryDropTargetId,
  parseLibraryDragPayload,
} from "../../lib/sourceCategoryDnD";

type Props = {
  /** Category name, or null for Uncategorised. Omit for non-droppable (All). */
  category?: string | null;
  onDropSource?: (sourceId: number, category: string | null) => void;
  className?: string;
  children: ReactNode;
};

/** HTML5 drop target for Library/Plan source → category assignment. */
export default function CategoryDropTarget({
  category,
  onDropSource,
  className,
  children,
}: Props) {
  const [over, setOver] = useState(false);
  const enabled = category !== undefined && Boolean(onDropSource);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOver(true);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const raw = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text");
    const payload = parseLibraryDragPayload(raw);
    if (!payload || !onDropSource) return;
    onDropSource(payload.sourceId, category ?? null);
  };

  return (
    <div
      data-cat-drop={categoryDropTargetId(category ?? null)}
      className={cn(className, over && "ring-2 ring-primary/50")}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {children}
    </div>
  );
}
