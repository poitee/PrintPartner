import type { QueryClient } from "@tanstack/react-query";
import type { PlanDraftIdentity, ProfileSummary } from "@print-partner/contracts";
import type { SavePlanChoicesResponse } from "../api/endpoints/planDrafts";
import type { PlanReview } from "../api/endpoints/planManifests";
import { queryKeys } from "../queries/keys";

function cacheObservation(client: QueryClient, key: readonly unknown[]) {
  const state = client.getQueryState(key);
  return { updates: state?.dataUpdateCount ?? 0, data: state?.data };
}

export function capturePlanSaveCache(client: QueryClient, profileId: number) {
  return {
    reviews: [false, true].map((includeExcluded) => ({
      includeExcluded, ...cacheObservation(client, queryKeys.planReview(profileId, includeExcluded)),
    })),
    profile: cacheObservation(client, queryKeys.profile(profileId)),
    listRow: client.getQueryData<ProfileSummary[]>(queryKeys.profiles)?.find((profile) => profile.id === profileId),
  };
}

export function includedPlanReview(review: PlanReview): PlanReview {
  return {
    ...review,
    part_groups: review.part_groups.flatMap((group) => {
      const parts = group.parts.filter((part) => part.included);
      return parts.length ? [{ ...group, source_layer: parts[0]?.source_layer ?? null, parts }] : [];
    }),
  };
}

export async function hydratePlanSave(
  client: QueryClient,
  saved: SavePlanChoicesResponse,
  observed: ReturnType<typeof capturePlanSaveCache>,
): Promise<void> {
  const profileId = saved.receipt.profile_id;
  const closed = new Set(saved.closed_draft_ids);
  await client.cancelQueries({ predicate: (query) =>
    (query.queryKey[0] === "profiles" && (query.queryKey.length === 1 || query.queryKey[1] === profileId)) ||
    (["planReview", "planDrafts", "planDraft"].includes(String(query.queryKey[0])) && query.queryKey[1] === profileId),
  }, { revert: false });
  const changedReviews = new Set(observed.reviews.filter((before) => {
    const now = cacheObservation(client, queryKeys.planReview(profileId, before.includeExcluded));
    return now.updates !== before.updates || now.data !== before.data;
  }).map((before) => before.includeExcluded));
  const profileNow = cacheObservation(client, queryKeys.profile(profileId));
  const profileChanged = profileNow.updates !== observed.profile.updates || profileNow.data !== observed.profile.data;
  const listRow = client.getQueryData<ProfileSummary[]>(queryKeys.profiles)?.find((profile) => profile.id === profileId);
  const listRowChanged = listRow !== observed.listRow;
  const listNeedsLoad = client.getQueryState(queryKeys.profiles) != null &&
    client.getQueryData(queryKeys.profiles) == null;
  const latestVersion = Math.max(...client.getQueriesData<PlanReview>({
    queryKey: ["planReview", profileId],
  }).map(([, review]) => review?.accepted_basis?.plan_version ?? 0), 0);
  if ((saved.review.accepted_basis?.plan_version ?? 0) >= latestVersion) {
    for (const includeExcluded of [false, true]) {
      const key = queryKeys.planReview(profileId, includeExcluded);
      const current = client.getQueryData<PlanReview>(key);
      if (changedReviews.has(includeExcluded) && current?.accepted_basis?.plan_version === saved.review.accepted_basis?.plan_version) continue;
      client.setQueryData(key, includeExcluded ? saved.review : includedPlanReview(saved.review));
    }
    if (!profileChanged) client.setQueryData(queryKeys.profile(profileId), saved.profile);
    client.setQueryData<ProfileSummary[]>(queryKeys.profiles, (profiles) => {
      return profiles?.map((profile) => profile.id === profileId && !listRowChanged ? saved.profile : profile);
    });
  }
  if (changedReviews.size > 0) {
    void client.invalidateQueries({ queryKey: ["planReview", profileId], refetchType: "active" });
  }
  if (profileChanged || listRowChanged || listNeedsLoad) {
    void client.invalidateQueries({ queryKey: queryKeys.profiles, exact: true, refetchType: "active" });
    void client.invalidateQueries({ queryKey: queryKeys.profile(profileId), exact: true, refetchType: "active" });
  }
  client.setQueryData<PlanDraftIdentity[]>(queryKeys.planDrafts(profileId), (drafts) =>
    (drafts ?? []).filter((draft) => !closed.has(draft.draft_id)),
  );
  for (const draftId of closed) {
    client.removeQueries({ queryKey: queryKeys.planDraft(profileId, draftId), exact: true });
  }
  for (const key of [queryKeys.checkoff(profileId), queryKeys.acceptedPlateWorkspace(profileId),
    queryKeys.acceptedPlateExportJobs(profileId), queryKeys.buildWorkflow(profileId)]) {
    void client.invalidateQueries({ queryKey: key, refetchType: "none" });
  }
}
