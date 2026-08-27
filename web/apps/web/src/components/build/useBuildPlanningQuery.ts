import { useQuery } from "@tanstack/react-query";
import type { BuildWorkflowWorkspace } from "@print-partner/contracts";
import {
  fetchBuildPlanningState,
  type BuildPlanningState,
} from "../../api/endpoints/planManifests";
import { useBuildWorkflowQuery } from "../../queries/buildWorkflow";

/**
 * A short fingerprint of the parts of the shared Build Workflow projection that
 * can change what the assistant proposed. Any browser or MCP mutation that
 * moves the Build shows up here, so the planning read below refetches with it
 * instead of going stale until the Build id changes.
 */
export function buildWorkflowSignature(
  workspace: BuildWorkflowWorkspace | undefined,
): string {
  if (!workspace) return "unknown";
  const { sources, accepted_plan: accepted, working_plan: working } = workspace;
  return [
    sources.kind,
    "attached_count" in sources ? sources.attached_count : 0,
    accepted.kind,
    "revision_id" in accepted ? accepted.revision_id : 0,
    working.kind,
    "draft_id" in working ? working.draft_id : 0,
    "change_count" in working ? working.change_count : 0,
    workspace.next_action.kind,
  ].join(":");
}

/**
 * Assistant planning state for a Build, keyed on the shared workflow query so
 * an MCP or browser mutation refreshes it.
 */
export function useBuildPlanningQuery(planId: number | null) {
  const workflowQuery = useBuildWorkflowQuery(planId);
  const signature = buildWorkflowSignature(workflowQuery.data);

  return useQuery<BuildPlanningState | null>({
    queryKey: ["buildPlanning", planId ?? 0, signature],
    queryFn: () => {
      if (planId == null || planId <= 0) {
        throw new Error("A Build is required to read its assistant changes");
      }
      return fetchBuildPlanningState(planId);
    },
    enabled: planId != null && planId > 0,
    staleTime: 5_000,
  });
}
