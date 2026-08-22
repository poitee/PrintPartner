import { cn } from "../../lib/utils";

type Props = {
  warnings: string[];
  className?: string;
};

/** Desk-loop Plan warnings (stale / blockers) — short copy. */
export default function PlanWarningsCard({ warnings, className }: Props) {
  if (warnings.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-amber-300/80 bg-amber-50 p-3.5 dark:border-amber-700/50 dark:bg-amber-950/35",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 shrink-0 rotate-45 bg-amber-700 dark:bg-amber-400"
          aria-hidden
        />
        <span className="text-[12.5px] font-semibold text-amber-950 dark:text-amber-100">
          Rebuild plan
        </span>
      </div>
      <ul className="space-y-1.5">
        {warnings.map((line, idx) => (
          <li
            key={`${idx}-${line}`}
            className="flex items-baseline gap-1.5 text-xs leading-snug text-amber-950/90 dark:text-amber-100/90"
          >
            <span
              className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-700 dark:bg-amber-400"
              aria-hidden
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
