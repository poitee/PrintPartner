import { ArrowDown, ArrowUp } from "lucide-react";
import type { CheckoffRowMoveControls } from "./CheckoffRowActionsMenu";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  rowLabel: string;
  move: CheckoffRowMoveControls;
  disabled?: boolean;
  large?: boolean;
  className?: string;
};

/**
 * Visible Move up / Move down pair. The pointer alternative to dragging is a
 * control the operator can see, not a hidden shortcut.
 */
export default function CheckoffRowMoveButtons({
  rowLabel,
  move,
  disabled = false,
  large = false,
  className,
}: Props) {
  const size = large ? "size-11 rounded-[10px]" : "size-7 rounded-md";
  const icon = large ? "size-5" : "size-3.5";
  return (
    <div className={cn("flex shrink-0 flex-col gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={size}
        disabled={disabled || !move.canMoveUp}
        aria-label={`Move ${rowLabel} up. ${move.positionLabel}`}
        onClick={move.onMoveUp}
      >
        <ArrowUp className={icon} aria-hidden />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={size}
        disabled={disabled || !move.canMoveDown}
        aria-label={`Move ${rowLabel} down. ${move.positionLabel}`}
        onClick={move.onMoveDown}
      >
        <ArrowDown className={icon} aria-hidden />
      </Button>
    </div>
  );
}
