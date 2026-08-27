import { ArrowDown, ArrowUp, MoreVertical, MoveVertical } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Non-drag ordering for one worklist row.
 *
 * WCAG 2.2 dragging movements: every drag needs a single-pointer alternative.
 * These callbacks are the alternative, and they work from the keyboard too.
 */
export type CheckoffRowMoveControls = {
  /** "Position 3 of 12" — read out with the move controls. */
  positionLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: () => void;
};

export type CheckoffRowAction = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

type Props = {
  /** Names the row so every control reads uniquely on a screen reader. */
  rowLabel: string;
  move?: CheckoffRowMoveControls;
  actions?: CheckoffRowAction[];
  disabled?: boolean;
  /** Phone rows use a 44 by 44 trigger. */
  large?: boolean;
};

export default function CheckoffRowActionsMenu({
  rowLabel,
  move,
  actions = [],
  disabled = false,
  large = false,
}: Props) {
  if (!move && actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={large ? "size-11 rounded-[10px]" : "size-9 rounded-md"}
          disabled={disabled}
          aria-label={`More actions for ${rowLabel}`}
        >
          <MoreVertical className={large ? "size-5" : "size-4"} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {move ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {move.positionLabel}
            </DropdownMenuLabel>
            <DropdownMenuItem disabled={!move.canMoveUp} onSelect={move.onMoveUp}>
              <ArrowUp className="mr-2 size-4" aria-hidden />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!move.canMoveDown} onSelect={move.onMoveDown}>
              <ArrowDown className="mr-2 size-4" aria-hidden />
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={move.onMoveTo}>
              <MoveVertical className="mr-2 size-4" aria-hidden />
              Move to position
            </DropdownMenuItem>
            {actions.length > 0 ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            onSelect={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
