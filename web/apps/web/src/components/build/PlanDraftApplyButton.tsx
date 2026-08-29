import type { PlanPublication } from "../../lib/planAcceptanceModel";
import { Button } from "../ui/button";

type PlanDraftApplyButtonProps = {
  readonly publication: PlanPublication;
  readonly busy: boolean;
  readonly onPublish: () => void;
};

/**
 * The one action of the Plan checkpoint. It states its own outcome, and when it
 * is unavailable the reason is written next to it rather than implied by a
 * greyed-out control.
 */
export default function PlanDraftApplyButton({
  publication,
  busy,
  onPublish,
}: PlanDraftApplyButtonProps) {
  const ready = publication.kind === "ready";
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        className="min-h-11 w-full sm:w-auto"
        aria-describedby="plan-publish-reason"
        disabled={busy || !ready}
        loading={busy}
        onClick={onPublish}
      >
        {publication.label}
      </Button>
      <p id="plan-publish-reason" className="text-sm text-muted-foreground">
        {publication.reason}
      </p>
    </div>
  );
}
