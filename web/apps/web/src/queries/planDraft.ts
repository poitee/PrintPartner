import { useQuery } from "@tanstack/react-query";
import { fetchPlanDraftWorkspace, listPlanDrafts } from "../api/engine";
import { queryKeys } from "./keys";

export function usePlanDraftListQuery(profileId: number | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.planDrafts(profileId ?? 0),
    queryFn: () => listPlanDrafts(profileId!),
    enabled: enabled && profileId != null && profileId > 0,
  });
}

export function usePlanDraftWorkspaceQuery(
  profileId: number | null,
  draftId: number | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.planDraft(profileId ?? 0, draftId ?? 0),
    queryFn: () => fetchPlanDraftWorkspace(profileId!, draftId!),
    enabled: enabled && profileId != null && profileId > 0 && draftId != null && draftId > 0,
  });
}
