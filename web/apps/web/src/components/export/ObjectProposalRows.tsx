/**
 * Shared proposal row list for Export preview and Progress verify chrome.
 * Preview only — no checkboxes. Unlabeled rows are gray and not confirmable.
 */
import { cn } from "../../lib/utils";
import type { ObjectPreviewRow } from "../../lib/proposeCheckoffFromObjects";

type Props = {
  rows: ObjectPreviewRow[];
  /** When set, matched rows show a live `printing` note (still unticked). */
  printing?: boolean;
  className?: string;
};

export default function ObjectProposalRows({ rows, printing = false, className }: Props) {
  if (!rows.length) return null;
  return (
    <ul className={cn("space-y-1.5", className)} aria-label="Proposed parts">
      {rows.map((row) => {
        if (row.kind === "unlabeled") {
          return (
            <li
              key={`unlabeled:${row.name}`}
              className="flex items-baseline justify-between gap-3 text-sm text-muted-foreground/70"
            >
              <span className="min-w-0 truncate font-mono">{row.name}</span>
              <span className="shrink-0 text-xs">unlabeled</span>
            </li>
          );
        }
        return (
          <li
            key={`part:${row.part_id}`}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono font-medium text-foreground">{row.filename}</span>
              <span className="text-muted-foreground">
                {" · "}
                <span className="font-medium text-foreground">×{row.quantity}</span>
                {" · "}
                {row.remaining} remaining
              </span>
            </span>
            {printing ? (
              <span className="shrink-0 text-xs font-medium text-sky-700 dark:text-sky-300">
                printing
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
