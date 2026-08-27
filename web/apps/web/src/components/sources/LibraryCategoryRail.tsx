import { useState } from "react";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight } from "lucide-react";
import { buildSourceCategoryTree } from "@print-partner/contracts";
import { cn } from "@/lib/utils";
import {
  LIBRARY_ADD_ACTIONS,
  buildLibraryCategoryRows,
  categoryRailIndentStyle,
  reorderCategoriesWithinSiblings,
  type LibraryAddKind,
  type LibraryCategoryRow,
} from "../../lib/libraryCategoryRailModel";
import { SortableDragHandle, SortableShell } from "../dnd/SortableDragHandle";
import CategoryDropTarget from "./CategoryDropTarget";

export type { LibraryAddKind } from "../../lib/libraryCategoryRailModel";

type CategoryRow = LibraryCategoryRow;

type Props = {
  /** Flat, ordered category paths ("Printers", "Printers/Frame"). */
  categories: string[];
  sourcesByCategory: Map<string | null, number>;
  totalCount: number;
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  onManageCategories: () => void;
  /** Persist a new order. Categories only move among their own siblings. */
  onCategoriesReorder?: (categories: string[]) => void;
  /** Drop a Library source (or file-from-source) onto this category. */
  onDropSourceCategory?: (sourceId: number, category: string | null) => void;
  onAddSource: (kind: LibraryAddKind) => void;
  className?: string;
};

function CategoryRowBody({
  row,
  active,
  onSelect,
  onToggleCollapsed,
}: {
  row: CategoryRow;
  active: boolean;
  onSelect: () => void;
  onToggleCollapsed?: (path: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center" style={categoryRailIndentStyle(row.depth)}>
      {row.hasChildren && onToggleCollapsed ? (
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-expanded={!row.collapsed}
          aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed(row.name);
          }}
        >
          {row.collapsed ? (
            <ChevronRight className="size-3" aria-hidden />
          ) : (
            <ChevronDown className="size-3" aria-hidden />
          )}
        </button>
      ) : (
        <span className="w-5 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2.5 text-left transition-colors"
      >
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
          style={{ background: row.swatch }}
          aria-hidden
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            active ? "font-semibold" : "font-medium",
          )}
        >
          {row.label}
        </span>
        <span className="ml-auto font-mono text-2xs tabular-nums text-muted-foreground">
          {row.count}
        </span>
      </button>
    </div>
  );
}

function SortableCategoryNavItem({
  row,
  active,
  reorderEnabled,
  onSelect,
  onToggleCollapsed,
  onDropSourceCategory,
}: {
  row: CategoryRow;
  active: boolean;
  reorderEnabled: boolean;
  onSelect: () => void;
  onToggleCollapsed: (path: string) => void;
  onDropSourceCategory?: (sourceId: number, category: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.id, disabled: !reorderEnabled || !row.sortable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <SortableShell style={style} isDragging={isDragging} className="rounded-md">
      <CategoryDropTarget
        category={row.name}
        onDropSource={onDropSourceCategory}
        className="rounded-md"
      >
        <div
          ref={setNodeRef}
          className={cn(
            "flex items-center gap-0.5 rounded-md",
            active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/70",
          )}
        >
          {reorderEnabled ? (
            <SortableDragHandle
              attributes={attributes}
              listeners={listeners}
              label={`Reorder category ${row.name}`}
              className="size-7"
            />
          ) : (
            <span className="w-1.5 shrink-0" aria-hidden />
          )}
          <CategoryRowBody
            row={row}
            active={active}
            onSelect={onSelect}
            onToggleCollapsed={onToggleCollapsed}
          />
        </div>
      </CategoryDropTarget>
    </SortableShell>
  );
}

/** Left Library column: category filters + quick add-source links. */
export default function LibraryCategoryRail({
  categories,
  sourcesByCategory,
  totalCount,
  categoryFilter,
  onCategoryFilterChange,
  onManageCategories,
  onCategoriesReorder,
  onDropSourceCategory,
  onAddSource,
  className,
}: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const tree = buildSourceCategoryTree(categories);
  const rows = buildLibraryCategoryRows(tree, sourcesByCategory, totalCount, collapsed);
  const sortableIds = rows.filter((row) => row.sortable).map((row) => row.id);
  const reorderEnabled = Boolean(onCategoriesReorder) && categories.length > 1;

  const toggleCollapsed = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    if (!onCategoriesReorder) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // Dragging across nesting levels would silently re-parent a category; the
    // category manager is where moves belong.
    const next = reorderCategoriesWithinSiblings(categories, String(active.id), String(over.id));
    if (next) onCategoriesReorder(next);
  };

  const renderStaticRow = (row: CategoryRow, active: boolean) => {
    const dropCategory = row.id === "all" ? undefined : null;
    return (
      <CategoryDropTarget
        key={row.id}
        category={dropCategory}
        onDropSource={onDropSourceCategory}
        className="rounded-md"
      >
        <div
          className={cn(
            "flex items-center gap-0.5 rounded-md pl-2.5",
            active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/70",
          )}
        >
          <CategoryRowBody
            row={row}
            active={active}
            onSelect={() => onCategoryFilterChange(row.id === "all" ? "all" : row.id)}
          />
        </div>
      </CategoryDropTarget>
    );
  };

  const nav = (
    <nav className="flex flex-col gap-px" aria-label="Source categories">
      {rows.map((row) => {
        const active =
          row.id === "all" ? categoryFilter === "all" : categoryFilter === row.id;
        if (!row.sortable) return renderStaticRow(row, active);
        return (
          <SortableCategoryNavItem
            key={row.id}
            row={row}
            active={active}
            reorderEnabled={reorderEnabled}
            onSelect={() => onCategoryFilterChange(row.id)}
            onToggleCollapsed={toggleCollapsed}
            onDropSourceCategory={onDropSourceCategory}
          />
        );
      })}
    </nav>
  );

  return (
    <aside
      className={cn(
        "flex h-full flex-col gap-3.5 border-r border-border bg-card px-3 py-4",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-3xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Categories
        </span>
        <button
          type="button"
          className="ml-auto text-2xs font-semibold text-primary hover:underline"
          onClick={onManageCategories}
        >
          Edit
        </button>
      </div>

      {reorderEnabled ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {nav}
          </SortableContext>
        </DndContext>
      ) : (
        nav
      )}

      <div className="mt-auto border-t border-border pt-3">
        <span className="font-mono text-3xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Add source
        </span>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {LIBRARY_ADD_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              className="rounded-md px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              onClick={() => onAddSource(action.kind)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
