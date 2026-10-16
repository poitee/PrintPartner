import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { patchPart } from "../api/endpoints/plans";
import { fetchPlanReview, type PlanReview } from "../api/endpoints/planManifests";
import { patchPartAssembled, patchPartProgress } from "../api/endpoints/checkoff";
import { useSpoolmanWorkflowAccess } from "../hooks/useSpoolmanWorkflowAccess";
import { maskSpoolmanReviewPart, mergeAssembledIntoReview, mergeProgressIntoReview } from "../lib/reviewParts";
import { queryKeys } from "./keys";
import { invalidateProfiles } from "./profiles";
import { invalidateRoleFilaments } from "./roleFilaments";

type ReviewMutationContext<T> = {
  profileId: number | null;
  includeExcluded: boolean;
  snapshots?: Array<{ key: readonly unknown[]; previous: T }>;
};

export function usePlanReviewQuery(
  profileId: number | null,
  options?: { includeExcluded?: boolean; enabled?: boolean },
) {
  const includeExcluded = options?.includeExcluded ?? false;
  const access = useSpoolmanWorkflowAccess(profileId);
  return useQuery({
    queryKey: queryKeys.planReview(profileId ?? 0, includeExcluded, access.queryAllowed),
    staleTime: 0,
    queryFn: () => fetchPlanReview(profileId!, { includeExcluded }),
    enabled: (options?.enabled ?? true) && profileId != null && profileId > 0,
    placeholderData: (previous, query) => query?.queryKey[1] === profileId && query.queryKey[2] === includeExcluded ? previous : undefined,
    select: (review) => access.allowed ? review : { ...review, part_groups: review.part_groups.map((group) => ({
      ...group, parts: group.parts.map(maskSpoolmanReviewPart),
    })) },
  });
}

export function invalidatePlanReview(
  qc: ReturnType<typeof useQueryClient>,
  profileId: number,
) {
  return qc.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "planReview" && q.queryKey[1] === profileId,
  });
}

function invalidateOtherPlanReviewVariants(
  qc: ReturnType<typeof useQueryClient>,
  profileId: number,
  includeExcluded: boolean,
) {
  return qc.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "planReview" &&
      query.queryKey[1] === profileId &&
      query.queryKey[2] !== includeExcluded,
  });
}

export function usePatchPartMutation(profileId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      partId,
      body,
    }: {
      partId: number;
      body: Parameters<typeof patchPart>[1];
    }) => patchPart(partId, body),
    onMutate: () => ({ profileId }),
    onSuccess: (_part, _variables, context) => {
      if (context?.profileId != null) {
        void invalidatePlanReview(qc, context.profileId);
        void invalidateProfiles(qc);
        void invalidateRoleFilaments(qc, context.profileId);
      }
    },
  });
}

export function usePatchPartProgressMutation(
  profileId: number | null,
  includeExcluded = false,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      partId,
      unitIndex,
      completed,
    }: {
      partId: number;
      unitIndex: number;
      completed: boolean;
    }) => patchPartProgress(partId, unitIndex, completed),
    onMutate: async ({ partId, unitIndex, completed }): Promise<ReviewMutationContext<Parameters<typeof mergeProgressIntoReview>[2]>> => {
      const context = { profileId, includeExcluded };
      if (profileId == null) return context;
      const prefix = ["planReview", profileId, includeExcluded];
      await qc.cancelQueries({ queryKey: prefix });
      const snapshots = [];
      for (const [key, current] of qc.getQueriesData<PlanReview>({ queryKey: prefix })) {
        if (!current) continue;
        const part = current.part_groups
          .flatMap((g) => g.parts)
          .find((p) => p.id === partId);
        const previous = part && {
          printed_count: part.printed_count, print_units: part.print_units,
          assembled_units: part.assembled_units, missing: part.missing,
        };
        if (part && previous) {
          snapshots.push({ key, previous });
          const optimisticUnits = [...part.print_units];
          while (optimisticUnits.length < part.quantity_effective) optimisticUnits.push(false);
          for (let index = 0; index < optimisticUnits.length; index += 1) {
            if (completed ? index <= unitIndex : index >= unitIndex) {
              optimisticUnits[index] = completed;
            }
          }
          const optimisticPrinted = optimisticUnits.filter(Boolean).length;
          qc.setQueryData(
            key,
            mergeProgressIntoReview(current, partId, {
              printed_count: optimisticPrinted,
              print_units: optimisticUnits,
              assembled_units: completed ? part.assembled_units : part.assembled_units?.map(
                (assembled, index) => index >= unitIndex ? false : assembled,
              ),
              missing: optimisticPrinted < part.quantity_effective,
            }),
          );
        }
      }
      return { ...context, snapshots };
    },
    onError: (_err, { partId }, ctx) => {
      for (const { key, previous } of ctx?.snapshots ?? []) {
        qc.setQueryData<PlanReview>(key, (current) => current &&
          mergeProgressIntoReview(current, partId, previous));
      }
    },
    onSuccess: (progress, { partId }, ctx) => {
      const profileId = ctx?.profileId;
      if (profileId == null) return;
      for (const { key } of ctx?.snapshots ?? []) {
        const current = qc.getQueryData<PlanReview>(key);
        if (current) {
          qc.setQueryData(
            key,
            mergeProgressIntoReview(current, partId, {
              printed_count: progress.printed_count,
              print_units: progress.print_units,
              // Server is authoritative about which units are still assembled
              // after a print toggle (un-printing clears the flag).
              assembled_units: progress.assembled_units,
              missing: progress.missing,
            }),
          );
        }
      }
      if (!ctx?.snapshots?.length) {
        void qc.invalidateQueries({ queryKey: ["planReview", profileId, ctx.includeExcluded] });
      }
      void invalidateOtherPlanReviewVariants(qc, profileId, ctx.includeExcluded);
      void invalidateProfiles(qc);
    },
  });
}

export function usePatchPartAssembledMutation(
  profileId: number | null,
  includeExcluded = false,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      partId,
      unitIndex,
      assembled,
    }: {
      partId: number;
      unitIndex: number;
      assembled: boolean;
    }) => patchPartAssembled(partId, unitIndex, assembled),
    onMutate: async ({ partId, unitIndex, assembled }): Promise<ReviewMutationContext<Parameters<typeof mergeAssembledIntoReview>[2]>> => {
      const context = { profileId, includeExcluded };
      if (profileId == null) return context;
      const prefix = ["planReview", profileId, includeExcluded];
      await qc.cancelQueries({ queryKey: prefix });
      const snapshots = [];
      for (const [key, current] of qc.getQueriesData<PlanReview>({ queryKey: prefix })) {
        if (!current) continue;
        const part = current.part_groups
          .flatMap((g) => g.parts)
          .find((p) => p.id === partId);
        const previous = part && { assembled_units: part.assembled_units ?? [] };
        if (part && previous) {
          snapshots.push({ key, previous });
          const qty = Math.max(1, part.quantity_effective);
          const optimisticUnits = [...(part.assembled_units ?? [])];
          while (optimisticUnits.length < qty) optimisticUnits.push(false);
          if (unitIndex < optimisticUnits.length) optimisticUnits[unitIndex] = assembled;
          qc.setQueryData(
            key,
            mergeAssembledIntoReview(current, partId, {
              assembled_units: optimisticUnits,
            }),
          );
        }
      }
      return { ...context, snapshots };
    },
    onError: (_err, { partId }, ctx) => {
      for (const { key, previous } of ctx?.snapshots ?? []) {
        qc.setQueryData<PlanReview>(key, (current) => current &&
          mergeAssembledIntoReview(current, partId, previous));
      }
    },
    onSuccess: (progress, { partId }, ctx) => {
      const profileId = ctx?.profileId;
      if (profileId == null) return;
      for (const { key } of ctx?.snapshots ?? []) {
        const current = qc.getQueryData<PlanReview>(key);
        if (current) {
          qc.setQueryData(
            key,
            mergeAssembledIntoReview(current, partId, {
              assembled_units: progress.assembled_units,
            }),
          );
        }
      }
      if (!ctx?.snapshots?.length) {
        void qc.invalidateQueries({ queryKey: ["planReview", profileId, ctx.includeExcluded] });
      }
      void invalidateOtherPlanReviewVariants(qc, profileId, ctx.includeExcluded);
    },
  });
}
