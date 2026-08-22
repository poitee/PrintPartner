import { randomUUID } from "node:crypto";
import type {
  PlanDecision,
  PlanDecisionActor,
  PlanDecisionKind,
  AssistantProposedAction,
} from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";

export type AppendDecisionInput = {
  planId: number;
  actor: PlanDecisionActor;
  kind: PlanDecisionKind;
  actionType?: string | null;
  params?: Record<string, unknown>;
  label?: string;
  summary?: string;
  rationale?: string | null;
  result?: Record<string, unknown> | null;
};

export function appendPlanDecision(
  repo: AppRepository,
  input: AppendDecisionInput,
): PlanDecision {
  return repo.createPlanDecision({
    planId: input.planId,
    actor: input.actor,
    kind: input.kind,
    actionType: input.actionType ?? null,
    params: input.params ?? {},
    label: input.label ?? "",
    summary: input.summary ?? "",
    rationale: input.rationale ?? null,
    result: input.result ?? null,
  });
}

export function logAppliedAction(
  repo: AppRepository,
  action: AssistantProposedAction,
  result?: Record<string, unknown> | null,
): PlanDecision | null {
  if (!repo.getOwnedProfileIdentity(action.plan_id)) return null;
  return appendPlanDecision(repo, {
    planId: action.plan_id,
    actor: "assistant",
    kind: "applied_action",
    actionType: action.type,
    params: action.params ?? {},
    label: action.label,
    summary: action.summary,
    result: result ?? null,
  });
}

export function logDismissedAction(
  repo: AppRepository,
  action: AssistantProposedAction,
): PlanDecision | null {
  if (!repo.getOwnedProfileIdentity(action.plan_id)) return null;
  return appendPlanDecision(repo, {
    planId: action.plan_id,
    actor: "user",
    kind: "dismissed_action",
    actionType: action.type,
    params: action.params ?? {},
    label: action.label,
    summary: action.summary,
  });
}

/** Stable id helper when constructing synthetic actions for recipe replay. */
export function newActionId(): string {
  return randomUUID();
}
