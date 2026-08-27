import type { PlanDraftWorkspace } from "@print-partner/contracts";
import { Button } from "../ui/button";

type PlanDraftApplyButtonProps = {
  workspace: PlanDraftWorkspace;
  busy: boolean;
  onApply: () => void;
  onRebase: () => void;
};

export default function PlanDraftApplyButton({
  workspace,
  busy,
  onApply,
  onRebase,
}: PlanDraftApplyButtonProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {!workspace.diff.base_is_current && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onRebase}
        >
          Refresh Working Plan
        </Button>
      )}
      <Button
        type="button"
        disabled={
          busy ||
          !workspace.diff.base_is_current ||
          workspace.reconciliation.kind !== "ready"
        }
        loading={busy}
        onClick={onApply}
      >
        Accept Working Plan
      </Button>
    </div>
  );
}
