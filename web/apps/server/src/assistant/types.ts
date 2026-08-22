import type { AiProviderId, AssistantChatMessage, AssistantProposedAction } from "@print-partner/contracts";
import type { AssistantToolSpec } from "./tools.js";

export type AssistantChatParams = {
  system: string;
  messages: AssistantChatMessage[];
  model: string;
  maxTokens: number;
};

export type AssistantStreamHandlers = {
  onToken: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
};

export type AssistantToolCallRequest = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** Message history for multi-round tool calling. */
export type AssistantToolMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: AssistantToolCallRequest[] }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export type AssistantToolsParams = {
  system: string;
  messages: AssistantToolMessage[];
  model: string;
  maxTokens: number;
  tools: AssistantToolSpec[];
};

export type AssistantCompletionResult = {
  content: string;
  toolCalls: AssistantToolCallRequest[];
  stopReason: "end_turn" | "tool_use";
};

export type AssistantTurnResult = {
  content: string;
  proposedActions: AssistantProposedAction[];
  toolsDegraded: boolean;
};

/** LLM chat adapter — keys stay on the server; never log secrets. */
export interface AssistantPort {
  readonly provider: AiProviderId;
  readonly model: string | null;
  readonly configured: boolean;
  /** True when completeWithTools is implemented. */
  readonly supportsTools: boolean;
  complete(params: AssistantChatParams): Promise<string>;
  stream(params: AssistantChatParams, handlers: AssistantStreamHandlers): Promise<void>;
  completeWithTools?(params: AssistantToolsParams): Promise<AssistantCompletionResult>;
}
