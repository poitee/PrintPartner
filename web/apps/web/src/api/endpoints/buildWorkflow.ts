import {
  parseBuildWorkflowWorkspace,
  type BuildWorkflowWorkspace,
} from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export async function fetchBuildWorkflowWorkspace(
  buildId: number,
): Promise<BuildWorkflowWorkspace> {
  return parseBuildWorkflowWorkspace(
    await engineFetch(`/plans/${buildId}/workflow`),
  );
}
