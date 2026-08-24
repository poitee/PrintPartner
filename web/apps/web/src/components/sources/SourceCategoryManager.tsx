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
import {
  useSaveSourceCategoriesMutation,
  useSourceCategoriesQuery,
} from "../../queries/sourceCategories";
import { moveItem } from "../../lib/reorderList";
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

type DraftCategory = {
  id: string;
  originalName: string | null;
  name: string;
};

type SortableRowProps = {
  id: string;
  name: string;
  index: number;
  disabled: boolean;
  canRemove: boolean;
  onRename: (index: number, value: string) => void;
  onRemove: (index: number) => void;
};

function SortableCategoryRow({
  id,
  name,
  index,
  disabled,
  canRemove,
  onRename,
  onRemove,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
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
        label={`Reorder category ${name || index + 1}`}
      />
      <Input
        value={name}
        onChange={(e) => onRename(index, e.target.value)}
        disabled={disabled}
        aria-label={`Category ${index + 1}`}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !canRemove}
        onClick={() => onRemove(index)}
      >
        Remove
      </Button>
    </li>
  );
}

const EMPTY_CATEGORIES: string[] = [];

function sameCategories(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function categoryRows(categories: readonly string[]): DraftCategory[] {
  return categories.map((name, index) => ({
    id: `saved-${index}`,
    originalName: name,
    name,
  }));
}

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
    const draftNames = draft.map((category) => category.name);
    if (sameCategories(draftNames, categories)) {
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

  const dirty = !sameCategories(
    draft.map((category) => category.name),
    categories,
  );

  const onAdd = () => {
    const name = newName.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (draft.some((category) => category.name.toLowerCase() === key)) {
      setLoadError("That category already exists.");
      return;
    }
    draftDirtyRef.current = true;
    setDraft((prev) => [
      ...prev,
      { id: `new-${nextRowIdRef.current++}`, originalName: null, name },
    ]);
    setNewName("");
    setLoadError(null);
  };

  const onRename = (index: number, value: string) => {
    draftDirtyRef.current = true;
    setDraft((prev) =>
      prev.map((category, i) =>
        i === index ? { ...category, name: value } : category,
      ),
    );
  };

  const onRemove = (index: number) => {
    if (draft.length <= 1) {
      setLoadError("Keep at least one category.");
      return;
    }
    draftDirtyRef.current = true;
    setDraft((prev) => prev.filter((_, i) => i !== index));
    setLoadError(null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = draft.findIndex((category) => category.id === active.id);
    const newIndex = draft.findIndex((category) => category.id === over.id);
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
      const normalizedRows = draft.map((category) => ({
        ...category,
        name: category.name.trim(),
      }));
      if (normalizedRows.length === 0) {
        setLoadError("At least one category is required.");
        return;
      }
      if (normalizedRows.some((category) => !category.name)) {
        setLoadError("Category names cannot be empty.");
        return;
      }
      const normalized = normalizedRows.map((category) => category.name);
      if (new Set(normalized.map((name) => name.toLowerCase())).size !== normalized.length) {
        setLoadError("Category names must be unique.");
        return;
      }
      const replacements: Record<string, string | null> = {};
      const retainedOriginals = new Set<string>();
      for (const category of normalizedRows) {
        if (category.originalName === null) continue;
        retainedOriginals.add(category.originalName);
        if (category.name !== category.originalName) {
          replacements[category.originalName] = category.name;
        }
      }
      for (const originalName of baselineRef.current) {
        if (!retainedOriginals.has(originalName)) replacements[originalName] = null;
      }
      const saved = await saveCategoriesMutation.mutateAsync({
        categories: normalized,
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

  const sortableIds = draft.map((category) => category.id);

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle level={3} className="text-base">Source categories</CardTitle>
        <CardDescription>
          Organize your library. Drag to reorder (flat list — nesting is not
          supported). Plans still use base vs addon layers separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {visibleError && <p className="text-sm text-destructive">{visibleError}</p>}
        {saveNote && <p className="text-sm text-muted-foreground">{saveNote}</p>}
        {!engineReady ? (
          <p className="text-sm text-muted-foreground">Waiting for engine…</p>
        ) : categoriesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading categories…</p>
        ) : draft.length === 0 ? (
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
                {draft.map((category, index) => (
                  <SortableCategoryRow
                    key={category.id}
                    id={category.id}
                    name={category.name}
                    index={index}
                    disabled={!engineReady || saving}
                    canRemove={draft.length > 1}
                    onRename={onRename}
                    onRemove={onRemove}
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
              placeholder="e.g. Extruders"
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
