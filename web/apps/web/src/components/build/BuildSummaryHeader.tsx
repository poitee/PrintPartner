import { useProfileSelection } from "../../context/ProfileContext";
import { type WorkflowStageId } from "../../lib/workflowStages";
import { buildActiveWorkChips, buildSummaryLine } from "../../lib/buildSummaryModel";
import { statusTone } from "../../lib/statusTone";
import { useBuildWorkflowQuery } from "../../queries/buildWorkflow";
import { cn } from "@/lib/utils";

type Props = {
  currentStageId: WorkflowStageId;
  className?: string;
};

/**
 * Print progress and actionable job status. Plan bookkeeping stays out of the
 * main workflow.
 */
export default function BuildSummaryHeader({ className }: Props) {
  const { selectedProfileId } = useProfileSelection();
  const workflowQuery = useBuildWorkflowQuery(selectedProfileId);
  const workspace = workflowQuery.data;
  if (!workspace) return null;

  const summary = buildSummaryLine(workspace);
  const chips = buildActiveWorkChips(workspace);
  if (summary.facts.length === 0 && chips.length === 0) return null;

  return (
    <section
      className={cn("desk-nameplate", className)}
      aria-label="Print progress"
      data-testid="build-summary-header"
    >
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="text-body text-muted-foreground">
          {summary.facts.join(" · ")}
        </p>
        {chips.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Active work">
            {chips.map((chip) => (
              <li
                key={chip.id}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs font-medium",
                  statusTone({ tone: chip.tone, emphasis: "soft" }),
                )}
              >
                {chip.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
