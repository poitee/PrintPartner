import type { QueryState } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type FeatureKey,
  type HealthResponse,
  type PlanFeatures,
} from "@print-partner/contracts";

type WorkflowAccessInput = {
  profileId: number | null | undefined;
  health: Pick<QueryState<HealthResponse>, "status" | "data"> | undefined;
  plan: Pick<QueryState<PlanFeatures>, "status" | "data" | "isInvalidated"> | undefined;
};

export function spoolmanWorkflowGated({ profileId, health }: Pick<WorkflowAccessInput, "profileId" | "health">) {
  return Boolean(profileId != null && health?.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));
}

export function spoolmanWorkflowAccess(input: WorkflowAccessInput) {
  return planWorkflowAccess("spoolman", input);
}

export function planWorkflowAccess(feature: FeatureKey, { profileId, health, plan }: WorkflowAccessInput) {
  const gated = spoolmanWorkflowGated({ profileId, health });
  const allowed = !gated || (health?.status === "success" && health.data?.ok === true
    && plan?.status === "success" && !plan.isInvalidated
    && plan.data != null && plan.data.profile_id === profileId && plan.data.effective[feature].enabled);
  // Keep the same key while features first load, so discovery does not fetch twice.
  const queryAllowed = !plan || plan.status === "pending" || allowed;
  return { gated, allowed, queryAllowed };
}
