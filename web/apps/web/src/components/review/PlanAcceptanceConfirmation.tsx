import { Link } from "react-router-dom";
import { CircleCheck } from "lucide-react";
import { planConfirmationCopy } from "../../lib/planAcceptanceModel";
import { prepareMissingPartsRoute, progressRoute } from "../../lib/routes";
import { statusTone } from "../../lib/statusTone";
import { Button } from "../ui/button";
import { usePlanAcceptance } from "./PlanAcceptanceContext";
import { cn } from "@/lib/utils";

/**
 * The acceptance receipt. It stays on the page after the click, names the
 * revision, says what survived, and offers the two places the work continues.
 * A toast cannot do that job: it is gone before the user looks up.
 */
export default function PlanAcceptanceConfirmation() {
  const { confirmation, buildId, dismissConfirmation } = usePlanAcceptance();
  if (!confirmation) return null;

  const copy = planConfirmationCopy(confirmation);

  return (
    <section
      role="status"
      aria-labelledby="plan-acceptance-receipt-heading"
      className={cn(
        "rounded-lg p-4",
        statusTone({ tone: "success", emphasis: "soft" }),
      )}
    >
      <div className="flex gap-2">
        <CircleCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="plan-acceptance-receipt-heading" className="text-base font-semibold text-foreground">
            {copy.heading}
          </h2>
          <p className="mt-1 text-sm text-foreground">{copy.detail}</p>

          {confirmation.unmoved.length > 0 && (
            <div className="mt-3 rounded-md border border-border bg-card p-3">
              <p className="text-sm font-medium text-foreground">
                Printer and Checkoff records that could not move
              </p>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {confirmation.unmoved.map((unit) => (
                  <li key={`${unit.filename}-${unit.outcome}`}>
                    <span className="font-mono text-foreground">{unit.filename}</span>
                    <span> — {unit.outcome}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {copy.prepareLabel && (
              <Button className="min-h-11 w-full sm:w-auto" asChild>
                <Link to={prepareMissingPartsRoute(buildId)}>{copy.prepareLabel}</Link>
              </Button>
            )}
            <Button variant="secondary" className="min-h-11 w-full sm:w-auto" asChild>
              <Link to={progressRoute(buildId)}>{copy.checkoffLabel}</Link>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full sm:w-auto"
              onClick={dismissConfirmation}
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
