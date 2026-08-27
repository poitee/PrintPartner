import { useEffect, useRef, useState } from "react";
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
import { CATEGORY_PATH_SEPARATOR, MAX_CATEGORY_DEPTH } from "@print-partner/contracts";
import {
  useSaveSourceCategoriesMutation,
  useSourceCategoriesQuery,
} from "../../queries/sourceCategories";
import { moveItem } from "../../lib/reorderList";
import {
  categoryRows,
  descendantIds,
  draftPaths,
  orderedRows,
  rowDepth,
  rowPath,
  sameCategories,
  type DraftCategory,
} from "../../lib/sourceCategoryDraftModel";
import { cn } from "@/lib/utils";
import { SortableDragHandle } from "../dnd/SortableDragHandle";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type Props = {
  engineReady: boolean;
};


type SortableRowProps = {
  row: DraftCategory;
  depth: number;
  index: number;
  disabled: boolean;
  canRemove: boolean;
  canNest: boolean;
  onRename: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  onAddChild: (id: string) => void;
};

function SortableCategoryRow({
  row,
  depth,
  index,
  disabled,
  canRemove,
  canNest,
  onRename,
  onRemove,
  onAddChild,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(depth > 0 ? { marginLeft: `${depth * 1.25}rem` } : {}),
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded-md border border-transparent bg-background px-0.5 py-0.5",
        isDragging && "z-10 opacity-90 shadow-md ring-1 ring-border",
      )}
    >
      <SortableDragHandle
        attributes={attributes}
        listeners={listeners}
        disabled={disabled}
        label={`Reorder category ${row.name || index + 1}`}
      />
      <Input
        value={row.name}
        onChange={(e) => onRename(row.id, e.target.value)}
        disabled={disabled}
        aria-label={depth > 0 ? `Subcategory ${index + 1}` : `Category ${index + 1}`}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !canNest}
        onClick={() => onAddChild(row.id)}
        aria-label={`Add subcategory under ${row.name || `category ${index + 1}`}`}
      >
        Add sub
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !canRemove}
        onClick={() => onRemove(row.id)}
      >
        Remove
      </Button>
    </li>
  );
}

const EMPTY_CATEGORIES: string[] = [];

export default function SourceCategoryManager({ engineReady }: Props) {
  const categoriesQuery = useSourceCategoriesQuery(engineReady);
  const saveCategoriesMutation = useSaveSourceCategoriesMutation();
  const categories = categoriesQuery.data ?? EMPTY_CATEGORIES;
  const [draft, setDraft] = useState<DraftCategory[]>(() => categoryRows(categories));
  const baselineRef = useRef<string[]>(categories);
  const nextRowIdRef = useRef(0);
  const draftDirtyRef = useRef(false);
  const [newName, setNewName] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (sameCategories(draftPaths(draft), categories)) {
      draftDirtyRef.current = false;
      baselineRef.current = categories;
      return;
    }
    if (!draftDirtyRef.current) {
      baselineRef.current = categories;
      setDraft(categoryRows(categories));
    }
  }, [categories, draft]);

  const queryError =
    categoriesQuery.error instanceof Error
      ? categoriesQuery.error.message
      : categoriesQuery.error
        ? String(categoriesQuery.error)
        : null;
  const visibleError = loadError ?? queryError;

  const dirty = !sameCategories(draftPaths(draft), categories);

  const addRow = (parentId: string | null, name: string) => {
    draftDirtyRef.current = true;
    setDraft((prev) => [
      ...prev,
      { id: `new-${nextRowIdRef.current++}`, parentId, originalPath: null, name },
    ]);
    setLoadError(null);
  };

  const onAdd = () => {
    const name = newName.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (draft.some((row) => row.parentId === null && row.name.trim().toLowerCase() === key)) {
      setLoadError("That category already exists.");
      return;
    }
    addRow(null, name);
    setNewName("");
  };

  const onAddChild = (parentId: string) => {
    const parent = draft.find((row) => row.id === parentId);
    if (!parent) return;
    if (rowDepth(draft, parent) + 1 > MAX_CATEGORY_DEPTH) {
      setLoadError(`Categories cannot nest deeper than ${MAX_CATEGORY_DEPTH} levels.`);
      return;
    }
    addRow(parentId, "");
  };

  const onRename = (id: string, value: string) => {
    draftDirtyRef.current = true;
    setDraft((prev) => prev.map((row) => (row.id === id ? { ...row, name: value } : row)));
  };

  const onRemove = (id: string) => {
    const doomed = new Set([id, ...descendantIds(draft, id)]);
    if (draft.length - doomed.size < 1) {
      setLoadError("Keep at least one category.");
      return;
    }
    draftDirtyRef.current = true;
    setDraft((prev) => prev.filter((row) => !doomed.has(row.id)));
    setLoadError(null);
  };

  /** Drag reorders within one parent only; re-parenting is an explicit action. */
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeRow = draft.find((row) => row.id === active.id);
    const overRow = draft.find((row) => row.id === over.id);
    if (!activeRow || !overRow || activeRow.parentId !== overRow.parentId) return;
    const oldIndex = draft.findIndex((row) => row.id === active.id);
    const newIndex = draft.findIndex((row) => row.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    draftDirtyRef.current = true;
    setDraft((prev) => moveItem(prev, oldIndex, newIndex));
    setSaveNote(null);
  };

  const onSave = async () => {
    setSaving(true);
    setSaveNote(null);
    setLoadError(null);
    try {
      const rows = orderedRows(draft);
      if (rows.length === 0) {
        setLoadError("At least one category is required.");
        return;
      }
      if (rows.some((row) => !row.name.trim())) {
        setLoadError("Category names cannot be empty.");
        return;
      }
      if (rows.some((row) => row.name.includes(CATEGORY_PATH_SEPARATOR))) {
        setLoadError(
          `Category names cannot contain “${CATEGORY_PATH_SEPARATOR}” — use Add sub to nest one.`,
        );
        return;
      }
      const paths = rows.map((row) => rowPath(draft, row));
      if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
        setLoadError("Category names must be unique within their parent.");
        return;
      }

      // Only moved rows need a replacement; removals fall back to the surviving
      // parent (or Uncategorised at the top level) server-side.
      const replacements: Record<string, string | null> = {};
      const retainedOriginals = new Set<string>();
      for (const row of rows) {
        if (row.originalPath === null) continue;
        retainedOriginals.add(row.originalPath);
        const path = rowPath(draft, row);
        if (path !== row.originalPath) replacements[row.originalPath] = path;
      }
      for (const originalPath of baselineRef.current) {
        if (retainedOriginals.has(originalPath)) continue;
        // A removed parent's descendants disappear with it; the server moves
        // their sources to whatever survives above them.
        if (!replacements[originalPath]) replacements[originalPath] = null;
      }

      const saved = await saveCategoriesMutation.mutateAsync({
        categories: paths,
        replacements,
      });
      draftDirtyRef.current = false;
      baselineRef.current = saved;
      setDraft(categoryRows(saved));
      setSaveNote("Categories saved.");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const rows = orderedRows(draft);
  const sortableIds = rows.map((row) => row.id);

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle level={3} className="text-base">Source categories</CardTitle>
        <CardDescription>
          Organize your library. Use “Add sub” to nest a subcategory under a
          category — “Printers” with “Frame” and “Toolhead” beneath it.
          Drag to reorder within the same parent. Plans still use base vs addon
          layers separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {visibleError && <p className="text-sm text-destructive">{visibleError}</p>}
        {saveNote && <p className="text-sm text-muted-foreground">{saveNote}</p>}
        {!engineReady ? (
          <p className="text-sm text-muted-foreground">Waiting for engine…</p>
        ) : categoriesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading categories…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {visibleError ? "Could not load categories." : "No categories yet. Add one below."}
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2" aria-label="Reorderable source categories">
                {rows.map((row, index) => (
                  <SortableCategoryRow
                    key={row.id}
                    row={row}
                    depth={rowDepth(draft, row)}
                    index={index}
                    disabled={!engineReady || saving}
                    canRemove={rows.length > 1}
                    canNest={rowDepth(draft, row) + 1 <= MAX_CATEGORY_DEPTH}
                    onRename={onRename}
                    onRemove={onRemove}
                    onAddChild={onAddChild}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Label htmlFor="new-source-category" className="text-xs text-muted-foreground">
              Add category
            </Label>
            <Input
              id="new-source-category"
              placeholder="e.g. Printers"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAdd();
                }
              }}
              disabled={!engineReady || saving}
            />
          </div>
          <Button type="button" variant="secondary" onClick={onAdd} disabled={!engineReady || saving}>
            Add
          </Button>
        </div>
        <Button onClick={() => void onSave()} disabled={!engineReady || saving || !dirty}>
          {saving ? "Saving…" : "Save categories"}
        </Button>
      </CardContent>
    </Card>
  );
}
