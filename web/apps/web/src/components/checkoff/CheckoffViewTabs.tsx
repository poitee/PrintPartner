import { CHECKOFF_VIEWS, type CheckoffViewCounts, type CheckoffViewId } from "../../lib/checkoffConsoleModel";
import { cn } from "@/lib/utils";

type Props = {
  value: CheckoffViewId;
  counts: CheckoffViewCounts;
  onValueChange: (value: CheckoffViewId) => void;
  className?: string;
};

/**
 * The three Checkoff views. Not a stepper: the operator picks the work in
 * front of them. Each control carries its own count in text, so the state
 * never depends on colour, and every target clears 44 by 44 CSS pixels.
 */
export default function CheckoffViewTabs({
  value,
  counts,
  onValueChange,
  className,
}: Props) {
  return (
    <div
      role="group"
      aria-label="Checkoff views"
      className={cn(
        "grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted p-1",
        className,
      )}
    >
      {CHECKOFF_VIEWS.map((view) => {
        const count = counts[view.id];
        const active = view.id === value;
        return (
          <button
            key={view.id}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(view.id)}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center rounded-md px-2 py-1.5 text-center text-xs font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{view.label}</span>
            <span className="font-mono text-2xs tabular-nums">
              {count}
              <span className="sr-only">
                {" "}
                {count === 1 ? "item" : "items"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
