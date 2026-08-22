import { MoreHorizontal } from "lucide-react";
import type { SourceSummary } from "../../api/engine";
import SourceCardCover from "../SourceCardCover";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type { LibraryCardMeta } from "../../lib/librarySourceMeta";
import { sourceCategoryLabel } from "../../lib/sourceCategoryAssignment";
import { librarySourceDragId } from "../../lib/sourceCategoryDnD";
import { kindLabel } from "./sourceLabels";
import SourceCategoryAssignSubmenu from "./SourceCategoryAssignSubmenu";

type Props = {
  source: SourceSummary;
  meta: LibraryCardMeta;
  categories: string[];
  busy?: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onSync?: () => void;
  onUpload?: () => void;
  onDelete: () => void;
  onAssignCategory: (category: string | null) => void;
  selected?: boolean;
  onSelectClick?: (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
};

function barClass(tone: LibraryCardMeta["barTone"]): string {
  switch (tone) {
    case "syncing":
      return "bg-sky-500";
    case "update":
      return "bg-amber-500";
    case "local":
      return "bg-emerald-600 dark:bg-emerald-500";
    case "attached":
      return "bg-primary";
    default:
      return "bg-transparent";
  }
}

function borderClass(tone: LibraryCardMeta["borderTone"]): string {
  switch (tone) {
    case "syncing":
      return "border-sky-400/70";
    case "update":
      return "border-amber-500/50";
    default:
      return "border-border";
  }
}

function stateClass(tone: LibraryCardMeta["stateTone"]): string {
  switch (tone) {
    case "warning":
      return "text-amber-700 dark:text-amber-300";
    case "sync":
      return "text-sky-600 dark:text-sky-400";
    case "success":
      return "text-emerald-700 dark:text-emerald-400";
    default:
      return "text-muted-foreground";
  }
}

/** Library grid card: cover, sync/update state, attach progress bar. */
export default function LibrarySourceCard({
  source,
  meta,
  categories,
  busy,
  onOpen,
  onEdit,
  onSync,
  onUpload,
  onDelete,
  onAssignCategory,
  selected = false,
  onSelectClick,
}: Props) {
  return (
    <article
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", librarySourceDragId(source.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "overflow-hidden rounded-lg border bg-card shadow-[0_1px_2px_rgba(89,115,166,0.06)] transition-colors",
        borderClass(meta.borderTone),
        selected && "ring-2 ring-primary border-primary/60",
        !busy && "cursor-grab active:cursor-grabbing",
      )}
      title="Drag onto a category"
    >
      <div className="relative">
        {onSelectClick && (
          <label
            className="absolute left-1.5 top-1.5 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md bg-background/85 shadow-sm backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={selected}
              aria-label={`Select ${source.name}`}
              onChange={() => {}}
              onClick={(e) =>
                onSelectClick({
                  shiftKey: e.shiftKey,
                  metaKey: e.metaKey,
                  ctrlKey: e.ctrlKey,
                })
              }
            />
          </label>
        )}
        <button
          type="button"
          className="block w-full text-left"
          onClick={(e) => {
            if (onSelectClick && (e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSelectClick({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
              return;
            }
            onOpen();
          }}
          aria-label={`Open ${source.name}`}
        >
          <SourceCardCover
            sourceId={source.id}
            name={source.name}
            sourceKind={source.source_kind}
            compact
            hideKindBadge
          />
        </button>
      </div>
      <div className="flex flex-col gap-2 px-2.5 py-2.5">
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={onOpen}
            aria-label={`Open ${source.name} (${meta.slug}, ${sourceCategoryLabel(source.category)})`}
          >
            <span className="block truncate text-[13px] font-semibold tracking-tight">
              {source.name}
            </span>
            <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
              {meta.slug}
            </span>
            <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
              {sourceCategoryLabel(source.category)}
            </span>
          </button>
          <Badge
            variant="muted"
            className="mt-0.5 shrink-0 rounded-full px-1.5 py-0 text-[10px] font-medium"
          >
            {kindLabel(source.source_kind)}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                aria-label="Source actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpen}>Open</DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
              <SourceCategoryAssignSubmenu
                categories={categories}
                current={source.category}
                onAssign={onAssignCategory}
                disabled={busy}
              />
              {onUpload && (
                <DropdownMenuItem onClick={onUpload}>Upload files…</DropdownMenuItem>
              )}
              {onSync && (
                <DropdownMenuItem onClick={onSync} disabled={busy}>
                  Sync
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete}>Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-1.5 border-t border-border/70 pt-2">
          <span className={cn("min-w-0 truncate text-[11.5px]", stateClass(meta.stateTone))}>
            {meta.stateLabel}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] font-medium tabular-nums text-foreground">
            {meta.pickLabel}
          </span>
        </div>

        <div className="h-[3px] overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-[width] duration-300", barClass(meta.barTone))}
            style={{ width: `${meta.barPct}%` }}
          />
        </div>
      </div>
    </article>
  );
}
