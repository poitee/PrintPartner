import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  PLAN_CONFLICT_HINT,
} from "../lib/mergeConflictCopy";

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
    <Alert tone="warning" className={className}>
      <AlertTriangle aria-hidden />
      <AlertTitle>
        Duplicate part names ({conflictCount} conflict{conflictCount === 1 ? "" : "s"})
      </AlertTitle>
      <AlertDescription>
        <p>{PLAN_CONFLICT_HINT}</p>
        {showGroups && (
          <ul className="mt-1 space-y-0.5 text-xs">
            {groups.map(([filename, count]) => (
              <li key={filename}>
                <span className="font-mono">{filename}</span>
                {" — "}
                {count} variant{count === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
