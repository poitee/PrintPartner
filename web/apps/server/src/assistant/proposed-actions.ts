import { randomUUID } from "node:crypto";
import type { AssistantActionType, AssistantProposedAction } from "@print-partner/contracts";
import { isAssistantUiAction } from "@print-partner/contracts";
import type { AppRepository } from "../db/repository.js";
import { decisionFingerprint, isDismissedFingerprint } from "./preferences-digest.js";

export type ToolInvokeResult = {
  content: string;
  proposedAction?: AssistantProposedAction;
};

export type ProposeAssistantActionInput = Readonly<{
  type: AssistantActionType;
  planId: number;
  label: string;
  summary: string;
  params: Record<string, unknown>;
  extras?: Record<string, unknown>;
}>;

export function proposeAssistantAction(
  input: ProposeAssistantActionInput,
): ToolInvokeResult {
  const action: AssistantProposedAction = {
    id: randomUUID(),
    type: input.type,
    plan_id: input.planId,
    label: input.label,
    summary: input.summary,
    params: input.params,
  };
  return {
    proposedAction: action,
    content: JSON.stringify({
      status: "proposed",
      note: "Not applied yet — user must confirm via Apply in the UI.",
      action,
      ...(input.extras ?? {}),
    }),
  };
}

export function proposeAssistantActionUnlessDismissed(
  input: {
    repo: AppRepository;
    type: AssistantActionType;
    planId: number;
    label: string;
    summary: string;
    params: Record<string, unknown>;
    extras?: Record<string, unknown>;
  },
): ToolInvokeResult {
  if (
    input.planId > 0 &&
    !isAssistantUiAction(input.type) &&
    isDismissedFingerprint(input.repo, input.planId, input.type, input.params)
  ) {
    return {
      content: JSON.stringify({
        error: "user_dismissed",
        detail: "User dismissed this action fingerprint on this plan. Ask before re-proposing the same change.",
        fingerprint: decisionFingerprint(input.type, input.params),
        action_type: input.type,
      }),
    };
  }

  return proposeAssistantAction(input);
}
