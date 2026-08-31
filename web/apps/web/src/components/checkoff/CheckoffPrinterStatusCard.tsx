import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { History, Printer } from "lucide-react";
import { checkoffPrinterSummary } from "../../lib/checkoffConsoleModel";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  printingJobs: number;
  queuedJobs: number;
  failedJobs: number;
  printersRoute: string;
  onAddPastPrint: () => void;
  /** Live printer detail. */
  children?: ReactNode;
  className?: string;
};

/**
 * Checkoff's printer desk: live status, missed-job recovery, and fleet access.
 * It does not dispatch new work; Production still owns preparation and send.
 */
export default function CheckoffPrinterStatusCard({
  printingJobs,
  queuedJobs,
  failedJobs,
  printersRoute,
  onAddPastPrint,
  children,
  className,
}: Props) {
  const summary = checkoffPrinterSummary({ printingJobs, queuedJobs, failedJobs });

  return (
    <section
      aria-label="Printer status"
      className={cn(
        "overflow-hidden rounded-lg border border-primary/40 bg-card shadow-sm",
        className,
      )}
    >
      <div className="space-y-3 bg-primary-soft px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <Printer className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Printer activity</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Watched jobs appear in Needs attention when they finish. If a job was missed or
              printed elsewhere, add its file here and assign the Required units it covered.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground" role="status">
            <span className="font-medium text-foreground">{summary.printingLabel}</span>
            <span aria-hidden> · </span>
            <span>{summary.queuedLabel}</span>
            {summary.failedLabel ? (
              <>
                <span aria-hidden> · </span>
                <span className="text-destructive">{summary.failedLabel}</span>
              </>
            ) : null}
          </p>
          <Button size="sm" className="min-h-9" onClick={onAddPastPrint}>
            <History className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Add a past print
          </Button>
          <Button variant="secondary" size="sm" className="min-h-9" asChild>
            <Link to={printersRoute}>Open all printers</Link>
          </Button>
        </div>
      </div>
      {children ? (
        <div className="border-t border-border px-3 py-2.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}
