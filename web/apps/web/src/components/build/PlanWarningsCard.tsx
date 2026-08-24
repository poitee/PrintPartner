import { cn } from "@/lib/utils";

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
        "flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-soft p-3.5",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 shrink-0 rotate-45 bg-warning"
          aria-hidden
        />
        <span className="text-xs font-semibold text-warning">
          Rebuild plan
        </span>
      </div>
      <ul className="space-y-1.5">
        {warnings.map((line, idx) => (
          <li
            key={`${idx}-${line}`}
            className="flex items-baseline gap-1.5 text-xs leading-snug text-warning"
          >
            <span
              className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-warning"
              aria-hidden
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
