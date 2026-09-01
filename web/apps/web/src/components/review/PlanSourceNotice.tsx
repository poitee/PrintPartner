import { Info } from "lucide-react";
import { Link } from "react-router-dom";
import { usePlanAcceptance } from "./PlanAcceptanceContext";
import { Button } from "../ui/button";

/**
 * Source drift is an update for a future Plan, not a problem with the revision
 * Production and Checkoff already use.
 */
export default function PlanSourceNotice() {
  const { model } = usePlanAcceptance();
  const notice = model.sourceNotice;
  if (!notice) return null;

  return (
    <section
      aria-labelledby="plan-source-notice-heading"
      className="rounded-lg border border-primary/35 bg-primary/5 p-4 shadow-sm"
    >
      <div className="flex gap-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="plan-source-notice-heading" className="text-sm font-semibold">
            {notice.title}
          </h2>
          <p className="mt-1 text-sm text-foreground">{notice.message}</p>
          <p className="mt-1 text-sm text-muted-foreground">{notice.detail}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className="min-h-11 w-full sm:w-auto" asChild>
              <Link to={notice.productionAction.to}>{notice.productionAction.label}</Link>
            </Button>
            <Button variant="secondary" className="min-h-11 w-full sm:w-auto" asChild>
              <Link to={notice.reviewAction.to}>{notice.reviewAction.label}</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
