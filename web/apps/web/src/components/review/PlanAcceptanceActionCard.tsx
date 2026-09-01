import { CircleAlert } from "lucide-react";
import PlanDraftApplyButton from "../build/PlanDraftApplyButton";
import { statusTone } from "../../lib/statusTone";
import { Button } from "../ui/button";
import { usePlanAcceptance } from "./PlanAcceptanceContext";
import { cn } from "@/lib/utils";
import { workingPlanChangedMessage } from "../../lib/workingPlanChanged";

/**
 * Step 7 of the Plan checkpoint: publish the revision for Production.
 *
 * Required-unit impact stays beside the publication action so the operator
 * sees the consequence in the same place they confirm it.
 *
 * A failed attempt stays on the page with its next safe action. Concurrent
 * edits refresh the Working Plan. Source changes rebuild it and require another
 * review before publication.
 */
export default function PlanAcceptanceActionCard() {
  const { model, busy, failure, accept } = usePlanAcceptance();
  if (!model.working) return null;

  const impact = model.impact;
  const retryFailure = failure?.kind === "error" || failure?.kind === "working_plan_changed"
    ? failure
    : null;
  const rebuiltFromSources = retryFailure?.kind === "working_plan_changed" &&
    retryFailure.recovery === "rebuilt_from_sources";
  const recoveryHeading = rebuiltFromSources
    ? "Working Plan rebuilt from Sources"
    : "Working Plan refreshed";

  return (
    <section
      id="plan-acceptance"
      aria-labelledby="plan-acceptance-heading"
      className="rounded-lg border border-primary/40 bg-card p-4 shadow-sm"
    >
      <h2 id="plan-acceptance-heading" className="text-sm font-semibold">
        Publish for Production
      </h2>
      {impact.kind === "ready" ? (
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Units kept</dt>
            <dd className="text-lg font-semibold tabular-nums">{impact.preservedUnits}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Must be printed again</dt>
            <dd className="text-lg font-semibold tabular-nums">{impact.printAgainUnits}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">No longer required</dt>
            <dd className="text-lg font-semibold tabular-nums">{impact.retiredUnits}</dd>
          </div>
        </dl>
      ) : null}
      <div className="mt-3">
        <PlanDraftApplyButton
          publication={model.publication}
          busy={busy}
          onPublish={() => accept()}
        />
      </div>
      {retryFailure && (
        <div
          role="alert"
          className={cn(
            "mt-3 flex gap-2 rounded-md p-3 text-sm",
            statusTone({ tone: "error", emphasis: "soft" }),
          )}
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              {retryFailure.kind === "working_plan_changed"
                ? recoveryHeading
                : "Publishing did not complete"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {retryFailure.kind === "working_plan_changed"
                ? workingPlanChangedMessage(retryFailure.recovery)
                : retryFailure.message}
            </p>
            {retryFailure.kind === "error" ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2 min-h-11"
                disabled={busy}
                onClick={() => accept()}
              >
                Retry publishing
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
