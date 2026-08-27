import { useEffect, useState } from "react";
import {
  checkoffRowPositionOptions,
  describeCheckoffRowPosition,
} from "../../lib/checkoffConsoleReorder";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

export type CheckoffMoveTarget = {
  sortableId: string;
  label: string;
  index: number;
  total: number;
};

type Props = {
  target: CheckoffMoveTarget | null;
  onCancel: () => void;
  onMove: (position: number) => void;
};

/**
 * Exact-position move for the worklist.
 *
 * WCAG 2.2 asks for a single-pointer alternative to dragging. Move up and
 * Move down handle small corrections; this handles "put it at the front"
 * without twenty taps.
 */
export default function CheckoffMoveToDialog({ target, onCancel, onMove }: Props) {
  const [position, setPosition] = useState(1);

  useEffect(() => {
    if (target) setPosition(target.index + 1);
  }, [target]);

  const options = checkoffRowPositionOptions(target?.total ?? 0);

  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-sm" aria-describedby="checkoff-move-current">
        <DialogHeader>
          <DialogTitle>Move {target?.label ?? "this row"}</DialogTitle>
          <p id="checkoff-move-current" className="text-sm text-muted-foreground">
            {target
              ? describeCheckoffRowPosition(target.index, target.total)
              : "Not in the list"}
          </p>
        </DialogHeader>
        <div className="space-y-1">
          <label htmlFor="checkoff-move-position" className="text-sm font-medium">
            New position
          </label>
          <select
            id="checkoff-move-position"
            className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
          <Button type="button" className="min-h-11" onClick={() => onMove(position)}>
            Move
          </Button>
          <Button type="button" variant="ghost" className="min-h-11" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
