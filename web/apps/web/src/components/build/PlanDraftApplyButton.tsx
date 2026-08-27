import type { PlanAcceptanceDecision } from "../../lib/planAcceptanceModel";
import { Button } from "../ui/button";

type PlanDraftApplyButtonProps = {
  readonly decision: PlanAcceptanceDecision;
  readonly busy: boolean;
  readonly onAccept: () => void;
};

/**
 * The one action of the Plan checkpoint. It states its own outcome, and when it
 * is unavailable the reason is written next to it rather than implied by a
 * greyed-out control.
 */
export default function PlanDraftApplyButton({
  decision,
  busy,
  onAccept,
}: PlanDraftApplyButtonProps) {
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        className="min-h-11 w-full sm:w-auto"
        aria-describedby="plan-accept-reason"
        disabled={busy || !decision.canAccept}
        loading={busy}
        onClick={onAccept}
      >
        {decision.label}
      </Button>
      <p id="plan-accept-reason" className="text-sm text-muted-foreground">
        {decision.reason}
      </p>
    </div>
  );
}
