import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useSourcesQuery } from "../queries/sources";
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
  const { profiles, selectedProfileId } = useProfileSelection();
  const { data: sources = [] } = useSourcesQuery();
  const { review } = usePlanWorkspace();

  const attachedSourceCount = useMemo(() => {
    if (!review?.layers) return null;
    const n = review.layers.filter((l) => l.project_id != null).length;
    return n > 0 ? n : null;
  }, [review]);

  const stages = useMemo(
    () =>
      buildWorkflowStages({
        pathname: location.pathname,
        sourcesCount: sources.length,
        profiles,
        selectedProfileId,
        attachedSourceCount,
        review,
      }),
    [
      location.pathname,
      sources.length,
      profiles,
      selectedProfileId,
      attachedSourceCount,
      review,
    ],
  );

  return {
    stages,
    activeId: stageIdFromPath(location.pathname),
  };
}
