import { statusTone } from "@/lib/statusTone";
import { cn } from "@/lib/utils";

type Props = {
  staleCount: number;
  attachedStaleCount?: number;
  onSeeChanges: () => void;
  className?: string;
};

/** Banner when upstream GitHub sources have moved since last sync. */
export default function LibraryStaleBanner({
  staleCount,
  attachedStaleCount = 0,
  onSeeChanges,
  className,
}: Props) {
  if (staleCount <= 0) return null;

  const detail =
    attachedStaleCount > 0
      ? ` ${attachedStaleCount} of them ${attachedStaleCount === 1 ? "is" : "are"} in your plan.`
      : " Your plan may still use older files.";

  return (
    <button
      type="button"
      onClick={onSeeChanges}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-warning/20",
        statusTone({ tone: "warning", emphasis: "surface" }),
        className,
      )}
    >
      <span
        className="h-2 w-2 shrink-0 rotate-45 bg-warning"
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-xs text-warning">
        <strong className="font-semibold">
          {staleCount} source{staleCount === 1 ? "" : "s"} moved upstream.
        </strong>
        {detail}
      </span>
      <span className="shrink-0 text-xs font-semibold text-warning">
        See what changed
      </span>
    </button>
  );
}
