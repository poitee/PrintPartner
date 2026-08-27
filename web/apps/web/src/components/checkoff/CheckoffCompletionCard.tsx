import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import {
  formatAcceptedRevisionLine,
  formatCompletedAt,
} from "../../lib/checkoffConsoleModel";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  buildName: string;
  totalUnits: number;
  partCount: number;
  completedAt: string | null;
  planVersion: number | null;
  revisionId: number | null;
  planHref: string;
  productionHref: string;
  onPrintSheet?: () => void;
  className?: string;
};

/**
 * Durable completion state for a finished Build.
 *
 * GOV.UK confirmation guidance: say what completed, give a reference the user
 * can quote, and offer what happens next. The reference here is the Accepted
 * Plan revision, because that is what the verified units belong to.
 */
export default function CheckoffCompletionCard({
  buildName,
  totalUnits,
  partCount,
  completedAt,
  planVersion,
  revisionId,
  planHref,
  productionHref,
  onPrintSheet,
  className,
}: Props) {
  return (
    <section
      aria-labelledby="checkoff-complete-title"
      role="status"
      className={cn(
        "rounded-lg border border-success/40 bg-success-soft p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-success" aria-hidden />
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <h2 id="checkoff-complete-title" className="text-lg font-semibold text-foreground">
              {buildName} is fully checked off
            </h2>
            <p className="text-sm text-foreground">
              {totalUnits} Required {totalUnits === 1 ? "unit" : "units"} across {partCount}{" "}
              {partCount === 1 ? "part" : "parts"} are verified.
            </p>
          </div>
          <dl className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
            <div>
              <dt className="sr-only">Accepted Plan revision</dt>
              <dd>{formatAcceptedRevisionLine({ planVersion, revisionId })}</dd>
            </div>
            <div>
              <dt className="sr-only">Completion time</dt>
              <dd>{formatCompletedAt(completedAt)}</dd>
            </div>
          </dl>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className="min-h-11 w-full sm:w-auto" asChild>
              <Link to={planHref}>Review the Accepted Plan</Link>
            </Button>
            <Button variant="secondary" className="min-h-11 w-full sm:w-auto" asChild>
              <Link to={productionHref}>Print more units</Link>
            </Button>
            {onPrintSheet ? (
              <Button
                variant="ghost"
                className="min-h-11 w-full sm:w-auto"
                onClick={onPrintSheet}
              >
                Print the packing sheet
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
