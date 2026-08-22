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
import { cn } from "../../lib/utils";
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

export default function SourceCategoryManager({ engineReady }: Props) {
  const categoriesQuery = useSourceCategoriesQuery(engineReady);
  const saveCategoriesMutation = useSaveSourceCategoriesMutation();
  const categories = categoriesQuery.data ?? EMPTY_CATEGORIES;
  const [draft, setDraft] = useState<string[]>(() => categories);
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
    if (sameCategories(draft, categories)) draftDirtyRef.current = false;
    if (!draftDirtyRef.current) setDraft(categories);
  }, [categories, draft]);

  const queryError =
    categoriesQuery.error instanceof Error
      ? categoriesQuery.error.message
      : categoriesQuery.error
        ? String(categoriesQuery.error)
        : null;
  const visibleError = loadError ?? queryError;

  const dirty = !sameCategories(draft, categories);

  const onAdd = () => {
    const name = newName.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (draft.some((c) => c.toLowerCase() === key)) {
      setLoadError("That category already exists.");
      return;
    }
    draftDirtyRef.current = true;
    setDraft((prev) => [...prev, name]);
    setNewName("");
    setLoadError(null);
  };

  const onRename = (index: number, value: string) => {
    draftDirtyRef.current = true;
    setDraft((prev) => prev.map((c, i) => (i === index ? value : c)));
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
    const oldIndex = Number(String(active.id).replace(/^cat-/, ""));
    const newIndex = Number(String(over.id).replace(/^cat-/, ""));
    if (!Number.isFinite(oldIndex) || !Number.isFinite(newIndex)) return;
    draftDirtyRef.current = true;
    setDraft((prev) => moveItem(prev, oldIndex, newIndex));
    setSaveNote(null);
  };

  const onSave = async () => {
    setSaving(true);
    setSaveNote(null);
    setLoadError(null);
    try {
      const normalized = draft.map((c) => c.trim()).filter(Boolean);
      if (normalized.length === 0) {
        setLoadError("At least one category is required.");
        return;
      }
      const saved = await saveCategoriesMutation.mutateAsync(normalized);
      draftDirtyRef.current = false;
      setDraft(saved);
      setSaveNote("Categories saved.");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Index-based ids stay stable through mid-edit renames (names may collide briefly).
  const sortableIds = draft.map((_, index) => `cat-${index}`);

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
                {draft.map((name, index) => (
                  <SortableCategoryRow
                    key={sortableIds[index]}
                    id={sortableIds[index]!}
                    name={name}
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
