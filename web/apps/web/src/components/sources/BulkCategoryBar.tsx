import { X } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { UNCategorized_FILTER } from "./sourceLabels";
import { selectionSummaryLabel } from "../../lib/sourceSelection";

type Props = {
  count: number;
  categories: string[];
  busy?: boolean;
  onAssign: (category: string | null) => void;
  onSelectAll: () => void;
  allSelected: boolean;
  onClear: () => void;
};

/**
 * Sticky action bar shown when one or more Library sources are selected.
 * Lets the user assign the whole selection to a category in one action
 * instead of repeating the single-item "Category" submenu per card.
 */
export default function BulkCategoryBar({
  count,
  categories,
  busy,
  onAssign,
  onSelectAll,
  allSelected,
  onClear,
}: Props) {
  if (count === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label="Bulk source actions"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
    >
      <span className="text-sm font-medium text-foreground">
        {selectionSummaryLabel(count)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7"
        onClick={onSelectAll}
        disabled={allSelected}
      >
        Select all
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="secondary" className="h-7" disabled={busy}>
            Assign category…
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuItem onClick={() => onAssign(null)}>Uncategorized</DropdownMenuItem>
          {categories
            .filter((name) => name.trim() && name.trim() !== UNCategorized_FILTER)
            .map((name) => (
              <DropdownMenuItem key={name} onClick={() => onAssign(name)}>
                {name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto h-7 gap-1"
        onClick={onClear}
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </Button>
    </div>
  );
}
