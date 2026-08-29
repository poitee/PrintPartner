import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useProfileSelection } from "../../context/ProfileContext";
import { buildWorkflowStages, type WorkflowStageId } from "../../lib/workflowStages";
import {
  buildActiveWorkChips,
  buildSummaryLine,
  type BuildActiveWorkChip,
} from "../../lib/buildSummaryModel";
import { useBuildWorkflowQuery } from "../../queries/buildWorkflow";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

type Props = {
  currentStageId: WorkflowStageId;
  className?: string;
};

function chipClass(tone: BuildActiveWorkChip["tone"]): string {
  switch (tone) {
    case "error":
      return "border-destructive/35 bg-destructive-soft text-destructive";
    case "warning":
      return "border-warning/35 bg-warning-soft text-warning";
    case "info":
      return "border-info/35 bg-info-soft text-info";
    case "neutral":
      return "border-border bg-muted text-muted-foreground";
  }
}

/**
 * Current-state summary on every Build stage. The instrument header already
 * names the Build. This block answers which accepted revision is in force,
 * what is happening in the background, and the one next action.
 *
 * It reads the server-owned Build Workflow projection, so the browser and MCP
 * agree on status and next action. It is not a stepper. Stage navigation stays
 * in the rail.
 */
export default function BuildSummaryHeader({ currentStageId, className }: Props) {
  const { selectedProfileId } = useProfileSelection();
  const workflowQuery = useBuildWorkflowQuery(selectedProfileId);
  const workspace = workflowQuery.data;
  if (!workspace) return null;

  const summary = buildSummaryLine(workspace);
  const chips = buildActiveWorkChips(workspace);
  const action = workspace.next_action;
  const actionStage = buildWorkflowStages(workspace, selectedProfileId).find(
    (stage) => stage.id === action.stage_id,
  );
  const onThisStage = action.stage_id === currentStageId;

  return (
    <section
      className={cn("desk-nameplate", className)}
      aria-label="Build summary and next action"
      data-testid="build-summary-header"
    >
      <div className="flex flex-col gap-1 border-b border-border px-4 py-3">
        <p className="text-body text-muted-foreground">
          {summary.facts.join(" · ")}
        </p>
        {chips.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Active work">
            {chips.map((chip) => (
              <li
                key={chip.id}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs font-medium",
                  chipClass(chip.tone),
                )}
              >
                {chip.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div
        className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        data-testid="build-next-action"
      >
        <div className="min-w-0">
          <p className="font-mono text-2xs font-semibold uppercase tracking-[0.14em] text-primary">
            Next
          </p>
          <p className="mt-0.5 text-sm font-medium text-foreground">{action.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{action.reason}</p>
        </div>
        {!onThisStage && actionStage ? (
          <Button variant="secondary" className="min-h-11 shrink-0" asChild>
            <Link to={actionStage.to}>
              Open {actionStage.label}
              <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
            </Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
