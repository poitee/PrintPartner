import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type HealthResponse,
  type PlanFeatures,
} from "@print-partner/contracts";
import type { PlanReview } from "../api/endpoints/planManifests";
import { maskSpoolmanReviewPart } from "../lib/reviewParts";
import type { FilamentCatalog, RoleFilamentRow } from "../api/endpoints/filaments";
import { useHealthQuery } from "../queries/health";
import { queryKeys } from "../queries/keys";
import { usePlanFeaturesQuery } from "../queries/planFeatures";

function purgeProfileSpools(client: ReturnType<typeof useQueryClient>, targetProfileId: number) {
  client.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === "spoolmanSpools" && query.queryKey[2] === targetProfileId,
  });
}

export function useSpoolmanWorkflowAccess(profileId: number) {
  const client = useQueryClient();
  const health = useHealthQuery();
  const healthy = Boolean(health.isSuccess && health.data?.ok);
  const gated = Boolean(health.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));

  const plan = usePlanFeaturesQuery(profileId, healthy && gated);

  const planState = client.getQueryState(queryKeys.planFeatures(profileId));

  const allowed = healthy && (!gated || (
    plan.isSuccess && !planState?.isInvalidated && plan.data?.profile_id === profileId && plan.data.effective.spoolman.enabled === true
  ));

  const generation = useRef(0);
  const mounted = useRef(false);
  const scope = useRef({ profileId });

  const currentAccessAllowed = useCallback(() => {
    const currentHealth = client.getQueryState<HealthResponse>(queryKeys.health);
    if (
      scope.current.profileId !== profileId ||
      !currentHealth ||
      currentHealth.status !== "success" ||
      !currentHealth.data?.ok
    ) {
      return false;
    }
    if (!currentHealth.data.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY)) return true;
    const currentPlan = client.getQueryState<PlanFeatures>(queryKeys.planFeatures(profileId));
    return currentPlan?.status === "success" && !currentPlan.isInvalidated
      && currentPlan.data?.profile_id === profileId && currentPlan.data.effective.spoolman.enabled === true;
  }, [client, profileId]);

  useLayoutEffect(() => {
    scope.current = { profileId };
    mounted.current = true;
    let previousAllowed = currentAccessAllowed();
    let clearing = false;
    const reviews = { queryKey: ["planReview", profileId] };
    const roles = { queryKey: queryKeys.roleFilaments(profileId) };
    const clearInventoryObservations = () => {
      clearing = true;
      void client.cancelQueries(reviews, { revert: false });
      void client.cancelQueries(roles, { revert: false });
      client.setQueriesData<PlanReview>(reviews, (review) => review && ({
        ...review, part_groups: review.part_groups.map((group) => ({
          ...group, parts: group.parts.map(maskSpoolmanReviewPart),
        })),
      }));
      client.setQueriesData<RoleFilamentRow[]>(roles, (rows) => rows?.map((row) => (
        row.filament_color_id?.trim().startsWith("spoolman:")
          ? { ...row, filament_display: row.filament_color_id, filament_hex: row.filament_custom_hex ?? null }
          : row
      )));
      clearing = false;
    };
    if (!previousAllowed) {
      purgeProfileSpools(client, profileId);
      clearInventoryObservations();
    }
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (clearing) return;
      const allowedNow = currentAccessAllowed();
      const changed = allowedNow !== previousAllowed;
      previousAllowed = allowedNow;
      if (!allowedNow) {
        generation.current += 1;
        purgeProfileSpools(client, profileId);
        if (changed || (event.type === "updated" && event.action.type === "success"
          && ((event.query.queryKey[0] === "planReview" && event.query.queryKey[1] === profileId)
            || (event.query.queryKey[0] === "roleFilaments" && event.query.queryKey[1] === profileId)))) {
          clearInventoryObservations();
        }
      } else if (changed) {
        void client.invalidateQueries(reviews);
        void client.invalidateQueries(roles);
        void client.invalidateQueries({ queryKey: queryKeys.filamentCatalog(profileId) });
      }
    });

    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [client, currentAccessAllowed, profileId]);

  const beginAction = useCallback(() => {
    const started = generation.current;
    const target = scope.current;
    const isCurrent = () => mounted.current && scope.current === target;
    return {
      isCurrent,
      isSpoolmanAllowed: () =>
        isCurrent() &&
        started === generation.current &&
        currentAccessAllowed(),
    };
  }, [currentAccessAllowed]);

  const prevAllowed = useRef(allowed);
  useEffect(() => {
    if (allowed) {
      const cached = client.getQueryData<FilamentCatalog>(queryKeys.filamentCatalog(profileId));
      if (!prevAllowed.current || cached?.spoolman_status === "disabled") {
        void client.invalidateQueries({ queryKey: queryKeys.filamentCatalog(profileId) });
      }
    }
    prevAllowed.current = allowed;
  }, [allowed, client, profileId]);

  return { allowed: Boolean(allowed), currentAccessAllowed, beginAction };
}
