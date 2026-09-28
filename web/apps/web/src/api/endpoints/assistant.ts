import type {
  PlanDecision,
} from "@print-partner/contracts";
import { engineFetch, } from "../engineTransport";

export async function fetchPlanDecisions(planId: number): Promise<{ decisions: PlanDecision[] }> {
  return engineFetch(`/plans/${planId}/decisions`);
}
