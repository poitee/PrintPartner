import { cn } from "../../lib/utils";

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
        "flex w-full items-center gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-left transition-colors hover:bg-amber-500/15",
        className,
      )}
    >
      <span
        className="h-2 w-2 shrink-0 rotate-45 bg-amber-600 dark:bg-amber-400"
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-[12.5px] text-amber-900 dark:text-amber-100">
        <strong className="font-semibold">
          {staleCount} source{staleCount === 1 ? "" : "s"} moved upstream.
        </strong>
        {detail}
      </span>
      <span className="shrink-0 text-xs font-semibold text-amber-700 dark:text-amber-300">
        See what changed
      </span>
    </button>
  );
}
