import { Link } from "react-router-dom";
import { useProfileSelection } from "../../context/ProfileContext";
import { buildWorkflowStages, type WorkflowStageId } from "../../lib/workflowStages";
import { useBuildWorkflowQuery } from "../../queries/buildWorkflow";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  currentStageId: WorkflowStageId;
  className?: string;
};

export default function BuildWorkflowNextAction({
  currentStageId,
  className,
}: Props) {
  const { selectedProfileId } = useProfileSelection();
  const workflowQuery = useBuildWorkflowQuery(selectedProfileId);
  const workspace = workflowQuery.data;
  if (!workspace) return null;

  const action = workspace.next_action;
  const actionStage = buildWorkflowStages(workspace, selectedProfileId).find(
    (stage) => stage.id === action.stage_id,
  );
  if (!actionStage) return null;

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/[0.04] p-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      aria-label="Next Build action"
      data-testid="build-next-action"
    >
      <div className="min-w-0">
        <p className="font-mono text-micro font-semibold uppercase tracking-[0.14em] text-primary">
          Next action
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">{action.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{action.reason}</p>
      </div>
      {action.stage_id !== currentStageId ? (
        <Button variant="secondary" size="sm" className="shrink-0" asChild>
          <Link to={actionStage.to}>Open {actionStage.label}</Link>
        </Button>
      ) : null}
    </section>
  );
}
