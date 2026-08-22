import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchPlanReview,
  patchPart,
  patchPartAssembled,
  patchPartProgress,
  type PlanReview,
} from "../api/engine";
import {
  optimisticReviewCacheKey,
  rollbackOptimisticCache,
} from "../lib/reviewCache";
import { mergeAssembledIntoReview, mergeProgressIntoReview } from "../lib/reviewParts";
import { queryKeys } from "./keys";
import { invalidateProfiles } from "./profiles";
import { invalidateRoleFilaments } from "./roleFilaments";

export function usePlanReviewQuery(
  profileId: number | null,
  options?: { includeExcluded?: boolean; enabled?: boolean },
) {
  const includeExcluded = options?.includeExcluded ?? false;
  return useQuery({
    queryKey: queryKeys.planReview(profileId ?? 0, includeExcluded),
    queryFn: () => fetchPlanReview(profileId!, { includeExcluded }),
    enabled: (options?.enabled ?? true) && profileId != null && profileId > 0,
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
    onSuccess: () => {
      if (profileId != null) {
        void invalidatePlanReview(qc, profileId);
        void invalidateProfiles(qc);
        void invalidateRoleFilaments(qc, profileId);
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
      optimisticReview?: PlanReview;
    }) => patchPartProgress(partId, unitIndex, completed),
    onMutate: async ({ partId, unitIndex, completed, optimisticReview }) => {
      if (profileId == null || !optimisticReview) return undefined;
      const key = optimisticReviewCacheKey(profileId, includeExcluded);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<PlanReview>(key);
      const part = optimisticReview.part_groups
        .flatMap((g) => g.parts)
        .find((p) => p.id === partId);
      if (part) {
        const optimisticUnits = [...part.print_units];
        while (optimisticUnits.length < part.quantity_effective) optimisticUnits.push(false);
        if (unitIndex < optimisticUnits.length) optimisticUnits[unitIndex] = completed;
        const optimisticPrinted = optimisticUnits.filter(Boolean).length;
        qc.setQueryData(
          key,
          mergeProgressIntoReview(optimisticReview, partId, {
            printed_count: optimisticPrinted,
            print_units: optimisticUnits,
            missing: optimisticPrinted < part.quantity_effective,
          }),
        );
      }
      return { previous, key };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx?.key) return;
      const rollback = rollbackOptimisticCache(ctx.previous);
      if (rollback.kind === "restore") {
        qc.setQueryData(ctx.key, rollback.previous);
      } else {
        qc.removeQueries({ queryKey: ctx.key, exact: true });
      }
    },
    onSuccess: (progress, { partId }, ctx) => {
      if (profileId == null) return;
      if (ctx?.key) {
        const current = qc.getQueryData<PlanReview>(ctx.key);
        if (current) {
          qc.setQueryData(
            ctx.key,
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
      } else {
        void qc.invalidateQueries({
          queryKey: optimisticReviewCacheKey(profileId, includeExcluded),
        });
      }
      void invalidateOtherPlanReviewVariants(qc, profileId, includeExcluded);
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
      optimisticReview?: PlanReview;
    }) => patchPartAssembled(partId, unitIndex, assembled),
    onMutate: async ({ partId, unitIndex, assembled, optimisticReview }) => {
      if (profileId == null || !optimisticReview) return undefined;
      const key = optimisticReviewCacheKey(profileId, includeExcluded);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<PlanReview>(key);
      const part = optimisticReview.part_groups
        .flatMap((g) => g.parts)
        .find((p) => p.id === partId);
      if (part) {
        const qty = Math.max(1, part.quantity_effective);
        const optimisticUnits = [...(part.assembled_units ?? [])];
        while (optimisticUnits.length < qty) optimisticUnits.push(false);
        if (unitIndex < optimisticUnits.length) optimisticUnits[unitIndex] = assembled;
        qc.setQueryData(
          key,
          mergeAssembledIntoReview(optimisticReview, partId, {
            assembled_units: optimisticUnits,
          }),
        );
      }
      return { previous, key };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx?.key) return;
      const rollback = rollbackOptimisticCache(ctx.previous);
      if (rollback.kind === "restore") {
        qc.setQueryData(ctx.key, rollback.previous);
      } else {
        qc.removeQueries({ queryKey: ctx.key, exact: true });
      }
    },
    onSuccess: (progress, { partId }, ctx) => {
      if (profileId == null) return;
      if (ctx?.key) {
        const current = qc.getQueryData<PlanReview>(ctx.key);
        if (current) {
          qc.setQueryData(
            ctx.key,
            mergeAssembledIntoReview(current, partId, {
              assembled_units: progress.assembled_units,
            }),
          );
        }
      } else {
        void qc.invalidateQueries({
          queryKey: optimisticReviewCacheKey(profileId, includeExcluded),
        });
      }
      void invalidateOtherPlanReviewVariants(qc, profileId, includeExcluded);
    },
  });
}
