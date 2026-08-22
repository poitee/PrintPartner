import { AlertTriangle } from "lucide-react";
import {
  PLAN_CONFLICT_HINT,
} from "../lib/mergeConflictCopy";
import { cn } from "../lib/utils";

type Props = {
  conflictCount: number;
  /** Unique filenames with variant counts, e.g. [["widget.stl", 2]] */
  groupedByFilename?: Array<[string, number]>;
  className?: string;
};

export default function MergeConflictBanner({
  conflictCount,
  groupedByFilename,
  className,
}: Props) {
  if (conflictCount === 0) return null;

  const groups = groupedByFilename ?? [];
  const showGroups = groups.length > 0 && groups.length <= 6;

  return (
    <div
      className={cn(
        "flex gap-2 rounded-md border border-warning bg-warning/15 px-3 py-2.5 text-sm",
        className,
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">
          Duplicate part names ({conflictCount} conflict{conflictCount === 1 ? "" : "s"})
        </p>
        <p className="mt-1 text-muted-foreground">{PLAN_CONFLICT_HINT}</p>
        {showGroups && (
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {groups.map(([filename, count]) => (
              <li key={filename}>
                <span className="font-mono text-foreground">{filename}</span>
                {" — "}
                {count} variant{count === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
