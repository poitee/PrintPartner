import { CircleAlert } from "lucide-react";
import PlanDraftApplyButton from "../build/PlanDraftApplyButton";
import { statusTone } from "../../lib/statusTone";
import { Button } from "../ui/button";
import { usePlanAcceptance } from "./PlanAcceptanceContext";
import { cn } from "@/lib/utils";

/**
 * Step 7 of the Plan checkpoint: accept the revision.
 *
 * A failed attempt stays on the page with Retry. The user's quantity, inclusion
 * and Required-unit answers are untouched, so Retry repeats the acceptance
 * rather than restarting the review.
 */
export default function PlanAcceptanceActionCard() {
  const { model, busy, failure, accept } = usePlanAcceptance();

  return (
    <section
      id="plan-acceptance"
      aria-labelledby="plan-acceptance-heading"
      className="rounded-lg border border-primary/40 bg-card p-4 shadow-sm"
    >
      <h2 id="plan-acceptance-heading" className="text-sm font-semibold">
        Accept this revision
      </h2>
      <div className="mt-2">
        <PlanDraftApplyButton
          decision={model.decision}
          busy={busy}
          onAccept={() => accept()}
        />
      </div>
      {failure?.kind === "error" && (
        <div
          role="alert"
          className={cn(
            "mt-3 flex gap-2 rounded-md p-3 text-sm",
            statusTone({ tone: "error", emphasis: "soft" }),
          )}
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">Acceptance did not complete</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{failure.message}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2 min-h-11"
              disabled={busy}
              onClick={() => accept()}
            >
              Retry acceptance
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
