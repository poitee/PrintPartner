import type { SourceSummary } from "@print-partner/contracts";
import { MoreHorizontal } from "lucide-react";
import type { LibraryCardMeta } from "../../lib/librarySourceMeta";
import { librarySourceDragId } from "../../lib/sourceCategoryDnD";
import { sourceCategoryLabel } from "../../lib/sourceCategoryAssignment";
import { sourceCanUpload } from "../../lib/sourceImportModel";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import SourceCategoryAssignSubmenu from "./SourceCategoryAssignSubmenu";
import { kindLabel } from "./sourceLabels";

export type SourceSelectModifiers = {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
};

type Props = {
  source: SourceSummary;
  meta: LibraryCardMeta;
  categories: string[];
  busy: boolean;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onSync?: () => void;
  onUpload?: () => void;
  onDelete: () => void;
  onAssignCategory: (category: string | null) => void;
  onSelectClick: (mods: SourceSelectModifiers) => void;
};

export default function LibrarySourceRow({
  source,
  meta,
  categories,
  busy,
  selected,
  onOpen,
  onEdit,
  onSync,
  onUpload,
  onDelete,
  onAssignCategory,
  onSelectClick,
}: Props) {
  return (
    <div
      draggable={!busy}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", librarySourceDragId(source.id));
        event.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center",
        meta.borderTone === "update" && "border-warning/30",
        meta.borderTone === "syncing" && "border-info/30",
        selected && "ring-2 ring-primary border-primary/60",
        !busy && "cursor-grab active:cursor-grabbing",
      )}
      title="Drag onto a category"
    >
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-primary"
        checked={selected}
        aria-label={`Select ${source.name}`}
        onChange={() => {}}
        onClick={(event) => {
          event.stopPropagation();
          onSelectClick({
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
          });
        }}
      />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={(event) => {
          if (event.shiftKey || event.metaKey || event.ctrlKey) {
            onSelectClick({
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
            });
            return;
          }
          onOpen();
        }}
      >
        <p className="font-medium">{source.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{meta.slug}</p>
        <p className="truncate text-xs text-muted-foreground">
          {sourceCategoryLabel(source.category)}
        </p>
      </button>
      <span className="text-xs text-muted-foreground">{meta.stateLabel}</span>
      <span className="font-mono text-xs font-medium tabular-nums">{meta.pickLabel}</span>
      <Badge variant="muted">{kindLabel(source.source_kind)}</Badge>

      <Button size="sm" variant="secondary" onClick={onOpen}>
        Open
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={`Source actions for ${source.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
          <SourceCategoryAssignSubmenu
            categories={categories}
            current={source.category}
            onAssign={onAssignCategory}
            disabled={busy}
          />
          {sourceCanUpload(source) && onUpload && (
            <DropdownMenuItem onClick={onUpload}>Upload files…</DropdownMenuItem>
          )}
          {source.source_kind === "github" && onSync && (
            <DropdownMenuItem onClick={onSync} disabled={busy}>
              Sync
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete}>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
