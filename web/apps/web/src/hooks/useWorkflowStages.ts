import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useProfileSelection } from "../context/ProfileContext";
import { useBuildWorkflowQuery } from "../queries/buildWorkflow";
import {
  buildWorkflowStages,
  stageIdFromPath,
  type WorkflowStage,
  type WorkflowStageId,
} from "../lib/workflowStages";

export function useWorkflowStages(): {
  stages: WorkflowStage[];
  activeId: WorkflowStageId | null;
} {
  const location = useLocation();
  const { selectedProfileId } = useProfileSelection();
  const workflowQuery = useBuildWorkflowQuery(selectedProfileId);

  const stages = useMemo(
    () => buildWorkflowStages(workflowQuery.data ?? null, selectedProfileId),
    [workflowQuery.data, selectedProfileId],
  );

  return {
    stages,
    activeId: stageIdFromPath(location.pathname),
  };
}
