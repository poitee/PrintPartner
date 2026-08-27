import { useQuery } from "@tanstack/react-query";
import { fetchBuildWorkflowWorkspace } from "../api/endpoints/buildWorkflow";
import { queryKeys } from "./keys";

export function useBuildWorkflowQuery(
  buildId: number | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.buildWorkflow(buildId ?? 0),
    queryFn: () => {
      if (buildId == null || buildId <= 0) {
        throw new Error("A Build is required to read its workflow");
      }
      return fetchBuildWorkflowWorkspace(buildId);
    },
    enabled: enabled && buildId != null && buildId > 0,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const activeWork = query.state.data?.active_work;
      if (!activeWork) return 30_000;
      const activeCount = activeWork.queued_jobs
        + activeWork.sending_jobs
        + activeWork.printing_jobs
        + activeWork.awaiting_verification;
      return activeCount > 0 ? 5_000 : 30_000;
    },
  });
}
