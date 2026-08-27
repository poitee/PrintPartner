import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { checkoffPrinterSummary } from "../../lib/checkoffConsoleModel";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  printingJobs: number;
  queuedJobs: number;
  failedJobs: number;
  productionRoute: string;
  /** Live printer detail. Stays mounted while collapsed so polling continues. */
  children?: ReactNode;
  className?: string;
};

/**
 * Printing now and Queued, as status only.
 *
 * Dispatch belongs to Production: Checkoff is where a physical result is
 * verified, and mixing "send more work" into that surface is what buried the
 * verification queue. This card reports and links, and never sends.
 */
export default function CheckoffPrinterStatusCard({
  printingJobs,
  queuedJobs,
  failedJobs,
  productionRoute,
  children,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const summary = checkoffPrinterSummary({ printingJobs, queuedJobs, failedJobs });

  return (
    <section
      aria-label="Printer status"
      className={cn("rounded-lg border border-border bg-card", className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
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
        <Button variant="ghost" size="sm" className="min-h-9" asChild>
          <Link to={productionRoute}>Go to Production</Link>
        </Button>
        {children ? (
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            )}
            {open ? "Hide printer detail" : "Show printer detail"}
          </button>
        ) : null}
      </div>
      {children ? (
        <div hidden={!open} className="border-t border-border px-3 py-2.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}
