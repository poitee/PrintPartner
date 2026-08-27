export type PlanLookupContext = {
  readonly activePlanId?: number | null;
  readonly repo: {
    getOwnedProfileIdentity(planId: number): unknown;
  };
};

export function asInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) {
    return Math.trunc(Number(raw));
  }
  return null;
}

export function resolvePlanId(
  input: Record<string, unknown>,
  ctx: PlanLookupContext,
  validateRequested = true,
): number | null {
  const requested = asInt(input.plan_id);
  if (requested != null && (!validateRequested || ctx.repo.getOwnedProfileIdentity(requested))) {
    return requested;
  }
  return ctx.activePlanId != null ? ctx.activePlanId : null;
}
