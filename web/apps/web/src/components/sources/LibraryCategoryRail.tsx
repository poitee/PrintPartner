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
import { cn } from "../../lib/utils";
import { moveItemById } from "../../lib/reorderList";
import { UNCategorized_FILTER } from "./sourceLabels";
import { categorySwatch } from "../../lib/librarySourceMeta";
import type { SourceKind } from "./sourceLabels";
import { SortableDragHandle, SortableShell } from "../dnd/SortableDragHandle";
import CategoryDropTarget from "./CategoryDropTarget";

export type LibraryAddKind =
  | SourceKind
  | "plan_bundle"
  | "repos_txt";

type CategoryRow = {
  id: string;
  name: string;
  count: number;
  swatch: string;
  sortable: boolean;
};

type Props = {
  categories: string[];
  sourcesByCategory: Map<string | null, number>;
  totalCount: number;
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  onManageCategories: () => void;
  /** Persist a new flat category order (API has no nesting / parent grouping). */
  onCategoriesReorder?: (categories: string[]) => void;
  /** Drop a Library source (or file-from-source) onto this category. */
  onDropSourceCategory?: (sourceId: number, category: string | null) => void;
  onAddSource: (kind: LibraryAddKind) => void;
  className?: string;
};

function buildRows(
  categories: string[],
  sourcesByCategory: Map<string | null, number>,
  totalCount: number,
): CategoryRow[] {
  const uncategorized = sourcesByCategory.get(null) ?? 0;
  return [
    {
      id: "all",
      name: "All sources",
      count: totalCount,
      swatch: "var(--primary)",
      sortable: false,
    },
    ...categories.map((name) => ({
      id: name,
      name,
      count: sourcesByCategory.get(name) ?? 0,
      swatch: categorySwatch(name),
      sortable: true,
    })),
    {
      id: UNCategorized_FILTER,
      name: "Uncategorised",
      count: uncategorized,
      swatch: "var(--border)",
      sortable: false,
    },
  ];
}

const ADD_ACTIONS: Array<{ id: string; kind: LibraryAddKind; label: string }> = [
  { id: "github", kind: "github", label: "GitHub repo" },
  { id: "local-folder", kind: "local", label: "Local folder" },
  { id: "archive", kind: "archive", label: "Zip upload" },
  { id: "single-stl", kind: "local", label: "Single STL" },
  { id: "plan-bundle", kind: "plan_bundle", label: "Plan bundle" },
  { id: "self", kind: "self", label: "Another instance" },
];

function SortableCategoryNavItem({
  row,
  active,
  reorderEnabled,
  onSelect,
  onDropSourceCategory,
}: {
  row: CategoryRow;
  active: boolean;
  reorderEnabled: boolean;
  onSelect: () => void;
  onDropSourceCategory?: (sourceId: number, category: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.id, disabled: !reorderEnabled || !row.sortable });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const dropCategory =
    row.id === "all" ? undefined : row.id === UNCategorized_FILTER ? null : row.name;

  return (
    <SortableShell style={style} isDragging={isDragging} className="rounded-md">
      <CategoryDropTarget
        category={dropCategory}
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
          {reorderEnabled && row.sortable ? (
            <SortableDragHandle
              attributes={attributes}
              listeners={listeners}
              label={`Reorder category ${row.name}`}
              className="size-7"
            />
          ) : (
            <span className="w-1.5 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={onSelect}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2.5 text-left transition-colors",
              reorderEnabled && row.sortable ? "pl-0" : "pl-2.5",
            )}
          >
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
              style={{ background: row.swatch }}
              aria-hidden
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12.5px]",
                active ? "font-semibold" : "font-medium",
              )}
            >
              {row.name}
            </span>
            <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {row.count}
            </span>
          </button>
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
  const rows = buildRows(categories, sourcesByCategory, totalCount);
  const sortableIds = categories;
  const reorderEnabled = Boolean(onCategoriesReorder) && categories.length > 1;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    if (!onCategoriesReorder) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = moveItemById(categories, String(active.id), String(over.id));
    if (next === categories) return;
    onCategoriesReorder(next);
  };

  const renderStaticRow = (row: CategoryRow, active: boolean) => {
    const dropCategory =
      row.id === "all" ? undefined : row.id === UNCategorized_FILTER ? null : row.name;
    return (
      <CategoryDropTarget
        key={row.id}
        category={dropCategory}
        onDropSource={onDropSourceCategory}
        className="rounded-md"
      >
        <button
          type="button"
          onClick={() => onCategoryFilterChange(row.id === "all" ? "all" : row.id)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
            active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/70",
          )}
        >
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
            style={{ background: row.swatch }}
            aria-hidden
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12.5px]",
              active ? "font-semibold" : "font-medium",
            )}
          >
            {row.name}
          </span>
          <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {row.count}
          </span>
        </button>
      </CategoryDropTarget>
    );
  };

  const nav = (
    <nav className="flex flex-col gap-px" aria-label="Source categories">
      {rows.map((row) => {
        const active =
          row.id === "all" ? categoryFilter === "all" : categoryFilter === row.id;
        if (!reorderEnabled || !row.sortable) {
          return renderStaticRow(row, active);
        }
        return (
          <SortableCategoryNavItem
            key={row.id}
            row={row}
            active={active}
            reorderEnabled
            onSelect={() => onCategoryFilterChange(row.id)}
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
        <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Categories
        </span>
        <button
          type="button"
          className="ml-auto text-[11.5px] font-semibold text-primary hover:underline"
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
        <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Add source
        </span>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {ADD_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              className="rounded-md px-1 py-1 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
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
