import type { QueryState } from "@tanstack/react-query";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  type HealthResponse,
  type PlanFeatures,
} from "@print-partner/contracts";

export function spoolmanWorkflowAccess({ profileId, health, plan }: {
  profileId: number | null | undefined;
  health: Pick<QueryState<HealthResponse>, "status" | "data"> | undefined;
  plan: Pick<QueryState<PlanFeatures>, "status" | "data" | "isInvalidated"> | undefined;
}) {
  const gated = Boolean(profileId != null && health?.data?.capabilities?.includes(TENANT_FEATURE_TOGGLES_CAPABILITY));
  const allowed = !gated || (health?.status === "success" && health.data?.ok === true
    && plan?.status === "success" && !plan.isInvalidated
    && plan.data != null && plan.data.profile_id === profileId && plan.data.effective.spoolman.enabled);
  // Keep the same key while features first load, so discovery does not fetch twice.
  const queryAllowed = !plan || plan.status === "pending" || allowed;
  return { gated, allowed, queryAllowed };
}
